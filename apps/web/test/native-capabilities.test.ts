import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlLedgerStore } from '@zichan/db';
import { installSyncLifecycle, type LifecycleSyncResult, type SyncLifecycleReason } from '../src/background-sync.js';
import {
  authenticateBiometric,
  currentDevicePosition,
  scanBarcode,
  sendDeviceNotification,
  shareJsonFile,
} from '../src/device-capabilities.js';
import { appLockResumeAction, authenticateAppLock, shouldRelockApp } from '../src/ui/AppSecurityGate.js';
import { getDeviceId } from '../src/db/cloud.js';
import { closeStoreWhenCancelled } from '../src/db/store.js';
import { sharedBackupFileName } from '../src/db/backups.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class LifecycleWindow extends EventTarget {
  interval?: () => void;
  timeout?: () => void;
  setInterval(callback: () => void) { this.interval = callback; return 1; }
  clearInterval() { this.interval = undefined; }
  setTimeout(callback: () => void) { this.timeout = callback; return 2; }
  clearTimeout() { this.timeout = undefined; }
}

class LifecycleDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'hidden';
}

const original = {
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
  Notification: Object.getOwnPropertyDescriptor(globalThis, 'Notification'),
};

function restore(name: keyof typeof original) {
  const descriptor = original[name];
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

afterEach(() => {
  restore('window');
  restore('document');
  restore('navigator');
  restore('localStorage');
  restore('sessionStorage');
  restore('Notification');
  vi.restoreAllMocks();
});

describe('application lifecycle sync', () => {
  it('runs on startup, interval, foreground, online and debounced credential readiness', async () => {
    const fakeWindow = new LifecycleWindow();
    const fakeDocument = new LifecycleDocument();
    const storage = new MemoryStorage();
    storage.setItem('zichan.sync.auto.v1', JSON.stringify({ enabled: true, minutes: 5 }));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

    const reasons: SyncLifecycleReason[] = [];
    const runner = async (_store: SqlLedgerStore, reason: SyncLifecycleReason): Promise<LifecycleSyncResult | null> => {
      reasons.push(reason);
      return null;
    };
    const cleanup = installSyncLifecycle({} as SqlLedgerStore, () => undefined, runner);
    await Promise.resolve();
    expect(reasons).toEqual(['startup']);

    fakeWindow.interval?.();
    fakeWindow.dispatchEvent(new Event('online'));
    fakeDocument.visibilityState = 'visible';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    fakeWindow.dispatchEvent(new Event('zichan:credentials-changed'));
    fakeWindow.timeout?.();
    expect(reasons).toEqual(['startup', 'interval', 'online', 'foreground', 'credentials']);

    cleanup();
    fakeWindow.dispatchEvent(new Event('online'));
    expect(reasons).toHaveLength(5);
  });

  it('relocks only after a meaningful background interval', () => {
    expect(shouldRelockApp(true, 1_000, 2_001)).toBe(true);
    expect(shouldRelockApp(true, 1_000, 2_000)).toBe(false);
    expect(shouldRelockApp(false, 1_000, 9_000)).toBe(false);
    expect(shouldRelockApp(true, null, 9_000)).toBe(false);
    expect(appLockResumeAction(true, 1_000, 2_001, false, false)).toBe('authenticate');
    expect(appLockResumeAction(true, 1_000, 1_500, false, false)).toBe('restore');
    expect(appLockResumeAction(true, 1_000, 1_500, true, false)).toBe('none');
    expect(appLockResumeAction(true, 1_000, 1_500, false, true)).toBe('none');
  });

  it('keeps the app lock closed when status or authentication fails', async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error('native auth failed'));
    await expect(authenticateAppLock(
      async () => ({ isAvailable: false, biometryType: 0, error: '设备验证不可用' }),
      authenticate,
    )).rejects.toThrow('设备验证不可用');
    expect(authenticate).toHaveBeenCalledOnce();

    const deviceCredential = vi.fn().mockResolvedValue(undefined);
    await expect(authenticateAppLock(
      async () => ({ isAvailable: false, biometryType: 0 }),
      deviceCredential,
    )).resolves.toBeUndefined();
  });

  it('closes an asynchronously opened store when StrictMode already cancelled initialization', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    expect(await closeStoreWhenCancelled({ close }, () => true)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(await closeStoreWhenCancelled({ close }, () => false)).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses unique timestamped names for shared backups', () => {
    expect(sharedBackupFileName('2026-07-12T12:34:56.789Z')).toBe('zichan-backup-2026-07-12T12-34-56-789Z.zcbak');
  });
});

