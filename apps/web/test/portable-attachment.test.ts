import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type Asset } from '@zichan/core';
import { openLedger } from '@zichan/db/node';
import {
  abortPreparedAttachments,
  attachmentStorageStatus,
  commitPreparedAttachment,
  commitPreparedStorageState,
  finalizePreparedAttachment,
  prepareAttachmentDraft,
  recoverAttachmentStorage,
  reconcileAttachmentStorage,
  verifyAttachmentContent,
} from '../src/db/attachment-storage.js';
import {
  exportPortableLedger,
  importPortableLedger,
  preflightPortableBackup,
  setPortableAttachmentSource,
} from '../src/db/portable-backup.js';
import { lockDeviceStorage, unlockDeviceStorage } from '../src/device-storage-key.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function installAttachmentMock() {
  const files = new Map<string, number[]>();
  const key = (area: string, value: string) => `${area}:${value}`;
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const tempKey = String(args?.['tempKey'] ?? '');
    const sha256 = String(args?.['sha256'] ?? '');
    const area = String(args?.['area'] ?? 'objects');
    if (command === 'native_attachment_storage_status') {
      return { directory: 'memory', availableBytes: Number.MAX_SAFE_INTEGER } as T;
    }
    if (command === 'native_attachment_stage_begin') {
      files.set(key('staging', tempKey), []);
      return { path: tempKey, sizeBytes: 0 } as T;
    }
    if (command === 'native_attachment_stage_append') {
      const current = files.get(key('staging', tempKey));
      if (!current) throw new Error('missing staged fixture file');
      const next = current.concat(args?.['chunk'] as number[]);
      files.set(key('staging', tempKey), next);
      return { path: tempKey, sizeBytes: next.length } as T;
    }
    if (command === 'native_attachment_stage_commit' || command === 'native_attachment_stage_status') {
      const value = files.get(key('staging', tempKey));
      if (value === undefined) throw new Error('missing staged fixture file');
      return { path: tempKey, sizeBytes: value.length } as T;
    }
    if (command === 'native_attachment_stage_read_range') {
      const value = files.get(key('staging', tempKey));
      if (value === undefined) throw new Error('missing staged fixture file');
      const offset = Number(args?.['offset'] ?? 0);
      return value.slice(offset, offset + Number(args?.['length'] ?? 0)) as T;
    }
    if (command === 'native_attachment_stage_discard') {
      files.delete(key('staging', tempKey));
      return undefined as T;
    }
    if (command === 'native_attachment_promote') {
      const staged = files.get(key('staging', tempKey));
      if (!files.has(key('objects', sha256)) && staged === undefined) throw new Error('missing staged fixture file');
      if (staged !== undefined) files.set(key('objects', sha256), staged);
      files.delete(key('staging', tempKey));
      return { path: sha256, sizeBytes: staged?.length ?? 0 } as T;
    }
    if (command === 'native_attachment_status') {
      const value = files.get(key(area, sha256));
      if (value === undefined) throw new Error('missing fixture file');
      return { path: sha256, sizeBytes: value.length } as T;
    }
    if (command === 'native_attachment_read_range') {
      const value = files.get(key(area, sha256));
      if (value === undefined) throw new Error('missing fixture file');
      const offset = Number(args?.['offset'] ?? 0);
      return value.slice(offset, offset + Number(args?.['length'] ?? 0)) as T;
    }
    if (command === 'native_attachment_exists') return files.has(key(area, sha256)) as T;
    if (command === 'native_attachment_trash') {
      const value = files.get(key('objects', sha256));
      if (value !== undefined) files.set(key('trash', sha256), value);
      files.delete(key('objects', sha256));
      return undefined as T;
    }
    if (command === 'native_attachment_restore') {
      const value = files.get(key('trash', sha256));
      if (value !== undefined) files.set(key('objects', sha256), value);
      files.delete(key('trash', sha256));
      return undefined as T;
    }
    if (command === 'native_attachment_purge') {
      for (const name of ['objects', 'trash', 'quarantine']) files.delete(key(name, sha256));
      return undefined as T;
    }
    return undefined as T;
  };
  (globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: { invoke } };
  return files;
}

beforeEach(async () => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
  await unlockDeviceStorage('device-storage-test-password');
});

