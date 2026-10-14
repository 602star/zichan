import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createLedgerKeyEnvelope, newId, unlockLedgerKeyEnvelope } from '@zichan/core';
import { registerAccount, loginAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from '../src/backup.js';

async function fixture(custodyEnabled = true) {
  const server = createTestSyncServer({ custodyEnabled });
  await server.ready;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  await registerAccount(url, 'owner', 'owner-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'alice', 'alice-password');
  await registerAccount(url, 'bob', 'bob-password');
  const alice = await loginAccount(url, 'alice', 'alice-password', { deviceId: 'alice-one', deviceName: 'Alice one' });
  const bob = await loginAccount(url, 'bob', 'bob-password', { deviceId: 'bob-device-one', deviceName: 'Bob one' });
  const request = (token: string, path: string, body?: unknown, method = 'POST') => fetch(url + path, { method: body ? method : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { server, url, alice, bob, request };
}

describe('account key custody', () => {
  it('backs up and restores custody keys, and refuses an archive missing its master key', async () => {
    const f = await fixture();
    const root = mkdtempSync(join(tmpdir(), 'zichan-custody-backup-'));
    let restored: ReturnType<typeof createTestSyncServer> | undefined;
    try {
      const before = await (await f.request(f.alice.accessToken, '/api/v3/protection/initialize', { mode: 'managed' })).json();
      await createServerBackup(f.server.dataDir, join(root, 'backup'));
      expect((await verifyServerBackup(join(root, 'backup'))).ok).toBe(true);
      await restoreServerBackup(join(root, 'backup'), join(root, 'restored'));
      restored = createTestSyncServer({ dataDir: join(root, 'restored') });
      await restored.ready;
      await new Promise<void>((resolve) => restored!.server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(restored.server.address() as AddressInfo).port}`;
      const session = await loginAccount(url, 'alice', 'alice-password');
      const after = await (await fetch(`${url}/api/v3/protection`, { headers: { Authorization: `Bearer ${session.accessToken}` } })).json();
      expect(after.secret).toBe(before.secret); expect(after.envelope).toEqual(before.envelope);
      rmSync(join(root, 'backup', 'custody.key'));
      expect((await verifyServerBackup(join(root, 'backup'))).ok).toBe(false);
    } finally { await restored?.close(); await f.server.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('initializes once, isolates accounts and persists only encrypted custody secrets', async () => {
    const f = await fixture();
    try {
      const responses = await Promise.all([1, 2].map(() => f.request(f.alice.accessToken, '/api/v3/protection/initialize', { mode: 'managed' })));
      const [a, retry] = await Promise.all(responses.map((response) => response.json()));
      expect(a.mode).toBe('managed'); expect(retry.secret).toBe(a.secret); expect(retry.replica.ledgerId).toBe(a.replica.ledgerId);
      const account = await (await f.request(f.alice.accessToken, '/api/auth/me')).json();
      expect(account.session.replicaId).toBe(a.replica.replicaId);
      expect(account.ledgers).toEqual([{ ledgerId: a.replica.ledgerId,
        replicaId: a.replica.replicaId, streamEpoch: a.replica.streamEpoch }]);
      await expect(unlockLedgerKeyEnvelope(a.secret, a.envelope)).resolves.toMatchObject({ ledgerId: a.replica.ledgerId });
      const b = await (await f.request(f.bob.accessToken, '/api/v3/protection')).json();
      expect(b.secret).toBeNull(); expect(b.envelope).toBeNull();
      expect((await f.request('bad', '/api/v3/protection')).status).toBe(401);
      const db = new NodeSqliteDriver(join(f.server.dataDir, 'server.sqlite'));
      try {
        const row = await db.get<{ sealed_secret: string }>('SELECT sealed_secret FROM sync_key_custody WHERE username = ?', ['alice']);
        expect(row?.sealed_secret).not.toContain(a.secret);
        expect(readFileSync(join(f.server.dataDir, 'server.sqlite')).includes(Buffer.from(a.secret))).toBe(false);
        expect(readFileSync(join(f.server.dataDir, 'custody.key'), 'utf8')).not.toBe(a.secret);
      } finally { await db.close(); }
    } finally { await f.server.close(); }
  });

  it('imports a managed ledger only with a matching custody secret', async () => {
    const f = await fixture();
    try {
      const secret = 'managed-ledger-secret-000000000000000000000';
      const created = await createLedgerKeyEnvelope(newId(), secret);
      expect((await f.request(f.alice.accessToken, '/api/v3/protection/initialize',
        { mode: 'managed', envelope: created.envelope, secret: 'wrong-secret-0000000000000000000000' })).status).toBe(400);
      const response = await f.request(f.alice.accessToken, '/api/v3/protection/initialize',
        { mode: 'managed', envelope: created.envelope, secret });
      expect(response.status).toBe(200);
      const protection = await response.json();
      expect(protection).toMatchObject({ mode: 'managed', secret, envelope: created.envelope,
        replica: { ledgerId: created.envelope.ledgerId } });
    } finally { await f.server.close(); }
  });
});
