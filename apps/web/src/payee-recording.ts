import { newId, type Transaction } from '@zichan/core';
import { normalizeIdentity, type SqlLedgerStore } from '@zichan/db';
import { catalogPayeeId, findPlatform, matchingPayee } from './payee-catalog.js';

/** The caller's audit transaction commits this together with the ledger record. */
export async function rememberTransactionPayee(store: SqlLedgerStore, entity: Pick<Transaction, 'payeeId' | 'merchant'>): Promise<string | undefined> {
  if (entity.payeeId || !entity.merchant?.trim()) return entity.payeeId;
  const name = entity.merchant.trim();
  const entry = findPlatform(name);
  const rows = await store.payees.list({ includeDeleted: true });
  const matches = rows.filter((row) => [row.name, ...(row.aliases ?? [])].some((n) => normalizeIdentity(n) === normalizeIdentity(name)));
  if (matches.length > 1) throw new Error('有多个匹配的交易对象，请从列表明确选择');
  const existing = matches[0] ?? matchingPayee(rows, name, entry);
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

/** Call inside the same audit transaction as the owning schedule/template/record. */
export async function withRememberedPayee<T extends { payeeId?: string; merchant?: string }>(store: SqlLedgerStore, entity: T): Promise<T> {
  return { ...entity, payeeId: await rememberTransactionPayee(store, entity) };
}

export async function withCashflowPayee<T extends { mode: string; createTransaction?: { payeeId?: string; merchant?: string } }>(store: SqlLedgerStore, draft: T): Promise<T> {
  return draft.mode === 'create_transaction' && draft.createTransaction
    ? { ...draft, createTransaction: await withRememberedPayee(store, draft.createTransaction) }
    : draft;
}
