import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '@zichan/db/node';
import { CURRENT_SERVER_SCHEMA, SyncServerStore } from '../src/store.js';

describe('stable account identity', () => {
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
      await store.bindReplica('owner', 'ledger-0000000001');
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

  it.each([6, 7, 8])('upgrades schema %i without resetting credentials, identity, policy or records', async (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-account-upgrade-'));
    const file = join(dir, 'server.sqlite');
    const previous = new NodeSqliteDriver(file);
    let next: SyncServerStore | undefined;
    try {
      await previous.exec(`
        CREATE TABLE server_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        INSERT INTO server_schema_migrations VALUES (${version}, '${version === 6 ? 'server_account_owner_v6' : version === 7 ? 'server_account_identity_v7' : 'server_management_v8'}', '2026-01-01');
        CREATE TABLE sync_users (username TEXT PRIMARY KEY COLLATE NOCASE, opaque_registration_record TEXT NOT NULL,
          disabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT);
        INSERT INTO sync_users VALUES ('existing', 'preserved-opaque-record', 0, '2026-01-01', '2026-01-01', NULL);
        CREATE TABLE server_ownership (singleton INTEGER PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO server_ownership VALUES (1, 'existing', '2026-01-01');
        CREATE TABLE server_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO server_meta VALUES ('registration_mode', 'open', '2026-01-01');
        ${version >= 7 ? `CREATE TABLE sync_account_identities (username TEXT PRIMARY KEY COLLATE NOCASE, account_id TEXT NOT NULL UNIQUE);
        INSERT INTO sync_account_identities VALUES ('existing', 'account-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');` : ''}
        CREATE TABLE protected_fixture (ciphertext TEXT);
        INSERT INTO protected_fixture VALUES ('original-encrypted-ledger');
      `);
      await previous.close();
      next = new SyncServerStore(file, 'closed', 'server-upgrade');
      const user = await next.getUser('existing');
      expect(user?.accountId).toMatch(/^account-[a-f0-9]{32}$/);
      if (version >= 7) expect(user?.accountId).toBe('account-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(user?.opaqueRegistrationRecord).toBe('preserved-opaque-record');
      expect(await next.ownerUsername()).toBe('existing');
      expect(await next.roleForUser('existing')).toBe('owner');
      expect(await next.registrationMode()).toBe('open');
      expect((await next.verify()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
      const reader = new NodeSqliteDriver(file);
      try {
        expect(await reader.get('SELECT ciphertext FROM protected_fixture')).toEqual({ ciphertext: 'original-encrypted-ledger' });
      } finally {
        await reader.close();
      }
    } finally {
      await (next ?? previous).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
