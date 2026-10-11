import { createLedgerKeyEnvelope, encryptJson, newId, sha256Json, wireSyncCommit,
  type SyncCommitV2 } from '@zichan/core';
import { memoryCommitTransport, syncReplicas, type CommitTransport } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeEmptyLedger } from '../src/db/ledger-initialization.js';
import {
  commitRemoteLedgerJoin,
  prepareMemberRemoteLedgerJoin,
  stageRemoteLedgerJoin,
} from '../src/remote-ledger-join.js';

afterEach(() => vi.unstubAllGlobals());

describe('safe remote ledger join', () => {
  it('restores a member using the current member key without reading the owner key envelope', async () => {
    const remote = await openLedger({ deviceId: 'member-restore-owner' });
    try {
      await initializeEmptyLedger(remote, { baseCurrencyCode: 'CNY', ledgerMode: 'spending' });
      const ledgerId = await remote.getLedgerId();
      const key = await createLedgerKeyEnvelope(ledgerId, 'member local password');
      const rows = await remote.listSyncCommits({ includeInvalid: true });
      const commits = await Promise.all(rows.map(async (row, index) => {
        const wire = wireSyncCommit(row);
        const contentHash = await sha256Json(wire);
        return { seq: index + 1, commitId: row.commitId, ledgerId, contentHash, keyEpoch: 1,
          encCommit: await encryptJson(key.session, wire,
            { protocol: 2, ledgerId, commitId: row.commitId, contentHash }) };
      }));
      const requested: string[] = [];
      const progress: { received: number; total: number }[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        requested.push(input);
        if (input.includes('/api/v3/key-envelope')) return Response.json({ error: 'owner only' }, { status: 403 });
        if (input.endsWith('/api/v3/replica')) return Response.json({
          bound: true, serverId: 'server-member-restore', replicaId: 'replica-member-restore',
          streamEpoch: 'epoch-member-restore', ledgerId, headSeq: commits.length,
          capabilities: ['asset-cost-v2'], currentKeyEpoch: 1,
        });
        if (input.includes('/api/v3/commits?')) {
          const after = Number(new URL(input).searchParams.get('after') ?? 0);
          return Response.json({ serverId: 'server-member-restore', replicaId: 'replica-member-restore',
            streamEpoch: 'epoch-member-restore', ledgerId, commits: commits.filter((row) => row.seq > after),
            nextSeq: commits.length, headSeq: commits.length, hasMore: false,
            currentKeyEpoch: 1 });
        }
        throw new Error(`Unexpected request ${input}`);
      }));
      const prepared = await prepareMemberRemoteLedgerJoin({
        baseUrl: 'https://ledger.example', token: 'member-token', ledgerId,
        keyEnvelope: key.envelope, cryptoSession: key.session,
        expectedServerId: 'server-member-restore',
        onProgress: (received, total) => progress.push({ received, total }),
      });
      expect(prepared.pulled).toBe(commits.length);
      expect(progress.at(-1)).toEqual({ received: commits.length, total: commits.length });
      expect(prepared.ledger.settings).toHaveLength(1);
      expect(requested.some((url) => url.includes('/api/v3/key-envelope'))).toBe(false);
    } finally { await remote.close(); }
  }, 30_000);

  it('stages and validates the complete remote ledger before replacing local data', async () => {
    const remote = await openLedger({ deviceId: 'remote-owner' });
    const local = await openLedger({ deviceId: 'local-device' });
    try {
      await initializeEmptyLedger(remote, { baseCurrencyCode: 'EUR', ledgerMode: 'accounts' });
      await initializeEmptyLedger(local, { baseCurrencyCode: 'CNY', ledgerMode: 'spending' });
      const remoteLedgerId = await remote.getLedgerId();
      const localLedgerId = await local.getLedgerId();
      const key = await createLedgerKeyEnvelope(remoteLedgerId, 'remote-password');
      const transport = memoryCommitTransport('join-server');
      expect((await syncReplicas(remote, [{ id: 'server', endpoint: 'memory', transport }])).converged).toBe(true);

      const prepared = await stageRemoteLedgerJoin(
        remoteLedgerId,
        transport,
        key.envelope,
        key.session,
      );
      const order: string[] = [];
      await commitRemoteLedgerJoin(local, prepared, {
        createProtectionBackup: async () => { order.push(`backup:${await local.getLedgerId()}`); },
        adoptRemoteKey: () => { order.push('adopt-remote-key'); },
        restoreLocalKey: () => { order.push('restore-local-key'); },
        reconcileAttachments: async () => { order.push('reconcile'); },
      });

      expect(order).toEqual([
        `backup:${localLedgerId}`,
        'adopt-remote-key',
        'reconcile',
      ]);
      expect(await local.getLedgerId()).toBe(remoteLedgerId);
      const [setting] = await local.settings.list();
      const [baseAsset] = await local.assets.list({ where: { id: setting!.baseCurrencyAssetId } });
      expect(baseAsset?.code).toBe('EUR');
      expect((await local.listSyncCommits({ includeInvalid: true })).length).toBeGreaterThan(0);
    } finally {
      await remote.close();
      await local.close();
    }
  }, 30_000);

  it('restores the original database and key when a post-commit step fails', async () => {
    const remote = await openLedger({ deviceId: 'remote-owner' });
    const local = await openLedger({ deviceId: 'local-device' });
    try {
      await initializeEmptyLedger(remote, { baseCurrencyCode: 'EUR', ledgerMode: 'accounts' });
      await initializeEmptyLedger(local, { baseCurrencyCode: 'CNY', ledgerMode: 'spending' });
      const remoteLedgerId = await remote.getLedgerId();
      const localLedgerId = await local.getLedgerId();
      const localSettingId = (await local.settings.list())[0]!.id;
      const key = await createLedgerKeyEnvelope(remoteLedgerId, 'remote-password');
      const transport = memoryCommitTransport('join-server');
      await syncReplicas(remote, [{ id: 'server', endpoint: 'memory', transport }]);
      const prepared = await stageRemoteLedgerJoin(remoteLedgerId, transport, key.envelope, key.session);
      const calls: string[] = [];

      await expect(commitRemoteLedgerJoin(local, prepared, {
        createProtectionBackup: async () => { calls.push('backup'); },
        adoptRemoteKey: () => { calls.push('adopt-remote'); throw new Error('vault write failed'); },
        restoreLocalKey: () => { calls.push('restore-local'); },
        reconcileAttachments: async () => { calls.push('reconcile'); },
      })).rejects.toThrow('vault write failed');

      expect(calls).toEqual(['backup', 'adopt-remote', 'restore-local', 'reconcile']);
      expect(await local.getLedgerId()).toBe(localLedgerId);
      expect(await local.settings.get(localSettingId)).toBeTruthy();
      const [setting] = await local.settings.list();
      const [baseAsset] = await local.assets.list({ where: { id: setting!.baseCurrencyAssetId } });
      expect(baseAsset?.code).toBe('CNY');
    } finally {
      await remote.close();
      await local.close();
    }
  }, 30_000);

  it('rolls back the database, key and client identity when profile persistence fails', async () => {
    const remote = await openLedger({ deviceId: 'remote-owner' });
    const local = await openLedger({ deviceId: 'local-device' });
    try {
      await initializeEmptyLedger(remote, { baseCurrencyCode: 'EUR', ledgerMode: 'accounts' });
      await initializeEmptyLedger(local, { baseCurrencyCode: 'CNY', ledgerMode: 'spending' });
      const remoteLedgerId = await remote.getLedgerId();
      const localLedgerId = await local.getLedgerId();
      const key = await createLedgerKeyEnvelope(remoteLedgerId, 'remote-password');
      const transport = memoryCommitTransport('join-server');
      await syncReplicas(remote, [{ id: 'server', endpoint: 'memory', transport }]);
      const prepared = await stageRemoteLedgerJoin(remoteLedgerId, transport, key.envelope, key.session);
      const calls: string[] = [];

      await expect(commitRemoteLedgerJoin(local, prepared, {
        createProtectionBackup: async () => { calls.push('backup'); },
        adoptRemoteKey: () => { calls.push('adopt-remote'); },
        restoreLocalKey: () => { calls.push('restore-local'); },
        commitClientState: () => { calls.push('persist-remote-profile'); throw new Error('profile quota exceeded'); },
        restoreClientState: () => { calls.push('restore-local-profile'); },
        reconcileAttachments: async () => { calls.push('reconcile'); },
      })).rejects.toThrow('profile quota exceeded');

      expect(calls).toEqual([
        'backup',
        'adopt-remote',
        'reconcile',
        'persist-remote-profile',
        'restore-local',
        'restore-local-profile',
        'reconcile',
      ]);
      expect(await local.getLedgerId()).toBe(localLedgerId);
      const [setting] = await local.settings.list();
      const [baseAsset] = await local.assets.list({ where: { id: setting!.baseCurrencyAssetId } });
      expect(baseAsset?.code).toBe('CNY');
    } finally {
      await remote.close();
      await local.close();
    }
  }, 30_000);

  it('rejects a converged remote stream containing an authenticated but invalid commit', async () => {
    const ledgerId = 'ledger-remote-invalid-0001';
    const key = await createLedgerKeyEnvelope(ledgerId, 'remote-password');
    const malformed: SyncCommitV2 = {
      protocol: 2,
      ledgerId,
      commitId: newId(),
      originDeviceId: 'broken-remote',
      createdAt: new Date().toISOString(),
      parentCommitIds: [],
      revisions: [{
        revisionId: newId(),
        aggregateType: 'conversion',
        aggregateId: newId(),
        parentRevisionIds: [],
        op: 'put',
        payload: {},
      }],
    };
    const contentHash = await sha256Json(malformed);
    const transport: CommitTransport = {
      async connect() {
        return { serverId: 'server', replicaId: 'replica', streamEpoch: 'epoch', ledgerId, headSeq: 1 };
      },
      async pullCommits(_identity, afterSeq) {
        return afterSeq < 1
          ? { commits: [{ seq: 1, commit: malformed, contentHash }], nextSeq: 1, headSeq: 1, hasMore: false }
          : { commits: [], nextSeq: 1, headSeq: 1, hasMore: false };
      },
      async pushCommits() {
        return { assigned: [], headSeq: 1 };
      },
    };

    await expect(stageRemoteLedgerJoin(ledgerId, transport, key.envelope, key.session))
      .rejects.toThrow('远端提交验证失败');
  }, 30_000);
});
