import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { listSavedBackups, recordLocalBackupVerification, removeLocalBackup, type SavedBackup } from '../src/db/backups.js';
import { loadBrowserBackupRecords, putBrowserBackupRecord } from '../src/db/browser-backup-storage.js';
import { deleteWebDatabase, loadKv, openIdb, saveKv } from '../src/db/idb.js';

function backup(id: string, preflightKnown: boolean): SavedBackup {
  const ledgerId = 'ledger-local-backup-test';
  const keyringId = 'keyring-local-backup-test';
  return {
    id,
    createdAt: `2026-10-20T00:00:0${id.length}.000Z`,
    reason: 'manual',
    label: id,
    kind: 'portable',
    tier: 'pinned',
    pinned: true,
    archive: new Blob(['backup']),
    sizeBytes: 6,
    preflightKnown,
    preflight: { ok: true, issues: [], summary: { entities: 0, chains: 0, steps: 0, byType: {} } },
    checksum: 'a'.repeat(64),
    container: {
      format: 'zichan-encrypted-archive', version: 4, encoding: 'ndjson-v1',
      archiveId: id, kind: 'portable', reason: 'manual', createdAt: '2026-10-20T00:00:00.000Z', label: id,
      ledgerId, keyringId,
      keyEnvelope: { v: 1, kdf: 'argon2id', ledgerId, keyringId, generation: 1, salt: '', memoryKiB: 1, iterations: 1, parallelism: 1, iv: '', ct: '' },
      chunkSizeBytes: 1024 * 1024, frameCount: 2, ledgerFrameCount: 1, ledgerSizeBytes: 0,
      ledgerSha256: 'a'.repeat(64),
    } as SavedBackup['container'],
  };
}

describe('browser local backup deletion', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  async function seed(...rows: SavedBackup[]): Promise<void> {
    for (const row of rows) await putBrowserBackupRecord(row);
  }

  async function ids(): Promise<string[]> {
    return (await loadBrowserBackupRecords<SavedBackup>()).map((row) => row.id).sort();
  }

  it('keeps the last local and last preflight-passing recovery point', async () => {
    await seed(backup('only', true));
    await expect(removeLocalBackup('only')).rejects.toThrow('最后一份本地备份');
    await deleteWebDatabase();
    await seed(backup('good', true), backup('unchecked', false));
    await expect(removeLocalBackup('good')).rejects.toThrow('最后一份通过预检');
    expect(await ids()).toEqual(['good', 'unchecked']);
  });

  it('keeps the last archive that passed a restore rehearsal', async () => {
    await seed(backup('verified', true), backup('newer', true));
    await recordLocalBackupVerification('verified', '2026-10-20T01:00:00.000Z');
    expect((await loadBrowserBackupRecords<SavedBackup>()).find((row) => row.id === 'verified')?.verifiedAt).toBe('2026-10-20T01:00:00.000Z');
    await expect(removeLocalBackup('verified')).rejects.toThrow('最后一份通过恢复演练');
    await recordLocalBackupVerification('newer', '2026-10-20T02:00:00.000Z');
    await removeLocalBackup('verified');
    expect(await ids()).toEqual(['newer']);
  });

  it('deletes one archive even when the archive store rejects writes for quota', async () => {
    await seed(backup('older', true), backup('newer', true));
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'backup-archives') throw new DOMException('quota reached', 'QuotaExceededError');
      return originalPut.apply(this, args);
    });
    await removeLocalBackup('older');
    expect(await ids()).toEqual(['newer']);
  });

  it('migrates the old catalog and keeps archives independently addressable', async () => {
    await saveKv('ledger.encryptedBackups.v3', [backup('older', true), backup('newer', true)]);
    expect((await listSavedBackups()).map((row) => row.id).sort()).toEqual(['newer', 'older']);
    const db = await openIdb();
    const legacy = await new Promise<unknown>((resolve) => {
      const request = db.transaction('kv').objectStore('kv').get('ledger.encryptedBackups.v3');
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    expect(legacy).toBeUndefined();
    await removeLocalBackup('older');
    expect(await ids()).toEqual(['newer']);
  });

  it('can shrink the legacy catalog when quota prevents migration', async () => {
    await saveKv('ledger.encryptedBackups.v3', [backup('older', true), backup('newer', true)]);
    const originalPut = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'backup-archives') throw new DOMException('quota reached', 'QuotaExceededError');
      return originalPut.apply(this, args);
    });
    expect((await listSavedBackups()).map((row) => row.id).sort()).toEqual(['newer', 'older']);
    await removeLocalBackup('older');
    expect((await loadKv<SavedBackup[]>('ledger.encryptedBackups.v3'))?.map((row) => row.id)).toEqual(['newer']);
    spy.mockRestore();
    expect((await listSavedBackups()).map((row) => row.id)).toEqual(['newer']);
  });

  it('does not let concurrent deletions remove the last local archive', async () => {
    await seed(backup('first', true), backup('second', true));
    const results = await Promise.allSettled([removeLocalBackup('first'), removeLocalBackup('second')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await ids()).toHaveLength(1);
  });
});
