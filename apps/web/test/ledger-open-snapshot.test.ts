import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { newId, unlockLedgerKeyEnvelope } from '@zichan/core';
import { createLedgerStore, httpCommitTransport, loginAccount, registerAccount, syncReplica, type LedgerOpenSnapshot } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from '../../sync-server/test/support/server-fixture.js';
import { decodeLedgerOpenSnapshot } from '../src/ledger-open-snapshot.js';
import { SqlJsDriver } from '../src/db/sqljs-driver.js';
import { newSyncConnection } from '../src/sync-config.js';
import { initializeEmptyLedger } from '../src/db/ledger-initialization.js';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });

describe('managed ledger open snapshot', () => {
  it('opens native SQLite in the browser, preserves the sync baseline and immediate new writes, and rejects tampering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-open-'));
    const server = createTestSyncServer({ dataDir: dir, custodyEnabled: true, accountProtection: 'managed' });
    await server.ready;
    await new Promise<void>(resolve => server.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    const author = await openLedger({ deviceId: 'author' });
    const driver = await SqlJsDriver.open(null);
    const browser = await createLedgerStore(driver, { deviceId: 'browser' });
    try {
      await registerAccount(url, 'snapshot-owner', 'snapshot-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const login = await loginAccount(url, 'snapshot-owner', 'snapshot-password', { deviceId: 'snapshot-author', deviceName: 'Author' });
      const headers = { Authorization: `Bearer ${login.accessToken}`, 'Content-Type': 'application/json' };
      const response = await fetch(`${url}/api/v3/protection/initialize`, { method: 'POST', headers, body: JSON.stringify({ mode: 'managed' }) });
      expect(response.status).toBe(200);
      const protection = await response.json();
      const crypto = await unlockLedgerKeyEnvelope(protection.secret, protection.envelope);
      await author.adoptLedgerId(crypto.ledgerId);
      const setting = await initializeEmptyLedger(author, { baseCurrencyCode: 'CNY', ledgerMode: 'spending' });
      const add = (store: typeof author, note: string) => store.transactions.put({ ...base(), date: '2026-11-17',
        type: 'expense', category: 'uncategorized', assetId: setting.baseCurrencyAssetId, amount: '12.34', note } as never);
      const marker = 'PRIVATE-SNAPSHOT-MARKER-117';
      await add(author, marker);
      const transport = httpCommitTransport({ baseUrl: url, token: login.accessToken, cryptoSession: crypto, keyEnvelope: protection.envelope });
      await syncReplica(author, transport);
      await server.flushOpenSnapshots();
      const read = async () => {
        const result = await fetch(`${url}/api/v4/ledger-open-snapshot`, { headers });
        expect(result.status).toBe(200);
        return await result.json() as LedgerOpenSnapshot;
      };
      const snapshot = await read();
      const refreshedLogin = await loginAccount(url, 'snapshot-owner', 'snapshot-password', { deviceId: 'snapshot-second', deviceName: 'Second' });
      expect(refreshedLogin.account?.ledgerId).toBe(crypto.ledgerId);
      expect(refreshedLogin.protection?.envelope?.keyringId).toBe(crypto.keyringId);
      const profile = { ...newSyncConnection(url), serverId: server.serverId, accountId: login.accountId,
        ledgerId: crypto.ledgerId, replicaId: snapshot.manifest.replicaId, streamEpoch: snapshot.manifest.streamEpoch };
      const bytes = await decodeLedgerOpenSnapshot(snapshot, profile, crypto);
      expect(await browser.installInitialSnapshot(bytes)).toBe(true);
      expect(browser.syncDeviceId()).toBe('browser');
      expect((await browser.transactions.list()).map(row => row.note)).toContain(marker);
      await add(author, 'remote-after-snapshot');
      await syncReplica(author, transport);
      await add(browser, 'immediate-browser-write');
      expect(await browser.installInitialSnapshot(bytes)).toBe(false);
      await syncReplica(browser, transport);
      await syncReplica(author, transport);
      expect(new Set((await author.transactions.list()).map(row => row.note)))
        .toEqual(new Set([marker, 'remote-after-snapshot', 'immediate-browser-write']));
      const commits = await browser.listSyncCommits({ state: 'applied' });
      expect(commits.filter(row => row.originDeviceId === 'browser').length).toBeGreaterThan(0);
      await server.flushOpenSnapshots();
      const updated = await read();
      expect(updated.manifest.headSeq).toBeGreaterThan(snapshot.manifest.headSeq);
      await expect(decodeLedgerOpenSnapshot(updated, { ...profile, accountId: 'other' }, crypto)).rejects.toThrow('不匹配');
      await expect(decodeLedgerOpenSnapshot({ ...updated, manifest: { ...updated.manifest, headSeq: 1 } }, profile, crypto)).rejects.toThrow();
      const saved = readdirSync(join(dir, 'ledger-open')).filter(file => file.endsWith('.json'));
      expect(saved).toHaveLength(1);
      expect(readFileSync(join(dir, 'ledger-open', saved[0]!), 'utf8')).not.toContain(marker);
      const corrupted = { ...updated, payload: { ...updated.payload, ct: 'AAAA' } };
      writeFileSync(join(dir, 'ledger-open', saved[0]!), JSON.stringify(corrupted));
      // Never hand a new device a disk cache that has not passed server validation.
      expect((await fetch(`${url}/api/v4/ledger-open-snapshot`, { headers })).status).toBe(202);
      await server.flushOpenSnapshots();
      const repaired = await read();
      expect(repaired.payload.ct).not.toBe('AAAA');
      expect(repaired.manifest.headSeq).toBe(updated.manifest.headSeq);
      await expect(decodeLedgerOpenSnapshot(repaired, profile, crypto)).resolves.toBeInstanceOf(Uint8Array);
      expect((await fetch(`${url}/api/v4/ledger-open-snapshot`)).status).toBe(401);
    } finally {
      await author.close(); await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses even partial local business data and leaves it intact', async () => {
    const driver = await SqlJsDriver.open(null);
    const store = await createLedgerStore(driver);
    try {
      await driver.run("INSERT INTO assets(id, name, code, type, decimals) VALUES ('local', 'kept', 'CNY', 'fiat', 2)");
      expect(await store.installInitialSnapshot(new Uint8Array([1]))).toBe(false);
      expect((await store.assets.get('local'))?.name).toBe('kept');
    } finally { await store.close(); }
  });
});
