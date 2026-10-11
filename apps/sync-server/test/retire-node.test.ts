import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyServerBackup } from '../src/backup.js';
import { inspectNodeRetirement, retireNodeData } from '../src/retire-node.js';
import { NODE_SIGNING_KEY_FILE } from '../src/node-identity.js';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('stopped node retirement', () => {
  it('keeps data on identity mismatch or a running service, then backs up and clears only the named node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retire-node-'));
    const dataDir = join(root, 'old-node');
    const backup = join(root, 'verified-backup');
    const survivor = join(root, 'survivor');
    const server = createTestSyncServer({ dataDir });
    let closed = false;
    try {
      await server.ready;
      writeFileSync(join(dataDir, 'server.pid'), JSON.stringify({ pid: process.pid }));
      await expect(inspectNodeRetirement(dataDir)).rejects.toThrow(/仍在运行/);
      rmSync(join(dataDir, 'server.pid'));
      await server.close();
      closed = true;
      writeFileSync(join(dataDir, 'backup-executor.lock'), String(process.pid));
      await expect(inspectNodeRetirement(dataDir)).rejects.toThrow(/监督进程锁文件/);
      rmSync(join(dataDir, 'backup-executor.lock'));
      const inspection = await inspectNodeRetirement(dataDir);
      expect(inspection).toMatchObject({ serverId: server.serverId, ledgerIds: [] });
      await expect(retireNodeData(dataDir, backup, 'srv-wrong-node'))
        .rejects.toThrow(/节点 ID 与数据目录不一致/);
      expect(existsSync(backup)).toBe(false);
      await expect(retireNodeData(dataDir, join(dataDir, 'backup'), server.serverId))
        .rejects.toThrow(/不能互相包含/);
      expect(existsSync(dataDir)).toBe(true);
      const signingKey = join(dataDir, NODE_SIGNING_KEY_FILE);
      renameSync(signingKey, `${signingKey}.held`);
      await expect(retireNodeData(dataDir, backup, server.serverId)).rejects.toThrow(/备份/);
      expect(existsSync(dataDir)).toBe(true);
      expect(existsSync(backup)).toBe(false);
      renameSync(`${signingKey}.held`, signingKey);
      writeFileSync(survivor, 'other node must survive');
      const result = await retireNodeData(dataDir, backup, server.serverId);
      expect(result.backupPath).toBe(backup);
      expect(existsSync(dataDir)).toBe(false);
      expect(existsSync(survivor)).toBe(true);
      expect((await verifyServerBackup(backup)).ok).toBe(true);
    } finally {
      if (!closed) await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to clear a node that still stores two ledgers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retire-multi-'));
    const dataDir = join(root, 'old-node');
    const server = createTestSyncServer({ dataDir });
    let closed = false;
    try {
      await server.ready;
      await server.close();
      closed = true;
      const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId);
      try {
        await store.register('first', 'opaque-first', undefined, true);
        await store.bindReplica('first', 'ledger-first-node-retirement');
        await store.register('second', 'opaque-second');
        await store.bindReplica('second', 'ledger-second-node-retirement');
      } finally { await store.close(); }
      expect((await inspectNodeRetirement(dataDir)).ledgerIds).toEqual([
        'ledger-first-node-retirement', 'ledger-second-node-retirement',
      ]);
      const backup = join(root, 'backup');
      await expect(retireNodeData(dataDir, backup, server.serverId)).rejects.toThrow(/包含 2 本账/);
      expect(existsSync(dataDir)).toBe(true);
      expect(existsSync(backup)).toBe(false);
    } finally {
      if (!closed) await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses two independent replica histories even when they share one ledger ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-retire-duplicate-ledger-'));
    const dataDir = join(root, 'old-node');
    const server = createTestSyncServer({ dataDir });
    let closed = false;
    try {
      await server.ready;
      await server.close();
      closed = true;
      const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId);
      try {
        await store.register('first', 'opaque-first', undefined, true);
        await store.bindReplica('first', 'ledger-same-id-separate-history');
        await store.register('second', 'opaque-second');
        await store.bindReplica('second', 'ledger-same-id-separate-history');
      } finally { await store.close(); }
      const inspection = await inspectNodeRetirement(dataDir);
      expect(inspection.ledgerIds).toEqual(['ledger-same-id-separate-history']);
      expect(inspection.replicaIds).toHaveLength(2);
      const backup = join(root, 'backup');
      await expect(retireNodeData(dataDir, backup, server.serverId)).rejects.toThrow(/2 个独立副本槽位/);
      expect(existsSync(dataDir)).toBe(true);
      expect(existsSync(backup)).toBe(false);
    } finally {
      if (!closed) await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
