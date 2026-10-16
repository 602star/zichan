import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loginAccount, registerAccount, type LedgerBackup } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import type { SyncServer } from '../../sync-server/src/server.js';
import { createTestSyncServer as createSyncServer, OWNER_SETUP_TOKEN } from '../../sync-server/test/support/server-fixture.js';
import {
  BackupPassphraseRequiredError,
  createEncryptedBackupContainer,
  downloadBackup,
  externalBackupStatus,
  maybeAutoBackup,
  openBackupContainer,
  openVerifiedSavedBackup,
  parseEncryptedBackup,
  saveLedgerBackup,
  suspendAutomaticBackups,
  type BackupPayload,
  type SavedBackup,
} from '../src/db/backups.js';
import { initializeLedgerKey, lockLedgerKey, updateLedgerPassphrase } from '../src/ledger-key-vault.js';
import { setRuntimeCredential } from '../src/credential-vault.js';
import {
  downloadRemoteBackup,
  listRemoteBackups,
  saveEncryptedBackupToSyncServers,
} from '../src/remote-backup.js';
import { saveSyncConnections, type SyncConnection } from '../src/sync-config.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const emptyLedger: LedgerBackup = {
  version: 7,
  exportedAt: '2026-07-22T00:00:00.000Z',
  chains: [],
  assets: [],
  accounts: [],
  settings: [],
  lots: [],
  lotConsumptions: [],
  priceMarks: [],
  dcaPlans: [],
  dcaExecutions: [],
  games: [],
  gameAccounts: [],
  gameSeasons: [],
  gameRecords: [],
  gameCashflowLinks: [],
  fixedAssets: [],
  fixedAssetCategories: [],
  fixedAssetEvents: [],
  fixedAssetCashflowLinks: [],
  fixedAssetUsageMetrics: [],
  fixedAssetUsageLogs: [],
  fixedAssetConsumables: [],
  fixedAssetGoals: [],
  attachments: [],
  categories: [],
  transactionTags: [],
  transactionLocations: [],
  transactionTemplates: [],
  transactionSavedViews: [],
  payees: [],
  transactions: [],
  transactionSplits: [],
  refundAllocations: [],
  budgetCategories: [],
  scheduledTransactions: [],
  scheduledExecutions: [],
  reconciliationSessions: [],
  reconciliationItems: [],
};

const payload: BackupPayload = {
  version: 2,
  kind: 'portable',
  ledger: emptyLedger,
};

async function listen(server: SyncServer): Promise<string> {
  await new Promise<void>((resolve) => server.server.listen(0, resolve));
  return `http://localhost:${(server.server.address() as AddressInfo).port}`;
}

async function replaceArchiveHeaderText(blob: Blob, from: string, to: string): Promise<Blob> {
  if (from.length !== to.length) throw new Error('test replacement must preserve archive length');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const source = new TextEncoder().encode(from);
  const replacement = new TextEncoder().encode(to);
  let found = -1;
  for (let offset = 0; offset <= bytes.length - source.length; offset += 1) {
    if (source.every((value, index) => bytes[offset + index] === value)) {
      found = offset;
      break;
    }
  }
  if (found < 0) throw new Error('test header text was not found');
  bytes.set(replacement, found);
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: blob.type });
}