describe('Stronghold credential vault', () => {
  it('creates, writes, reads and locks through Stronghold without browser storage', async () => {
    vi.resetModules();
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const records = new Map<string, number[]>();
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      if (command === 'native_security_status') {
        return { platform: 'android', mobile: true, strongholdPath: '/app/security/sync-vault.hold', strongholdExists: false } as T;
      }
      if (command === 'plugin:stronghold|load_client') throw new Error('client missing');
      if (command === 'plugin:stronghold|get_store_record') return (records.get(String(args?.key)) ?? null) as T;
      if (command === 'plugin:stronghold|save_store_record') {
        records.set(String(args?.key), args?.value as number[]);
      }
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke } },
    });

    const vault = await import('../src/credential-vault.js');
    await vault.unlockCredentialVault('local-password', ['home']);
    await vault.persistCredential('home', { password: 'sync-secret', inviteCode: 'invite-1' });
    expect(vault.runtimeCredential('home')).toMatchObject({ password: 'sync-secret', inviteCode: 'invite-1' });
    expect(new TextDecoder().decode(new Uint8Array(records.get('sync-server:home')!))).toBe('{"password":"sync-secret","inviteCode":"invite-1"}');
    await vault.lockCredentialVault();
    expect(vault.runtimeCredentialMap()).toEqual({});
    expect(calls.map((call) => call.command)).toEqual(expect.arrayContaining([
      'plugin:stronghold|initialize',
      'plugin:stronghold|create_client',
      'plugin:stronghold|save_store_record',
      'plugin:stronghold|save',
      'plugin:stronghold|destroy',
    ]));
  });

  it('restores an existing server password after a new application process unlocks', async () => {
    vi.resetModules();
    const stored = [...new TextEncoder().encode('{"password":"restored-secret","inviteCode":""}')];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'native_security_status') {
        return { platform: 'windows', mobile: false, strongholdPath: 'C:/App/security/sync-vault.hold', strongholdExists: true } as T;
      }
      if (command === 'plugin:stronghold|get_store_record' && args?.key === 'sync-server:office') return stored as T;
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
    const vault = await import('../src/credential-vault.js');
    const credentials = await vault.unlockCredentialVault('local-password', ['office']);
    expect(credentials.office).toMatchObject({ password: 'restored-secret', inviteCode: '' });
  });

  it('unloads a partially opened Stronghold after a record read failure so unlock can retry', async () => {
    vi.resetModules();
    const stored = [...new TextEncoder().encode('{"password":"retry-secret","inviteCode":""}')];
    const calls: string[] = [];
    let reads = 0;
    const invoke = async <T>(command: string): Promise<T> => {
      calls.push(command);
      if (command === 'native_security_status') {
        return { platform: 'android', mobile: true, strongholdPath: '/app/security/sync-vault.hold', strongholdExists: true } as T;
      }
      if (command === 'plugin:stronghold|get_store_record') {
        reads += 1;
        if (reads === 1) throw new Error('record temporarily unavailable');
        return stored as T;
      }
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
    const vault = await import('../src/credential-vault.js');
    await expect(vault.unlockCredentialVault('local-password', ['home'])).rejects.toThrow('record temporarily unavailable');
    expect(vault.credentialVaultState().unlocked).toBe(false);
    expect(calls.filter((command) => command === 'plugin:stronghold|destroy')).toHaveLength(1);
    await expect(vault.unlockCredentialVault('local-password', ['home'])).resolves.toMatchObject({
      home: { password: 'retry-secret', inviteCode: '' },
    });
  });

  it('refuses to orphan saved credentials when deleting a profile while Stronghold is locked', async () => {
    vi.resetModules();
    const invoke = async <T>(command: string): Promise<T> => {
      if (command === 'native_security_status') {
        return { platform: 'windows', mobile: false, strongholdPath: 'C:/App/security/sync-vault.hold', strongholdExists: true } as T;
      }
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
    const vault = await import('../src/credential-vault.js');
    await vault.refreshCredentialVaultState();
    await expect(vault.deleteCredential('home')).rejects.toThrow('请先解锁 Stronghold');
  });

  it('does not publish an unsaved credential when Stronghold persistence fails', async () => {
    vi.resetModules();
    const calls: string[] = [];
    const invoke = async <T>(command: string): Promise<T> => {
      calls.push(command);
      if (command === 'native_security_status') {
        return { platform: 'windows', mobile: false, strongholdPath: 'C:/App/security/sync-vault.hold', strongholdExists: true } as T;
      }
      if (command === 'plugin:stronghold|get_store_record') return null as T;
      if (command === 'plugin:stronghold|save') throw new Error('disk full');
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
    const vault = await import('../src/credential-vault.js');
    await vault.unlockCredentialVault('local-password', ['home']);

    await expect(vault.persistCredential('home', { password: 'not-durable', inviteCode: '' })).rejects.toThrow('disk full');
    expect(vault.runtimeCredential('home')).toBeUndefined();
    expect(vault.credentialVaultState()).toMatchObject({ unlocked: false });
    expect(calls).toContain('plugin:stronghold|destroy');
  });
});

describe('mobile device bridges', () => {
  it('keeps a stable installed-app device id outside the tab session', () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => undefined } } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: sessionStorage });
    const first = getDeviceId();
    sessionStorage.clear();
    expect(getDeviceId()).toBe(first);
    expect(localStorage.getItem('zichan-device-id-v2')).toBe(first);
  });

  it('requests native biometric, barcode and location capabilities', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      if (command === 'plugin:barcode-scanner|scan') return { content: '6901234567892', format: 'EAN_13' } as T;
      if (command === 'plugin:geolocation|get_current_position') {
        return { timestamp: 123, coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 7.5 } } as T;
      }
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Android Tauri WebView' } });

    await authenticateBiometric();
    expect(await scanBarcode()).toMatchObject({ content: '6901234567892', format: 'EAN_13' });
    expect(await currentDevicePosition()).toMatchObject({ latitude: 31.2304, longitude: 121.4737, accuracy: 7.5 });
    expect(calls.map((call) => call.command)).toEqual(expect.arrayContaining([
      'plugin:biometric|authenticate',
      'plugin:barcode-scanner|request_permissions',
      'plugin:barcode-scanner|scan',
      'plugin:geolocation|request_permissions',
      'plugin:geolocation|get_current_position',
    ]));
    const scan = calls.find((call) => call.command === 'plugin:barcode-scanner|scan');
    expect((scan?.args?.formats as string[])).toContain('UPC_A');
  });

  it('omits the unsupported UPC_A option when scanning on iOS', async () => {
    let scanArgs: Record<string, unknown> | undefined;
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'plugin:barcode-scanner|scan') {
        scanArgs = args;
        return { content: '012345678905', format: 'EAN_13' } as T;
      }
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'iPhone Tauri WebView' } });

    await scanBarcode();
    expect(scanArgs?.formats as string[]).not.toContain('UPC_A');
  });

  it('shares backup files through the native mobile plugin', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      return { shared: true } as T;
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'iPhone Tauri WebView', share: vi.fn() },
    });

    expect(await shareJsonFile('{"native":true}', 'mobile-backup.json', '分享账本')).toBe(true);
    expect(calls).toEqual([{
      command: 'plugin:system-share|share',
      args: {
        payload: {
          contents: '{"native":true}',
          fileName: 'mobile-backup.json',
          mimeType: 'application/json',
          title: '分享账本',
        },
      },
    }]);
    expect(navigator.share).not.toHaveBeenCalled();
  });

  it('uses the system share sheet and notification surface when available', async () => {
    const shares: ShareData[] = [];
    const shown: Array<{ title: string; body?: string }> = [];
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = async () => 'granted' as NotificationPermission;
      constructor(title: string, options?: NotificationOptions) { shown.push({ title, body: options?.body }); }
    }
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { Notification: FakeNotification } });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        canShare: (data: ShareData) => Boolean(data.files?.length),
        share: async (data: ShareData) => { shares.push(data); },
      },
    });

    expect(await shareJsonFile('{"ok":true}', 'backup.json')).toBe(true);
    expect(shares[0]?.files?.[0]?.name).toBe('backup.json');
    expect(await sendDeviceNotification('同步完成', '没有冲突')).toBe(true);
    expect(shown).toEqual([{ title: '同步完成', body: '没有冲突' }]);
  });
});
