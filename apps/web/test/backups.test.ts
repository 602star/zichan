import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loginAccount, registerAccount, type LedgerBackup } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { createSyncServer, type SyncServer } from '../../sync-server/src/server.js';
import {
  BackupPassphraseRequiredError,
  createEncryptedBackupContainer,
  maybeAutoBackup,
  openBackupContainer,
  parseEncryptedBackup,
  saveLedgerBackup,
  suspendAutomaticBackups,
  type BackupPayload,
} from '../src/db/backups.js';
import { initializeLedgerKey, lockLedgerKey } from '../src/ledger-key-vault.js';
import { setRuntimeCredential } from '../src/credential-vault.js';
import {
  downloadRemoteBackup,
  listRemoteBackups,
  saveEncryptedBackupToSyncServers,
} from '../src/remote-backup.js';
import { saveSyncProfiles, type SyncServerProfile } from '../src/sync-config.js';

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
    lockLedgerKey();
  });

  afterEach(() => {
    lockLedgerKey();
    Reflect.deleteProperty(globalThis, 'localStorage');
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
      await registerAccount(baseUrl, username, password);
      const session = await loginAccount(baseUrl, username, password, {
        deviceId: 'remote-backup-test-device',
        deviceName: 'Remote backup test',
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
      const parsed = new URL(baseUrl);
      const profile: SyncServerProfile = {
        id: 'remote-backup-profile',
        alias: '备份服务器',
        protocol: 'http',
        host: parsed.hostname,
        port: parsed.port,
        basePath: '',
        username,
        enabled: true,
        serverId: 'remote-backup-server',
        ledgerId,
      };
      saveSyncProfiles([profile]);
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
