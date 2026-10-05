import { describe, expect, it } from 'vitest';
import { newId, type FixedAsset, type FixedAssetConsumable, type FixedAssetEvent } from '@zichan/core';
import { openLedger } from '@zichan/db/node';
import { materializeScheduledTransaction, saveFixedAssetAcquisition, saveFixedAssetEvent, saveFixedAssetConsumable, saveGameRecordAggregate } from '@zichan/db';
import { initializeEmptyLedger, QUICK_START_LEDGER_OPTIONS } from '../src/db/ledger-initialization.js';
import { loadSnapshot } from '../src/db/snapshot.js';
import { withCashflowPayee, withRememberedPayee } from '../src/payee-recording.js';
import { fixedAssetForm, fixedConsumableForm, fixedEventForm, gameRecordForm, scheduledTransactionForm, transactionTemplateForm } from '../src/forms.js';
import { makeSnapshot } from './fixtures.js';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });

describe('unified payee entry points', () => {
  it('binds every record form to its own counterpart and category fields', () => {
    const snap = makeSnapshot();
    const forms = [scheduledTransactionForm(snap), transactionTemplateForm(snap), fixedAssetForm(snap), fixedEventForm(snap, 'asset'), fixedConsumableForm(snap, 'asset', []), gameRecordForm(snap)];
    const bindings = forms.flatMap((form) => form.fields.filter((field) => field.type === 'payee'));
    expect(bindings.map((field) => field.key)).toEqual(['payeeId', 'payeeId', 'purchaseMerchant', 'cashflowPayeeId', 'purchaseMerchant', 'settlementPayeeId', 'feePayeeId']);
    for (const field of bindings) expect(field.payeeBinding?.nameKey).toBeTruthy();
    for (const form of forms) expect(form.fields.some((field) => /商户文本|已有商户/.test(field.label))).toBe(false);
    expect(bindings.filter((field) => field.key === 'purchaseMerchant').every((field) => field.payeeBinding?.textOnly)).toBe(true);
    expect(bindings.find((field) => field.key === 'settlementPayeeId')?.payeeBinding?.categoryKey).toBe('settlementCategoryId');
  });

  it('saves a template and schedule with one platform identity and carries it into generated transactions', async () => {
    const store = await openLedger();
    try {
      const setting = await initializeEmptyLedger(store, QUICK_START_LEDGER_OPTIONS);
      const snap = await loadSnapshot(store);
      const values = { name: '订阅', type: 'expense', category: 'shopping', amount: '20', assetId: setting.baseCurrencyAssetId,
        accountId: setting.expenseDefaultAccountId!, merchant: 'JD', frequency: 'monthly', anchorDate: '2026-09-01',
        timezone: 'Asia/Shanghai', time: '09:00', status: 'active', isActive: 'true' };
      const schedule = await store.runInAuditBatch('save schedule', async (tx) => tx.scheduledTransactions.put(await withRememberedPayee(tx, scheduledTransactionForm(snap).fromValues(values))));
      const template = await store.runInAuditBatch('save template', async (tx) => tx.transactionTemplates.put(await withRememberedPayee(tx, transactionTemplateForm(snap).fromValues({ ...values, merchant: '京东' }))));
      expect(schedule.payeeId).toBe('platform-payee:jd');
      expect(template.payeeId).toBe(schedule.payeeId);
      const generated = await materializeScheduledTransaction(store, schedule.id, 0);
      expect(generated?.payeeId).toBe(schedule.payeeId);
      expect(await store.payees.count()).toBe(1);
      await expect(store.runInAuditBatch('reject schedule', async (tx) => tx.scheduledTransactions.put(await withRememberedPayee(tx, { ...schedule, ...base(), category: 'missing', merchant: '新建但失败', payeeId: undefined })))).rejects.toThrow();
      expect(await store.payees.count()).toBe(1);
    } finally { await store.close(); }
  });

  it('persists counterpart IDs for acquisition, repair, consumable, game settlement and fees atomically', async () => {
    const store = await openLedger();
    try {
      const setting = await initializeEmptyLedger(store, QUICK_START_LEDGER_OPTIONS);
      const snap = await loadSnapshot(store);
      const fixedCategory = snap.fixedAssetCategories.find((row) => row.parentId)!;
      const income = snap.categories.find((row) => row.type === 'income' && row.parentId)!;
      const expenseDraft = (merchant: string) => ({ mode: 'create_transaction' as const, createTransaction: { categoryId: 'shopping', accountId: setting.expenseDefaultAccountId, merchant } });
      const acquired = await store.runInAuditBatch('acquire', async (tx) => saveFixedAssetAcquisition(tx, {
        asset: { ...base(), name: '测试物品', categoryId: fixedCategory.id, status: 'active', purchaseDate: '2026-09-01', baseCurrencyAssetId: setting.baseCurrencyAssetId } as FixedAsset,
        purchaseAmount: '100', cashflow: await withCashflowPayee(tx, expenseDraft('京东')),
      }));
      const repaired = await store.runInAuditBatch('repair', async (tx) => saveFixedAssetEvent(tx, {
        event: { ...base(), fixedAssetId: acquired.asset.id, type: 'repair', date: '2026-09-02', amountBase: '10' } as FixedAssetEvent,
        cashflow: await withCashflowPayee(tx, expenseDraft('维修店')),
      }));
      const consumed = await store.runInAuditBatch('consumable', async (tx) => saveFixedAssetConsumable(tx, {
        consumable: { ...base(), fixedAssetId: acquired.asset.id, name: '滤芯', status: 'active', purchaseDate: '2026-09-02', amountBase: '5' } as FixedAssetConsumable,
        cashflow: await withCashflowPayee(tx, expenseDraft('JD')),
      }));
      expect(acquired.transaction?.payeeId).toBe('platform-payee:jd');
      expect(consumed.transaction?.payeeId).toBe(acquired.transaction?.payeeId);
      expect((await store.payees.get(repaired.transaction!.payeeId!))?.name).toBe('维修店');
      const game = await store.games.put({ ...base(), name: '测试游戏', enableSeason: false, isActive: true });
      const result = await store.runInAuditBatch('game', async (tx) => saveGameRecordAggregate(tx, {
        record: { ...base(), gameId: game.id, date: '2026-09-03', recordType: 'withdraw', settlementAssetId: setting.baseCurrencyAssetId, settlementAmount: '20', feeAssetId: setting.baseCurrencyAssetId, feeAmount: '1' },
        settlement: await withCashflowPayee(tx, { mode: 'create_transaction', createTransaction: { categoryId: income.id, accountId: setting.incomeDefaultAccountId, merchant: 'Steam' } }),
        fee: await withCashflowPayee(tx, expenseDraft('服务公司')),
      }));
      expect((await store.transactions.get(result.settlementLink!.transactionId))?.payeeId).toBe('platform-payee:steam');
      const feeTx = await store.transactions.get(result.feeLink!.transactionId);
      expect((await store.payees.get(feeTx!.payeeId!))?.name).toBe('服务公司');
      const before = await store.payees.count();
      await withCashflowPayee(store, { ...expenseDraft('不应创建'), mode: 'record_only' });
      expect(await store.payees.count()).toBe(before);
    } finally { await store.close(); }
  });
});
