import { decryptBackupChunk, encryptBackupChunk, type LedgerCryptoSession } from '@zichan/core';
import { accountScopeKey, createAccountScope, type AccountScope } from '../account-scope.js';
import { deleteKv, hasKv, loadKv, moveKv, saveKv } from './idb.js';

interface AccountDatabaseSnapshot {
  format: 'zichan-account-database';
  version: 1;
  scopeKey: string;
  storageId: string;
  keyringId: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** An immutable, captured scope: a late operation cannot follow an account switch. */
export function createAccountCache(input: AccountScope) {
  const scope = createAccountScope(input);
  const scopeKey = accountScopeKey(scope);
  const databaseName = `zichan-account:${scopeKey}`;
  const get = <T>(key: string) => loadKv<T>(key, databaseName);
  const put = <T>(key: string, value: T) => saveKv(key, value, databaseName);
  const context = (session: LedgerCryptoSession) => ({
    purpose: 'zichan-account-database', version: 1, scopeKey,
    storageId: session.ledgerId, keyringId: session.keyringId,
  });
  return Object.freeze({
    scope, databaseName, get, put,
    has: (key: string) => hasKv(key, databaseName),
    remove: (key: string) => deleteKv(key, databaseName),
    move: (source: string, target: string) => moveKv(source, target, databaseName),
    async saveDatabase(bytes: Uint8Array, session: LedgerCryptoSession): Promise<void> {
      const encrypted = await encryptBackupChunk(session, bytes, context(session));
      await put<AccountDatabaseSnapshot>('ledger.sqlite', {
        format: 'zichan-account-database', version: 1, scopeKey,
        storageId: session.ledgerId, keyringId: session.keyringId,
        iv: encrypted.iv, ciphertext: encrypted.ciphertext,
      });
    },
    async loadDatabase(session: LedgerCryptoSession): Promise<Uint8Array | null> {
      const row = await get<Partial<AccountDatabaseSnapshot>>('ledger.sqlite');
      if (row === null) return null;
      if (row.format !== 'zichan-account-database' || row.version !== 1 || row.scopeKey !== scopeKey
        || row.storageId !== session.ledgerId || row.keyringId !== session.keyringId
        || !(row.iv instanceof Uint8Array) || row.iv.length !== 12
        || !(row.ciphertext instanceof Uint8Array) || row.ciphertext.length < 16) {
        throw new Error('账号缓存身份不匹配或格式损坏，已保留原数据');
      }
      return decryptBackupChunk(session, { v: 1, iv: row.iv, ciphertext: row.ciphertext }, context(session));
    },
  });
}
