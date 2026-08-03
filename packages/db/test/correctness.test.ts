import { describe, expect, it } from 'vitest';
import {
  archiveMasterData,
  exportLedger,
  mergeMasterData,
  preflightImport,
  deleteFixedAssetEvent,
  saveFixedAssetAcquisition,
  saveFixedAssetConsumable,
  saveFixedAssetEvent,
  saveTransactionAggregate,
} from '../src/index.js';
import { openLedger } from '../src/node.js';
import {
  newId,
  transactionReportingEffect,
  type Account,
  type Asset,
  type Category,
  type DcaPlan,
  type FixedAsset,
  type FixedAssetCategory,
  type FixedAssetConsumable,
  type FixedAssetEvent,
  type Payee,
  type Transaction,
} from '@zichan/core';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

async function seedReferences(store: Awaited<ReturnType<typeof openLedger>>) {
  const currency = await store.assets.put({ ...base(), code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, symbol: '¥', isActive: true } as Asset);
  const account = await store.accounts.put({ ...base(), name: '日常账户', kind: 'bank', isActive: true } as Account);
  const expenseParent = await store.categories.put({ ...base(), name: '居家生活', type: 'expense', isActive: true } as Category);
  const expenseLeaf = await store.categories.put({ ...base(), name: '家具家电', type: 'expense', parentId: expenseParent.id, isActive: true } as Category);
  const incomeParent = await store.categories.put({ ...base(), name: '其他收入', type: 'income', isActive: true } as Category);
  const incomeLeaf = await store.categories.put({ ...base(), name: '二手出售', type: 'income', parentId: incomeParent.id, isActive: true } as Category);
  const fixedParent = await store.fixedAssetCategories.put({ ...base(), name: '家用电器', isActive: true } as FixedAssetCategory);
  const fixedLeaf = await store.fixedAssetCategories.put({ ...base(), name: '洗衣机', parentId: fixedParent.id, isActive: true } as FixedAssetCategory);
  return { currency, account, expenseParent, expenseLeaf, incomeParent, incomeLeaf, fixedParent, fixedLeaf };
}

function expense(refs: Awaited<ReturnType<typeof seedReferences>>, amount = '600'): Transaction {
  return {
    ...base(),
    date: '2026-07-22',
    timePrecision: 'day',
    type: 'expense',
    category: refs.expenseLeaf.id,
    amount,
    assetId: refs.currency.id,
    accountId: refs.account.id,
    description: '购买家电',
    status: 'cleared',
    recordState: 'active',
  } as Transaction;
}

function fixedAsset(refs: Awaited<ReturnType<typeof seedReferences>>, name = '洗衣机'): FixedAsset {
  return {
    ...base(),
    name,
    categoryId: refs.fixedLeaf.id,
    status: 'active',
    purchaseDate: '2026-07-22',
    baseCurrencyAssetId: refs.currency.id,
  } as FixedAsset;
}

