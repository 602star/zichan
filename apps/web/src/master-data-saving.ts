import { D, type ScheduledTransaction } from '@zichan/core';
import { normalizeIdentity, type SqlLedgerStore } from '@zichan/db';

export async function scheduleDuplicateWarning(store: SqlLedgerStore, row: ScheduledTransaction): Promise<string | undefined> {
  const rows = await store.scheduledTransactions.list();
  const keys = ['type', 'category', 'assetId', 'accountId', 'transferAssetId', 'transferAccountId', 'frequency', 'anchorDate', 'time', 'timezone', 'anchorMode', 'endDate'] as const;
  const same = (a: ScheduledTransaction, b: ScheduledTransaction) => keys.every((key) => (a[key] ?? '') === (b[key] ?? '')) && D(a.amount).eq(b.amount) && D(a.transferAmount ?? 0).eq(b.transferAmount ?? 0);
  const current = rows.find((item) => item.id === row.id);
  if (current && normalizeIdentity(current.name) === normalizeIdentity(row.name) && same(current, row)) return undefined;
  const matching = rows.filter((item) => item.id !== row.id && !item.isDeleted && (normalizeIdentity(item.name) === normalizeIdentity(row.name) || same(item, row)));
  if (!matching.length) return undefined;
  const exact = matching.some((item) => same(item, row));
  return `${exact ? '已有类型、金额、账户和周期相同的计划，可能重复生成流水。' : '已有同名计划，请确认它们是不同账单。'} ${matching.map((item) => `${item.name}（金额 ${item.amount}）`).join('、')}`;
}
