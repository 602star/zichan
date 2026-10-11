import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentPromiseDigest } from '@zichan/core';
import { describe, expect, it } from 'vitest';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';

describe('attachment promise catalog', () => {
  it('resumes sorted pages, publishes atomically, and rejects stale or conflicting frontiers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-attachment-promise-'));
    const node = createTestSyncServer({ dataDir: root });
    let store: SyncServerStore | undefined;
    try {
      await node.ready;
      store = new SyncServerStore(join(root, 'server.sqlite'), 'open', node.serverId);
      await store.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-attachment-promise-0001';
      await store.bindReplica('owner', ledgerId);
      const firstId = '1'.repeat(64);
      const secondId = '2'.repeat(64);
      const upload = await store.beginAttachmentPromise('owner', 2);
      await expect(store.completeAttachmentPromise('owner', upload.uploadId))
        .rejects.toMatchObject({ code: 'ATTACHMENT_PROMISE_INCOMPLETE' });
      await store.appendAttachmentPromisePage('owner', upload.uploadId, [firstId]);
      expect(await store.attachmentPromiseUpload('owner', upload.uploadId)).toMatchObject({
        receivedCount: 1, lastBlobId: firstId,
      });
      await expect(store.appendAttachmentPromisePage('owner', upload.uploadId, [firstId]))
        .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_PROMISE_PAGE' });
      await store.appendAttachmentPromisePage('owner', upload.uploadId, [secondId]);
      const published = await store.completeAttachmentPromise('owner', upload.uploadId);
      expect(published).toMatchObject({ commitCount: 0, blobCount: 2,
        blobHash: attachmentPromiseDigest([firstId, secondId]) });
      expect(await store.attachmentPromiseUpload('owner', upload.uploadId)).toBeUndefined();
      expect(await store.attachmentPromisePage('owner', '', 1)).toMatchObject({
        catalog: published, blobIds: [firstId], nextId: firstId, hasMore: true,
      });
      expect(await store.attachmentPromisePage('owner', firstId, 1)).toMatchObject({
        catalog: published, blobIds: [secondId], nextId: secondId, hasMore: false,
      });

      const conflicting = await store.beginAttachmentPromise('owner', 1);
      await store.appendAttachmentPromisePage('owner', conflicting.uploadId, [firstId]);
      await expect(store.completeAttachmentPromise('owner', conflicting.uploadId))
        .rejects.toMatchObject({ code: 'ATTACHMENT_PROMISE_CONFLICT' });
      expect((await store.attachmentPromisePage('owner')).catalog).toEqual(published);

      const stale = await store.beginAttachmentPromise('owner', 2);
      const commitId = 'commit-attachment-promise-0001';
      await store.pushCommits('owner', [{ commitId, ledgerId, contentHash: 'a'.repeat(64),
        encCommit: { v: 3, keyId: 'test-key-id-0000001', iv: 'test-iv', ct: 'test-ciphertext' } }]);
      await store.appendAttachmentPromisePage('owner', stale.uploadId, [firstId, secondId]);
      await expect(store.completeAttachmentPromise('owner', stale.uploadId))
        .rejects.toMatchObject({ code: 'ATTACHMENT_PROMISE_STALE' });
      expect((await store.attachmentPromisePage('owner')).catalog).toEqual(published);

      const next = await store.beginAttachmentPromise('owner', 1);
      await store.appendAttachmentPromisePage('owner', next.uploadId, [secondId]);
      const replacement = await store.completeAttachmentPromise('owner', next.uploadId);
      expect(replacement).toMatchObject({ commitCount: 1, blobCount: 1 });
      expect((await store.attachmentPromisePage('owner')).blobIds).toEqual([secondId]);
    } finally {
      await store?.close();
      await node.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
