import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  D, newId, round, scheduleExecutionId, scheduledTransactionId,
  type BudgetCategory, type Category, type Payee, type ReconciliationSession,
  type ScheduledTransaction, type Transaction, type TransactionLocation, type TransactionSplit,
  type TransactionSavedView, type TransactionTag, type TransactionTemplate,
} from '@zichan/core';
import {
  exportLedger,
  closeReconciliation,
  checkConsistency,
  importLedger,
  importTransactions,
  previewReconciliation,
  monthlyTransactionSummary,
  materializeScheduledTransaction,
  preflightImport,
  previewScheduledBacklog,
  restoreTransaction,
  runDueScheduledTransactions,
  saveTransaction,
  saveTransactionAggregate,
  undoLatestReconciliation,
  voidTransaction,
} from '../src/index.js';
import { openLedger } from '../src/node.js';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    ...base(),
    date: '2026-03-01',
    type: 'expense',
    category: 'food',
    amount: '12.50',
    assetId: 'GBP',
    ...overrides,
  } as Transaction;
}

async function seedTransactionLedger(store: Awaited<ReturnType<typeof openLedger>>) {
  await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
  await store.accounts.put({ ...base(), id: 'bank', name: 'Bank', kind: 'bank', isActive: true } as never);
  await store.categories.put({ ...base(), id: 'expense-root', name: '支出', type: 'expense', isActive: true } as never);
  await store.categories.put({ ...base(), id: 'food', name: '餐饮', type: 'expense', parentId: 'expense-root', isActive: true } as never);
  await store.categories.put({ ...base(), id: 'housing', name: '居住', type: 'expense', parentId: 'expense-root', isActive: true } as never);
  await store.categories.put({ ...base(), id: 'income-root', name: '收入', type: 'income', isActive: true } as never);
  await store.categories.put({ ...base(), id: 'salary', name: '工资', type: 'income', parentId: 'income-root', isActive: true } as never);
}

async function openTransactionLedger() {
  const store = await openLedger();
  await seedTransactionLedger(store);
  return store;
}

