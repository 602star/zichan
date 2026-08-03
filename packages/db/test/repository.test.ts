import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openLedger } from '../src/node.js';
import { NodeSqliteDriver } from '../src/drivers/node-sqlite.js';
import { newId, type Asset, type Game, type GameRecord } from '@zichan/core';
import { ConcurrencyError, createLedgerStore, type SqlLedgerStore } from '../src/index.js';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}
function asset(p: Partial<Asset> & Pick<Asset, 'code' | 'name' | 'type' | 'decimals'>): Asset {
  return { ...base(), isActive: true, ...p } as Asset;
}

describe('SqlLedgerStore — CRUD + audit', () => {
  let store: SqlLedgerStore;
  beforeEach(async () => {
    store = await openLedger({ deviceId: 'dev-test' });
  });
  afterEach(async () => {
    await store.close();
  });

  it('migrate is idempotent', async () => {
    await store.migrate();
    await store.migrate(); // must not throw or duplicate
    expect(true).toBe(true);
  });

  it('put creates then updates, bumping version and preserving createdAt', async () => {
    const a = asset({ code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8 });
    const created = await store.assets.put(a);
    expect(created.version).toBe(1);
    expect(created.createdAt).not.toBe('');

    const fetched = await store.assets.get(a.id);
    expect(fetched?.code).toBe('BTC');
    expect(fetched?.decimals).toBe(8); // int round-trips as number
    expect(fetched?.isActive).toBe(true); // bool round-trips as boolean

    const updated = await store.assets.put({ ...created, name: 'Bitcoin!' });
    expect(updated.version).toBe(2);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('rejects a stale edit instead of overwriting a newer window', async () => {
    const created = await store.assets.put(asset({ code: 'JPY', name: 'Yen', type: 'fiat', decimals: 0 }));
    const firstWindow = (await store.assets.get(created.id))!;
    const secondWindow = (await store.assets.get(created.id))!;

    const updated = await store.assets.put({ ...firstWindow, name: 'Japanese yen' });
    expect(updated.version).toBe(2);
    await expect(store.assets.put({ ...secondWindow, name: 'Stale name' })).rejects.toBeInstanceOf(ConcurrencyError);
    expect((await store.assets.get(created.id))?.name).toBe('Japanese yen');
  });

  it('optional fields round-trip as undefined, not null', async () => {
    const a = asset({ code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2 });
    await store.assets.put(a);
    const f = await store.assets.get(a.id);
    expect(f).not.toBeNull();
    expect('note' in f!).toBe(false);
    expect(f!.symbol).toBeUndefined();
  });

  it('list excludes soft-deleted by default; includeDeleted returns all', async () => {
    const g1: Game = { ...base(), name: 'A', enableSeason: true } as Game;
    const g2: Game = { ...base(), name: 'B', enableSeason: false } as Game;
    await store.games.put(g1);
    await store.games.put(g2);
    await store.games.remove(g2.id, g2.version);

    const active = await store.games.list();
    expect(active.map((g) => g.name)).toEqual(['A']);
    const all = await store.games.list({ includeDeleted: true });
    expect(all.length).toBe(2);
    expect((await store.games.get(g2.id))?.isDeleted).toBe(true);
  });

  it('uses a stable range cursor for duplicate sort values', async () => {
    for (const name of ['B', 'A', 'A', 'C', 'B', 'A', 'D']) {
      await store.games.put({ ...base(), name, enableSeason: true } as Game);
    }
    const expected = await store.games.list({ orderBy: 'name' });
    const seen: Game[] = [];
    let cursor: import('@zichan/core').QueryCursor | undefined;
    do {
      const page = await store.games.listPage({ orderBy: 'name', limit: 2, cursor });
      seen.push(...page.rows);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (cursor);
    expect(seen.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(new Set(seen.map((row) => row.id)).size).toBe(expected.length);
  });

  it('records create/update/delete in the operation log with device + payload', async () => {
    const a = asset({ code: 'ETH', name: 'Ether', type: 'crypto', decimals: 8 });
    await store.assets.put(a);
    const updated = await store.assets.put({ ...a, name: 'Ether2' });
    await store.assets.remove(a.id, updated.version);

    const log = await store.operationLog({ entityType: 'asset', entityId: a.id });
    expect(log.map((l) => l.op)).toEqual(['create', 'update', 'delete']);
    expect(log[0]!.deviceId).toBe('dev-test');
    expect(JSON.parse(log[0]!.payload!).code).toBe('ETH');
    expect(log[1]!.changedKeys).toContain('name');
    expect(JSON.parse(log[1]!.diffJson!).name).toMatchObject({ before: 'Ether', after: 'Ether2' });
    expect(JSON.parse(log[1]!.beforePayload!).name).toBe('Ether');
    expect(JSON.parse(log[1]!.afterPayload!).name).toBe('Ether2');
    expect(log[2]!.version).toBe(3);
  });

  it('groups audit entries into batches', async () => {
    const batch = await store.createAuditBatch({ id: newId(), type: 'bulk_update', label: '批量修正资产', entityCount: 2 });
    await store.withAuditContext({ batchId: batch.id, source: 'local' }, async (store) => {
      await store.assets.put(asset({ code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2 }));
      await store.assets.put(asset({ code: 'USD', name: 'Dollar', type: 'fiat', decimals: 2 }));
    });
    await store.finishAuditBatch(batch.id, { entityCount: 2, summary: '两条资产' });

    const batches = await store.listAuditBatches();
    expect(batches[0]).toMatchObject({ id: batch.id, entityCount: 2, summary: '两条资产' });
    const log = await store.operationLog({ batchId: batch.id });
    expect(log.length).toBe(2);
    expect(log.every((l) => l.batchId === batch.id)).toBe(true);
  });

  it('keeps overlapping audit contexts isolated', async () => {
    const firstBatch = await store.createAuditBatch({ id: newId(), type: 'bulk_update', label: '第一批', entityCount: 2 });
    const secondBatch = await store.createAuditBatch({ id: newId(), type: 'bulk_update', label: '第二批', entityCount: 1 });
    let releaseFirst!: () => void;
    let markFirstWritten!: () => void;
    const firstMayContinue = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstWritten = new Promise<void>((resolve) => { markFirstWritten = resolve; });

    const first = store.withAuditContext({ batchId: firstBatch.id, source: 'local' }, async (batchStore) => {
      await batchStore.assets.put(asset({ code: 'AUD1', name: 'Audit one', type: 'fiat', decimals: 2 }));
      markFirstWritten();
      await firstMayContinue;
      await batchStore.assets.put(asset({ code: 'AUD2', name: 'Audit two', type: 'fiat', decimals: 2 }));
    });
    await firstWritten;
    await store.withAuditContext({ batchId: secondBatch.id, source: 'local' }, async (batchStore) => {
      await batchStore.assets.put(asset({ code: 'AUD3', name: 'Audit three', type: 'fiat', decimals: 2 }));
    });
    releaseFirst();
    await first;

    expect(await store.operationLog({ batchId: firstBatch.id })).toHaveLength(2);
    expect(await store.operationLog({ batchId: secondBatch.id })).toHaveLength(1);
  });

  it('seals a non-transactional batch after an error so committed changes can still sync', async () => {
    const batchId = newId();
    await expect(store.withAuditContext({ batchId, source: 'local' }, async (batchStore) => {
      await batchStore.assets.put(asset({ code: 'PARTIAL', name: 'Committed before error', type: 'fiat', decimals: 2 }));
      throw new Error('batch failed after a committed write');
    })).rejects.toThrow('batch failed');

    await expect(store.assertSyncReady()).resolves.toBeUndefined();
    const commits = await store.commitsPendingForReplica('new-replica');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ commitId: batchId, sealed: true });
    expect(commits[0]?.revisions).toHaveLength(1);
  });

  it('recovers an unsealed local commit during startup migration', async () => {
    const driver = new NodeSqliteDriver();
    const recovering = await createLedgerStore(driver, { deviceId: 'recovery-test' });
    await recovering.assets.put(asset({ code: 'RECOVER', name: 'Interrupted write', type: 'fiat', decimals: 2 }));
    await driver.run("UPDATE sync_commits SET sealed = 0 WHERE source = 'local'");
    await expect(recovering.assertSyncReady()).rejects.toThrow('未完成的原子批次');

    await recovering.migrate();

    await expect(recovering.assertSyncReady()).resolves.toBeUndefined();
    expect(await recovering.commitsPendingForReplica('new-replica')).toEqual([
      expect.objectContaining({ sealed: true }),
    ]);
    await recovering.close();
  });

  it('applies inclusive since and exclusive until boundaries to audit queries', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    const after = new Date(Date.now() + 60_000).toISOString();
    const batch = await store.createAuditBatch({ id: newId(), type: 'bulk_update', label: '区间测试', entityCount: 1 });
    await store.withAuditContext({ batchId: batch.id, source: 'local' }, async (store) => {
      await store.assets.put(asset({ code: 'CNY', name: 'Yuan', type: 'fiat', decimals: 2 }));
    });
    await store.finishAuditBatch(batch.id, { entityCount: 1 });

    const groupId = newId();
    await store.finishConflictGroup({
      groupId,
      action: 'keep_local',
      detail: { aggregates: ['transaction\u0000tx-range'], changedPaths: ['transaction.amount'] },
    });

    expect((await store.operationLog({ since: before, until: after })).length).toBe(1);
    expect(await store.operationLog({ since: after })).toEqual([]);
    expect(await store.operationLog({ until: before })).toEqual([]);

    expect((await store.listAuditBatches({ since: before, until: after })).map((row) => row.id)).toEqual([batch.id]);
    expect(await store.listAuditBatches({ since: after })).toEqual([]);
    expect(await store.listAuditBatches({ until: before })).toEqual([]);

    expect((await store.listConflictResolutions({ since: before, until: after })).map((row) => row.groupId)).toEqual([groupId]);
    expect(await store.listConflictResolutions({ since: after })).toEqual([]);
    expect(await store.listConflictResolutions({ until: before })).toEqual([]);
  });

  it('records sync conflict resolutions', async () => {
    const groupId = newId();
    const resolvedCommitId = newId();
    await store.finishConflictGroup({
      groupId,
      action: 'keep_branch',
      resolvedCommitId,
      detail: { aggregates: ['transaction\u0000tx-1'], changedPaths: ['transaction.amount'] },
      note: '采用设备 B 分支',
    });

    expect(await store.listConflicts()).toEqual([]);
    const resolutions = await store.listConflictResolutions();
    expect(resolutions[0]).toMatchObject({ groupId, action: 'keep_branch', resolvedCommitId, note: '采用设备 B 分支' });
    expect(JSON.parse(resolutions[0]!.detailJson!).changedPaths).toEqual(['transaction.amount']);
  });

  it('exports and exactly restores audit, sync and ledger identity state', async () => {
    const row = await store.assets.put(asset({ code: 'STATE', name: 'Device state', type: 'fiat', decimals: 2 }));
    const sourceLedgerId = await store.getLedgerId();
    const state = await store.exportDeviceRecoveryState();

    const fresh = await openLedger({ deviceId: 'restore-target' });
    await fresh.assets.put(asset({ code: 'OTHER', name: 'Unrelated local data', type: 'fiat', decimals: 2 }));
    await fresh.restoreDeviceRecoveryState(state);

    expect(await fresh.getLedgerId()).toBe(sourceLedgerId);
    expect(await fresh.operationLog({ entityType: 'asset', entityId: row.id })).toHaveLength(1);
    expect((await fresh.listSyncCommits()).some((commit) => commit.revisions.some((revision) => revision.aggregateId === row.id))).toBe(true);
    await fresh.close();
  });

  it('changes backup generation after a durable ledger mutation', async () => {
    const before = await store.backupGeneration();
    await store.assets.put(asset({ code: 'GEN', name: 'Generation', type: 'fiat', decimals: 2 }));
    const after = await store.backupGeneration();
    expect(after).not.toBe(before);
    expect(after.startsWith(`${await store.getLedgerId()}:`)).toBe(true);
  });

  it('rebuilds transient attachment operations when exporting device recovery state', async () => {
    const now = new Date().toISOString();
    const sha256 = 'a'.repeat(64);
    await store.attachmentState.putBlob({
      sha256,
      sizeBytes: 12,
      mimeType: 'application/octet-stream',
      state: 'ready',
      verifiedAt: now,
    });
    await store.attachmentState.putFileOp({
      id: newId(),
      kind: 'download',
      contentSha256: sha256,
      phase: 'prepared',
      tempContentKey: 'temporary-download',
      createdAt: now,
      updatedAt: now,
    });
    await store.attachmentState.putReplicaBlob({
      profileId: 'profile-one',
      sha256,
      remoteBlobId: 'remote-one',
      state: 'uploading',
      uploadId: 'partial-upload',
      uploadedChunks: [0, 1],
      keyVersion: 1,
      updatedAt: now,
    });

    const state = await store.exportDeviceRecoveryState();
    expect(state.tables['attachment_file_ops']).toEqual([]);
    expect(state.tables['attachment_blobs']?.[0]).toMatchObject({
      state: 'missing',
      verified_at: null,
    });
    expect(state.tables['attachment_replica_blobs']?.[0]).toMatchObject({
      state: 'queued',
      upload_id: null,
      uploaded_chunks_json: '[]',
    });

    const fresh = await openLedger({ deviceId: 'attachment-state-restore' });
    try {
      await fresh.restoreDeviceRecoveryState(state);
      expect(await fresh.attachmentState.listFileOps()).toEqual([]);
      expect(await fresh.attachmentState.getBlob(sha256)).toMatchObject({ state: 'missing' });
      expect(await fresh.attachmentState.getReplicaBlob('profile-one', sha256)).toMatchObject({
        state: 'queued',
        uploadId: undefined,
        uploadedChunks: [],
      });
    } finally {
      await fresh.close();
    }
  });

  it('filters game records by a where clause on an indexed column', async () => {
    await store.assets.put({ ...asset({ code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2 }), id: 'GBP' });
    await store.games.put({ ...base(), id: 'g1', name: 'Game', enableSeason: true, isActive: true } as never);
    await store.gameSeasons.put({ ...base(), id: 's1', gameId: 'g1', name: 'Season 1', status: 'active' } as never);
    await store.gameSeasons.put({ ...base(), id: 's2', gameId: 'g1', name: 'Season 2', status: 'active' } as never);
    const mk = (seasonId: string, amt: string): GameRecord =>
      ({
        ...base(), date: '2026-01-01', gameId: 'g1', seasonId,
        recordType: 'sell_currency', settlementAssetId: 'GBP', settlementAmount: amt,
      }) as GameRecord;
    await store.gameRecords.put(mk('s1', '10'));
    await store.gameRecords.put(mk('s2', '20'));

    const s1 = await store.gameRecords.list({ where: { seasonId: 's1' } });
    expect(s1.length).toBe(1);
    expect(s1[0]!.settlementAmount).toBe('10');
  });

  it('rejects an unknown filter field (guards against injection)', async () => {
    await expect(store.assets.list({ where: { bogus: 'x' } as never })).rejects.toThrow(/unknown filter/);
  });
});
