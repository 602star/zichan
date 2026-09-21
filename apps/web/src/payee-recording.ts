import { newId, type Transaction } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import { catalogPayeeId, findPlatform, matchingPayee } from './payee-catalog.js';

/** The caller's audit transaction commits this together with the ledger record. */
export async function rememberTransactionPayee(store: SqlLedgerStore, entity: Pick<Transaction, 'payeeId' | 'merchant'>): Promise<string | undefined> {
  if (entity.payeeId || !entity.merchant?.trim()) return entity.payeeId;
  const name = entity.merchant.trim();
  const entry = findPlatform(name);
  const existing = matchingPayee(await store.payees.list({ includeDeleted: true }), name, entry);
  if (existing) {
    if (existing.isDeleted || !existing.isActive) throw new Error('这个交易对象已停用或删除，请在管理页恢复后使用。');
    return existing.id;
  }
  const payee = await store.payees.put({
    id: entry ? catalogPayeeId(entry) : newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    name: entry?.name ?? name, aliases: entry ? [entry.name, ...entry.aliases] : [], isActive: true,
  });
  return payee.id;
}
