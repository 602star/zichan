import { describe, expect, it } from 'vitest';
import {
  balanceOf,
  newId,
  postingsFromTransaction,
  scheduleExecutionId,
  type Asset,
  type Category,
} from '@zichan/core';
import { openLedger } from '../src/node.js';
import {
  archiveFixedUsageMetric,
  archiveScheduledTransaction,
  cancelFixedAssetGoal,
  deleteBudgetCategory,
  deleteFixedUsageLog,
  deleteGameRecord,
  deleteTransactionSavedView,
  materializeScheduledTransaction,
  previewScheduledBacklog,
  restoreDeletedBudgetCategory,
  restoreDeletedFixedUsageLog,
  restoreDeletedGameRecord,
  restoreDeletedTransactionSavedView,
  restoreFixedAssetGoalState,
  restoreFixedUsageMetricState,
  restoreScheduledTransactionState,
  retryScheduledExecution,
  saveGameRecordAggregate,
} from '../src/index.js';

function base(id = newId()) {
  return { id, createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

async function seedDailyLedger(store: Awaited<ReturnType<typeof openLedger>>) {
  const asset = await store.assets.put({
    ...base('CNY'),
    code: 'CNY',
    name: '人民币',
    type: 'fiat',
    decimals: 2,
    symbol: '¥',
    isActive: true,
  } satisfies Asset);
  const account = await store.accounts.put({
    ...base(),
    name: '日常账户',
    kind: 'bank',
    isActive: true,
  });
  const expenseParent = await store.categories.put({
    ...base(),
    name: '休闲娱乐',
    type: 'expense',
    isActive: true,
  } satisfies Category);
  const expense = await store.categories.put({
    ...base(),
    name: '游戏',
    type: 'expense',
    parentId: expenseParent.id,
    isActive: true,
  } satisfies Category);
  const incomeParent = await store.categories.put({
    ...base(),
    name: '其他收入',
    type: 'income',
    isActive: true,
  } satisfies Category);
  const income = await store.categories.put({
    ...base(),
    name: '游戏提现',
    type: 'income',
    parentId: incomeParent.id,
    isActive: true,
  } satisfies Category);
  return { asset, account, expense, income };
}

describe('P2 business compensation commands', () => {
  it('normalizes game settlement and fees into transactions without double-counting', async () => {
    const store = await openLedger();
    try {
      const { asset, account, expense, income } = await seedDailyLedger(store);
      const game = await store.games.put({
        ...base(),
        name: '测试游戏',
        enableSeason: false,
        isActive: true,
      });
      const saved = await saveGameRecordAggregate(store, {
        record: {
          ...base(),
          date: '2026-07-20',
          gameId: game.id,
          recordType: 'withdraw',
          settlementAssetId: asset.id,
          settlementAmount: '75',
          feeAssetId: asset.id,
          feeAmount: '5',
        },
        settlement: {
          mode: 'create_transaction',
          createTransaction: { categoryId: income.id, accountId: account.id },
        },
        fee: {
          mode: 'create_transaction',
          createTransaction: { categoryId: expense.id, accountId: account.id },
        },
      });

      expect(saved.settlementLink?.ownership).toBe('created');
      expect(saved.feeLink?.ownership).toBe('created');
      const activeTransactions = await store.transactions.list();
      expect(activeTransactions).toHaveLength(2);
      expect(balanceOf(activeTransactions.flatMap(postingsFromTransaction), asset.id)).toBe('70');

      const compensation = await deleteGameRecord(store, saved.record.id, saved.record.version);
      const voided = await store.transactions.list({ includeDeleted: true });
      expect(balanceOf(voided.flatMap(postingsFromTransaction), asset.id)).toBe('0');

      await restoreDeletedGameRecord(store, compensation);
      const restored = await store.transactions.list();
      expect(balanceOf(restored.flatMap(postingsFromTransaction), asset.id)).toBe('70');
    } finally {
      await store.close();
    }
  });

  it('rejects a standalone fee record that also carries a fee amount', async () => {
    const store = await openLedger();
    try {
      const { asset, account, expense } = await seedDailyLedger(store);
      const game = await store.games.put({
        ...base(),
        name: '测试游戏',
        enableSeason: false,
        isActive: true,
      });
      await expect(saveGameRecordAggregate(store, {
        record: {
          ...base(),
          date: '2026-07-21',
          gameId: game.id,
          recordType: 'fee',
          settlementAssetId: asset.id,
          settlementAmount: '5',
          feeAssetId: asset.id,
          feeAmount: '5',
        },
        settlement: {
          mode: 'create_transaction',
          createTransaction: { categoryId: expense.id, accountId: account.id },
        },
        fee: {
          mode: 'create_transaction',
          createTransaction: { categoryId: expense.id, accountId: account.id },
        },
      })).rejects.toThrow('独立手续费记录的费用应填写在结算金额字段');
    } finally {
      await store.close();
    }
  });

  it('restores operational deletes and state changes only from their exact CAS point', async () => {
    const store = await openLedger();
    try {
      const { asset, expense } = await seedDailyLedger(store);
      const budget = await store.budgetCategories.put({
        ...base(),
        month: '2026-07',
        category: expense.id,
        plannedAmount: '500',
        assetId: asset.id,
        rolloverMode: 'none',
      });
      await expect(deleteBudgetCategory(store, budget.id, budget.version - 1)).rejects.toThrow('其他窗口');
      const budgetUndo = await deleteBudgetCategory(store, budget.id, budget.version);
      expect((await store.budgetCategories.get(budget.id))?.isDeleted).toBe(true);
      await restoreDeletedBudgetCategory(store, budgetUndo);
      expect((await store.budgetCategories.get(budget.id))?.isDeleted).toBe(false);

      const savedView = await store.transactionSavedViews.put({
        ...base(),
        name: '本月游戏',
        queryJson: '{"operator":"and","conditions":[]}',
        isActive: true,
      });
      const viewUndo = await deleteTransactionSavedView(store, savedView.id, savedView.version);
      await restoreDeletedTransactionSavedView(store, viewUndo);
      expect((await store.transactionSavedViews.get(savedView.id))?.name).toBe('本月游戏');

      const schedule = await store.scheduledTransactions.put({
        ...base(),
        name: '月度订阅',
        type: 'expense',
        category: expense.id,
        amount: '20',
        assetId: asset.id,
        frequency: 'monthly',
        anchorDate: '2026-07-01',
        anchorMode: 'calendar_day',
        timezone: 'Asia/Shanghai',
        autoCreate: true,
        catchUpPolicy: 'all',
        status: 'active',
      });
      const scheduleUndo = await archiveScheduledTransaction(store, schedule.id, schedule.version);
      expect(await store.scheduledTransactions.get(schedule.id)).toMatchObject({ status: 'paused', autoCreate: false });
      await restoreScheduledTransactionState(store, scheduleUndo);
      expect(await store.scheduledTransactions.get(schedule.id)).toMatchObject({ status: 'active', autoCreate: true });
    } finally {
      await store.close();
    }
  });

  it('compensates fixed-asset metric, usage-log, and goal changes', async () => {
    const store = await openLedger();
    try {
      await store.assets.put({
        ...base('CNY'),
        code: 'CNY',
        name: '人民币',
        type: 'fiat',
        decimals: 2,
        isActive: true,
      });
      const categoryParent = await store.fixedAssetCategories.put({
        ...base(),
        name: '家用电器',
        isActive: true,
      });
      const category = await store.fixedAssetCategories.put({
        ...base(),
        name: '洗衣机',
        parentId: categoryParent.id,
        isActive: true,
      });
      const fixedAsset = await store.fixedAssets.put({
        ...base(),
        name: '洗衣机',
        categoryId: category.id,
        status: 'active',
        purchaseDate: '2026-01-01',
        baseCurrencyAssetId: 'CNY',
      });
      const metric = await store.fixedAssetUsageMetrics.put({
        ...base(),
        fixedAssetId: fixedAsset.id,
        name: '洗衣次数',
        unit: 'count',
        entryMode: 'increment',
        startValue: '0',
        isPrimary: true,
        isActive: true,
      });
      const log = await store.fixedAssetUsageLogs.put({
        ...base(),
        fixedAssetId: fixedAsset.id,
        metricId: metric.id,
        date: '2026-07-20',
        value: '1',
        entryMode: 'increment',
      });
      const goal = await store.fixedAssetGoals.put({
        ...base(),
        fixedAssetId: fixedAsset.id,
        name: '每次两元',
        metricId: metric.id,
        unit: 'count',
        mode: 'unit_cost',
        costBasisAmount: '500',
        targetUnitCost: '2',
        targetUsage: '250',
        startDate: '2026-01-01',
        status: 'active',
      });

      const metricUndo = await archiveFixedUsageMetric(store, metric.id, metric.version);
      const logUndo = await deleteFixedUsageLog(store, log.id, log.version);
      const goalUndo = await cancelFixedAssetGoal(store, goal.id, goal.version);
      expect(await store.fixedAssetUsageMetrics.get(metric.id)).toMatchObject({ isActive: false, isPrimary: false });
      expect((await store.fixedAssetUsageLogs.get(log.id))?.isDeleted).toBe(true);
      expect((await store.fixedAssetGoals.get(goal.id))?.status).toBe('cancelled');

      await restoreFixedUsageMetricState(store, metricUndo);
      await restoreDeletedFixedUsageLog(store, logUndo);
      await restoreFixedAssetGoalState(store, goalUndo);
      expect(await store.fixedAssetUsageMetrics.get(metric.id)).toMatchObject({ isActive: true, isPrimary: true });
      expect((await store.fixedAssetUsageLogs.get(log.id))?.isDeleted).toBe(false);
      expect((await store.fixedAssetGoals.get(goal.id))?.status).toBe('active');
    } finally {
      await store.close();
    }
  });
});

describe('P2 scheduled execution recovery', () => {
  it('keeps a failed occurrence in backlog and retries it after its reference is repaired', async () => {
    const store = await openLedger();
    try {
      const { asset, account, expense } = await seedDailyLedger(store);
      const schedule = await store.scheduledTransactions.put({
        ...base(),
        name: '待修复订阅',
        type: 'expense',
        category: expense.id,
        amount: '20',
        assetId: asset.id,
        frequency: 'monthly',
        anchorDate: '2026-07-01',
        anchorMode: 'calendar_day',
        timezone: 'Asia/Shanghai',
        autoCreate: true,
        catchUpPolicy: 'all',
        status: 'active',
      });
      await store.settings.put({
        ...base(),
        baseCurrencyAssetId: asset.id,
        ledgerMode: 'accounting',
      });

      await expect(materializeScheduledTransaction(store, schedule.id, 0)).rejects.toThrow('账户');
      const executionId = scheduleExecutionId(schedule.id, 0);
      const failed = await store.scheduledExecutions.get(executionId);
      expect(failed).toMatchObject({
        status: 'failed',
        retryCount: 1,
      });
      expect(Date.parse(failed!.nextRetryAt!) - Date.parse(failed!.attemptedAt!)).toBe(5 * 60_000);
      const backlog = await previewScheduledBacklog(store, new Date('2026-07-02T04:00:00.000Z'));
      expect(backlog).toContainEqual(expect.objectContaining({
        scheduleId: schedule.id,
        occurrenceIndex: 0,
        status: 'failed',
      }));

      const current = await store.scheduledTransactions.get(schedule.id);
      await store.scheduledTransactions.put({ ...current!, accountId: account.id });
      const transaction = await retryScheduledExecution(store, executionId);
      expect(transaction).toMatchObject({ amount: '20', category: expense.id });
      const recoveredExecution = await store.scheduledExecutions.get(executionId);
      expect(recoveredExecution).toMatchObject({
        status: 'created',
        retryCount: 1,
      });
      expect(recoveredExecution?.lastError).toBeUndefined();
      expect(recoveredExecution?.nextRetryAt).toBeUndefined();
      await expect(retryScheduledExecution(store, executionId)).rejects.toThrow('失败的定期执行记录不存在');
    } finally {
      await store.close();
    }
  });
});
