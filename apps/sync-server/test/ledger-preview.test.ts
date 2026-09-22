import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newId,
  unlockLedgerKeyEnvelope,
  type Asset,
  type Category,
  type Transaction,
} from '@zichan/core';
import {
  httpCommitTransport,
  loginAccount,
  registerAccount,
  syncReplica,
} from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import {
  LedgerPreviewRegistry,
  buildLedgerBackup,
} from '../src/ledger-preview.js';
import { loadCustodyKey } from '../src/key-custody.js';
import { SyncServerStore } from '../src/store.js';
import {
  createTestSyncServer,
  OWNER_SETUP_TOKEN,
} from './support/server-fixture.js';

const MARKER = 'PREVIEW-MARKER-4412';

/**
 * Seed a managed-custody account whose commits are already on the server, then hand
 * the operator view nothing but the server's own stored material.
 */
async function seedAccount(dataDir: string) {
  const custodyKeyPath = join(dataDir, 'custody.key');
  const server = createTestSyncServer({
    dataDir,
    custodyKeyPath,
    custodyEnabled: true,
    accountProtection: 'managed',
  });
  await new Promise<void>((resolve) => server.server.listen(0, resolve));
  await server.ready;
  const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;

  await registerAccount(url, 'preview-user', 'preview-pw', {
    ownerSetupToken: OWNER_SETUP_TOKEN,
  });
  const { accessToken } = await loginAccount(
    url,
    'preview-user',
    'preview-pw',
    {
      deviceId: 'preview-device',
      deviceName: 'Preview',
    },
  );
  const auth = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  const init = await fetch(`${url}/api/v3/protection/initialize`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ mode: 'managed' }),
  });
  expect(init.status).toBe(200);
  const protection = (await init.json()) as {
    secret: string;
    envelope: { ledgerId: string } & Record<string, unknown>;
  };
  const ledgerId = protection.envelope.ledgerId;
  const session = await unlockLedgerKeyEnvelope(
    protection.secret,
    protection.envelope as never,
  );

  const author = await openLedger({ deviceId: 'AUTHOR' });
  await author.adoptLedgerId(ledgerId);
  const asset: Asset = {
    id: newId(),
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    code: 'CNY',
    name: '人民币',
    type: 'fiat',
    decimals: 2,
    isActive: true,
  } as Asset;
  await author.assets.put(asset);
  const category: Category = {
    id: newId(),
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    name: '餐饮',
    type: 'expense',
    isActive: true,
  } as Category;
  await author.categories.put(category);
  const subcategory: Category = {
    id: newId(),
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    name: '午餐',
    type: 'expense',
    parentId: category.id,
    isActive: true,
  } as Category;
  await author.categories.put(subcategory);
  const transaction: Transaction = {
    id: newId(),
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    date: '2026-09-01',
    type: 'expense',
    category: subcategory.id,
    amount: '42.50',
    assetId: asset.id,
    note: MARKER,
  } as Transaction;
  await author.transactions.put(transaction);

  const bound = await fetch(`${url}/api/v3/replica/bind`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ledgerId }),
  });
  expect(bound.status).toBe(200);
  await syncReplica(
    author,
    httpCommitTransport({
      baseUrl: url,
      token: accessToken,
      cryptoSession: session,
      keyEnvelope: protection.envelope as never,
    }),
    url,
  );
  await author.close();

  return { server, custodyKeyPath, ledgerId, url, dataDir };
}

/** Open a second handle on the same sqlite file, as the other store-level tests do. */
function openStore(dataDir: string, serverId: string): SyncServerStore {
  return new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', serverId);
}

describe('admin ledger preview', () => {
  it('builds a portable backup from stored material alone', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-preview-'));
    const { server, custodyKeyPath, ledgerId } = await seedAccount(dataDir);
    const store = openStore(dataDir, server.serverId);
    try {
      const options = {
        store,
        custodyKey: loadCustodyKey(custodyKeyPath, true),
        serverId: server.serverId,
      };
      const {
        backup,
        commitCount,
        ledgerId: reportedLedgerId,
      } = await buildLedgerBackup(options, 'preview-user');

      expect(reportedLedgerId).toBe(ledgerId);
      expect(commitCount).toBeGreaterThan(0);
      expect(backup.transactions.some((t) => t.note === MARKER)).toBe(true);
      expect(backup.transactions.some((t) => t.amount === '42.50')).toBe(true);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('refuses an account the server cannot decrypt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-preview-'));
    const custodyKeyPath = join(dataDir, 'custody.key');
    const server = createTestSyncServer({
      dataDir,
      custodyKeyPath,
      custodyEnabled: true,
    });
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    await server.ready;
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    await registerAccount(url, 'private-user', 'private-pw', {
      ownerSetupToken: OWNER_SETUP_TOKEN,
    });
    const store = openStore(dataDir, server.serverId);
    try {
      await expect(
        buildLedgerBackup(
          {
            store,
            custodyKey: loadCustodyKey(custodyKeyPath, true),
            serverId: server.serverId,
          },
          'private-user',
        ),
      ).rejects.toThrow(/托管模式/);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('expires sessions on the idle window and never persists them', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-preview-'));
    const { server, custodyKeyPath } = await seedAccount(dataDir);
    const store = openStore(dataDir, server.serverId);
    try {
      let clock = 1_000_000;
      const registry = new LedgerPreviewRegistry({
        store,
        custodyKey: loadCustodyKey(custodyKeyPath, true),
        serverId: server.serverId,
        idleTtlMs: 5_000,
        absoluteTtlMs: 60_000,
        now: () => clock,
      });

      const opened = await registry.open('preview-user', 'operator');
      expect(opened.transactionCount).toBeGreaterThan(0);
      expect(registry.read(opened.id)).toBeDefined();

      // Reading slides the window forward.
      clock += 4_000;
      expect(registry.read(opened.id)).toBeDefined();

      // Past the idle window, the session and its plaintext are gone.
      clock += 6_000;
      expect(registry.read(opened.id)).toBeUndefined();
      expect(registry.size()).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('honours the absolute ceiling even while the session is being read', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-preview-'));
    const { server, custodyKeyPath } = await seedAccount(dataDir);
    const store = openStore(dataDir, server.serverId);
    try {
      let clock = 1_000_000;
      const registry = new LedgerPreviewRegistry({
        store,
        custodyKey: loadCustodyKey(custodyKeyPath, true),
        serverId: server.serverId,
        idleTtlMs: 60_000,
        absoluteTtlMs: 20_000,
        now: () => clock,
      });

      const opened = await registry.open('preview-user', 'operator');
      // Keep reading, so the idle window never lapses.
      for (let i = 0; i < 4; i += 1) {
        clock += 4_000;
        expect(registry.read(opened.id)).toBeDefined();
      }
      // The absolute ceiling still ends it.
      clock += 5_000;
      expect(registry.read(opened.id)).toBeUndefined();
    } finally {
      await server.close();
    }
  }, 120_000);
});
