import { describe, expect, it } from 'vitest';
import { fixedAssetCost, newId, parseFixedOperatingCost, type FixedAssetEvent, type FixedOperatingCost } from '@zichan/core';
import { checkConsistency, deleteFixedAssetEvent, exportLedger, restoreDeletedFixedAssetEvent, restoreLedger, saveFixedAssetEvent, saveTransaction, undoBusinessCompensation, type FixedAssetCashflowDraft } from '../src/index.js';
import { openLedger } from '../src/node.js';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });
async function setup() {
  const store = await openLedger();
  const currency = await store.assets.put({ ...base(), code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true });
  await store.settings.put({ ...base(), baseCurrencyAssetId: currency.id, defaultLotMethod: 'fifo' });
  const parent = await store.fixedAssetCategories.put({ ...base(), name: '家电', isActive: true });
  const category = await store.fixedAssetCategories.put({ ...base(), name: '净水器', parentId: parent.id, isActive: true });
  const item = await store.fixedAssets.put({ ...base(), name: '净水器', categoryId: category.id, status: 'active', purchaseDate: '2026-01-01', baseCurrencyAssetId: currency.id });
  const account = await store.accounts.put({ ...base(), name: '银行', kind: 'bank', isActive: true });
  const expenseParent = await store.categories.put({ ...base(), name: '家庭', type: 'expense', isActive: true });
  const expense = await store.categories.put({ ...base(), name: '电费', type: 'expense', parentId: expenseParent.id, isActive: true });
  const save = async (data: Partial<FixedOperatingCost>, date = '2026-01-02', cashflow?: FixedAssetCashflowDraft, existing?: FixedAssetEvent) => saveFixedAssetEvent(store, {
    event: { ...(existing ?? base()), fixedAssetId: item.id, type: 'operating_cost', date, amountBase: '0',
      operatingCostJson: JSON.stringify({ version: 1, mode: 'quantity', name: '电费', unit: 'kWh', source: 'manual', ...data }) }, cashflow,
  });
  return { store, currency, item, account, expense, save };
}
describe('使用费用资金处理与计量历史', () => {
  it('also guards persistent audit undo when later meter readings depend on the operation', async () => {
    const { store, save } = await setup();
    try {
      const start = await save({ mode: 'start', meterId: 'plug', reading: '10' }, '2026-01-01');
      const undoStart = await store.consumeLatestBusinessCompensation();
      const read = await save({ mode: 'reading', meterId: 'plug', reading: '15' });
      await expect(undoBusinessCompensation(store, undoStart!.id)).rejects.toThrow('后续计量记录依赖');
      expect((await store.fixedAssetEvents.get(start.event.id))?.isDeleted).toBe(false);
      await deleteFixedAssetEvent(store, read.event);
      const undoDelete = await store.consumeLatestBusinessCompensation();
      await save({ mode: 'reading', meterId: 'plug', reading: '17' }, '2026-01-03');
      await expect(undoBusinessCompensation(store, undoDelete!.id)).rejects.toThrow('后续用量会改变');
      expect((await store.fixedAssetEvents.get(read.event.id))?.isDeleted).toBe(true);
    } finally { await store.close(); }
  });
  it('records quantities without payment, freezes costs and round-trips metadata in backup', async () => {
    const { store, item, save } = await setup(); const restored = await openLedger();
    try {
      await save({ mode: 'start', meterId: 'plug', reading: '100' }, '2026-01-01');
      await save({ mode: 'reading', meterId: 'plug', reading: '101', unitPrice: '0.6' });
      await save({ mode: 'pause', meterId: 'plug' }, '2026-01-03');
      await save({ mode: 'resume', meterId: 'plug', reading: '150' }, '2026-01-09');
      await save({ mode: 'reading', meterId: 'plug', reading: '152' }, '2026-01-10');
      expect(await store.transactions.list()).toHaveLength(0);
      expect(await checkConsistency(store)).toEqual([]);
      expect(fixedAssetCost(item, await store.fixedAssetEvents.list(), '2026-01-10').netCost).toBe('0.6');
      await restoreLedger(restored, await exportLedger(store));
      expect((await restored.fixedAssetEvents.list()).map((event) => event.operatingCostJson).sort()).toEqual((await store.fixedAssetEvents.list()).map((event) => event.operatingCostJson).sort());
    } finally { await restored.close(); await store.close(); }
  });
  it('allocates an existing bill once, rejects over-allocation atomically and leaves the bill when unlinked', async () => {
    const { store, currency, account, expense, save } = await setup();
    try {
      const transaction = await saveTransaction(store, { ...base(), date: '2026-01-02', type: 'expense', category: expense.id, assetId: currency.id, accountId: account.id, amount: '20' });
      const first = await save({ quantity: '10', billedAmount: '12' }, '2026-01-02', { mode: 'linked_transaction', linkedTransactionId: transaction.id, sourceAmount: '12' });
      await expect(save({ quantity: '10', billedAmount: '12' }, '2026-01-02', { mode: 'linked_transaction', linkedTransactionId: transaction.id, sourceAmount: '12' })).rejects.toThrow('尚未分配');
      expect(await store.fixedAssetEvents.list()).toHaveLength(1);
      expect(await store.transactions.list()).toHaveLength(1);
      await deleteFixedAssetEvent(store, first.event);
      expect((await store.transactions.get(transaction.id))?.recordState).not.toBe('voided');
    } finally { await store.close(); }
  });
  it('creates exactly one charging payment, compensates deletion, and excludes estimates from cash flow', async () => {
    const { store, account, expense, save } = await setup();
    try {
      const saved = await save({ quantity: '30', unitPrice: '0.6', serviceFee: '3', billedAmount: '22.55' }, '2026-01-02',
        { mode: 'create_transaction', sourceAmount: '22.55', createTransaction: { categoryId: expense.id, accountId: account.id } });
      expect(saved.event.amountBase).toBe('22.55'); expect(saved.transaction?.amount).toBe('22.55');
      expect(await checkConsistency(store)).toEqual([]);
      const deleted = await deleteFixedAssetEvent(store, saved.event);
      expect((await store.transactions.get(saved.transaction!.id))?.recordState).toBe('voided');
      await restoreDeletedFixedAssetEvent(store, deleted);
      expect((await store.transactions.get(saved.transaction!.id))?.recordState).toBe('active');
      await expect(save({ mode: 'estimate', quantity: '4', unitPrice: '0.6', fromDate: '2026-01-10', toDate: '2026-01-12' }, '2026-01-12',
        { mode: 'linked_transaction', linkedTransactionId: saved.transaction!.id, sourceAmount: '1' })).rejects.toThrow('不能关联资金');
      expect(await store.transactions.list()).toHaveLength(1);
    } finally { await store.close(); }
  });
  it('guards dependent readings while allowing historical price completion and safe latest-entry undo', async () => {
    const { store, save } = await setup();
    try {
      const start = await save({ mode: 'start', meterId: 'plug', reading: '10' }, '2026-01-01');
      const read = await save({ mode: 'reading', meterId: 'plug', reading: '15' });
      const next = await save({ mode: 'reading', meterId: 'plug', reading: '17' }, '2026-01-03');
      await expect(deleteFixedAssetEvent(store, start.event)).rejects.toThrow('后续读数');
      await expect(save({ ...parseFixedOperatingCost(read.event.operatingCostJson), reading: '16' }, read.event.date, undefined, read.event)).rejects.toThrow('历史记录只能');
      const priced = await save({ ...parseFixedOperatingCost(read.event.operatingCostJson), unitPrice: '0.6' }, read.event.date, undefined, read.event);
      expect(priced.event.amountBase).toBe('3.00');
      const deleted = await deleteFixedAssetEvent(store, next.event);
      await restoreDeletedFixedAssetEvent(store, deleted);
      expect((await store.fixedAssetEvents.get(next.event.id))?.isDeleted).toBe(false);
    } finally { await store.close(); }
  });
});