describe('P1 correctness boundaries', () => {
  it('rejects illegal transaction enum values at repository and import boundaries', async () => {
    const store = await openLedger();
    const refs = await seedReferences(store);
    await expect(store.transactions.put({
      ...expense(refs),
      status: 'reconciled',
    } as never)).rejects.toThrow('流水状态无效');

    const saved = await saveTransactionAggregate(store, { transaction: expense(refs) });
    const backup = await exportLedger(store);
    const row = backup.transactions.find((transaction) => transaction.id === saved.transaction.id)! as unknown as Record<string, unknown>;
    row.status = 'reconciled';
    expect(preflightImport(backup).issues).toContainEqual(expect.objectContaining({
      code: 'invalid_transaction_enum',
      entityId: saved.transaction.id,
    }));

    await expect(store.dcaPlans.put({
      ...base(),
      name: '月末定投',
      targetAssetId: refs.currency.id,
      baseCurrencyAssetId: refs.currency.id,
      anchorDate: '2026-01-31',
      anchorMode: 'calendar_day',
      timezone: 'Invalid/Timezone',
      frequency: 'monthly',
      plannedAmount: '100',
      status: 'active',
    } as DcaPlan)).rejects.toThrow('定投计划时区无效');
    await store.close();
  });

  it('creates a cash-flow expense and an exact frozen funding link with a physical asset', async () => {
    const store = await openLedger();
    const refs = await seedReferences(store);

    const result = await saveFixedAssetAcquisition(store, {
      asset: fixedAsset(refs),
      purchaseAmount: '500',
      cashflow: {
        mode: 'create_transaction',
        sourceAmount: '500',
        createTransaction: { categoryId: refs.expenseLeaf.id, accountId: refs.account.id, merchant: '家电商场' },
      },
    });

    expect(result.transaction).toMatchObject({ amount: '500', type: 'expense', assetId: refs.currency.id });
    expect(result.purchaseEvent).toMatchObject({ amountBase: '500', cashflowMode: 'create_transaction' });
    expect(result.cashflowLink).toMatchObject({
      transactionId: result.transaction!.id,
      sourceType: 'event',
      sourceId: result.purchaseEvent.id,
      direction: 'outflow',
      ownership: 'created',
      sourceAmount: '500',
      amountBase: '500',
      fxRateSnapshot: '1',
    });
    await store.close();
  });

  it('rolls back an acquisition when it over-allocates an existing expense', async () => {
    const store = await openLedger();
    const refs = await seedReferences(store);
    const source = (await saveTransactionAggregate(store, { transaction: expense(refs) })).transaction;
    const first = fixedAsset(refs, '洗衣机');
    await saveFixedAssetAcquisition(store, {
      asset: first,
      purchaseAmount: '500',
      cashflow: { mode: 'linked_transaction', linkedTransactionId: source.id, sourceAmount: '500' },
    });

    const second = fixedAsset(refs, '烘干机');
    await expect(saveFixedAssetAcquisition(store, {
      asset: second,
      purchaseAmount: '200',
      cashflow: { mode: 'linked_transaction', linkedTransactionId: source.id, sourceAmount: '200' },
    })).rejects.toThrow('超过该流水尚未分配');
    expect(await store.fixedAssets.get(second.id)).toBeNull();
    expect((await store.fixedAssetCashflowLinks.list({ where: { transactionId: source.id } }))).toHaveLength(1);
    await store.close();
  });

  it('keeps repair, sale, and consumable cash flow linked to exactly one transaction', async () => {
    const store = await openLedger();
    const refs = await seedReferences(store);
    const acquisition = await saveFixedAssetAcquisition(store, {
      asset: fixedAsset(refs),
      purchaseAmount: '500',
      cashflow: { mode: 'record_only', sourceAmount: '0' },
    });

    const repair = await saveFixedAssetEvent(store, {
      event: {
        ...base(),
        fixedAssetId: acquisition.asset.id,
        type: 'repair',
        date: '2026-08-01',
        amountBase: '80',
        cashflowMode: 'create_transaction',
      } as FixedAssetEvent,
      cashflow: {
        mode: 'create_transaction',
        sourceAmount: '80',
        createTransaction: { categoryId: refs.expenseLeaf.id, accountId: refs.account.id },
      },
    });
    expect(repair.transaction).toMatchObject({ type: 'expense', amount: '80' });
    expect(repair.cashflowLink).toMatchObject({ ownership: 'created', direction: 'outflow' });

    const repairedAgain = await saveFixedAssetEvent(store, {
      event: { ...repair.event, amountBase: '90' },
      expectedVersion: repair.event.version,
      cashflow: {
        mode: 'create_transaction',
        sourceAmount: '90',
        createTransaction: { categoryId: refs.expenseLeaf.id, accountId: refs.account.id },
      },
    });
    expect(repairedAgain.transaction).toMatchObject({ id: repair.transaction!.id, amount: '90' });
    expect((await store.fixedAssetCashflowLinks.list({ where: { sourceId: repair.event.id } }))).toHaveLength(1);

    const sale = await saveFixedAssetEvent(store, {
      event: {
        ...base(),
        fixedAssetId: acquisition.asset.id,
        type: 'sale',
        date: '2026-09-01',
        amountBase: '300',
        cashflowMode: 'create_transaction',
      } as FixedAssetEvent,
      cashflow: {
        mode: 'create_transaction',
        sourceAmount: '300',
        createTransaction: {
          categoryId: refs.incomeLeaf.id,
          accountId: refs.account.id,
          reportingTreatment: 'balance_only',
        },
      },
    });
    expect(sale.transaction).toMatchObject({ type: 'income', amount: '300', reportingTreatment: 'balance_only' });
    expect(transactionReportingEffect(sale.transaction!)).toMatchObject({
      cashAmount: '300',
      incomeDelta: '0',
      expenseDelta: '0',
    });

    const sourceExpense = (await saveTransactionAggregate(store, {
      transaction: expense(refs, '25'),
    })).transaction;
    const consumable = await saveFixedAssetConsumable(store, {
      consumable: {
        ...base(),
        fixedAssetId: acquisition.asset.id,
        name: '空调滤芯',
        amountBase: '25',
        cashflowMode: 'linked_transaction',
        purchaseDate: '2026-08-15',
        status: 'active',
      } as FixedAssetConsumable,
      cashflow: {
        mode: 'linked_transaction',
        linkedTransactionId: sourceExpense.id,
        sourceAmount: '25',
      },
    });
    expect(consumable.cashflowLink).toMatchObject({
      sourceType: 'consumable',
      sourceId: consumable.consumable.id,
      ownership: 'linked',
    });

    await deleteFixedAssetEvent(store, repairedAgain.event);
    expect(await store.transactions.get(repair.transaction!.id)).toMatchObject({ recordState: 'voided' });
    expect((await store.fixedAssetCashflowLinks.list({ where: { sourceId: repair.event.id } }))).toHaveLength(0);
    await store.close();
  });

  it('migrates references during a payee merge and archives instead of deleting', async () => {
    const store = await openLedger();
    const refs = await seedReferences(store);
    const source = await store.payees.put({ ...base(), name: '旧商户', aliases: ['旧别名'], isActive: true } as Payee);
    const target = await store.payees.put({ ...base(), name: '新商户', isActive: true } as Payee);
    const transaction = (await saveTransactionAggregate(store, { transaction: { ...expense(refs), payeeId: source.id } })).transaction;

    const impact = await mergeMasterData(store, 'payee', source.id, target.id, source.version);
    expect(impact.references.transactions).toBe(1);
    expect(await store.transactions.get(transaction.id)).toMatchObject({ payeeId: target.id });
    expect(await store.payees.get(source.id)).toMatchObject({ isActive: false, mergedIntoId: target.id, archiveReason: '已合并' });
    expect((await store.payees.get(target.id))?.aliases).toEqual(expect.arrayContaining(['旧商户', '旧别名']));

    const leaf = refs.expenseLeaf;
    await archiveMasterData(store, 'category', leaf.id, leaf.version, '暂不使用');
    expect(await store.categories.get(leaf.id)).toMatchObject({ isActive: false, archiveReason: '暂不使用' });
    await store.close();
  });

  it('rejects tampered split totals and fixed-asset funding snapshots before import', async () => {
    const store = await openLedger();
    const refs = await seedReferences(store);
    const secondLeaf = await store.categories.put({ ...base(), name: '家居日用', type: 'expense', parentId: refs.expenseParent.id, isActive: true } as Category);
    const transaction = { ...expense(refs, '100'), category: secondLeaf.id };
    await saveTransactionAggregate(store, {
      transaction,
      splits: [
        { ...base(), transactionId: transaction.id, category: refs.expenseLeaf.id, amount: '60' },
        { ...base(), transactionId: transaction.id, category: secondLeaf.id, amount: '40', isRemainder: true },
      ],
    });
    await saveFixedAssetAcquisition(store, {
      asset: fixedAsset(refs),
      purchaseAmount: '100',
      cashflow: { mode: 'linked_transaction', linkedTransactionId: transaction.id, sourceAmount: '100' },
    });
    const backup = await exportLedger(store);

    (backup.transactionSplits[0] as { amount: string }).amount = '59';
    (backup.fixedAssetCashflowLinks[0] as { fxRateSnapshot?: string }).fxRateSnapshot = '2';
    const preflight = preflightImport(backup);
    expect(preflight.ok).toBe(false);
    expect(preflight.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'split_total_mismatch' }),
      expect.objectContaining({ code: 'invalid_cashflow_amount' }),
    ]));
    await store.close();
  });
});
