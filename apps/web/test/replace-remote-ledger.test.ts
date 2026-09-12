import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createLedgerKeyEnvelope } from '@zichan/core';
import { fetchAuthMe, httpCommitTransport, loginAccount, registerAccount, syncReplica } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from '../../sync-server/test/support/server-fixture.js';
import { initializeEmptyLedger } from '../src/db/ledger-initialization.js';
import { replaceRemoteLedger } from '../src/replace-remote-ledger.js';
import { prepareRemoteLedgerJoin } from '../src/remote-ledger-join.js';
import { runtimeLedgerCryptoSession, clearLedgerKey, storedLedgerKeyEnvelope } from '../src/ledger-key-vault.js';
import { loadSyncConnections, newSyncConnection, saveSyncConnections } from '../src/sync-config.js';

const auth = vi.hoisted(() => ({ token: '' }));
vi.mock('../src/sync-auth.js', () => ({ authenticateSyncProfile: async () => auth.token }));

afterEach(() => { clearLedgerKey(); vi.unstubAllGlobals(); });

describe('replace a forgotten encrypted ledger using an existing account', () => {
  it('replaces atomically, restores the new ledger, rejects stale devices, and rolls back rejected attempts', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const baseUrl = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    const old = await openLedger({ deviceId: 'old-ledger' });
    const local = await openLedger({ deviceId: 'new-ledger' });
    const rejected = await openLedger({ deviceId: 'stale-replacement' });
    try {
      await registerAccount(baseUrl, 'restart-user', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      auth.token = (await loginAccount(baseUrl, 'restart-user', 'account-password', { deviceId: 'current-device', deviceName: 'Current' })).accessToken;
      const other = (await loginAccount(baseUrl, 'restart-user', 'account-password', { deviceId: 'old-device', deviceName: 'Old' })).accessToken;
      await initializeEmptyLedger(old, { baseCurrencyCode: 'EUR', ledgerMode: 'assets' });
      const oldKeys = await createLedgerKeyEnvelope(await old.getLedgerId(), 'forgotten-password');
      await syncReplica(old, httpCommitTransport({ baseUrl, token: auth.token, cryptoSession: oldKeys.session, keyEnvelope: oldKeys.envelope }), baseUrl);
      const before = await fetchAuthMe(baseUrl, auth.token);
      const health = await (await fetch(`${baseUrl}/api/health`)).json();
      const connection = { ...newSyncConnection(baseUrl), ...before, serverId: health.serverId, serverPublicKey: health.serverPublicKey };
      saveSyncConnections([connection]);

      await expect(replaceRemoteLedger(local, { ...connection, streamEpoch: 'stale-epoch' }, 'new-ledger-password')).rejects.toThrow('服务器账本已变化');
      expect(await local.settings.count()).toBe(0);
      expect(await local.listSyncCommits()).toEqual([]);
      expect((await fetchAuthMe(baseUrl, auth.token)).ledgerId).toBe(before.ledgerId);
      expect(storedLedgerKeyEnvelope()).toBeUndefined();

      const setting = await replaceRemoteLedger(local, connection, 'new-ledger-password');
      expect(setting.ledgerMode).toBe('spending');
      const after = await fetchAuthMe(baseUrl, auth.token);
      expect(after.accountId).toBe(before.accountId);
      expect(after.role).toBe(before.role);
      expect(after.ledgerId).toBe(await local.getLedgerId());
      expect(after.ledgerId).not.toBe(before.ledgerId);
      expect(after.streamEpoch).not.toBe(before.streamEpoch);
      expect(after.replicaId).not.toBe(before.replicaId);
      expect(loadSyncConnections()[0]!.ledgerId).toBe(after.ledgerId);
      await expect(fetchAuthMe(baseUrl, other)).rejects.toThrow();
      const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
      const page = await (await fetch(`${baseUrl}/api/v3/commits?after=0`, { headers })).json();
      const replacement = { expectedLedgerId: before.ledgerId, expectedStreamEpoch: before.streamEpoch, confirmation: '替换旧账本', envelope: storedLedgerKeyEnvelope(), commits: page.commits };
      const repeat = () => fetch(`${baseUrl}/api/v3/replica/replace`, { method: 'POST', headers, body: JSON.stringify(replacement) });
      expect((await Promise.all([repeat(), repeat()])).map((response) => response.status)).toEqual([200, 200]);
      expect(await fetchAuthMe(baseUrl, auth.token)).toEqual(after);
      expect((await fetch(`${baseUrl}/api/v3/replica/replace`, { method: 'POST', headers, body: JSON.stringify({ ...replacement, confirmation: '' }) })).status).toBe(400);
      expect((await fetch(`${baseUrl}/api/v3/replica/replace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(replacement) })).status).toBe(401);
      // Even a newly authenticated old device cannot put its old key or commits into the new stream.
      await expect(syncReplica(old, httpCommitTransport({ baseUrl, token: auth.token, cryptoSession: oldKeys.session, keyEnvelope: oldKeys.envelope }), baseUrl)).rejects.toThrow('LEDGER_MISMATCH');
      await expect(replaceRemoteLedger(rejected, connection, 'another-password')).rejects.toThrow('服务器账本已变化');
      expect(await rejected.settings.count()).toBe(0);

      const restored = await prepareRemoteLedgerJoin({ baseUrl, token: auth.token, ledgerId: after.ledgerId!, passphrase: 'new-ledger-password', expectedServerId: health.serverId });
      expect(restored.ledger.settings[0]!.id).toBe(setting.id);
      expect(restored.ledger.assets.map((asset) => asset.code)).toEqual(['CNY']);
      await syncReplica(local, httpCommitTransport({ baseUrl, token: auth.token, cryptoSession: runtimeLedgerCryptoSession()!, keyEnvelope: storedLedgerKeyEnvelope()! }), baseUrl);
      const relogin = await loginAccount(baseUrl, 'restart-user', 'account-password', { deviceId: 'relogin-device', deviceName: 'Relogin' });
      expect((await fetchAuthMe(baseUrl, relogin.accessToken)).ledgerId).toBe(after.ledgerId);
    } finally {
      await Promise.all([old.close(), local.close(), rejected.close()]);
      await server.close();
    }
  }, 30_000);
});