describe('encrypted backup archives', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
    lockLedgerKey();
  });

  afterEach(() => {
    lockLedgerKey();
    Reflect.deleteProperty(globalThis, 'localStorage');
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('recovers a binary archive and passphrase without device-local key state', async () => {
    await initializeLedgerKey('ledger-backup-test-1234', 'backup-password');
    const created = await createEncryptedBackupContainer(payload, 'manual', 'self-contained');

    lockLedgerKey();
    globalThis.localStorage.clear();
    await expect(openBackupContainer(created.blob)).rejects.toBeInstanceOf(BackupPassphraseRequiredError);

    const opened = await parseEncryptedBackup(created.blob, 'backup-password');
    expect(opened.payload).toEqual(payload);
    expect(opened.session.ledgerId).toBe(created.header.ledgerId);
    expect(opened.container.keyEnvelope.keyringId).toBe(created.header.keyringId);
    expect(opened.usedCurrentSession).toBe(false);
  });

  it('authenticates frame data and archive header metadata', async () => {
    await initializeLedgerKey('ledger-backup-test-5678', 'backup-password');
    const created = await createEncryptedBackupContainer(payload, 'manual', 'original');
    lockLedgerKey();

    await expect(openBackupContainer(created.blob, 'wrong-password')).rejects.toThrow('密码错误');
    const tampered = await replaceArchiveHeaderText(created.blob, 'original', 'tampered');
    await expect(openBackupContainer(tampered, 'backup-password')).rejects.toBeTruthy();
  });

  it('streams a native backup through bounded append commands and verifies the disk header', async () => {
    await initializeLedgerKey('ledger-backup-stream-1234', 'backup-password');
    let bytes: number[] = [];
    const commands: string[] = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      commands.push(command);
      if (command === 'desktop_begin_backup_write') {
        expect(Number(args?.['estimatedSizeBytes'])).toBeGreaterThan(0);
        bytes = [];
        return undefined as T;
      }
      if (command === 'desktop_append_backup_chunk') {
        const chunk = args?.['chunk'] as number[];
        expect(chunk.length).toBeLessThanOrEqual(512 * 1024);
        bytes = bytes.concat(chunk);
        return undefined as T;
      }
      if (command === 'desktop_commit_backup_write') {
        expect(args?.['expectedSizeBytes']).toBe(bytes.length);
        return { path: 'C:/backups/stream.zcbak' } as T;
      }
      if (command === 'desktop_read_backup_chunk') {
        const offset = Number(args?.['offset']);
        return bytes.slice(offset, offset + Number(args?.['length'])) as T;
      }
      if (command === 'desktop_list_backup_files') return [] as T;
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke }, dispatchEvent: () => true },
    });

    const store = await openLedger({ deviceId: 'native-stream-backup' });
    try {
      const saved = await saveLedgerBackup(store, 'manual', 'streamed', 'portable');
      expect(saved.archive).toBeUndefined();
      expect(saved.sizeBytes).toBe(bytes.length);
      expect(saved.localPath).toBe('C:/backups/stream.zcbak');
      expect(saved.externalSaved).toBe(false);
      expect(saved.externalPath).toBeUndefined();
      expect(saved.externalError).toContain('便携目录 data/backups');
      expect(commands).toContain('desktop_append_backup_chunk');
      expect(commands).toContain('desktop_read_backup_chunk');
      const opened = await parseEncryptedBackup(new Blob([
        new Uint8Array(bytes).buffer,
      ]));
      expect(opened.payload.ledger.version).toBe(7);
      expect(opened.container.version).toBe(4);
    } finally {
      await store.close();
    }
  });

  it('uploads, catalogs, downloads, and verifies an encrypted browser backup on a sync server', async () => {
    const ledgerId = 'ledger-remote-backup-1234';
    const password = 'remote-backup-password';
    const username = 'remote-backup-user';
    await initializeLedgerKey(ledgerId, 'ledger-backup-passphrase');
    const created = await createEncryptedBackupContainer(payload, 'manual', 'remote-roundtrip');
    const server = createSyncServer();
    const baseUrl = await listen(server);
    try {
      const health = await fetch(`${baseUrl}/api/health`, { redirect: 'error' })
        .then((response) => response.json()) as { serverId: string; serverPublicKey: string };
      await registerAccount(baseUrl, username, password, {
        ownerSetupToken: OWNER_SETUP_TOKEN,
        expectedServerId: health.serverId,
        expectedServerPublicKey: health.serverPublicKey,
      });
      const session = await loginAccount(baseUrl, username, password, {
        deviceId: 'remote-backup-test-device',
        deviceName: 'Remote backup test',
        expectedServerId: health.serverId,
        expectedServerPublicKey: health.serverPublicKey,
      });
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
      };
      expect((await fetch(baseUrl + '/api/v3/replica/bind', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ledgerId }),
      })).status).toBe(200);
      const profile: SyncConnection = {
        id: 'remote-backup-profile',
        serverRef: 'remote-backup-profile',
        alias: '备份服务器',
        baseUrl,
        activeUrl: baseUrl,
        alternateUrls: [],
        sharedUrls: [],
        deviceUrls: [baseUrl],
        username,
        enabled: true,
        status: 'online',
        serverId: health.serverId,
        serverPublicKey: health.serverPublicKey,
        ledgerId,
      };
      saveSyncConnections([profile]);
      setRuntimeCredential(profile.id, {
        password,
        inviteCode: '',
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        accessExpiresAt: session.accessExpiresAt,
        sessionId: session.session.id,
      }, false);

      expect(await saveEncryptedBackupToSyncServers(created.header, created.blob)).toEqual([
        expect.objectContaining({
          profileId: profile.id,
          saved: true,
          archiveId: created.header.archiveId,
        }),
      ]);
      // A completed upload may be retried after a client-side timeout. Its
      // manifest must remain byte-for-byte stable for server idempotency.
      expect(await saveEncryptedBackupToSyncServers(created.header, created.blob)).toEqual([
        expect.objectContaining({
          profileId: profile.id,
          saved: true,
          archiveId: created.header.archiveId,
        }),
      ]);
      const remote = await listRemoteBackups(profile);
      expect(remote).toEqual([
        expect.objectContaining({
          archiveId: created.header.archiveId,
          ledgerId,
          sizeBytes: created.blob.size,
        }),
      ]);
      const downloaded = await downloadRemoteBackup(profile, remote[0]!);
      lockLedgerKey();
      const opened = await parseEncryptedBackup(downloaded, 'ledger-backup-passphrase');
      expect(opened.payload).toEqual(payload);
    } finally {
      await server.close();
    }
  });

  it('asks the portable desktop to save an existing archive outside data instead of using a WebView download', async () => {
    await initializeLedgerKey('ledger-native-save-as-1234', 'backup-password');
    const created = await createEncryptedBackupContainer(payload, 'manual', 'native-save-as');
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      commands.push({ command, args });
      if (command === 'desktop_export_backup_file') return { path: 'F:/safe-copy/native-save-as.zcbak' } as T;
      throw new Error(`unexpected command ${command}`);
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke } },
    });
    const entry: SavedBackup = {
      id: created.header.archiveId,
      createdAt: created.header.createdAt,
      reason: created.header.reason,
      label: created.header.label,
      kind: created.header.kind,
      tier: 'pinned',
      pinned: true,
      container: created.header,
      nativeFileName: 'native-save-as.zcbak',
      preflight: { ok: true, issues: [], summary: { entities: 0, chains: 0, steps: 0, byType: {} } },
      checksum: created.header.ledgerSha256,
      sizeBytes: created.blob.size,
    };

    await expect(downloadBackup(entry)).resolves.toBe('downloaded');
    expect(commands).toEqual([{
      command: 'desktop_export_backup_file',
      args: { fileName: 'native-save-as.zcbak' },
    }]);
  });

  it('keeps the local archive intact when portable Save As is cancelled', async () => {
    await initializeLedgerKey('ledger-native-cancel-1234', 'backup-password');
    const created = await createEncryptedBackupContainer(payload, 'manual', 'native-cancel');
    const invoke = async <T>(command: string): Promise<T> => {
      if (command === 'desktop_export_backup_file') return null as T;
      throw new Error(`unexpected command ${command}`);
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke } },
    });
    const entry: SavedBackup = {
      id: created.header.archiveId,
      createdAt: created.header.createdAt,
      reason: created.header.reason,
      label: created.header.label,
      kind: created.header.kind,
      tier: 'pinned',
      pinned: true,
      container: created.header,
      nativeFileName: 'native-cancel.zcbak',
      preflight: { ok: true, issues: [], summary: { entities: 0, chains: 0, steps: 0, byType: {} } },
      checksum: created.header.ledgerSha256,
      sizeBytes: created.blob.size,
    };

    await expect(downloadBackup(entry)).resolves.toBe('cancelled');
  });

  it('prompts for and accepts the creation-time password after the local key envelope changes', async () => {
    await initializeLedgerKey('ledger-old-backup-key-1234', 'original-password');
    const created = await createEncryptedBackupContainer(payload, 'manual', 'older generation');
    await updateLedgerPassphrase('current-password');
    const entry: SavedBackup = {
      id: created.header.archiveId,
      createdAt: created.header.createdAt,
      reason: created.header.reason,
      label: created.header.label,
      kind: created.header.kind,
      tier: 'pinned',
      pinned: true,
      container: created.header,
      archive: created.blob,
      preflight: { ok: true, issues: [], summary: { entities: 0, chains: 0, steps: 0, byType: {} } },
      checksum: created.header.ledgerSha256,
      sizeBytes: created.blob.size,
    };

    await expect(openVerifiedSavedBackup(entry)).rejects.toBeInstanceOf(BackupPassphraseRequiredError);
    await expect(openVerifiedSavedBackup(entry, 'wrong-password')).rejects.toThrow('密码错误');
    const opened = await openVerifiedSavedBackup(entry, 'original-password');
    expect(opened.payload).toEqual(payload);
    expect(opened.usedCurrentSession).toBe(false);
  });

  it('commits a portable desktop backup before uploading it through bounded native reads', async () => {
    const password = 'portable-remote-password';
    const username = 'portable-remote-user';
    const server = createSyncServer();
    const baseUrl = await listen(server);
    const store = await openLedger({ deviceId: 'portable-remote-backup-device' });
    let committed = false;
    let sizeBytes = 0;
    const storedChunks: Uint8Array[] = [];
    const readLengths: number[] = [];

    function readStored(offset: number, length: number): number[] {
      if (!committed) throw new Error('backup was read before its local commit');
      const result = new Uint8Array(length);
      let sourceOffset = 0;
      let targetOffset = 0;
      for (const chunk of storedChunks) {
        const chunkEnd = sourceOffset + chunk.byteLength;
        if (chunkEnd > offset && sourceOffset < offset + length) {
          const from = Math.max(0, offset - sourceOffset);
          const to = Math.min(chunk.byteLength, offset + length - sourceOffset);
          result.set(chunk.subarray(from, to), targetOffset);
          targetOffset += to - from;
        }
        sourceOffset = chunkEnd;
        if (targetOffset === length) break;
      }
      if (targetOffset !== length) throw new Error(`test backup read was truncated at ${targetOffset}/${length}`);
      return Array.from(result);
    }

    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'desktop_begin_backup_write') {
        committed = false;
        sizeBytes = 0;
        storedChunks.length = 0;
        return undefined as T;
      }
      if (command === 'desktop_append_backup_chunk') {
        const chunk = Uint8Array.from(args?.['chunk'] as number[]);
        expect(chunk.byteLength).toBeLessThanOrEqual(512 * 1024);
        storedChunks.push(chunk);
        sizeBytes += chunk.byteLength;
        return undefined as T;
      }
      if (command === 'desktop_commit_backup_write') {
        expect(args?.['expectedSizeBytes']).toBe(sizeBytes);
        committed = true;
        return { path: 'D:/portable/data/backups/remote.zcbak' } as T;
      }
      if (command === 'desktop_read_backup_chunk') {
        const length = Number(args?.['length']);
        readLengths.push(length);
        expect(length).toBeLessThanOrEqual(512 * 1024);
        return readStored(Number(args?.['offset']), length) as T;
      }
      if (command === 'desktop_list_backup_files') return [] as T;
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke }, dispatchEvent: () => true },
    });

    try {
      const ledgerId = await store.getLedgerId();
      await initializeLedgerKey(ledgerId, 'portable-ledger-key-password');
      await store.assets.put({
        id: 'large-portable-backup-asset',
        code: 'LARGE',
        name: 'x'.repeat(4 * 1024 * 1024 + 128 * 1024),
        type: 'fiat',
        decimals: 2,
        isActive: true,
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
        version: 1,
        isDeleted: false,
      } as never);
      const health = await fetch(`${baseUrl}/api/health`, { redirect: 'error' })
        .then((response) => response.json()) as { serverId: string; serverPublicKey: string };
      await registerAccount(baseUrl, username, password, {
        ownerSetupToken: OWNER_SETUP_TOKEN,
        expectedServerId: health.serverId,
        expectedServerPublicKey: health.serverPublicKey,
      });
      const session = await loginAccount(baseUrl, username, password, {
        deviceId: 'portable-remote-backup-login',
        deviceName: 'Portable remote backup test',
        expectedServerId: health.serverId,
        expectedServerPublicKey: health.serverPublicKey,
      });
      expect((await fetch(baseUrl + '/api/v3/replica/bind', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({ ledgerId }),
      })).status).toBe(200);
      const profile: SyncConnection = {
        id: 'portable-remote-backup-profile',
        serverRef: 'portable-remote-backup-profile',
        alias: '便携备份服务器',
        baseUrl,
        activeUrl: baseUrl,
        alternateUrls: [],
        sharedUrls: [],
        deviceUrls: [baseUrl],
        username,
        enabled: true,
        status: 'online',
        serverId: health.serverId,
        serverPublicKey: health.serverPublicKey,
        ledgerId,
      };
      saveSyncConnections([profile]);
      setRuntimeCredential(profile.id, {
        password: '',
        inviteCode: '',
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        accessExpiresAt: session.accessExpiresAt,
        sessionId: session.session.id,
      }, false);

      const saved = await saveLedgerBackup(store, 'manual', '便携远端备份', 'portable');

      expect(committed).toBe(true);
      expect(sizeBytes).toBeGreaterThan(4 * 1024 * 1024);
      expect(readLengths.length).toBeGreaterThan(8);
      expect(Math.max(...readLengths)).toBeLessThanOrEqual(512 * 1024);
      expect(saved.localPath).toBe('D:/portable/data/backups/remote.zcbak');
      expect(saved.externalSaved).toBe(true);
      expect(saved.externalPath).toBe('同步服务器：便携备份服务器');
      expect(saved.remoteCopies).toEqual([
        expect.objectContaining({ profileId: profile.id, saved: true }),
      ]);
      await expect(listRemoteBackups(profile)).resolves.toEqual([
        expect.objectContaining({ archiveId: saved.container.archiveId, sizeBytes }),
      ]);
    } finally {
      await store.close();
      await server.close();
    }
  }, 20_000);

  it('keeps the committed portable backup when an enabled remote target is unavailable', async () => {
    const store = await openLedger({ deviceId: 'portable-local-fallback-device' });
    let bytes: number[] = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'desktop_begin_backup_write') bytes = [];
      if (command === 'desktop_append_backup_chunk') bytes.push(...args?.['chunk'] as number[]);
      if (command === 'desktop_commit_backup_write') return { path: 'E:/portable/data/backups/local.zcbak' } as T;
      if (command === 'desktop_read_backup_chunk') {
        const offset = Number(args?.['offset']);
        return bytes.slice(offset, offset + Number(args?.['length'])) as T;
      }
      if (command === 'desktop_list_backup_files') return [] as T;
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke }, dispatchEvent: () => true },
    });

    try {
      const ledgerId = await store.getLedgerId();
      await initializeLedgerKey(ledgerId, 'portable-local-fallback-key');
      saveSyncConnections([{
        id: 'unavailable-portable-backup-profile',
        serverRef: 'unavailable-portable-backup-profile',
        alias: '未连接服务器',
        baseUrl: 'http://localhost:8787',
        activeUrl: 'http://localhost:8787',
        alternateUrls: [],
        sharedUrls: [],
        deviceUrls: ['http://localhost:8787'],
        username: 'backup-user',
        enabled: true,
        status: 'unchecked',
        ledgerId,
      }]);

      const saved = await saveLedgerBackup(store, 'manual', '本地恢复点', 'portable');

      expect(saved.localPath).toBe('E:/portable/data/backups/local.zcbak');
      expect(saved.sizeBytes).toBe(bytes.length);
      expect(saved.externalSaved).toBe(false);
      expect(saved.externalError).toContain('未连接服务器：尚未识别服务器 ID');
      expect(saved.remoteCopies).toEqual([
        expect.objectContaining({
          profileId: 'unavailable-portable-backup-profile',
          saved: false,
        }),
      ]);
    } finally {
      await store.close();
    }
  });

  it('deduplicates concurrent automatic backups for one store', async () => {
    await initializeLedgerKey('ledger-auto-backup-1234', 'backup-password');
    let bytes: number[] = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'desktop_list_backup_files') return [] as T;
      if (command === 'desktop_begin_backup_write') {
        bytes = [];
        return undefined as T;
      }
      if (command === 'desktop_append_backup_chunk') {
        bytes.push(...args?.['chunk'] as number[]);
        return undefined as T;
      }
      if (command === 'desktop_commit_backup_write') {
        return { path: 'C:/backups/auto.zcbak' } as T;
      }
      if (command === 'desktop_read_backup_chunk') {
        const offset = Number(args?.['offset']);
        return bytes.slice(offset, offset + Number(args?.['length'])) as T;
      }
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke }, dispatchEvent: () => true },
    });
    const store = await openLedger({ deviceId: 'automatic-backup-single-flight' });
    try {
      const first = maybeAutoBackup(store);
      const second = maybeAutoBackup(store);
      expect(second).toBe(first);
      const saved = await first;
      expect(saved?.reason).toBe('auto');
      expect(bytes.length).toBeGreaterThan(128);
    } finally {
      await store.close();
    }
  });

  it('describes the portable desktop backup directory as local rather than independent', async () => {
    const invoke = async <T>(command: string): Promise<T> => {
      if (command === 'desktop_backup_status') {
        return {
          directory: 'D:/portable/data/backups',
          availableBytes: 1024 * 1024,
        } as T;
      }
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke }, dispatchEvent: () => true },
    });

    await expect(externalBackupStatus()).resolves.toEqual({
      kind: 'portable',
      configured: false,
      label: 'D:/portable/data/backups（便携目录内，非独立副本）',
    });
  });

  it('describes installed desktop backups as user-local recovery points', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke: async () => ({
        mode: 'installed',
        directory: 'C:/Users/Alice/AppData/Local/com.zichan.ledger/backups',
        availableBytes: 1024 * 1024,
      }) } },
    });
    await expect(externalBackupStatus()).resolves.toEqual({
      kind: 'portable',
      desktopMode: 'installed',
      configured: false,
      label: 'C:/Users/Alice/AppData/Local/com.zichan.ledger/backups（当前用户数据目录内，非独立副本）',
    });
  });

  it('blocks new automatic backups and drains an existing flight before reset continues', async () => {
    await initializeLedgerKey('ledger-auto-backup-drain-1234', 'backup-password');
    let releaseCommit!: () => void;
    let markCommitStarted!: () => void;
    const commitMayFinish = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const commitStarted = new Promise<void>((resolve) => { markCommitStarted = resolve; });
    let bytes: number[] = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'desktop_list_backup_files') return [] as T;
      if (command === 'desktop_begin_backup_write') bytes = [];
      if (command === 'desktop_append_backup_chunk') bytes.push(...args?.['chunk'] as number[]);
      if (command === 'desktop_commit_backup_write') {
        markCommitStarted();
        await commitMayFinish;
        return { path: 'C:/backups/drain.zcbak' } as T;
      }
      if (command === 'desktop_read_backup_chunk') {
        const offset = Number(args?.['offset']);
        return bytes.slice(offset, offset + Number(args?.['length'])) as T;
      }
      return undefined as T;
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke }, dispatchEvent: () => true },
    });
    const store = await openLedger({ deviceId: 'automatic-backup-drain' });
    const flight = maybeAutoBackup(store);
    await commitStarted;
    const suspension = suspendAutomaticBackups();
    try {
      await expect(maybeAutoBackup(store)).resolves.toBeNull();
      let drained = false;
      const drain = suspension.drain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      releaseCommit();
      await flight;
      await drain;
      expect(drained).toBe(true);
    } finally {
      releaseCommit();
      suspension.resume();
      await flight.catch(() => undefined);
      await store.close();
    }
  });

  it('honors cancellation before preparing an archive', async () => {
    await initializeLedgerKey('ledger-cancel-backup-1234', 'backup-password');
    const controller = new AbortController();
    controller.abort();
    await expect(createEncryptedBackupContainer(
      payload,
      'manual',
      'cancelled',
      new Date().toISOString(),
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
  });
});
