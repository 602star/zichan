import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createLedgerKeyEnvelope, newId, unlockLedgerKeyEnvelope, rotateLedgerProtection, encryptJson, decryptJson, encryptBackupBytes, decryptBackupBytes } from '@zichan/core';
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

  it('supports private initialization without sending recovery secrets and rejects unsupported custody', async () => {
    const f = await fixture(false);
    try {
      expect((await f.request(f.alice.accessToken, '/api/v3/protection/initialize', { mode: 'managed' })).status).toBe(400);
      const created = await createLedgerKeyEnvelope(newId(), 'private-recovery-code');
      const response = await f.request(f.alice.accessToken, '/api/v3/protection/initialize', { mode: 'private', envelope: created.envelope });
      expect(response.status).toBe(200);
      const data = await response.json(); expect(data.mode).toBe('private'); expect(data.secret).toBeNull();
      await expect(unlockLedgerKeyEnvelope('private-recovery-code', data.envelope)).resolves.toMatchObject({ ledgerId: created.session.ledgerId });
    } finally { await f.server.close(); }
  });

  it('atomically switches protection, revokes other devices, and rotates future payload and backup keys', async () => {
    const f = await fixture();
    try {
      const a = await (await f.request(f.alice.accessToken, '/api/v3/protection/initialize', { mode: 'managed' })).json();
      const old = await unlockLedgerKeyEnvelope(a.secret, a.envelope);
      const second = await loginAccount(f.url, 'alice', 'alice-password', { deviceId: 'alice-two', deviceName: 'Alice two' });
      const historical = await encryptJson(old, { text: 'old' }, 'test');
      const historicalBackup = await encryptBackupBytes(old, new Uint8Array([1, 2]), 'backup');
      const next = await rotateLedgerProtection(old, 'saved-private-recovery-code');
      const changed = await f.request(f.alice.accessToken, '/api/v3/protection', { version: a.version, mode: 'private', envelope: next.envelope }, 'PUT');
      expect(changed.status).toBe(200); expect((await changed.json()).secret).toBeNull();
      expect((await f.request(second.accessToken, '/api/v3/protection')).status).toBe(401);
      expect((await f.request(f.alice.accessToken, '/api/v3/protection', { version: a.version, mode: 'private', envelope: next.envelope }, 'PUT')).status).toBe(409);
      await expect(decryptJson(next.session, historical, 'test')).resolves.toEqual({ text: 'old' });
      await expect(decryptBackupBytes(next.session, historicalBackup, 'backup')).resolves.toEqual(new Uint8Array([1, 2]));
      await expect(decryptJson(old, await encryptJson(next.session, { text: 'new' }, 'test'), 'test')).rejects.toThrow();
      await expect(decryptBackupBytes(old, await encryptBackupBytes(next.session, new Uint8Array([3]), 'backup'), 'backup')).rejects.toThrow();
      expect(next.session.attachmentSecret).not.toEqual(old.attachmentSecret);
      await expect(unlockLedgerKeyEnvelope(a.secret, next.envelope)).rejects.toThrow();
    } finally { await f.server.close(); }
  });

  it('requires explicit authorization and a matching secret to grant custody', async () => {
    const f = await fixture();
    try {
      const created = await createLedgerKeyEnvelope(newId(), 'a-long-secret-for-custody-000000000000000');
      await f.request(f.alice.accessToken, '/api/v3/protection/initialize', { mode: 'private', envelope: created.envelope });
      const body = { version: 1, mode: 'managed', envelope: created.envelope, secret: 'a-long-secret-for-custody-000000000000000' };
      expect((await f.request(f.alice.accessToken, '/api/v3/protection', body, 'PUT')).status).toBe(400);
      expect((await f.request(f.alice.accessToken, '/api/v3/protection', { ...body, confirmation: '允许此服务器解密账本', secret: 'wrong-secret-0000000000000000000000' }, 'PUT')).status).toBe(400);
      expect((await f.request(f.alice.accessToken, '/api/v3/protection', { ...body, confirmation: '允许此服务器解密账本' }, 'PUT')).status).toBe(200);
    } finally { await f.server.close(); }
  });
});