describe('transactions persistence', () => {
  it('supports partial refunds, rejects over-refunds, and attributes them to the original month by default', async () => {
    const store = await openTransactionLedger();
    await store.settings.put({ ...base(), baseCurrencyAssetId: 'GBP', defaultLotMethod: 'fifo', refundAttributionMode: 'original_date' });
    const expense = await saveTransaction(store, tx({ date: '2026-03-08', amount: '100', category: 'food' }));
    const refund1 = await saveTransaction(store, tx({
      date: '2026-04-02', type: 'refund', amount: '20', category: 'food',
      refundForId: expense.id, refundAppliedAmount: '20', refundAppliedAssetId: 'GBP',
    }));
    await saveTransaction(store, tx({
      date: '2026-04-03', type: 'refund', amount: '35', category: 'food',
      refundForId: expense.id, refundAppliedAmount: '35', refundAppliedAssetId: 'GBP',
    }));

    await expect(saveTransaction(store, tx({
      date: '2026-04-04', type: 'refund', amount: '46', category: 'food',
      refundForId: expense.id, refundAppliedAmount: '46', refundAppliedAssetId: 'GBP',
    }))).rejects.toThrow('超过原支出');
    expect(round((await monthlyTransactionSummary(store, '2026-03', 'GBP')).expense, 2)).toBe('45.00');
    expect(round((await monthlyTransactionSummary(store, '2026-04', 'GBP')).expense, 2)).toBe('0.00');

    await voidTransaction(store, refund1.id, '录错退款');
    expect(round((await monthlyTransactionSummary(store, '2026-03', 'GBP')).expense, 2)).toBe('65.00');
    await restoreTransaction(store, refund1.id);
    expect(round((await monthlyTransactionSummary(store, '2026-03', 'GBP')).expense, 2)).toBe('45.00');
    await store.close();
  });

  it('pages report rows by frozen report date and loads only page child records', async () => {
    const store = await openTransactionLedger();
    await store.settings.put({ ...base(), baseCurrencyAssetId: 'GBP', defaultLotMethod: 'fifo', refundAttributionMode: 'original_date' });
    const draft = tx({ date: '2026-03-08', amount: '100', category: 'housing' });
    const original = await saveTransactionAggregate(store, {
      transaction: draft,
      splits: [
        { ...base(), transactionId: draft.id, category: 'food', amount: '60' },
        { ...base(), transactionId: draft.id, category: 'housing', amount: '40', isRemainder: true },
      ],
    });
    const refund = await saveTransactionAggregate(store, {
      transaction: tx({
        date: '2026-04-02',
        type: 'refund',
        amount: '25',
        refundForId: original.transaction.id,
        refundAppliedAmount: '25',
        refundAppliedAssetId: 'GBP',
      }),
    });
    const first = await store.transactionReportPage({
      from: '2026-03-01',
      to: '2026-03-31',
      limit: 1,
    });
    expect(first.transactions).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor?.value).toBe('2026-03-08');
    const second = await store.transactionReportPage({
      from: '2026-03-01',
      to: '2026-03-31',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(new Set([...first.transactions, ...second.transactions].map((row) => row.id))).toEqual(
      new Set([original.transaction.id, refund.transaction.id]),
    );
    expect([...first.refundAllocations, ...second.refundAllocations]).toHaveLength(2);
    expect([...first.transactionSplits, ...second.transactionSplits]).toHaveLength(2);
    const iteratedIds: string[] = [];
    let iteratedSplits = 0;
    let iteratedAllocations = 0;
    for await (const page of store.iterateTransactionReport({
      from: '2026-03-01',
      to: '2026-03-31',
      pageSize: 1,
    })) {
      iteratedIds.push(...page.transactions.map((row) => row.id));
      iteratedSplits += page.transactionSplits.length;
      iteratedAllocations += page.refundAllocations.length;
    }
    expect(new Set(iteratedIds)).toEqual(new Set([original.transaction.id, refund.transaction.id]));
    expect(iteratedIds).toHaveLength(2);
    expect(iteratedSplits).toBe(2);
    expect(iteratedAllocations).toBe(2);
    expect((await store.transactionReportPage({
      from: '2026-04-01',
      to: '2026-04-30',
    })).transactions).toEqual([]);
    const aggregates = await store.transactionReportAggregate({
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(aggregates).toHaveLength(2);
    expect(aggregates.find((row) => row.category === 'food')).toMatchObject({
      reportDate: '2026-03-08',
      reportAssetId: 'GBP',
      direction: 'expense',
      count: 2,
    });
    expect(aggregates.find((row) => row.category === 'food')!.amounts
      .reduce((total, amount) => total.plus(amount), D(0)).toString()).toBe('45');
    expect(aggregates.find((row) => row.category === 'housing')!.amounts
      .reduce((total, amount) => total.plus(amount), D(0)).toString()).toBe('30');
    await store.close();
  });

  it('browses filtered transactions with SQL AND/OR conditions and page-local relations', async () => {
    const store = await openTransactionLedger();
    await store.payees.put({ ...base(), id: 'cafe', name: 'Corner Cafe', aliases: [], isActive: true });
    await store.transactionTags.put({ ...base(), id: 'work', name: '上班', groupName: '场景', isActive: true });
    await store.transactionLocations.put({ ...base(), id: 'office', name: '办公室', address: 'Main Street', isActive: true });
    const coffee = await saveTransaction(store, tx({
      id: 'tx-coffee',
      date: '2026-03-12',
      amount: '18.5',
      category: 'food',
      payeeId: 'cafe',
      tagIds: ['work'],
      locationId: 'office',
      description: 'Morning coffee',
      status: 'cleared',
    }));
    const splitDraft = tx({
      id: 'tx-split',
      date: '2026-03-11',
      amount: '80',
      category: 'housing',
      description: 'Mixed order',
    });
    await saveTransactionAggregate(store, {
      transaction: splitDraft,
      splits: [
        { ...base(), transactionId: splitDraft.id, category: 'food', amount: '30' },
        { ...base(), transactionId: splitDraft.id, category: 'housing', amount: '50', isRemainder: true },
      ],
    });
    await saveTransaction(store, tx({
      id: 'tx-housing',
      date: '2026-03-10',
      amount: '900',
      category: 'housing',
      description: 'Rent',
    }));
    await store.attachments.put({
      ...base(),
      id: 'receipt',
      entityType: 'transaction',
      entityId: coffee.id,
      fileName: 'receipt.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
    });

    const coffeePage = await store.transactionBrowsePage({
      from: '2026-03-01',
      to: '2026-03-31',
      search: 'corner',
      tagId: 'work',
      advanced: {
        groups: [{
          conditions: [
            { field: 'parentCategory', op: 'eq', value: 'expense-root' },
            { field: 'amount', op: 'gte', value: '18.5' },
            { field: 'hasAttachment', op: 'eq', value: 'true' },
          ],
        }],
      },
    });
    expect(coffeePage.transactions.map((row) => row.id)).toEqual(['tx-coffee']);
    expect(coffeePage.totalCount).toBe(1);
    expect(coffeePage.attachments.map((row) => row.id)).toEqual(['receipt']);

    const categoryPage = await store.transactionBrowsePage({
      category: 'food',
      advanced: {
        groups: [
          { conditions: [{ field: 'merchant', op: 'contains', value: 'cafe' }] },
          { conditions: [{ field: 'description', op: 'contains', value: 'mixed' }] },
        ],
      },
      limit: 1,
    });
    expect(categoryPage.totalCount).toBe(2);
    expect(categoryPage.transactions).toHaveLength(1);
    expect(categoryPage.hasMore).toBe(true);
    const categoryNext = await store.transactionBrowsePage({
      category: 'food',
      advanced: {
        groups: [
          { conditions: [{ field: 'merchant', op: 'contains', value: 'cafe' }] },
          { conditions: [{ field: 'description', op: 'contains', value: 'mixed' }] },
        ],
      },
      limit: 1,
      cursor: categoryPage.nextCursor,
    });
    expect(new Set([...categoryPage.transactions, ...categoryNext.transactions].map((row) => row.id)))
      .toEqual(new Set(['tx-coffee', 'tx-split']));
    expect(categoryNext.transactionSplits).toHaveLength(2);
    await store.close();
  });

  it('filters large and high-precision amounts exactly across count and cursor pages', async () => {
    const store = await openTransactionLedger();
    const amounts = [
      ['amount-low', '9007199254740992.01'],
      ['amount-exact-fixed', '9007199254740992.02'],
      ['amount-exact-exponent', '9.00719925474099202e+15'],
      ['amount-high', '9007199254740993.01'],
      ['amount-max-exponent', '1e9000000000000000'],
    ] as const;
    for (const [id, amount] of amounts) {
      await saveTransaction(store, tx({ id, date: '2026-03-15', amount }));
    }

    const first = await store.transactionBrowsePage({
      amountMin: '9007199254740992.0200',
      amountMax: '9.00719925474099202e+15',
      limit: 1,
    });
    expect(first.totalCount).toBe(2);
    expect(first.transactions).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = await store.transactionBrowsePage({
      amountMin: '9007199254740992.0200',
      amountMax: '9.00719925474099202e+15',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.totalCount).toBe(2);
    expect(new Set([...first.transactions, ...second.transactions].map((row) => row.id))).toEqual(
      new Set(['amount-exact-fixed', 'amount-exact-exponent']),
    );

    const advanced = await store.transactionBrowsePage({
      advanced: { groups: [{ conditions: [{
        field: 'amount',
        op: 'eq',
        value: '09007199254740992.0200',
      }] }] },
    });
    expect(advanced.totalCount).toBe(2);
    expect(new Set(advanced.transactions.map((row) => row.id))).toEqual(
      new Set(['amount-exact-fixed', 'amount-exact-exponent']),
    );
    const extreme = await store.transactionBrowsePage({
      amountMin: '1e9000000000000000',
      amountMax: '1e9000000000000000',
    });
    expect(extreme.totalCount).toBe(1);
    expect(extreme.transactions.map((row) => row.id)).toEqual(['amount-max-exponent']);
    await expect(store.transactionBrowsePage({ amountMin: '1e9000000000000001' }))
      .rejects.toThrow('金额筛选值不是有限数字');
    await expect(saveTransaction(store, tx({ id: 'amount-infinite', amount: 'Infinity' })))
      .rejects.toThrow('金额必须是有限数字');
    await store.close();
  });

  it('aggregates and pages account ledgers without mixing currencies', async () => {
    const store = await openTransactionLedger();
    await store.assets.put({ ...base(), id: 'JPY', code: 'JPY', name: 'Yen', type: 'fiat', decimals: 0, isActive: true } as never);
    await store.accounts.put({ ...base(), id: 'cash', name: 'Cash', kind: 'cash', isActive: true } as never);
    await saveTransaction(store, tx({
      id: 'income-gbp', date: '2026-03-01', type: 'income', category: 'salary',
      amount: '1000', assetId: 'GBP', accountId: 'bank',
    }));
    await saveTransaction(store, tx({
      id: 'income-jpy', date: '2026-03-02', type: 'income', category: 'salary',
      amount: '5000', assetId: 'JPY', accountId: 'bank',
    }));
    await saveTransaction(store, tx({
      id: 'expense-gbp', date: '2026-03-03', amount: '100', assetId: 'GBP', accountId: 'bank',
    }));
    await saveTransaction(store, tx({
      id: 'transfer-gbp', date: '2026-03-04', type: 'transfer', category: 'food',
      amount: '200', assetId: 'GBP', accountId: 'bank',
      transferAmount: '200', transferAssetId: 'GBP', transferAccountId: 'cash',
    }));

    const balances = await store.accountBalanceAggregates();
    const total = (accountId: string, assetId: string) => balances
      .find((row) => row.accountId === accountId && row.assetId === assetId)!
      .amounts.reduce((value, amount) => value.plus(amount), D(0)).toString();
    expect(total('bank', 'GBP')).toBe('700');
    expect(total('bank', 'JPY')).toBe('5000');
    expect(total('cash', 'GBP')).toBe('200');

    const first = await store.accountLedgerPage({
      accountId: 'bank',
      from: '2026-03-01',
      to: '2026-03-31',
      limit: 2,
    });
    expect(first.totalCount).toBe(4);
    expect(first.rows.map((row) => [row.transaction.id, row.postingAmount, row.balance])).toEqual([
      ['transfer-gbp', '-200', '700'],
      ['expense-gbp', '-100', '900'],
    ]);
    const second = await store.accountLedgerPage({
      accountId: 'bank',
      from: '2026-03-01',
      to: '2026-03-31',
      limit: 2,
      cursor: first.nextCursor,
      startingBalances: first.nextStartingBalances,
    });
    expect(second.rows.map((row) => [row.transaction.id, row.postingAmount, row.balance])).toEqual([
      ['income-jpy', '5000', '5000'],
      ['income-gbp', '1000', '1000'],
    ]);
    await store.close();
  });

  it('keeps refund category allocation frozen after the original split is edited', async () => {
    const store = await openTransactionLedger();
    const draft = tx({ amount: '100', category: 'housing' });
    const original = await saveTransactionAggregate(store, {
      transaction: draft,
      splits: [
        { ...base(), transactionId: draft.id, category: 'food', amount: '60' },
        { ...base(), transactionId: draft.id, category: 'housing', amount: '40', isRemainder: true },
      ],
    });
    const refund = await saveTransactionAggregate(store, {
      transaction: tx({ type: 'refund', amount: '25', refundForId: original.transaction.id, refundAppliedAmount: '25' }),
    });
    const frozen = refund.refundAllocations.map((row) => ({
      sourceSplitId: row.sourceSplitId,
      categoryId: row.categoryId,
      categoryPathSnapshot: row.categoryPathSnapshot,
      amount: row.amount,
    }));

    await saveTransactionAggregate(store, {
      transaction: { ...original.transaction, category: 'food' },
      splits: [],
      expectedVersion: original.transaction.version,
    });

    expect((await store.refundAllocations.list({ where: { refundTransactionId: refund.transaction.id } })).map((row) => ({
      sourceSplitId: row.sourceSplitId,
      categoryId: row.categoryId,
      categoryPathSnapshot: row.categoryPathSnapshot,
      amount: row.amount,
    }))).toEqual(frozen);
    expect((await checkConsistency(store)).filter((issue) => issue.kind === 'refund_allocation_invalid')).toEqual([]);
    await store.close();
  });

  it('rejects a stale aggregate edit before replacing child rows', async () => {
    const store = await openTransactionLedger();
    const original = await saveTransaction(store, tx({ amount: '40' }));
    await saveTransaction(store, { ...original, amount: '45' });

    await expect(saveTransactionAggregate(store, {
      transaction: { ...original, amount: '50' },
      splits: [{ ...base(), transactionId: original.id, category: 'food', amount: '50' }],
      expectedVersion: original.version,
    })).rejects.toMatchObject({ name: 'ConcurrencyError' });
    expect((await store.transactions.get(original.id))?.amount).toBe('45');
    expect(await store.transactionSplits.list({ where: { transactionId: original.id } })).toEqual([]);
    await store.close();
  });

  it('protects reconciled transactions and prevents voiding an expense with active refunds', async () => {
    const store = await openTransactionLedger();
    const expense = await saveTransaction(store, tx({ amount: '80', status: 'cleared' }));
    const refund = await saveTransaction(store, tx({
      type: 'refund', amount: '10', refundForId: expense.id, refundAppliedAmount: '10', refundAppliedAssetId: 'GBP',
    }));
    await expect(voidTransaction(store, expense.id)).rejects.toThrow('已有退款');
    await voidTransaction(store, refund.id);
    await voidTransaction(store, expense.id);
    expect((await store.transactions.get(expense.id))?.recordState).toBe('voided');

    const reconciled = await saveTransaction(store, tx({ amount: '22', accountId: 'bank', status: 'pending' }));
    await closeReconciliation(store, {
      accountId: 'bank', assetId: 'GBP', statementDate: '2026-03-31', statementBalance: '-22',
      selectedTransactionIds: [reconciled.id],
    });
    await expect(saveTransaction(store, { ...reconciled, amount: '23' })).rejects.toThrow('已对账');
    await expect(voidTransaction(store, reconciled.id)).rejects.toThrow('已对账');
    for (const patch of [{ amount: '23' }, { date: '2026-04-01' }, {
      recordState: 'voided' as const,
      voidedAt: '2026-04-01T00:00:00.000Z',
      voidReason: '绕过服务层',
    }]) {
      const before = (await store.transactions.get(reconciled.id))!;
      await expect(store.transactions.put({ ...before, ...patch })).rejects.toThrow('对账');
      expect(await store.transactions.get(reconciled.id)).toEqual(before);
    }
    const [session] = await store.reconciliationSessions.list();
    await undoLatestReconciliation(store, session!.id);
    const editable = (await store.transactions.get(reconciled.id))!;
    await expect(saveTransaction(store, { ...editable, amount: '23' })).resolves.toMatchObject({ amount: '23' });
    await store.close();
  });

  it('reconciles selected bank postings, creates an explicit adjustment, and undoes latest first', async () => {
    const store = await openTransactionLedger();
    const deposit = await saveTransaction(store, tx({ date: '2026-03-01', type: 'income', category: 'salary', amount: '1000', accountId: 'bank', status: 'cleared' }));
    const groceries = await saveTransaction(store, tx({ date: '2026-03-12', amount: '120', accountId: 'bank', status: 'pending' }));
    await saveTransaction(store, tx({ date: '2026-04-02', amount: '30', accountId: 'bank', status: 'pending' }));
    const input = {
      accountId: 'bank', assetId: 'GBP', statementDate: '2026-03-31', statementBalance: '900',
      selectedTransactionIds: [deposit.id, groceries.id],
    };
    const preview = await previewReconciliation(store, input);
    expect(preview).toMatchObject({ openingBalance: '0', selectedTotal: '880', clearedBalance: '880', difference: '20' });
    expect(preview.candidates.every((row) => row.transaction.date <= '2026-03-31')).toBe(true);
    await expect(closeReconciliation(store, input)).rejects.toThrow('差额为 20');

    const march = await closeReconciliation(store, { ...input, createAdjustment: true });
    expect(march).toMatchObject({ statementBalance: '900', selectedTotal: '900', clearedBalance: '900', difference: '0' });
    expect((await store.transactions.get(groceries.id))?.status).toBe('cleared');
    const adjustment = (await store.transactions.list()).find((row) => row.id === march.adjustmentTransactionId);
    expect(adjustment).toMatchObject({ type: 'adjustment', amount: '20', adjustmentDirection: 'increase' });
    expect(round((await monthlyTransactionSummary(store, '2026-03', 'GBP')).income, 2)).toBe('1000.00');

    const aprilExpense = await saveTransaction(store, tx({ date: '2026-04-10', amount: '50', accountId: 'bank', status: 'pending' }));
    const april = await closeReconciliation(store, {
      accountId: 'bank', assetId: 'GBP', statementDate: '2026-04-30', statementBalance: '820',
      selectedTransactionIds: [
        ...(await store.transactions.list()).filter((row) => row.date === '2026-04-02').map((row) => row.id),
        aprilExpense.id,
      ],
    });
    expect(april).toMatchObject({ openingBalance: '900', selectedTotal: '-80', difference: '0' });
    await expect(undoLatestReconciliation(store, march.id)).rejects.toThrow('最新一期');
    await undoLatestReconciliation(store, april.id);
    await undoLatestReconciliation(store, march.id);
    expect((await store.transactions.get(groceries.id))?.status).toBe('pending');
    expect((await store.transactions.get(adjustment!.id))?.recordState).toBe('voided');
    await store.close();
  });

  it('round-trips CRUD through SQLite', async () => {
    const store = await openTransactionLedger();
    const saved = await store.transactions.put(tx({ description: '午餐', merchant: 'Noodle Bar' }));

    const got = await store.transactions.get(saved.id);
    expect(got?.description).toBe('午餐');
    expect(got?.merchant).toBe('Noodle Bar');

    await store.transactions.remove(saved.id, saved.version);
    expect(await store.transactions.list()).toEqual([]);
    expect((await store.transactions.list({ includeDeleted: true }))[0]?.isDeleted).toBe(true);
    await store.close();
  });

  it('serializes concurrent root transactions so one rollback cannot erase another write', async () => {
    const store = await openTransactionLedger();
    let releaseFailure!: () => void;
    let markFailureReady!: () => void;
    const failureMayContinue = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const failureReady = new Promise<void>((resolve) => { markFailureReady = resolve; });

    const failed = store.transaction(async (transaction) => {
      await transaction.transactions.put(tx({ description: 'will roll back' }));
      markFailureReady();
      await failureMayContinue;
      throw new Error('planned rollback');
    }).catch((error: unknown) => error);
    await failureReady;
    const successful = store.transaction(async (transaction) => {
      await transaction.transactions.put(tx({ description: 'must survive' }));
    });

    releaseFailure();
    expect(await failed).toBeInstanceOf(Error);
    await successful;
    expect((await store.transactions.list()).map((row) => row.description)).toEqual(['must survive']);
    await store.close();
  });

  it('persists transaction time, entity tags, locations and templates', async () => {
    const store = await openTransactionLedger();
    const tag: TransactionTag = { ...base(), name: '待报销', groupName: '报销', isActive: true } as TransactionTag;
    const location: TransactionLocation = { ...base(), name: '公司附近', address: 'Office', isActive: true } as TransactionLocation;
    await store.transactionTags.put(tag);
    await store.transactionLocations.put(location);
    const saved = await saveTransaction(store, tx({
      time: '13:04',
      timezone: 'Asia/Shanghai',
      tagIds: [tag.id],
      locationId: location.id,
      locationName: '公司附近',
      latitude: '31.2304160',
      longitude: '121.4737010',
      locationAccuracyMeters: '8.5',
    }));
    const template: TransactionTemplate = {
      ...base(), name: '午餐', type: 'expense', category: 'food', amount: '20', assetId: 'GBP',
      tagIds: [tag.id], locationId: location.id, isActive: true,
    } as TransactionTemplate;
    const savedView: TransactionSavedView = {
      ...base(), name: '待报销', queryJson: JSON.stringify({ range: 'all', tagId: tag.id }), isPinned: true, isActive: true,
    } as TransactionSavedView;
    await store.transactionTemplates.put(template);
    await store.transactionSavedViews.put(savedView);

    expect((await store.transactions.get(saved.id))?.tagIds).toEqual([tag.id]);
    expect(await store.transactions.get(saved.id)).toMatchObject({
      latitude: '31.2304160',
      longitude: '121.4737010',
      locationAccuracyMeters: '8.5',
    });
    const backup = await exportLedger(store);
    expect(backup.transactionTags?.[0]?.name).toBe('待报销');
    expect(backup.transactionLocations?.[0]?.name).toBe('公司附近');
    expect(backup.transactionTemplates?.[0]?.tagIds).toEqual([tag.id]);
    expect(backup.transactionSavedViews?.[0]?.name).toBe('待报销');
    expect(preflightImport(backup).ok).toBe(true);
    await store.close();
  });

  it('imports transactions with duplicate detection and monthly summary', async () => {
    const store = await openTransactionLedger();
    const salary = tx({ type: 'income', category: 'salary', amount: '3000', description: 'March salary' });
    const lunch = tx({ type: 'expense', category: 'food', amount: '22.40', merchant: 'Cafe' });

    const first = await importTransactions(store, { transactions: [salary, lunch] });
    expect(first.imported).toBe(2);

    const dup = await importTransactions(store, { transactions: [{ ...lunch, id: newId() }] });
    expect(dup.imported).toBe(0);
    expect(dup.skipped).toBe(1);

    const summary = await monthlyTransactionSummary(store, '2026-03', 'GBP');
    expect(round(summary.income, 2)).toBe('3000.00');
    expect(round(summary.expense, 2)).toBe('22.40');
    expect(round(summary.net, 2)).toBe('2977.60');
    expect(summary.byCategory[0]?.category).toBe('salary');
    await store.close();
  });

  it('imports refunds after their originals and remaps a skipped duplicate original', async () => {
    const store = await openTransactionLedger();
    const existingExpense = await saveTransaction(store, tx({ amount: '100', description: 'Headphones' }));
    const importedOriginalId = newId();
    const importedOriginal = { ...existingExpense, id: importedOriginalId };
    const refund = tx({
      type: 'refund',
      amount: '25',
      category: 'food',
      refundForId: importedOriginalId,
      refundAppliedAmount: '25',
      refundAppliedAssetId: 'GBP',
      description: 'Headphones refund',
    });

    const result = await importTransactions(store, { transactions: [refund, importedOriginal] });

    expect(result).toMatchObject({ imported: 1, skipped: 1, duplicateIds: [importedOriginalId] });
    const savedRefund = (await store.transactions.list()).find((row) => row.type === 'refund');
    expect(savedRefund?.refundForId).toBe(existingExpense.id);
    expect(savedRefund?.category).toBe(existingExpense.category);
    await store.close();
  });

  it('exports/imports transactions', async () => {
    const store = await openTransactionLedger();
    await saveTransaction(store, tx({ amount: '8.20', description: 'coffee' }));
    const backup = await exportLedger(store);
    expect(backup.transactions?.length).toBe(1);
    expect(preflightImport(backup).ok).toBe(true);
    await store.close();

    const fresh = await openLedger();
    await importLedger(fresh, backup);
    expect((await fresh.transactions.list())[0]?.description).toBe('coffee');
    await fresh.close();
  });

  it('persists categories, payees, splits, budgets, schedules and reconciliations', async () => {
    const store = await openTransactionLedger();
    const category: Category = { ...base(), id: 'cat-food', name: '工作餐', type: 'expense', parentId: 'expense-root', isActive: true, isHidden: true, budgetable: true } as Category;
    const payee: Payee = { ...base(), name: 'Noodle Bar', aliases: ['面馆'], defaultCategory: category.id, isActive: true } as Payee;
    await store.categories.put(category);
    await store.payees.put(payee);
    const parent = await store.transactions.put(tx({ category: category.id, amount: '60', merchant: payee.name, payeeId: payee.id }));
    const split: TransactionSplit = { ...base(), transactionId: parent.id, category: category.id, amount: '60' } as TransactionSplit;
    const budget: BudgetCategory = { ...base(), month: '2026-03', category: category.id, plannedAmount: '500', assetId: 'GBP', rolloverMode: 'none' } as BudgetCategory;
    const scheduled: ScheduledTransaction = {
      ...base(), name: '房租', type: 'expense', category: category.id, amount: '980', assetId: 'GBP',
      frequency: 'monthly', anchorDate: '2026-04-01', anchorMode: 'calendar_day', time: '09:00', timezone: 'Asia/Shanghai',
      catchUpPolicy: 'all', autoCreate: false, status: 'active',
    } as ScheduledTransaction;
    const reconciliation: ReconciliationSession = {
      ...base(), accountId: 'bank', assetId: 'GBP', statementDate: '2026-03-31',
      statementBalance: '0', openingBalance: '0', selectedTotal: '0', clearedBalance: '0', difference: '0',
      status: 'closed', closedAt: '2026-04-01T00:00:00.000Z',
    } as ReconciliationSession;

    await store.transactionSplits.put(split);
    await store.budgetCategories.put(budget);
    await store.scheduledTransactions.put(scheduled);
    await store.reconciliationSessions.put(reconciliation);

    expect((await store.categories.get(category.id))?.isHidden).toBe(true);
    expect((await store.payees.get(payee.id))?.aliases).toEqual(['面馆']);
    const backup = await exportLedger(store);
    expect(backup.categories?.map((c) => c.id)).toContain(category.id);
    expect(backup.payees?.[0]?.aliases).toEqual(['面馆']);
    expect(backup.transactionSplits?.[0]?.transactionId).toBe(parent.id);
    expect(backup.budgetCategories?.[0]?.plannedAmount).toBe('500');
    expect(backup.budgetCategories?.[0]?.assetId).toBe('GBP');
    expect(backup.scheduledTransactions?.[0]?.anchorDate).toBe('2026-04-01');
    expect(backup.reconciliationSessions?.[0]?.difference).toBe('0');
    await store.close();
  });

  it('anchors monthly schedules to month-end and executes each occurrence idempotently', async () => {
    const store = await openTransactionLedger();
    const schedule: ScheduledTransaction = {
      ...base(), id: 'monthly-rent', name: '月末房租', type: 'expense', category: 'housing', amount: '980', assetId: 'GBP',
      frequency: 'monthly', anchorDate: '2026-01-31', anchorMode: 'month_end', time: '09:00', timezone: 'Asia/Shanghai',
      catchUpPolicy: 'all', autoCreate: true, status: 'active',
    } as ScheduledTransaction;
    await store.scheduledTransactions.put(schedule);

    expect(await runDueScheduledTransactions(store, new Date('2026-03-31T02:00:00.000Z'))).toMatchObject({ created: 3, skipped: 0, errors: [] });
    expect((await store.scheduledExecutions.list()).map((row) => row.occurrenceDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect((await store.transactions.list()).map((row) => row.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(await runDueScheduledTransactions(store, new Date('2026-03-31T03:00:00.000Z'))).toMatchObject({ created: 0, skipped: 0, errors: [] });
    expect(await materializeScheduledTransaction(store, schedule.id, 2)).toMatchObject({ id: 'scheduled-transaction-monthly-rent-2' });
    await store.close();
  });

  it('does not truncate daily schedules beyond 1000 occurrences', async () => {
    const store = await openTransactionLedger();
    const schedule: ScheduledTransaction = {
      ...base(), id: 'daily-3y', name: '每日咖啡', type: 'expense', category: 'food', amount: '9.90', assetId: 'GBP',
      frequency: 'daily', anchorDate: '2023-01-01', anchorMode: 'calendar_day', time: '09:00', timezone: 'Asia/Shanghai',
      catchUpPolicy: 'all', autoCreate: true, status: 'active',
    } as ScheduledTransaction;
    await store.scheduledTransactions.put(schedule);

    // 2023-01-01 → 2026-03-01 共 1156 期,超过原 1000 期上限。
    const backlog = await previewScheduledBacklog(store, new Date('2026-03-01T02:00:00.000Z'));
    expect(backlog.length).toBe(1156);
    expect(backlog[0]).toMatchObject({ occurrenceIndex: 0, occurrenceDate: '2023-01-01', status: 'pending' });
    expect(backlog[1155]).toMatchObject({ occurrenceIndex: 1155, occurrenceDate: '2026-03-01', status: 'pending' });

    // 启动触发每轮有界，不会因多年积压卡住界面；剩余期次留给后续轮次。
    const result = await runDueScheduledTransactions(store, new Date('2026-03-01T02:00:00.000Z'));
    expect(result.created).toBe(100);
    expect(result.backlog).toBe(1156);
    expect(result.errors).toEqual([]);
    expect((await store.scheduledExecutions.list()).length).toBe(100);
    expect(await previewScheduledBacklog(store, new Date('2026-03-01T02:00:00.000Z'))).toHaveLength(1056);
    await store.close();
  });

  it('validates coordinated reconciliation changes at the outer transaction boundary', async () => {
    const store = await openTransactionLedger();
    const transaction = await saveTransaction(store, tx({ amount: '22', accountId: 'bank', status: 'cleared' }));
    const session = await closeReconciliation(store, {
      accountId: 'bank', assetId: 'GBP', statementDate: '2026-03-31', statementBalance: '-22',
      selectedTransactionIds: [transaction.id],
    });
    const [item] = await store.reconciliationItems.list({ where: { reconciliationId: session.id } });

    await store.transaction(async (transactionStore) => {
      const currentTransaction = (await transactionStore.transactions.get(transaction.id))!;
      const currentItem = (await transactionStore.reconciliationItems.get(item!.id))!;
      const currentSession = (await transactionStore.reconciliationSessions.get(session.id))!;
      await transactionStore.transactions.put({ ...currentTransaction, amount: '23' });
      await transactionStore.reconciliationItems.put({ ...currentItem, postingAmount: '-23' });
      await transactionStore.reconciliationSessions.put({
        ...currentSession,
        statementBalance: '-23',
        selectedTotal: '-23',
        clearedBalance: '-23',
        difference: '0',
      });
    });

    expect(await store.transactions.get(transaction.id)).toMatchObject({ amount: '23' });
    expect(await store.reconciliationItems.get(item!.id)).toMatchObject({ postingAmount: '-23' });
    const savedSession = (await store.reconciliationSessions.get(session.id))!;
    await expect(store.assertReconciliationAggregate(
      savedSession,
      await store.reconciliationItems.list({ where: { reconciliationId: session.id } }),
    )).resolves.toBeUndefined();
    await store.close();
  });

  it('materializes one occurrence once across two stores sharing the same database', async () => {
    const filename = join(tmpdir(), `zichan-scheduled-concurrency-${newId()}.sqlite`);
    let first: Awaited<ReturnType<typeof openLedger>> | undefined;
    let second: Awaited<ReturnType<typeof openLedger>> | undefined;
    try {
      first = await openLedger({ filename, deviceId: 'window-a' });
      await seedTransactionLedger(first);
      const schedule: ScheduledTransaction = {
        ...base(), id: 'shared-daily', name: '共享日计划', type: 'expense', category: 'food', amount: '8.88', assetId: 'GBP',
        frequency: 'daily', anchorDate: '2026-03-01', anchorMode: 'calendar_day', time: '09:00', timezone: 'Asia/Shanghai',
        catchUpPolicy: 'all', autoCreate: true, status: 'active',
      } as ScheduledTransaction;
      await first.scheduledTransactions.put(schedule);
      second = await openLedger({ filename, deviceId: 'window-b' });

      const [left, right] = await Promise.all([
        materializeScheduledTransaction(first, schedule.id, 0),
        materializeScheduledTransaction(second, schedule.id, 0),
      ]);

      const transactionId = scheduledTransactionId(schedule.id, 0);
      const executionId = scheduleExecutionId(schedule.id, 0);
      expect(left.id).toBe(transactionId);
      expect(right.id).toBe(transactionId);
      expect(await first.transactions.get(transactionId)).toMatchObject({ version: 1, scheduledExecutionId: executionId });
      const savedExecution = (await first.scheduledExecutions.get(executionId))!;
      expect(savedExecution).toMatchObject({
        version: 2,
        status: 'created',
        transactionId,
      });
      expect(savedExecution.lastError).toBeUndefined();
      expect(savedExecution.nextRetryAt).toBeUndefined();
      expect(await first.operationLog({ entityType: 'transaction', entityId: transactionId })).toHaveLength(1);
      expect(await first.operationLog({ entityType: 'scheduled_execution', entityId: executionId })).toHaveLength(1);
      expect((await first.listAuditBatches({ limit: 100 }))
        .filter((batch) => batch.label === `生成定期交易 ${schedule.name}`)).toHaveLength(1);

      const beforeTransaction = (await first.transactions.get(transactionId))!;
      const beforeExecution = (await first.scheduledExecutions.get(executionId))!;
      await expect(materializeScheduledTransaction(second, schedule.id, 0)).resolves.toMatchObject({ id: transactionId });
      expect(await first.transactions.get(transactionId)).toEqual(beforeTransaction);
      expect(await first.scheduledExecutions.get(executionId)).toEqual(beforeExecution);
    } finally {
      await second?.close();
      await first?.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${filename}${suffix}`, { force: true });
    }
  });

  it('does not let an expired scheduled claim overwrite a later success as failed', async () => {
    const store = await openTransactionLedger();
    const schedule: ScheduledTransaction = {
      ...base(), id: 'claim-takeover', name: '租约接管', type: 'expense', category: 'food', amount: '6.66', assetId: 'GBP',
      frequency: 'daily', anchorDate: '2026-03-01', anchorMode: 'calendar_day', time: '09:00', timezone: 'Asia/Shanghai',
      catchUpPolicy: 'all', autoCreate: true, status: 'active',
    } as ScheduledTransaction;
    await store.scheduledTransactions.put(schedule);
    const executionId = scheduleExecutionId(schedule.id, 0);
    const transactionId = scheduledTransactionId(schedule.id, 0);
    const claimInput = {
      id: executionId,
      scheduleId: schedule.id,
      occurrenceIndex: 0,
      occurrenceDate: '2026-03-01',
      transactionId,
      createdAt: '2026-03-01T09:00:00.000Z',
    };
    const stale = await store.claimScheduledExecution({
      ...claimInput,
      attemptedAt: '2026-03-01T00:00:00.000Z',
      leaseUntil: '2026-03-01T00:01:00.000Z',
    });
    expect(stale.state).toBe('claimed');
    if (stale.state !== 'claimed') throw new Error('测试未取得初始租约');
    const winner = await store.claimScheduledExecution({
      ...claimInput,
      attemptedAt: '2026-03-01T00:02:00.000Z',
      leaseUntil: '2026-03-01T00:03:00.000Z',
    });
    expect(winner.state).toBe('claimed');
    if (winner.state !== 'claimed') throw new Error('测试未接管过期租约');

    await store.transaction(async (transactionStore) => {
      const owned = (await transactionStore.getScheduledExecutionClaim(executionId, winner.token))!;
      await saveTransaction(transactionStore, tx({
        id: transactionId,
        date: '2026-03-01',
        amount: schedule.amount,
        scheduledExecutionId: executionId,
      }));
      await transactionStore.scheduledExecutions.put({
        ...owned,
        status: 'created',
        transactionId,
        completedAt: '2026-03-01T00:02:01.000Z',
        lastError: undefined,
        nextRetryAt: undefined,
      });
    });

    const staleFailureRecorded = await store.transaction(async (transactionStore) => {
      const owned = await transactionStore.getScheduledExecutionClaim(executionId, stale.token);
      if (!owned) return false;
      await transactionStore.scheduledExecutions.put({
        ...owned,
        status: 'failed',
        lastError: '晚到的失败',
      });
      return true;
    });
    expect(staleFailureRecorded).toBe(false);
    expect(await store.scheduledExecutions.get(executionId)).toMatchObject({
      status: 'created',
      transactionId,
    });
    await store.close();
  });

  it('allows different ledgers to run scheduled work concurrently', async () => {
    const first = await openTransactionLedger();
    const second = await openTransactionLedger();
    const schedule = (id: string): ScheduledTransaction => ({
      ...base(), id, name: id, type: 'expense', category: 'food', amount: '1', assetId: 'GBP',
      frequency: 'daily', anchorDate: '2026-03-01', anchorMode: 'calendar_day', time: '09:00', timezone: 'Asia/Shanghai',
      catchUpPolicy: 'all', autoCreate: true, status: 'active',
    } as ScheduledTransaction);
    try {
      await first.scheduledTransactions.put(schedule('first-ledger-daily'));
      await second.scheduledTransactions.put(schedule('second-ledger-daily'));
      const [firstResult, secondResult] = await Promise.all([
        runDueScheduledTransactions(first, new Date('2026-03-01T02:00:00.000Z')),
        runDueScheduledTransactions(second, new Date('2026-03-01T02:00:00.000Z')),
      ]);
      expect(firstResult).toMatchObject({ created: 1, errors: [] });
      expect(secondResult).toMatchObject({ created: 1, errors: [] });
    } finally {
      await first.close();
      await second.close();
    }
  });
});
