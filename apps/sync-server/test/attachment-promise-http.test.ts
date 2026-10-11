import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { attachmentPromiseDigest } from '@zichan/core';
import { loginAccount, registerAccount } from '@zichan/db';
import { describe, expect, it } from 'vitest';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('attachment promise HTTP', () => {
  it('requires a ledger session and accepts a paged catalog for its selected replica', async () => {
    const node = createTestSyncServer();
    await new Promise<void>((resolve) => node.server.listen(0, resolve));
    const url = `http://localhost:${(node.server.address() as AddressInfo).port}`;
    let store: SyncServerStore | undefined;
    try {
      await registerAccount(url, 'owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const login = await loginAccount(url, 'owner', 'account-password');
      store = new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId);
      const ledgerId = 'ledger-promise-http-0001';
      await store.bindReplica('owner', ledgerId);
      await store.putKeyEnvelope('owner', ledgerId, 'keyring-promise-http-0001', 1,
        { ledgerId, keyringId: 'keyring-promise-http-0001', generation: 1 });
      const headers = { Authorization: `Bearer ${login.accessToken}`, 'Content-Type': 'application/json' };
      const request = (path: string, method: 'GET' | 'POST', body?: object) => fetch(`${url}${path}`,
        { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect((await fetch(`${url}/api/v4/ledger/attachment-promise?limit=1`)).status).toBe(401);
      const first = await request('/api/v4/ledger/attachment-promise', 'GET');
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ catalog: null, blobIds: [] });
      const started = await request('/api/v4/ledger/attachment-promise/uploads', 'POST', { expectedCount: 2 });
      expect(started.status).toBe(201);
      const upload = await started.json() as { uploadId: string };
      const firstId = '1'.repeat(64);
      const secondId = '2'.repeat(64);
      const page = await request(`/api/v4/ledger/attachment-promise/uploads/${upload.uploadId}/pages`,
        'POST', { blobIds: [firstId, secondId] });
      expect(page.status).toBe(200);
      expect(await page.json()).toMatchObject({ receivedCount: 2, lastBlobId: secondId });
      const complete = await request(`/api/v4/ledger/attachment-promise/uploads/${upload.uploadId}/complete`, 'POST');
      expect(complete.status).toBe(200);
      expect(await complete.json()).toMatchObject({ catalog: {
        commitCount: 0, blobCount: 2, blobHash: attachmentPromiseDigest([firstId, secondId]),
      } });
      const read = await request('/api/v4/ledger/attachment-promise?limit=1', 'GET');
      expect(await read.json()).toMatchObject({ blobIds: [firstId], hasMore: true });
      expect((await store.replicaInventory('owner', ledgerId)).missingPromisedBlobCount).toBe(2);
    } finally {
      await store?.close();
      await node.close();
    }
  });
});
