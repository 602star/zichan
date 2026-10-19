import { accountLocalStorage, accountSessionStorage, accountStorageKey } from '../account-storage.js';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { LedgerKind, Setting } from '@zichan/core';
import {
  assertCurrentSchema,
  createLedgerStore,
  runDueScheduledTransactions,
  SqlLedgerStore,
} from '@zichan/db';
import { createLogger, consoleSink } from '@zichan/logger';
import { CLOUD_DEVICE_ID_KEY, getDeviceId } from './cloud.js';
import {
  downloadBackup,
  maybeAutoBackup,
  suspendAutomaticBackups,
  type AutomaticBackupSuspension,
} from './backups.js';
import { runLedgerMaintenance } from './maintenance.js';
import { successfulBackupSafetyPatch, writeSafetyState } from './safety.js';
import { openPlatformDriver, resetPlatformData, type StorageBackend } from './platform-driver.js';
import { withSharedBrowserTaskLock } from './shared-browser-driver.js';
import { recoverAttachmentStorage } from './attachment-storage.js';
import { isInitializationResetRequiredError } from './initialization-error.js';
import { initializedLedgerSetting } from './ledger-initialization.js';
import { exportPortableLedger } from './portable-backup.js';
import { FirstRunWizard } from '../ui/FirstRunWizard.js';
import { FirstUseModeGate, BrowserStorageConsent } from '../ui/FirstUseModeGate.js';
import { FirstServerConnectionGate } from '../ui/FirstServerConnectionGate.js';
import { FirstRemoteLedgerRestoreGate } from '../ui/FirstRemoteLedgerRestoreGate.js';
import { NativeAccountGate } from '../ui/NativeAccountGate.js';
import { hasNativeLedgerBootstrap } from '../desktop-ledger-profile.js';
import {
  lockDeviceStorage,
  refreshDeviceStorageState,
  unlockDeviceStorage,
  type DeviceStorageState,
} from '../device-storage-key.js';
import { ensureLedgerKeyForStore } from '../ledger-key-lifecycle.js';
import { replaceRemoteLedger } from '../replace-remote-ledger.js';
import { ledgerKeyState, unlockLedgerKey, lockLedgerKey } from '../ledger-key-vault.js';
import { accountProtection } from '../account-protection.js';
import { copyTextToClipboard, formatInitializationDiagnostic } from '../ui/diagnostics.js';
import {
  browserStorageDisposition,
  browserLocalCapability,
  loadBestEffortConsent,
  acceptBestEffortStorage,
  browserPersistenceStatus,
  clearFirstUseMode,
  loadFirstUseMode,
  prepareBrowserStorageForMode,
  saveFirstUseMode,
  type FirstUseMode,
} from '../browser-storage-policy.js';
import { isTauriRuntime } from '../tauri.js';
import { ACCOUNT_EXIT_KEY, ACCOUNT_LOCK_REQUEST_EVENT, exitBrowserAccount, setAccountCloseHandlerMounted } from '../browser-account-exit.js';
import { clearSyncConfiguration, hasSavedSyncConnection, loadSyncConnections, saveSyncConnections } from '../sync-config.js';
import { syncConfiguredServers } from '../sync-orchestrator.js';
import { clearCredentialVaultRuntimeState, persistCredential, runtimeCredentialMap, unlockCredentialVault } from '../credential-vault.js';
import { loadSharedSyncDirectory, mergeSharedSyncDirectory, saveSharedSyncDirectory } from '../sync-server-directory.js';

/**
 * What every ledger screen reads.
 *
 * Exported because the administrator preview mounts the same screens against a different
 * source: it supplies this shape over a read-only in-memory store. Two providers, one
 * context — a second context would mean a second `App`.
 */
export interface StoreCtx {
  store: SqlLedgerStore;
  /** Bumped after a write so data hooks reload. */
  rev: number;
  bump: () => void;
  storageBackend: StorageBackend;
  dataLocation: string;
  firstUseMode: FirstUseMode;
  browserStoragePersistent: boolean;
  resetLocalData: () => Promise<void>;
  exitAccount?: () => Promise<void>;
  /**
   * Present only in the administrator preview. The ledger app reads it to replace the
   * ordinary header affordances (export, import, settings) with preview facts.
   */
  preview?: {
    previewId: string;
    username: string;
    operator: string;
    expiresAt: string;
    openedAt: string;
    transactionCount: number;
    attachmentCount: number;
    commitCount: number;
  };
  /**
   * Downloads one attachment body of a previewed ledger.
   *
   * Only the server can decrypt it, so the preview hands the screens a fetch rather than the
   * bytes: the Manage screen decides when an operator actually wants a file. Absent outside a
   * preview, where the ordinary local/sync attachment paths apply.
   */
  downloadPreviewAttachment?: (sha256: string) => Promise<{ blob: Blob; fileName: string }>;
  closePreview?: () => Promise<void>;
}

export const StoreCtxContext = createContext<StoreCtx | null>(null);
const Ctx = StoreCtxContext;
const storeCloseFlights = new WeakMap<object, Promise<void>>();

type ClosableStore = Pick<SqlLedgerStore, 'close'>;
type LifecycleErrorReporter = (message: string, detail: unknown) => void;

export type VoidSingleFlight = (task: () => Promise<void>) => Promise<void>;