afterEach(async () => {
  await lockDeviceStorage();
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

describe('portable attachment storage', () => {
  it('recovers a database-committed staged body after an interrupted promotion', async () => {
    const files = installAttachmentMock();
    const store = await openLedger({ deviceId: 'attachment-recovery' });
    try {
      const owner = await store.assets.put({
        id: newId(), code: 'REC', name: 'Recovery owner', type: 'fixed', decimals: 2, isActive: true,
        createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      } as Asset);
      const id = newId();
      const prepared = await prepareAttachmentDraft(store, id, {
        fileName: 'recover.txt',
        mimeType: 'text/plain',
        contentBlob: new Blob(['recover me'], { type: 'text/plain' }),
      });
      const attachment = await store.transaction((transaction) => commitPreparedAttachment(transaction, prepared, 'asset', owner.id));
      expect(await attachmentStorageStatus(attachment.sha256)).toBe('missing');
      expect([...files.keys()].some((value) => value.startsWith('staging:'))).toBe(true);

      await recoverAttachmentStorage(store);
      expect(await attachmentStorageStatus(attachment.sha256)).toBe('ready');
      expect(await verifyAttachmentContent(attachment)).toBe(true);
      expect((await store.attachmentState.getFileOp(prepared.operationId!))?.phase).toBe('completed');
      expect([...files.keys()].some((value) => value.startsWith('staging:'))).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('discards staged bytes when the metadata transaction rolls back', async () => {
    const files = installAttachmentMock();
    const store = await openLedger({ deviceId: 'attachment-rollback' });
    try {
      const prepared = await prepareAttachmentDraft(store, newId(), {
        fileName: 'rollback.txt',
        mimeType: 'text/plain',
        contentBlob: new Blob(['must not remain'], { type: 'text/plain' }),
      });
      await expect(store.transaction(async (transaction) => {
        await commitPreparedStorageState(transaction, prepared);
        throw new Error('injected metadata failure');
      })).rejects.toThrow('injected metadata failure');
      await abortPreparedAttachments(store, [prepared]);
      expect((await store.attachmentState.getFileOp(prepared.operationId!))?.phase).toBe('aborted');
      expect([...files.keys()].some((value) => value.startsWith('staging:'))).toBe(false);
      expect(await attachmentStorageStatus(prepared.metadata.sha256)).toBe('missing');
    } finally {
      await store.close();
    }
  });

  it('removes partial native staging files when a chunked write is cancelled', async () => {
    const files = installAttachmentMock();
    const store = await openLedger({ deviceId: 'attachment-cancel' });
    const controller = new AbortController();
    try {
      await expect(prepareAttachmentDraft(store, newId(), {
        fileName: 'large.bin',
        mimeType: 'application/octet-stream',
        contentBlob: new Blob([new Uint8Array(700 * 1024)]),
      }, 'create', {
        signal: controller.signal,
        onProgress(progress) {
          if (progress.phase === 'writing' && progress.transferredBytes > 0) controller.abort();
        },
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect([...files.keys()].some((value) => value.startsWith('staging:'))).toBe(false);
      expect((await store.attachmentState.listFileOps(['failed']))).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('commits content-addressed files and moves unreferenced bodies to trash', async () => {
    const files = installAttachmentMock();
    const store = await openLedger({ deviceId: 'attachment-cas' });
    try {
      const owner = await store.assets.put({
        id: newId(), code: 'CAS', name: 'CAS owner', type: 'fixed', decimals: 2, isActive: true,
        createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      } as Asset);
      const id = newId();
      const prepared = await prepareAttachmentDraft(store, id, {
        fileName: 'receipt.txt',
        mimeType: 'text/plain',
        contentBlob: new Blob(['hello'], { type: 'text/plain' }),
        thumbnailBlob: new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }),
      });
      const attachment = await store.transaction((transaction) => commitPreparedAttachment(transaction, prepared, 'asset', owner.id));
      await finalizePreparedAttachment(store, prepared);

      expect(attachment.sizeBytes).toBe(5);
      expect(attachment.sha256).toHaveLength(64);
      expect(attachment.thumbnailSha256).toHaveLength(64);
      expect(await verifyAttachmentContent(attachment)).toBe(true);
      expect(await attachmentStorageStatus(attachment.sha256)).toBe('ready');

      await store.attachments.remove(id, attachment.version);
      await reconcileAttachmentStorage(store);
      expect(await attachmentStorageStatus(attachment.sha256)).toBe('trash');
      expect([...files.keys()].some((value) => value.startsWith('staging:'))).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('includes attachment bytes in backup and restores metadata with checksums intact', async () => {
    installAttachmentMock();
    const source = await openLedger({ deviceId: 'portable-source' });
    const target = await openLedger({ deviceId: 'portable-target' });
    try {
      const id = newId();
      const assetId = newId();
      await source.assets.put({
        id: assetId, code: 'DOC', name: 'Document asset', type: 'fixed', decimals: 2, isActive: true,
        createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      } as Asset);
      const prepared = await prepareAttachmentDraft(source, id, {
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
        contentBlob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
      });
      await source.transaction((transaction) => commitPreparedAttachment(transaction, prepared, 'asset', assetId));
      await finalizePreparedAttachment(source, prepared);

      const backup = await exportPortableLedger(source);
      expect('contentBase64' in (backup.attachments[0] ?? {})).toBe(false);
      expect((await preflightPortableBackup(backup)).ok).toBe(true);
      await importPortableLedger(target, backup);
      const restored = await target.attachments.get(id);
      expect(restored?.sha256).toBe(prepared.metadata.sha256);
      expect(restored && await verifyAttachmentContent(restored)).toBe(true);

      const corrupt = structuredClone(backup);
      setPortableAttachmentSource(corrupt, async () => new Blob(['corrupt'], { type: 'application/pdf' }));
      await expect(importPortableLedger(target, corrupt)).rejects.toThrow(/SHA-256|大小/);
      expect((await preflightPortableBackup(corrupt)).ok).toBe(false);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('rolls back business replacement when full-device state fails validation', async () => {
    installAttachmentMock();
    const source = await openLedger({ deviceId: 'device-source' });
    const target = await openLedger({ deviceId: 'device-target' });
    try {
      const incoming = await source.assets.put({
        id: newId(), code: 'NEW', name: 'Incoming', type: 'fiat', decimals: 2, isActive: true,
        createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      } as Asset);
      const existing = await target.assets.put({
        id: newId(), code: 'KEEP', name: 'Keep on rollback', type: 'fiat', decimals: 2, isActive: true,
        createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      } as Asset);
      const backup = await exportPortableLedger(source);
      const state = await source.exportDeviceRecoveryState();
      state.tables['unknown_table'] = [];

      await expect(importPortableLedger(target, backup, 'replace', { deviceState: state })).rejects.toThrow('未知表');
      expect(await target.assets.get(existing.id)).toMatchObject({ isDeleted: false, code: 'KEEP' });
      expect(await target.assets.get(incoming.id)).toBeNull();
    } finally {
      await source.close();
      await target.close();
    }
  });
});
