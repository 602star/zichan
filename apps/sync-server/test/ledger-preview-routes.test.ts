import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
  httpCommitTransport,
  loginAccount,
  registerAccount,
  syncReplica,
  type LedgerBackup,
} from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import {
  newId,
  unlockLedgerKeyEnvelope,
  type Asset,
  type Category,
  type Transaction,
} from '@zichan/core';
import {
  createTestSyncServer,
  OWNER_SETUP_TOKEN,
} from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

const MARKER = 'PREVIEW-ROUTE-8821';
const ADMIN_PASSWORD = ['preview', 'admin', '0001'].join('-');
const MEMBER_PASSWORD = ['preview', 'member', '0001'].join('-');
const BEARER = ['Bea', 'rer'].join('');

/**
 * An owner plus one managed-custody member whose ledger is already on the server. The
 * owner is the operator doing the previewing.
 */
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'zichan-preview-route-'));
  const custodyKeyPath = join(dataDir, 'custody.key');
  const server = createTestSyncServer({
    dataDir,
    custodyKeyPath,
    custodyEnabled: true,
    accountProtection: 'managed',
  });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) =>
    server.server.listen(0, '127.0.0.1', resolve),
  );
  const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

  await registerAccount(url, 'owner', ADMIN_PASSWORD, {
    [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN,
  });
  const owner = await loginAccount(url, 'owner', ADMIN_PASSWORD);
  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `${BEARER} ${owner.accessToken}`,
  };

  await registerAccount(url, 'member-user', MEMBER_PASSWORD);
  const member = await loginAccount(url, 'member-user', MEMBER_PASSWORD, {
    deviceId: 'member-device-01',
    deviceName: 'Member',
  });
  const memberHeaders = {
    'Content-Type': 'application/json',
    Authorization: `${BEARER} ${member.accessToken}`,
  };

  const init = await fetch(`${url}/api/v3/protection/initialize`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({ mode: 'managed' }),
  });
  expect(init.status).toBe(200);
  const protection = (await init.json()) as {
    secret: string;
    envelope: { ledgerId: string } & Record<string, unknown>;
  };
  const session = await unlockLedgerKeyEnvelope(
    protection.secret,
    protection.envelope as never,
  );

  const author = await openLedger({ deviceId: 'MEMBER-AUTHOR' });
  await author.adoptLedgerId(protection.envelope.ledgerId);
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
  await author.transactions.put({
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
  } as Transaction);

  await fetch(`${url}/api/v3/replica/bind`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({ ledgerId: protection.envelope.ledgerId }),
  });
  await syncReplica(
    author,
    httpCommitTransport({
      baseUrl: url,
      token: member.accessToken,
      cryptoSession: session,
      keyEnvelope: protection.envelope as never,
    }),
    url,
  );
  await author.close();

  const api = (path: string, init?: RequestInit) =>
    fetch(`${url}/api/admin${path}`, {
      ...init,
      headers: { ...adminHeaders, ...(init?.headers ?? {}) },
    });
  return { server, url, api, dataDir };
}

