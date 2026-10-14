import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { SyncServerStore } from '../src/store.js';

describe('fresh server database', () => {
  it('preserves account IDs, ownership and ledger binding across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-account-id-'));
    const file = join(dir, 'server.sqlite');
    const store = new SyncServerStore(file, 'open', 'server-stable');
    let next: SyncServerStore | undefined;
    try {
      await store.register('owner', 'opaque-record', undefined, true);
      await store.register('member', 'opaque-member-record');
      const first = await store.getUser('owner');
      expect(first?.accountId).toMatch(/^account-[a-f0-9]{32}$/);
      expect((await store.getUser('member'))?.accountId).not.toBe(first?.accountId);
      const session = await store.createSession({ id: 'session-before-binding', username: 'owner',
        deviceId: 'device-before-binding', deviceName: 'First browser', refreshHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(session.replicaId).toBeUndefined();
      const replica = await store.bindReplica('owner', 'ledger-0000000001');
      expect((await store.getSession(session.id))?.replicaId).toBe(replica.replicaId);
      await store.close();
      next = new SyncServerStore(file, 'closed', 'server-stable');
      expect(await next.getUser('OWNER')).toMatchObject({ accountId: first!.accountId, opaqueRegistrationRecord: 'opaque-record' });
      expect(await next.roleForUser('owner')).toBe('owner');
      expect(await next.getReplica('owner')).toMatchObject({ ledgerId: 'ledger-0000000001' });
    } finally {
      await (next ?? store).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a previous schema before modifying its tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-prior-schema-'));
    const file = join(dir, 'server.sqlite');
    const driver = new NodeSqliteDriver(file);
    try {
      await driver.exec("CREATE TABLE server_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE protected_fixture (ciphertext TEXT);");
      await driver.run("INSERT INTO server_schema_migrations VALUES (23, 'ledger_replacement_checkpoints_v23', '2026-01-01')");
      await driver.run("INSERT INTO protected_fixture VALUES ('original-encrypted-ledger')");
    } finally { await driver.close(); }
    const store = new SyncServerStore(file, 'closed', 'server-fresh');
    try {
      await expect(store.ready).rejects.toThrow(/不升级旧库/);
      const reader = new NodeSqliteDriver(file);
      try {
        expect(await reader.all('SELECT ciphertext FROM protected_fixture'))
          .toEqual([{ ciphertext: 'original-encrypted-ledger' }]);
        expect((await reader.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((row) => row.name))
          .toEqual(['protected_fixture', 'server_schema_migrations']);
      } finally { await reader.close(); }
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
