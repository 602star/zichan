import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  newId,
  type Account,
  type Asset,
  type Attachment,
  type Category,
  type ConversionChain,
  type ConversionStep,
  type Transaction,
  type TransactionSplit,
} from '@zichan/core';
import {
  inspectBusinessCompensation,
  saveTransactionAggregate,
  undoBusinessCompensation,
} from '../src/index.js';
import { openLedger } from '../src/node.js';

function base(id = newId()) {
  return { id, createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

async function seed(store: Awaited<ReturnType<typeof openLedger>>) {
  const asset = await store.assets.put({
    ...base('CNY'), code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true,
  } satisfies Asset);
  const account = await store.accounts.put({
    ...base('bank'), name: '银行卡', kind: 'bank', isActive: true,
  } satisfies Account);
  const root = await store.categories.put({
    ...base('food-root'), name: '食品餐饮', type: 'expense', isActive: true,
  } satisfies Category);
  const meal = await store.categories.put({
    ...base('meal'), name: '堂食餐饮', type: 'expense', parentId: root.id, isActive: true,
  } satisfies Category);
  const drink = await store.categories.put({
    ...base('drink'), name: '咖啡奶茶', type: 'expense', parentId: root.id, isActive: true,
  } satisfies Category);
  return { asset, account, meal, drink };
}

function transaction(refs: Awaited<ReturnType<typeof seed>>): Transaction {
  return {
    ...base('lunch'),
    date: '2026-07-23',
    type: 'expense',
    category: refs.meal.id,
    amount: '100',
    assetId: refs.asset.id,
    accountId: refs.account.id,
    status: 'cleared',
    recordState: 'active',
    description: '午餐',
  } as Transaction;
}

function split(
  id: string,
  transactionId: string,
  category: string,
  amount: string,
): TransactionSplit {
  return { ...base(id), transactionId, category, amount } as TransactionSplit;
}

function attachment(
  id: string,
  transactionId: string,
  fileName: string,
  hashCharacter: string,
): Attachment {
  return {
    ...base(id),
    entityType: 'transaction',
    entityId: transactionId,
    fileName,
    mimeType: 'image/jpeg',
    role: 'image',
    sizeBytes: 128,
    sha256: hashCharacter.repeat(64),
  } as Attachment;
}

describe('persistent business compensation', () => {
  it('restores a complete transaction aggregate and attachment relationships after reopen', async () => {
    const filename = join(tmpdir(), `zichan-compensation-${newId()}.sqlite`);
    try {
      let store = await openLedger({ filename, deviceId: 'desktop-a' });
      const refs = await seed(store);
      const original = transaction(refs);
      const firstSplits = [
        split('split-meal', original.id, refs.meal.id, '60'),
        split('split-drink', original.id, refs.drink.id, '40'),
      ];
      const oldAttachment = attachment('receipt-old', original.id, 'old.jpg', 'a');
      await store.runInAuditBatch('新增午餐流水及附件', async (transactionStore) => {
        await saveTransactionAggregate(transactionStore, { transaction: original, splits: firstSplits });
        await transactionStore.attachments.put(oldAttachment);
      });

      const current = (await store.transactions.get(original.id))!;
      const currentSplits = await store.transactionSplits.list({ where: { transactionId: original.id } });
      const newAttachment = attachment('receipt-new', original.id, 'new.jpg', 'b');
      await store.runInAuditBatch('修改午餐流水及附件', async (transactionStore) => {
        await saveTransactionAggregate(transactionStore, {
          transaction: { ...current, amount: '120', description: '午餐和饮料' },
          expectedVersion: current.version,
          splits: currentSplits.map((row) => ({
            ...row,
            amount: row.id === 'split-meal' ? '70' : '50',
          })),
        });
        const beforeAttachment = (await transactionStore.attachments.get(oldAttachment.id))!;
        await transactionStore.attachments.remove(beforeAttachment.id, beforeAttachment.version);
        await transactionStore.attachments.put(newAttachment);
      });
      const compensation = (await store.listBusinessCompensations({ status: 'pending' }))
        .find((row) => row.label === '修改午餐流水及附件');
      expect(compensation?.affectedEntities).toEqual(expect.arrayContaining([
        { entityType: 'transaction', entityId: original.id },
        { entityType: 'attachment', entityId: oldAttachment.id },
        { entityType: 'attachment', entityId: newAttachment.id },
      ]));
      await store.close();

      store = await openLedger({ filename, deviceId: 'desktop-a' });
      await undoBusinessCompensation(store, compensation!.id);

      expect(await store.transactions.get(original.id)).toMatchObject({
        amount: '100',
        description: '午餐',
      });
      expect((await store.transactionSplits.list({ where: { transactionId: original.id } }))
        .map((row) => [row.id, row.amount]).sort()).toEqual([
        ['split-drink', '40'],
        ['split-meal', '60'],
      ]);
      expect((await store.attachments.get(oldAttachment.id))?.isDeleted).toBe(false);
      expect((await store.attachments.get(newAttachment.id))?.isDeleted).toBe(true);
      expect((await store.getBusinessCompensation(compensation!.id))?.status).toBe('applied');
      await store.close();
    } finally {
      rmSync(filename, { force: true });
    }
  });

  it('blocks the whole compensation when an affected entity changed later', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    const saved = (await saveTransactionAggregate(store, { transaction: transaction(refs) })).transaction;
    await saveTransactionAggregate(store, {
      transaction: { ...saved, amount: '110' },
      expectedVersion: saved.version,
    });
    const compensation = (await store.listBusinessCompensations({ status: 'pending' }))
      .find((row) => row.label === '保存流水');
    await expect(inspectBusinessCompensation(store, compensation!.id)).resolves.toMatchObject({ reversible: true });
    const latest = (await store.transactions.get(saved.id))!;
    await saveTransactionAggregate(store, {
      transaction: { ...latest, description: '后来又修改' },
      expectedVersion: latest.version,
    });

    await expect(inspectBusinessCompensation(store, compensation!.id)).resolves.toMatchObject({
      reversible: false,
      blocker: expect.stringContaining('后来发生了变化'),
    });
    expect((await store.getBusinessCompensation(compensation!.id))?.status).toBe('pending');

    await expect(undoBusinessCompensation(store, compensation!.id)).rejects.toThrow('后来发生了变化');
    expect((await store.transactions.get(saved.id))?.description).toBe('后来又修改');
    expect((await store.getBusinessCompensation(compensation!.id))?.status).toBe('blocked');
    await store.close();
  });

  it('coalesces repeated writes in one batch and exposes its signal only once', async () => {
    const store = await openLedger();
    const refs = await seed(store);

    await store.runInAuditBatch('批量调整分类', async (transactionStore) => {
      const firstMeal = await transactionStore.categories.put({ ...refs.meal, isHidden: true });
      await transactionStore.categories.put({ ...refs.drink, isHidden: true });
      await transactionStore.categories.put({ ...firstMeal, sortOrder: 7 });
    }, 'bulk_update');

    const compensation = await store.consumeLatestBusinessCompensation();
    expect(compensation?.label).toBe('批量调整分类');
    expect(compensation?.payload.states).toHaveLength(2);
    const sourceBatch = (await store.listAuditBatches()).find((batch) => batch.id === compensation?.sourceBatchId);
    expect(sourceBatch?.type).toBe('bulk_update');
    const mealState = compensation?.payload.states.find((state) => state.entityId === refs.meal.id);
    expect(mealState?.before).not.toHaveProperty('isHidden');
    expect(mealState?.before).not.toHaveProperty('sortOrder');
    expect(mealState?.after).toMatchObject({ isHidden: true, sortOrder: 7 });
    expect(await store.consumeLatestBusinessCompensation()).toBeNull();

    await undoBusinessCompensation(store, compensation!.id);
    const restoredMeal = await store.categories.get(refs.meal.id);
    const restoredDrink = await store.categories.get(refs.drink.id);
    expect(restoredMeal).not.toHaveProperty('isHidden');
    expect(restoredMeal).not.toHaveProperty('sortOrder');
    expect(restoredDrink).not.toHaveProperty('isHidden');
    await store.close();
  });

  it('keeps a compensation retryable after a transient infrastructure failure', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    await saveTransactionAggregate(store, { transaction: transaction(refs) });
    const compensation = await store.consumeLatestBusinessCompensation();
    expect((await store.listAuditBatches()).find((batch) => batch.id === compensation!.sourceBatchId)?.type).toBe('user');
    const originalWithAuditContext = store.withAuditContext.bind(store);
    (store as unknown as { withAuditContext: typeof store.withAuditContext }).withAuditContext = async () => {
      throw new Error('SQLITE_BUSY: temporary lock');
    };

    await expect(undoBusinessCompensation(store, compensation!.id)).rejects.toThrow('temporary lock');
    expect(await store.getBusinessCompensation(compensation!.id)).toMatchObject({
      status: 'pending',
      error: expect.stringContaining('temporary lock'),
    });

    (store as unknown as { withAuditContext: typeof store.withAuditContext }).withAuditContext = originalWithAuditContext;
    await expect(undoBusinessCompensation(store, compensation!.id)).resolves.toMatchObject({ status: 'applied' });
    await store.close();
  });

  it('never reopens an applied compensation when audit finalization fails after commit', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    await store.runInAuditBatch('修改分类名称', async (transactionStore) => {
      await transactionStore.categories.put({ ...refs.meal, name: '工作餐' });
    });
    const compensation = await store.consumeLatestBusinessCompensation();
    const originalFinishAuditBatch = store.finishAuditBatch.bind(store);
    let failOnce = true;
    (store as unknown as { finishAuditBatch: typeof store.finishAuditBatch }).finishAuditBatch = async (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('audit storage unavailable');
      }
      return originalFinishAuditBatch(...args);
    };

    await expect(undoBusinessCompensation(store, compensation!.id)).rejects.toThrow('audit storage unavailable');
    expect(await store.getBusinessCompensation(compensation!.id)).toMatchObject({ status: 'applied' });
    await expect(undoBusinessCompensation(store, compensation!.id)).rejects.toThrow('已经撤销');
    expect((await store.categories.get(refs.meal.id))?.name).toBe(refs.meal.name);
    await store.close();
  });

  it('never reopens an applied compensation when sync-commit sealing fails after commit', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    await store.runInAuditBatch('修改分类名称', async (transactionStore) => {
      await transactionStore.categories.put({ ...refs.meal, name: '工作餐' });
    });
    const compensation = await store.consumeLatestBusinessCompensation();
    const originalWithAuditContext = store.withAuditContext.bind(store);
    let failOnce = true;
    (store as unknown as { withAuditContext: typeof store.withAuditContext }).withAuditContext = async (...args) => {
      const result = await originalWithAuditContext(...args);
      if (failOnce) {
        failOnce = false;
        throw new Error('sync commit seal unavailable');
      }
      return result;
    };

    await expect(undoBusinessCompensation(store, compensation!.id)).rejects.toThrow('sync commit seal unavailable');
    expect(await store.getBusinessCompensation(compensation!.id)).toMatchObject({ status: 'applied' });
    await expect(undoBusinessCompensation(store, compensation!.id)).rejects.toThrow('已经撤销');
    expect((await store.categories.get(refs.meal.id))?.name).toBe(refs.meal.name);
    await store.close();
  });

  it('restores a conversion chain and its complete step set together', async () => {
    const store = await openLedger();
    for (const asset of [
      { id: 'GBP', code: 'GBP', name: '英镑', type: 'fiat', decimals: 2 },
      { id: 'USDT', code: 'USDT', name: 'Tether', type: 'stablecoin', decimals: 6 },
      { id: 'BTC', code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8 },
    ] as const) {
      await store.assets.put({ ...base(asset.id), ...asset, isActive: true } as Asset);
    }
    const chain: ConversionChain = {
      ...base('chain-1'),
      date: '2026-07-23',
      type: 'exchange',
      title: '原转换',
      baseCurrencyAssetId: 'GBP',
    };
    const originalSteps: ConversionStep[] = [
      {
        id: 'step-1',
        chainId: chain.id,
        order: 1,
        fromAssetId: 'GBP',
        fromAmount: '100',
        toAssetId: 'USDT',
        toAmount: '125',
      },
      {
        id: 'step-2',
        chainId: chain.id,
        order: 2,
        fromAssetId: 'USDT',
        fromAmount: '125',
        toAssetId: 'BTC',
        toAmount: '0.0015',
      },
    ];
    await store.runInAuditBatch('新增转换', (transactionStore) =>
      transactionStore.saveChainWithSteps(chain, originalSteps));
    const current = (await store.getChainWithSteps(chain.id))!;

    await store.runInAuditBatch('修改转换', (transactionStore) =>
      transactionStore.saveChainWithSteps(
        { ...current.chain, title: '修改后转换' },
        [{
          ...current.steps[0]!,
          toAmount: '126',
        }],
      ));
    const compensation = (await store.listBusinessCompensations({ status: 'pending' }))
      .find((row) => row.label === '修改转换');

    await undoBusinessCompensation(store, compensation!.id);
    const restored = (await store.getChainWithSteps(chain.id))!;
    expect(restored.chain.title).toBe('原转换');
    expect(restored.steps.map((step) => [step.id, step.toAmount])).toEqual([
      ['step-1', '125'],
      ['step-2', '0.0015'],
    ]);
    await store.close();
  });

  it('restores frozen refund allocations together with a refund edit', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    const originalDraft = transaction(refs);
    const original = await saveTransactionAggregate(store, {
      transaction: originalDraft,
      splits: [
        split('refund-source-meal', originalDraft.id, refs.meal.id, '60'),
        split('refund-source-drink', originalDraft.id, refs.drink.id, '40'),
      ],
    });
    const refundDraft: Transaction = {
      ...transaction(refs),
      id: 'refund-1',
      type: 'refund',
      amount: '25',
      refundForId: original.transaction.id,
      refundAppliedAmount: '25',
      refundAppliedAssetId: refs.asset.id,
      description: '部分退款',
    };
    const refund = await saveTransactionAggregate(store, {
      transaction: refundDraft,
      refundAllocations: [
        { sourceSplitId: 'refund-source-meal', amount: '20' },
        { sourceSplitId: 'refund-source-drink', amount: '5' },
      ],
    });
    const originalAllocation = refund.refundAllocations.map((row) => ({
      sourceSplitId: row.sourceSplitId,
      categoryId: row.categoryId,
      amount: row.amount,
    }));

    await saveTransactionAggregate(store, {
      transaction: {
        ...refund.transaction,
        amount: '30',
        refundAppliedAmount: '30',
        description: '修改后的退款',
      },
      expectedVersion: refund.transaction.version,
      refundAllocations: [
        { sourceSplitId: 'refund-source-meal', amount: '10' },
        { sourceSplitId: 'refund-source-drink', amount: '20' },
      ],
    });
    const compensation = await store.consumeLatestBusinessCompensation();
    await undoBusinessCompensation(store, compensation!.id);

    expect(await store.transactions.get(refund.transaction.id)).toMatchObject({
      amount: '25',
      refundAppliedAmount: '25',
      description: '部分退款',
    });
    expect((await store.refundAllocations.list({ where: { refundTransactionId: refund.transaction.id } }))
      .map((row) => ({
        sourceSplitId: row.sourceSplitId,
        categoryId: row.categoryId,
        amount: row.amount,
      }))
      .sort((left, right) => String(left.sourceSplitId).localeCompare(String(right.sourceSplitId))))
      .toEqual(originalAllocation.sort((left, right) => String(left.sourceSplitId).localeCompare(String(right.sourceSplitId))));
    await store.close();
  });
});
