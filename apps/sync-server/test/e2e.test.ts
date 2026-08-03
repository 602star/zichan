import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  createLedgerCryptoSession,
  newId,
  type Asset,
  type LedgerCryptoSession,
  type LedgerKeyEnvelope,
} from '@zichan/core';
import {
  httpCommitTransport,
  loginAccount,
  registerAccount,
  syncReplica,
  syncReplicas,
} from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import { createSyncServer } from '../src/server.js';

function asset(code: string): Asset {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false, code, name: code, type: 'crypto', decimals: 8, isActive: true } as Asset;
}

function testKeyring(ledgerId: string): { session: LedgerCryptoSession; envelope: LedgerKeyEnvelope } {
  const session = createLedgerCryptoSession(ledgerId);
  return {
    session,
    envelope: {
      v: 1, kdf: 'argon2id', ledgerId, keyringId: session.keyringId, generation: session.generation,
      salt: 'AAECAwQFBgcICQoLDA0ODw==', memoryKiB: 32 * 1024, iterations: 3, parallelism: 1,
      iv: 'AAECAwQFBgcICQoL', ct: 'opaque-test-keyring',
    },
  };
}

function transport(baseUrl: string, token: string, keys: ReturnType<typeof testKeyring>) {
  return httpCommitTransport({ baseUrl, token, cryptoSession: keys.session, keyEnvelope: keys.envelope });
}

describe('end-to-end encrypted sync protocol v3', () => {
  it('converges two devices and keeps commit payloads encrypted on the server', async () => {
    const server = createSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    try {
      await b.adoptLedgerId(await a.getLedgerId());
      const keys = testKeyring(await a.getLedgerId());
      await registerAccount(url, 'cara', 'commit-pw');
      const tokenA = (await loginAccount(url, 'cara', 'commit-pw', { deviceId: 'device-cara-a', deviceName: 'Cara A' })).accessToken;
      const tokenB = (await loginAccount(url, 'cara', 'commit-pw', { deviceId: 'device-cara-b', deviceName: 'Cara B' })).accessToken;
      const transportA = transport(url, tokenA, keys);
      const transportB = transport(url, tokenB, keys);

      await a.assets.put(asset('BTC'));
      await b.assets.put(asset('ETH'));
      await syncReplica(a, transportA, url);
      await syncReplica(b, transportB, url);
      await syncReplica(a, transport(url, tokenA, keys), url);

      expect((await a.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
      expect((await b.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);

      const raw = (await (await fetch(url + '/api/v3/commits?after=0', { headers: { Authorization: `Bearer ${tokenA}` } })).json()) as { commits: unknown[] };
      expect(raw.commits).toHaveLength(2);
      expect(JSON.stringify(raw.commits)).not.toContain('"code":"BTC"');
      expect(JSON.stringify(raw.commits)).not.toContain('"code":"ETH"');
    } finally {
      await server.close();
      await a.close();
      await b.close();
    }
  });

  it('relays and re-encrypts commits across servers with different passwords', async () => {
    const first = createSyncServer({ serverId: 'server-one' });
    const second = createSyncServer({ serverId: 'server-two' });
    await new Promise<void>((resolve) => first.server.listen(0, resolve));
    await new Promise<void>((resolve) => second.server.listen(0, resolve));
    const firstUrl = `http://localhost:${(first.server.address() as AddressInfo).port}`;
    const secondUrl = `http://localhost:${(second.server.address() as AddressInfo).port}`;
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    try {
      await b.adoptLedgerId(await a.getLedgerId());
      const keys = testKeyring(await a.getLedgerId());
      await registerAccount(firstUrl, 'nway', 'first-password');
      await registerAccount(secondUrl, 'nway', 'second-password');
      const firstToken = (await loginAccount(firstUrl, 'nway', 'first-password', { deviceId: 'device-nway-first', deviceName: 'N-way first' })).accessToken;
      const secondToken = (await loginAccount(secondUrl, 'nway', 'second-password', { deviceId: 'device-nway-second', deviceName: 'N-way second' })).accessToken;
      const targets = () => [
        {
          id: 'first', endpoint: firstUrl,
          transport: transport(firstUrl, firstToken, keys),
        },
        {
          id: 'second', endpoint: secondUrl,
          transport: transport(secondUrl, secondToken, keys),
        },
      ];

      await a.assets.put(asset('BTC'));
      await b.assets.put(asset('ETH'));
      await syncReplica(a, targets()[0]!.transport, firstUrl);
      await syncReplica(b, targets()[1]!.transport, secondUrl);
      expect((await syncReplicas(a, targets())).converged).toBe(true);
      expect((await syncReplicas(b, targets())).converged).toBe(true);

      expect((await a.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
      expect((await b.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);

      const rawFirst = (await (await fetch(firstUrl + '/api/v3/commits?after=0', { headers: { Authorization: `Bearer ${firstToken}` } })).json()) as { serverId: string; commits: unknown[] };
      const rawSecond = (await (await fetch(secondUrl + '/api/v3/commits?after=0', { headers: { Authorization: `Bearer ${secondToken}` } })).json()) as { serverId: string; commits: unknown[] };
      expect(rawFirst.serverId).toBe('server-one');
      expect(rawSecond.serverId).toBe('server-two');
      expect(rawFirst.commits).toHaveLength(2);
      expect(rawSecond.commits).toHaveLength(2);
      expect(JSON.stringify(rawFirst.commits)).not.toBe(JSON.stringify(rawSecond.commits));
      expect(JSON.stringify(rawFirst.commits)).not.toContain('"code":"BTC"');
      expect(JSON.stringify(rawSecond.commits)).not.toContain('"code":"ETH"');
    } finally {
      await first.close();
      await second.close();
      await a.close();
      await b.close();
    }
  });

  it('lets a user-confirmed replacement join an account already bound to another ledger', async () => {
    const server = createSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    const owner = await openLedger({ deviceId: 'owner' });
    const joining = await openLedger({ deviceId: 'joining' });
    try {
      await registerAccount(url, 'join', 'join-password');
      const token = (await loginAccount(url, 'join', 'join-password', { deviceId: 'device-join-owner', deviceName: 'Join owner' })).accessToken;
      const keys = testKeyring(await owner.getLedgerId());
      await owner.assets.put(asset('REMOTE'));
      await syncReplica(owner, transport(url, token, keys), url);

      const local = await joining.assets.put(asset('LOCAL'));
      await expect(syncReplica(joining, transport(url, token, keys), url))
        .rejects.toThrow(`LEDGER_MISMATCH:${await owner.getLedgerId()}`);

      await joining.resetToLedger(await owner.getLedgerId());
      await syncReplica(joining, transport(url, token, keys), url);
      expect(await joining.assets.get(local.id)).toBeNull();
      expect((await joining.assets.list()).map((row) => row.code)).toEqual(['REMOTE']);
    } finally {
      await server.close();
      await owner.close();
      await joining.close();
    }
  });
});