/** Start the task synchronously and return the same Promise to every concurrent caller. */
export function createVoidSingleFlight(): VoidSingleFlight {
  let active: Promise<void> | null = null;
  return (task) => {
    if (active) return active;
    let flight: Promise<void>;
    try {
      flight = Promise.resolve(task());
    } catch (error) {
      flight = Promise.reject(error);
    }
    active = flight;
    void flight.then(
      () => { if (active === flight) active = null; },
      () => { if (active === flight) active = null; },
    );
    return flight;
  };
}

interface PendingInitialization {
  store: SqlLedgerStore;
  storageBackend: StorageBackend;
  dataLocation: string;
}

export async function closeStoreWhenCancelled(
  store: Pick<SqlLedgerStore, 'close'>,
  isCancelled: () => boolean,
): Promise<boolean> {
  if (!isCancelled()) return false;
  await closeStoreOnce(store);
  return true;
}

/** Await one shared close flight so retry cannot race a still-open SQLite connection. */
export function closeStoreOnce(store: Pick<SqlLedgerStore, 'close'>): Promise<void> {
  const existing = storeCloseFlights.get(store);
  if (existing) return existing;
  const flight = Promise.resolve().then(() => store.close()).catch((error) => {
    storeCloseFlights.delete(store);
    throw error;
  });
  storeCloseFlights.set(store, flight);
  return flight;
}

async function closeUniqueStores(stores: Array<ClosableStore | null | undefined>): Promise<void> {
  const unique = [...new Set(stores.filter((value): value is ClosableStore => !!value))];
  for (const current of unique) await closeStoreOnce(current);
}

/** Close every live ledger and clear published references before the key vault is locked. */
export async function closeStoresBeforeStorageLock(
  stores: Array<ClosableStore | null | undefined>,
  clearStores: () => void,
  lockStorage: () => Promise<void>,
): Promise<void> {
  await closeUniqueStores(stores);
  clearStores();
  await lockStorage();
}

interface ResetStoreLifecycleOptions {
  stores: Array<ClosableStore | null | undefined>;
  clearStores: () => void;
  lockStorage: () => Promise<void>;
  resetPlatform: () => Promise<void>;
  suspendBackups?: () => AutomaticBackupSuspension;
}

/**
 * Pause and drain automatic backups before closing SQLite and deleting platform data.
 * A successful reset intentionally leaves backups paused until the document reloads.
 */
export async function resetStoreLifecycle(options: ResetStoreLifecycleOptions): Promise<void> {
  const suspension = (options.suspendBackups ?? suspendAutomaticBackups)();
  try {
    await suspension.drain();
    await closeUniqueStores(options.stores);
    options.clearStores();
    await options.lockStorage();
    await options.resetPlatform();
  } catch (error) {
    suspension.resume();
    throw error;
  }
}

export async function refreshLedgerKindSafely(
  store: Pick<SqlLedgerStore, 'settings'>,
  apply: (kind: LedgerKind) => void,
  report: LifecycleErrorReporter = (message, detail) => console.warn(message, detail),
): Promise<void> {
  try {
    const settings = await store.settings.list({ limit: 1 });
    apply(settings[0]?.ledgerKind === 'demo' ? 'demo' : 'personal');
  } catch (error) {
    report('setting subscription refresh failed', error);
  }
}

export async function runScheduledTransactionsSafely(
  store: SqlLedgerStore,
  onChanged: () => void,
  execute: typeof runDueScheduledTransactions = runDueScheduledTransactions,
  report: LifecycleErrorReporter = (message, detail) => console.warn(message, detail),
): Promise<void> {
  try {
    const result = await execute(store);
    if (result.created || result.skipped || result.failed) onChanged();
    if (result.errors.length) report('scheduled transaction execution failed', result.errors);
  } catch (error) {
    report('scheduled transaction execution rejected', error);
  }
}

function Splash({ label }: { label: string }) {
  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', color: 'var(--text-secondary)', fontFamily: 'system-ui, sans-serif', fontSize: 'var(--fs-body)',
    }}>
      {label}
    </div>
  );
}

