import { decryptBackupChunk, encryptBackupChunk, type LedgerCryptoSession } from '@zichan/core';
import { accountDatabaseName } from '../account-storage.js';
import { deleteKv, loadKv, saveKv } from './idb.js';

export interface ConversionDraft<T> {
  version: 1;
  entityVersion?: number;
  savedAt: string;
  values: T;
}
interface EncryptedDraft {
  version: 1;
  ledgerId: string;
  keyringId: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** Capture both account storage and the unlocked ledger; asynchronous writes never follow an account switch. */
export function createConversionDraftStore<T>(session: LedgerCryptoSession, recordId = 'new', databaseName = accountDatabaseName()) {
  const key = `conversion-draft.v1.${encodeURIComponent(session.ledgerId)}.${encodeURIComponent(recordId)}`;
  const context = { purpose: 'conversion-draft', version: 1, ledgerId: session.ledgerId, keyringId: session.keyringId, recordId };
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const enqueue = <R>(work: () => Promise<R>): Promise<R> => {
    const next = queue.catch(() => undefined).then(work);
    queue = next;
    return next;
  };
  return {
    async load(): Promise<ConversionDraft<T> | null> {
      const row = await loadKv<EncryptedDraft>(key, databaseName);
      if (!row) return null;
      if (row.version !== 1 || row.ledgerId !== session.ledgerId || row.keyringId !== session.keyringId) throw new Error('草稿身份不匹配，已保留原草稿');
      const bytes = await decryptBackupChunk(session, { v: 1, iv: row.iv, ciphertext: row.ciphertext }, context);
      const draft = JSON.parse(new TextDecoder().decode(bytes)) as ConversionDraft<T>;
      if (draft.version !== 1 || !draft.values || typeof draft.values !== 'object') throw new Error('草稿格式不受支持，已保留原草稿');
      return draft;
    },
    save(values: T, entityVersion?: number): Promise<void> {
      if (closed) return Promise.resolve();
      const draft: ConversionDraft<T> = { version: 1, savedAt: new Date().toISOString(), values: structuredClone(values), entityVersion };
      return enqueue(async () => {
        if (closed) return;
        const encrypted = await encryptBackupChunk(session, new TextEncoder().encode(JSON.stringify(draft)), context);
        if (closed) return;
        await saveKv<EncryptedDraft>(key, { version: 1, ledgerId: session.ledgerId, keyringId: session.keyringId, iv: encrypted.iv, ciphertext: encrypted.ciphertext }, databaseName);
      });
    },
    clear(): Promise<void> { return enqueue(() => deleteKv(key, databaseName)); },
    finish(): Promise<void> {
      closed = true;
      return enqueue(() => deleteKv(key, databaseName));
    },
  };
}