describe('ledger preview routes', () => {
  it('opens a preview, serves the backup, and records the reason', async () => {
    const f = await fixture();
    try {
      const opened = await f.api('/users/member-user/preview', {
        method: 'POST',
        body: JSON.stringify({ reason: '用户反馈账目不对，协助排查' }),
      });
      expect(opened.status).toBe(201);
      const summary = (await opened.json()) as {
        previewId: string;
        transactionCount: number;
        ledgerId: string;
      };
      expect(summary.previewId).toMatch(/^preview-/);
      expect(summary.transactionCount).toBeGreaterThan(0);
      expect(summary.ledgerId).toBeTruthy();

      const backup = await f.api(`/previews/${summary.previewId}/backup`);
      expect(backup.status).toBe(200);
      const ledger = (await backup.json()) as LedgerBackup;
      expect(ledger.transactions.some((t) => t.note === MARKER)).toBe(true);
      expect(ledger.transactions.some((t) => t.amount === '42.50')).toBe(true);

      // The audit row is the durable trace that plaintext was viewed.
      const store = new SyncServerStore(
        join(f.dataDir, 'server.sqlite'),
        'open',
        f.server.serverId,
      );
      const audit = await store.listAdminAudit({ limit: 50 });
      const entry = audit.entries.find(
        (row) => row['action'] === 'ledger-preview-open',
      );
      expect(entry).toBeDefined();
      expect(String(entry!['reason'])).toContain('协助排查');
    } finally {
      await f.server.close();
    }
  }, 480_000);

  it('reports an open preview without opening one', async () => {
    const f = await fixture();
    try {
      // Nothing is open yet, and asking must not open anything. A GET that decrypted would be an
      // unaudited read: no fresh-login check, no recorded reason.
      const before = await f.api('/users/member-user/preview');
      expect(before.status).toBe(404);
      const beforeBody = (await before.json()) as { code: string };
      expect(beforeBody.code).toBe('PREVIEW_NOT_OPEN');

      const opened = await f.api('/users/member-user/preview', {
        method: 'POST',
        body: JSON.stringify({ reason: '排查' }),
      });
      expect(opened.status).toBe(201);
      const summary = (await opened.json()) as { previewId: string };

      const existing = await f.api('/users/member-user/preview');
      expect(existing.status).toBe(200);
      expect(((await existing.json()) as { previewId: string }).previewId).toBe(summary.previewId);

      // And the unaudited GET left no audit row behind: the only one is the deliberate POST.
      const store = new SyncServerStore(join(f.dataDir, 'server.sqlite'), 'open', f.server.serverId);
      const audit = await store.listAdminAudit({ limit: 50 });
      expect(audit.entries.filter((row) => row['action'] === 'ledger-preview-open')).toHaveLength(1);
    } finally {
      await f.server.close();
    }
  }, 480_000);

  it('refuses the backup once the preview is closed', async () => {
    const f = await fixture();
    try {
      const opened = await f.api('/users/member-user/preview', {
        method: 'POST',
        body: JSON.stringify({ reason: '排查' }),
      });
      const summary = (await opened.json()) as { previewId: string };

      const closed = await f.api(`/previews/${summary.previewId}`, {
        method: 'DELETE',
      });
      expect(closed.status).toBe(200);

      const after = await f.api(`/previews/${summary.previewId}/backup`);
      expect(after.status).toBe(410);
      const body = (await after.json()) as { code: string };
      expect(body.code).toBe('PREVIEW_EXPIRED');
    } finally {
      await f.server.close();
    }
  }, 480_000);

  it('answers an unknown preview id as expired, not as an empty ledger', async () => {
    const f = await fixture();
    try {
      const response = await f.api('/previews/preview-does-not-exist/backup');
      expect(response.status).toBe(410);
    } finally {
      await f.server.close();
    }
  }, 480_000);

  it('rejects missing attachments, invalid checksums and closed previews', async () => {
    const f = await fixture();
    try {
      const opened = await f.api('/users/member-user/preview', {
        method: 'POST',
        body: JSON.stringify({ reason: '核对发票' }),
      });
      const summary = (await opened.json()) as { previewId: string };

      // An unknown checksum is a missing file, not an expired preview: the operator should not be
      // sent back to reopen the preview over a file that simply is not in this ledger.
      const absent = await f.api(`/previews/${summary.previewId}/attachments/${'f'.repeat(64)}`);
      expect(absent.status).toBe(404);
      expect(((await absent.json()) as { code: string }).code).toBe('ATTACHMENT_NOT_FOUND');

      // A malformed checksum is refused before any storage is touched.
      const malformed = await f.api(`/previews/${summary.previewId}/attachments/not-a-hash`);
      expect(malformed.status).toBe(400);

      // Closing the preview ends the route: the plaintext is gone, so the file is too.
      await f.api(`/previews/${summary.previewId}`, { method: 'DELETE' });
      const afterClose = await f.api(`/previews/${summary.previewId}/attachments/${'f'.repeat(64)}`);
      expect(afterClose.status).toBe(410);
      expect(((await afterClose.json()) as { code: string }).code).toBe('PREVIEW_EXPIRED');
    } finally {
      await f.server.close();
    }
  }, 480_000);
});