function DeviceStorageGate(props: {
  state: DeviceStorageState;
  busy: boolean;
  error: string;
  onUnlock: (password: string) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const creating = !props.state.initialized;
  const canSubmit = password.length >= 8 && (!creating || password === confirmation);
  return (
    <div style={{
      minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24,
      background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'system-ui, sans-serif',
    }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void props.onUnlock(password);
        }}
        style={{ width: 'min(420px, 100%)', border: '1px solid var(--border)', background: 'var(--surface)', padding: 24, boxShadow: 'var(--shadow-lg)' }}
      >
        <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>{creating ? '保护本机账本' : '解锁本机账本'}</div>
        <div style={{ marginTop: 7, color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', lineHeight: 1.55 }}>{props.state.message}</div>
        <div style={{ marginTop: 5, color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', lineHeight: 1.5 }}>
          新账本使用同一个“账本密码”保护加密备份与端到端同步密钥；密码不会写入磁盘。
          配置同步时会再次要求输入这个密码，名称相同，不是另一个密码。
        </div>
        <label style={{ display: 'block', marginTop: 20, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
          账本密码
          <input
            autoFocus
            autoComplete={creating ? 'new-password' : 'current-password'}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={{ width: '100%', minHeight: 44, marginTop: 6, border: '1px solid var(--border-strong)', padding: '0 11px', boxSizing: 'border-box', fontSize: 'var(--fs-title)' }}
          />
        </label>
        {creating && (
          <label style={{ display: 'block', marginTop: 12, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
            再输入一次
            <input
              autoComplete="new-password"
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              style={{ width: '100%', minHeight: 44, marginTop: 6, border: '1px solid var(--border-strong)', padding: '0 11px', boxSizing: 'border-box', fontSize: 'var(--fs-title)' }}
            />
          </label>
        )}
        <div style={{ minHeight: 20, marginTop: 8, color: 'var(--negative)', fontSize: 'var(--fs-caption)' }}>
          {props.error || (password && password.length < 8 ? '密码至少需要 8 个字符' : creating && confirmation && password !== confirmation ? '两次输入不一致' : '')}
        </div>
        <button
          type="submit"
          disabled={!canSubmit || props.busy}
          style={{ width: '100%', minHeight: 44, marginTop: 6, border: 0, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)', cursor: canSubmit && !props.busy ? 'pointer' : 'not-allowed', opacity: canSubmit && !props.busy ? 1 : 0.55 }}
        >
          {props.busy ? '正在解锁…' : creating ? '创建并打开' : '解锁'}
        </button>
        {props.state.initialized && (
          <button
            type="button"
            disabled={props.busy}
            onClick={() => void props.onReset()}
            style={{ width: '100%', marginTop: 12, border: 0, background: 'transparent', color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', cursor: props.busy ? 'not-allowed' : 'pointer' }}
          >
            忘记密码并重置本机开发数据
          </button>
        )}
      </form>
    </div>
  );
}

function BrowserStorageRecoveryGate(props: {
  store: SqlLedgerStore;
  reason: string;
  onPersistenceRestored: () => void;
  onUseServer: () => void;
  onContinueLocal: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'persist' | 'export' | null>(null);
  const [message, setMessage] = useState('');

  async function retryPersistence() {
    setBusy('persist');
    setMessage('');
    try {
      const result = await browserPersistenceStatus(true);
      if (!result.persisted) throw new Error(result.reason || '浏览器仍未授予持久存储权限');
      props.onPersistenceRestored();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function exportRecoveryBackup() {
    setBusy('export');
    setMessage('');
    try {
      const backup = await exportPortableLedger(props.store);
      const result = await downloadBackup({ backup, createdAt: new Date().toISOString(), label: '浏览器本地恢复备份' });
      setMessage(result === 'cancelled' ? '已取消导出。' : '加密 .zcbak 已导出，请确认文件已保存到浏览器外。');
    } catch (error) {
      setMessage(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main style={{ minHeight: '100dvh', overflowY: 'auto', padding: 'clamp(24px, 6vw, 64px)', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(760px, 100%)', margin: '6vh auto 0', padding: 'clamp(20px, 5vw, 34px)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--surface)' }}>
        <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', letterSpacing: '.1em' }}>只读恢复模式</div>
        <h1 style={{ margin: '9px 0 8px', color: 'var(--text-primary)', fontSize: 'var(--fs-display)' }}>浏览器不再保证本地数据持久保存</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>{props.reason}</p>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>账本没有被删除。恢复持久授权前不会运行定期任务、自动备份或普通写入；你可以先导出加密备份，或者改为连接同步服务器。</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 20 }}>
          <button type="button" disabled={busy !== null} onClick={() => void retryPersistence()} style={{ minHeight: 44, padding: '0 16px', border: 0, borderRadius: 'var(--r-sm)', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)' }}>重新申请持久授权</button>
          <button type="button" disabled={busy !== null} onClick={() => void exportRecoveryBackup()} style={{ minHeight: 44, padding: '0 16px', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', color: 'var(--text-primary)', fontWeight: 'var(--fw-bold)' }}>导出加密 .zcbak</button>
          <button type="button" disabled={busy !== null} onClick={props.onUseServer} style={{ minHeight: 44, padding: '0 16px', border: 0, background: 'transparent', color: 'var(--text-primary)', fontWeight: 'var(--fw-bold)' }}>改为连接服务器</button>
        </div>
        <BrowserStorageConsent busy={busy !== null} onContinue={async () => {
          setBusy('persist');
          try { await props.onContinueLocal(); } catch (error) { setMessage(String(error)); } finally { setBusy(null); }
        }} />
        {message && <div role="status" style={{ marginTop: 14, color: message.includes('失败') ? 'var(--negative)' : 'var(--positive)', lineHeight: 1.6 }}>{message}</div>}
      </section>
    </main>
  );
}

function recoveryDeviceId(): string {
  try {
    return accountLocalStorage?.getItem(CLOUD_DEVICE_ID_KEY) || 'browser-read-only-recovery';
  } catch {
    return 'browser-read-only-recovery';
  }
}

async function unlockExistingLedgerKeyForRecovery(
  store: Pick<SqlLedgerStore, 'getLedgerId'>,
  passphrase: string,
): Promise<void> {
  const ledgerId = await store.getLedgerId();
  const state = ledgerKeyState();
  if (!state.initialized) throw new Error('只读恢复模式没有可用的账本备份密钥，请先恢复持久授权');
  if (state.ledgerId !== ledgerId) throw new Error('本机账本密钥与当前恢复账本不匹配');
  if (!state.unlocked) await unlockLedgerKey(passphrase);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<SqlLedgerStore | null>(null);
  const [rev, setRev] = useState(0);
  const [error, setError] = useState<{ message: string; resetRequired: boolean } | null>(null);
  const [errorCopyStatus, setErrorCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [resetting, setResetting] = useState(false);
  const [storageBackend, setStorageBackend] = useState<StorageBackend>('browser-indexeddb');
  const [dataLocation, setDataLocation] = useState('');
  const [storageProtection, setStorageProtection] = useState<DeviceStorageState | null>(null);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [pendingInitialization, setPendingInitialization] = useState<PendingInitialization | null>(null);
  const [ledgerKind, setLedgerKind] = useState<LedgerKind>('personal');
  const [firstUseMode, setFirstUseMode] = useState<FirstUseMode | null>(() => {
    // WebAccountApp verifies identity before mounting this provider; old mode flags are irrelevant.
    if (!isTauriRuntime()) return 'server';
    const mode = loadFirstUseMode();
    return mode === 'server' && !hasSavedSyncConnection() && !hasNativeLedgerBootstrap() ? null : mode;
  });
  const [serverSetupRequested, setServerSetupRequested] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState('');
  const [bestEffortAccepted, setBestEffortAccepted] = useState(loadBestEffortConsent);
  const persistenceCheckGeneration = useRef(0);
  const [browserPersistence, setBrowserPersistence] = useState<{
    checked: boolean;
    persisted: boolean;
    reason: string;
  }>(() => ({ checked: isTauriRuntime(), persisted: isTauriRuntime(), reason: '' }));
  const unlockStorageFlight = useRef(createVoidSingleFlight()).current;
  const resetStorageFlight = useRef(createVoidSingleFlight()).current;
  const storageLockFlight = useRef(createVoidSingleFlight()).current;
  const storagePassphrase = useRef<string | null>(accountProtection()?.secret ?? null);
  const initializationDiagnostic = useMemo(
    () => error ? formatInitializationDiagnostic(error.message, error.resetRequired) : '',
    [error],
  );

  useEffect(() => {
    setErrorCopyStatus('idle');
  }, [error?.message]);

  useEffect(() => {
    let active = true;
    void refreshDeviceStorageState()
      .then((state) => { if (active) setStorageProtection(state); })
      .catch((reason) => {
        if (active) setUnlockError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (isTauriRuntime()) return;
    let active = true;
    const generation = ++persistenceCheckGeneration.current;
    void browserPersistenceStatus(false).then((result) => {
      if (!active || generation !== persistenceCheckGeneration.current) return;
      setBrowserPersistence({ checked: true, persisted: result.persisted, reason: result.reason ?? '' });
    });
    return () => { active = false; };
  }, [firstUseMode]);

  async function selectFirstUseMode(mode: FirstUseMode, acceptRisk = false) {
    persistenceCheckGeneration.current += 1;
    setModeBusy(true);
    setModeError('');
    try {
      if (!isTauriRuntime()) {
        const result = await prepareBrowserStorageForMode(mode);
        setBrowserPersistence({ checked: true, persisted: result.persisted, reason: result.reason ?? '' });
        if (mode === 'local') {
          if (!result.supported) throw new Error(result.reason || '本地存储能力不可用');
          if (!result.persisted && !acceptRisk && !bestEffortAccepted) return;
          if (!result.persisted && acceptRisk) {
            acceptBestEffortStorage();
            setBestEffortAccepted(true);
          }
        }
      }
      if (mode === 'server') {
        setServerSetupRequested(true);
        return;
      }
      saveFirstUseMode(mode);
      setFirstUseMode(mode);
    } catch (error) {
      setModeError(error instanceof Error ? error.message : String(error));
    } finally {
      setModeBusy(false);
    }
  }

  async function finishFirstServerConnection() {
    accountLocalStorage.removeItem(ACCOUNT_EXIT_KEY);
    saveFirstUseMode('server');
    setFirstUseMode('server');
    setServerSetupRequested(false);
  }

  const storageDisposition = browserStorageDisposition({
    mode: firstUseMode,
    persistenceChecked: browserPersistence.checked,
    persisted: browserPersistence.persisted,
    hasExistingLocalData: storageProtection?.initialized === true,
    desktop: isTauriRuntime(),
    bestEffortAccepted,
    localSupported: browserLocalCapability().supported,
  });
  const browserLocalRecovery = storageDisposition === 'recovery';

  useEffect(() => {
    if (!firstUseMode || !storageProtection?.unlocked || storageDisposition === 'pending' || storageDisposition === 'blocked') return;
    let cancelled = false;
    let openedStore: SqlLedgerStore | null = null;
    let unsubscribeExternalChanges: (() => void) | undefined;
    let published = false;
    const closeOpenedStore = async () => {
      unsubscribeExternalChanges?.();
      unsubscribeExternalChanges = undefined;
      const current = openedStore;
      openedStore = null;
      published = false;
      if (current) await closeStoreOnce(current);
    };
    (async () => {
      try {
        if (!isTauriRuntime() && firstUseMode === 'local' && storageDisposition === 'writable') {
          const currentPersistence = await browserPersistenceStatus(false);
          if (cancelled) return;
          setBrowserPersistence({
            checked: true,
            persisted: currentPersistence.persisted,
            reason: currentPersistence.reason ?? '',
          });
          if (!currentPersistence.supported || (!currentPersistence.persisted && !bestEffortAccepted)) return;
        }
        const platform = await openPlatformDriver();
        if (await closeStoreWhenCancelled(platform.driver, () => cancelled)) return;
        const log = createLogger({ level: 'info', sinks: [consoleSink()], fields: { app: platform.backend === 'native-sqlite' ? 'native' : 'web' } });
        let s: SqlLedgerStore;
        try {
          const deviceId = browserLocalRecovery ? recoveryDeviceId() : getDeviceId();
          if (browserLocalRecovery) {
            await assertCurrentSchema(platform.driver);
            s = new SqlLedgerStore(platform.driver, { logger: log, deviceId });
          } else {
            s = await createLedgerStore(platform.driver, { logger: log, deviceId });
          }
        } catch (error) {
          await platform.driver.close().catch(() => undefined);
          throw error;
        }
        openedStore = s;
        unsubscribeExternalChanges = platform.subscribeChanges?.(() => s.invalidate(['*']));
        if (await closeStoreWhenCancelled(s, () => cancelled)) {
          openedStore = null;
          return;
        }
        const setting = await initializedLedgerSetting(s);
        if (await closeStoreWhenCancelled(s, () => cancelled)) {
          openedStore = null;
          return;
        }
        if (!setting) {
          const protection = accountProtection();
          if (protection?.info.replica && protection.info.replica.headSeq === 0) {
            await s.resetToLedger(protection.info.replica.ledgerId);
          }
          published = true;
          setStorageBackend(platform.backend);
          setDataLocation(platform.dataLocation);
          if (browserLocalRecovery) {
            setLedgerKind('personal');
            setStore(s);
            return;
          }
          setPendingInitialization({
            store: s,
            storageBackend: platform.backend,
            dataLocation: platform.dataLocation,
          });
          return;
        }
        const passphrase = storagePassphrase.current;
        if (passphrase) {
          try {
            if (browserLocalRecovery) await unlockExistingLedgerKeyForRecovery(s, passphrase);
            else await ensureLedgerKeyForStore(s, passphrase);
          } catch (ledgerKeyError) {
            const message = ledgerKeyError instanceof Error ? ledgerKeyError.message : String(ledgerKeyError);
            log.warn('ledger backup key was not unlocked with the device passphrase', { error: message });
            if (!browserLocalRecovery) {
              writeSafetyState({
                lastBackupErrorAt: new Date().toISOString(),
                lastBackupError: `账本备份密钥需要手动解锁：${message}`,
              });
            }
          } finally {
            storagePassphrase.current = null;
          }
        }
        if (!browserLocalRecovery) {
          await withSharedBrowserTaskLock('sync', async () => {
            await recoverAttachmentStorage(s);
            await runLedgerMaintenance(s);
            await runDueScheduledTransactions(s);
          });
        }
        if (await closeStoreWhenCancelled(s, () => cancelled)) {
          openedStore = null;
          return;
        }
        published = true;
        setStorageBackend(platform.backend);
        setDataLocation(platform.dataLocation);
        setLedgerKind(setting.ledgerKind ?? 'personal');
        setStore(s);
        if (!browserLocalRecovery) {
          void maybeAutoBackup(s)
            .then((entry) => {
              if (entry) writeSafetyState(successfulBackupSafetyPatch(entry));
            })
            .catch((backupError) => writeSafetyState({ lastBackupErrorAt: new Date().toISOString(), lastBackupError: backupError instanceof Error ? backupError.message : String(backupError) }));
        }
      } catch (e) {
        await closeOpenedStore().catch(() => undefined);
        if (!cancelled) {
          setError({
            message: e instanceof Error ? e.message : String(e),
            resetRequired: isInitializationResetRequiredError(e),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (published) void closeOpenedStore().catch(() => undefined);
    };
  }, [storageProtection?.unlocked, initializationAttempt, browserLocalRecovery, firstUseMode, storageDisposition, bestEffortAccepted]);

  useEffect(() => {
    if (!store || rev === 0 || browserLocalRecovery) return;
    void maybeAutoBackup(store)
      .then((entry) => {
        if (entry) writeSafetyState(successfulBackupSafetyPatch(entry));
      })
      .catch((backupError) => writeSafetyState({ lastBackupErrorAt: new Date().toISOString(), lastBackupError: backupError instanceof Error ? backupError.message : String(backupError) }));
  }, [store, rev, browserLocalRecovery]);

  useEffect(() => {
    if (!store || browserLocalRecovery) return;
    return store.subscribe((change) => {
      setRev((value) => value + 1);
      if (change.entityTypes.includes('setting') || change.entityTypes.includes('*')) {
        void refreshLedgerKindSafely(store, setLedgerKind);
      }
    });
  }, [store, browserLocalRecovery]);

  useEffect(() => {
    if (!store || browserLocalRecovery) return;
    let running = false;
    const execute = async () => {
      if (running) return;
      running = true;
      try {
        await runScheduledTransactionsSafely(store, () => setRev((value) => value + 1));
      } finally {
        running = false;
      }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') void execute(); };
    const onFocus = () => { void execute(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => void execute(), 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [store, browserLocalRecovery]);

  function resetDevelopmentData(requireConfirmation = true): Promise<void> {
    return resetStorageFlight(async () => {
      if (
        requireConfirmation
        &&
        !window.confirm(
          '将删除本机开发账本、附件、表单草稿和浏览器内备份。此操作不可撤销；只有浏览器外的 .zcbak 或服务器副本可用于恢复。确定继续吗？',
        )
      ) return;
      setResetting(true);
      try {
        await resetStoreLifecycle({
          stores: [store, pendingInitialization?.store],
          clearStores: () => {
            setStore(null);
            setPendingInitialization(null);
            storagePassphrase.current = null;
          },
          lockStorage: lockDeviceStorage,
          resetPlatform: resetPlatformData,
        });
        clearFirstUseMode();
        window.location.reload();
      } catch (reason) {
        setError({
          message: `重置失败：${reason instanceof Error ? reason.message : String(reason)}`,
          resetRequired: true,
        });
        setResetting(false);
      }
    });
  }

  function unlockStorage(password: string): Promise<void> {
    return unlockStorageFlight(async () => {
      setUnlockBusy(true);
      setUnlockError('');
      try {
        const pendingCredentials = runtimeCredentialMap();
        const unlocked = await unlockDeviceStorage(password);
        if (isTauriRuntime() && firstUseMode === 'server') {
          const connectionIds = loadSyncConnections().map((connection) => connection.id);
          await unlockCredentialVault(password, connectionIds);
          for (const [connectionId, credential] of Object.entries(pendingCredentials)) {
            if (credential.refreshToken) await persistCredential(connectionId, credential);
          }
        }
        storagePassphrase.current = password;
        setStorageProtection(unlocked.state);
      } catch (reason) {
        setUnlockError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setUnlockBusy(false);
      }
    });
  }

  async function retryInitialization() {
    const pending = pendingInitialization;
    if (pending) {
      try {
        await closeStoreOnce(pending.store);
      } catch (reason) {
        setError({
          message: `关闭上一次数据库连接失败：${reason instanceof Error ? reason.message : String(reason)}`,
          resetRequired: false,
        });
        return;
      }
    }
    setError(null);
    setPendingInitialization(null);
    setInitializationAttempt((attempt) => attempt + 1);
  }

  async function finishFirstRun(setting: Setting) {
    const pending = pendingInitialization;
    if (!pending) throw new Error('首次初始化上下文已经失效，请重新打开账本');
    try {
      const passphrase = storagePassphrase.current;
      if (!passphrase) throw new Error('账本密码会话已经失效，请返回解锁页后重试');
      await ensureLedgerKeyForStore(pending.store, passphrase);
      await withSharedBrowserTaskLock('sync', async () => {
        await recoverAttachmentStorage(pending.store);
        await runLedgerMaintenance(pending.store);
        await runDueScheduledTransactions(pending.store);
      });
      if (firstUseMode === 'server') {
        const connections = isTauriRuntime() ? mergeSharedSyncDirectory(
          loadSyncConnections(), await loadSharedSyncDirectory(pending.store),
        ) : loadSyncConnections();
        saveSyncConnections(connections);
        const enabledConnections = connections.filter((connection) => connection.enabled);
        if (!enabledConnections.length) throw new Error('服务器模式没有可用连接，请重新完成服务器登录');
        if (isTauriRuntime()) await saveSharedSyncDirectory(pending.store, connections);
        const syncResult = await syncConfiguredServers(pending.store, enabledConnections);
        const failed = syncResult.endpoints.filter((endpoint) => endpoint.error || endpoint.attachments?.error);
        if (failed.length) {
          throw new Error(`首次同步失败：${failed.map((endpoint) => `${endpoint.alias}：${endpoint.error ?? endpoint.attachments?.error}`).join('；')}`);
        }
      }
      setStorageBackend(pending.storageBackend);
      setDataLocation(pending.dataLocation);
      setLedgerKind(setting.ledgerKind ?? 'personal');
      setPendingInitialization(null);
      setStore(pending.store);
      storagePassphrase.current = null;
      void maybeAutoBackup(pending.store)
        .then((entry) => {
          if (entry) writeSafetyState(successfulBackupSafetyPatch(entry));
        })
        .catch((backupError) => writeSafetyState({ lastBackupErrorAt: new Date().toISOString(), lastBackupError: backupError instanceof Error ? backupError.message : String(backupError) }));
    } catch (reason) {
      setError({
        message: reason instanceof Error ? reason.message : String(reason),
        resetRequired: isInitializationResetRequiredError(reason),
      });
      throw reason;
    }
  }

  function returnToStorageUnlock(): Promise<void> {
    return storageLockFlight(async () => {
      setError(null);
      setUnlockError('');
      try {
        await closeStoresBeforeStorageLock(
          [store, pendingInitialization?.store],
          () => {
            setStore(null);
            setPendingInitialization(null);
            storagePassphrase.current = null;
          },
          lockDeviceStorage,
        );
        if (!isTauriRuntime() && firstUseMode === 'server') {
          // Browser accounts are unlocked by their authenticated account gate.
          // Returning to the legacy device-password form asks for the wrong secret.
          window.location.reload();
          return;
        }
        setStorageProtection(await refreshDeviceStorageState());
      } catch (reason) {
        setError({
          message: reason instanceof Error ? reason.message : '无法返回设备解锁页面',
          resetRequired: false,
        });
      }
    });
  }

  function reloadAfterPersistenceRestore() {
    window.location.reload();
  }

  function switchRecoveryToServerMode() {
    clearFirstUseMode();
    try {
      accountSessionStorage.setItem('zichan.retryScreen', 'sync');
    } catch {
      // Hardened browser contexts can reject session storage; the app still opens safely.
    }
    window.location.reload();
  }

  function restartFirstUseWithDifferentAccount() {
    if (!isTauriRuntime()) {
      void exitBrowserAccount().then(closeForAccountExit).catch((reason) => setError({ message: String(reason), resetRequired: false }));
      return;
    }
    clearSyncConfiguration();
    clearFirstUseMode();
    window.location.reload();
  }

  const closeForAccountExit = useCallback(async () => {
    await closeStoresBeforeStorageLock([store, pendingInitialization?.store], () => {
      setStore(null); setPendingInitialization(null); storagePassphrase.current = null;
    }, lockDeviceStorage);
    lockLedgerKey();
    window.location.reload();
  }, [store, pendingInitialization]);

  useEffect(() => {
    if (isTauriRuntime()) return;
    const onExit = (event: StorageEvent) => {
      if (event.key === accountStorageKey(ACCOUNT_EXIT_KEY) && event.newValue === 'pending') {
        clearCredentialVaultRuntimeState();
        void closeForAccountExit().catch((reason) => setError({ message: String(reason), resetRequired: false }));
      }
    };
    const lockAccount = () => {
      clearCredentialVaultRuntimeState();
      void closeForAccountExit().catch((reason) => setError({ message: String(reason), resetRequired: false }));
    };
    window.addEventListener('storage', onExit);
    window.addEventListener(ACCOUNT_LOCK_REQUEST_EVENT, lockAccount);
    setAccountCloseHandlerMounted(true);
    return () => { setAccountCloseHandlerMounted(false); window.removeEventListener('storage', onExit); window.removeEventListener(ACCOUNT_LOCK_REQUEST_EVENT, lockAccount); };
  }, [closeForAccountExit]);

  if (!storageProtection) return <Splash label={unlockError || '正在检查本机加密存储…'} />;
  if (!firstUseMode) {
    if (serverSetupRequested || !isTauriRuntime()) {
      return <FirstServerConnectionGate accountOnly={!isTauriRuntime()} onReady={finishFirstServerConnection} onCancel={() => { setServerSetupRequested(false); setModeError(''); }} />;
    }
    return <FirstUseModeGate busy={modeBusy} error={modeError} onSelect={selectFirstUseMode} persistence={browserPersistence} onContinueLocal={() => selectFirstUseMode('local', true)} />;
  }
  if (storageDisposition === 'pending' && firstUseMode === 'local' && !isTauriRuntime()) {
    return <Splash label="正在确认浏览器持久存储…" />;
  }
  if (storageDisposition === 'blocked') {
    return (
      <FirstUseModeGate
        busy={modeBusy}
        error={modeError || browserPersistence.reason || '浏览器没有授予持久存储权限'}
        onSelect={selectFirstUseMode}
        persistence={browserPersistence}
        onContinueLocal={() => selectFirstUseMode('local', true)}
      />
    );
  }
  if (!storageProtection.unlocked) {
    if (isTauriRuntime() && firstUseMode === 'server') return <NativeAccountGate onReady={async () => {
      storagePassphrase.current = accountProtection()?.secret ?? null;
      setStorageProtection(await refreshDeviceStorageState());
    }} onCancel={() => { clearFirstUseMode(); setFirstUseMode(null); }} />;
    if (!isTauriRuntime() && firstUseMode === 'server') return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)', color: 'var(--text-primary)' }}>
        <div style={{ width: 'min(420px, 100%)', padding: 24, border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <h1 style={{ fontSize: 'var(--fs-heading)' }}>重新验证账号</h1>
          <p>此网站的账本由账号登录流程解锁。请重新打开账本，无需输入另一套本机密码。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button type="button" className="zc-btn zc-btn--primary" onClick={() => window.location.reload()}>重新打开账本</button>
            <button type="button" className="zc-btn" onClick={() => void exitBrowserAccount().then(closeForAccountExit).catch((reason) => setUnlockError(String(reason)))}>退出并切换账号</button>
          </div>
          {unlockError && <p role="alert">{unlockError}</p>}
        </div>
      </div>
    );
    return (
      <>
      {!isTauriRuntime() && <div style={{ padding: 12, background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between' }}><span>当前账号：{loadSyncConnections()[0]?.username}</span><button disabled={unlockBusy || resetting} onClick={() => void exitBrowserAccount().then(closeForAccountExit).catch((reason) => setUnlockError(String(reason)))}>退出并切换账号</button></div>}
      <DeviceStorageGate
        state={storageProtection}
        busy={unlockBusy || resetting}
        error={unlockError}
        onUnlock={unlockStorage}
        onReset={resetDevelopmentData}
      />
      </>
    );
  }
  if (error) {
    const diagnostic = initializationDiagnostic;
    const copyInitializationDiagnostic = async () => {
      try {
        await copyTextToClipboard(diagnostic);
        setErrorCopyStatus('copied');
      } catch {
        setErrorCopyStatus('failed');
      }
    };
    return (
      <div style={{ minHeight: '100dvh', padding: 40, fontFamily: 'system-ui, sans-serif', background: 'var(--bg)', color: 'var(--text-primary)' }}>
        <div style={{ maxWidth: 720, margin: '10vh auto 0' }}>
          <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>数据库初始化失败</div>
          <label style={{ display: 'block', marginTop: 12, fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>
            错误详情（可选择后按 Ctrl+C 复制）
            <textarea
              readOnly
              value={diagnostic}
              aria-label="数据库初始化错误详情"
              onFocus={(event) => event.currentTarget.select()}
              spellCheck={false}
              style={{ display: 'block', boxSizing: 'border-box', width: '100%', minHeight: 156, maxHeight: '42dvh', marginTop: 8, padding: 12, border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', color: 'var(--text-primary)', fontFamily: 'ui-monospace, monospace', fontSize: 'var(--fs-body)', lineHeight: 1.5, resize: 'vertical', overflow: 'auto', userSelect: 'text', WebkitUserSelect: 'text' }}
            />
          </label>
          {error.resetRequired ? (
            <div style={{ marginTop: 12 }}>
              旧数据尚未被修改。请先确认已有浏览器外的 .zcbak 备份或服务器副本，再执行重置。
            </div>
          ) : null}
          <div style={{ marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {error.resetRequired && (
              <button
                type="button"
                disabled={resetting}
                onClick={() => void resetDevelopmentData()}
                style={{ minHeight: 44, padding: '0 16px', border: 0, borderRadius: 'var(--r-sm)', background: 'var(--negative)', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)' }}
              >
                {resetting ? '正在重置…' : '重置本机开发数据'}
              </button>
            )}
            <button
              type="button"
              disabled={resetting}
              onClick={retryInitialization}
              style={{ minHeight: 44, padding: '0 16px', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', color: 'var(--text-primary)', fontWeight: 'var(--fw-bold)' }}
            >
              重新尝试
            </button>
            <button
              type="button"
              disabled={resetting}
              onClick={() => void copyInitializationDiagnostic()}
              style={{ minHeight: 44, padding: '0 16px', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', color: 'var(--text-primary)', fontWeight: 'var(--fw-bold)' }}
            >
              {errorCopyStatus === 'copied' ? '已复制诊断信息' : '复制诊断信息'}
            </button>
            <button
              type="button"
              disabled={resetting}
              onClick={() => void returnToStorageUnlock()}
              style={{ minHeight: 44, padding: '0 16px', border: 0, borderRadius: 'var(--r-sm)', background: 'transparent', color: 'var(--text-primary)', fontWeight: 'var(--fw-bold)' }}
            >
              {!isTauriRuntime() && firstUseMode === 'server' ? '重新验证账号' : '返回解锁'}
            </button>
          </div>
          {errorCopyStatus !== 'idle' && (
            <div role="status" aria-live="polite" style={{ marginTop: 12, fontSize: 'var(--fs-body)' }}>
              {errorCopyStatus === 'copied'
                ? '诊断信息已复制。'
                : '自动复制失败。点击错误详情后按 Ctrl+A、Ctrl+C 可手动复制。'}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (pendingInitialization) {
    const boundConnection = firstUseMode === 'server'
      ? loadSyncConnections().find((connection) => Boolean(connection.enabled && connection.ledgerId
        && !(accountProtection()?.profileId === connection.id
          && accountProtection()?.info.replica?.headSeq === 0)))
      : undefined;
    if (boundConnection) {
      return (
        <FirstRemoteLedgerRestoreGate
          store={pendingInitialization.store}
          connection={boundConnection}
          onRestored={finishFirstRun}
          onStartNew={async () => {
            const passphrase = storagePassphrase.current;
            if (!passphrase) throw new Error('账本密码会话已失效，请返回解锁页重试');
            const setting = await replaceRemoteLedger(pendingInitialization.store, boundConnection, passphrase);
            await finishFirstRun(setting);
          }}
          onUseDifferentAccount={restartFirstUseWithDifferentAccount}
        />
      );
    }
    return <FirstRunWizard store={pendingInitialization.store} onInitialized={finishFirstRun} />;
  }
  if (!store) return <Splash label="正在加载账本…" />;
  if (browserLocalRecovery) {
    return (
      <BrowserStorageRecoveryGate
        store={store}
        reason={browserPersistence.reason || '浏览器没有授予持久存储权限'}
        onPersistenceRestored={reloadAfterPersistenceRestore}
        onUseServer={switchRecoveryToServerMode}
        onContinueLocal={async () => {
          if (!browserLocalCapability().supported) throw new Error('本地存储能力不可用，不能继续写入');
          acceptBestEffortStorage();
          window.location.reload();
        }}
      />
    );
  }

  return (
      <Ctx.Provider value={{
        store,
        rev,
        bump: () => setRev((n) => n + 1),
        storageBackend,
        dataLocation,
        firstUseMode,
        browserStoragePersistent: isTauriRuntime() || browserPersistence.persisted,
        resetLocalData: () => resetDevelopmentData(false),
        exitAccount: !isTauriRuntime() && firstUseMode === 'server' ? async () => {
          await exitBrowserAccount();
          await closeForAccountExit();
        } : undefined,
      }}>
      {ledgerKind === 'demo' && (
        <div
          role="status"
          aria-label="当前是演示账本"
          style={{ position: 'fixed', top: 8, left: '50%', zIndex: 10000, transform: 'translateX(-50%)', border: '1px solid var(--warning)', borderRadius: 'var(--r-pill)', padding: '4px 10px', background: 'var(--warn-surface)', color: 'var(--warning)', boxShadow: 'var(--shadow-md)', fontFamily: 'system-ui, sans-serif', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', pointerEvents: 'none' }}
        >
          演示账本
        </div>
      )}
      {!isTauriRuntime() && firstUseMode === 'local' && !browserPersistence.persisted && (
        <div role="status" style={{ padding: 10, background: 'var(--warn-surface)', color: 'var(--text-primary)', fontSize: 'var(--fs-body)' }}>
          普通本地存储：未获得防自动清理保护。请使用“导出”保存浏览器外加密备份；不要清除本站数据或在无痕窗口保存重要账本。
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}

export function useStore(): StoreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStore must be used within <StoreProvider>');
  return c;
}
