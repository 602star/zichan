import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ rows: [] as unknown[], failWrite: false }));
vi.mock('../src/db/idb.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/db/idb.js')>(),
  loadKv: async () => storage.rows,
  saveKv: async (_key: string, rows: unknown[]) => {
    if (storage.failWrite) throw new DOMException('quota reached', 'QuotaExceededError');
    storage.rows = rows;
  },
}));

import { recordLocalBackupVerification, removeLocalBackup, type SavedBackup } from '../src/db/backups.js';

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
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    storage.rows = [];
    storage.failWrite = false;
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  it('keeps the last local and last preflight-passing recovery point', async () => {
    storage.rows = [backup('only', true)];
    await expect(removeLocalBackup('only')).rejects.toThrow('最后一份本地备份');
    storage.rows = [backup('good', true), backup('unchecked', false)];
    await expect(removeLocalBackup('good')).rejects.toThrow('最后一份通过预检');
    expect(storage.rows).toHaveLength(2);
  });

  it('keeps the last archive that passed a restore rehearsal', async () => {
    storage.rows = [backup('verified', true), backup('newer', true)];
    await recordLocalBackupVerification('verified', '2026-10-20T01:00:00.000Z');
    expect((storage.rows as SavedBackup[])[0]?.verifiedAt).toBe('2026-10-20T01:00:00.000Z');
    await expect(removeLocalBackup('verified')).rejects.toThrow('最后一份通过恢复演练');
    await recordLocalBackupVerification('newer', '2026-10-20T02:00:00.000Z');
    await removeLocalBackup('verified');
    expect((storage.rows as SavedBackup[]).map((row) => row.id)).toEqual(['newer']);
  });

  it('removes only the selected archive and retains it when IndexedDB rejects the write', async () => {
    storage.rows = [backup('older', true), backup('newer', true)];
    storage.failWrite = true;
    await expect(removeLocalBackup('older')).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(storage.rows).toHaveLength(2);
    storage.failWrite = false;
    await removeLocalBackup('older');
    expect((storage.rows as SavedBackup[]).map((row) => row.id)).toEqual(['newer']);
  });
});
