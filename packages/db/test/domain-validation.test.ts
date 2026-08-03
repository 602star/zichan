import { describe, expect, it } from 'vitest';
import {
  applyPendingCommits,
  exportLedger,
  preflightImport,
  restoreLedger,
  saveTransactionAggregate,
} from '../src/index.js';
import { openLedger } from '../src/node.js';
import {
  newId,
  type Account,
  type Asset,
  type Category,
  type ReconciliationSession,
  type SyncCommitV2,
  type Transaction,
  type TransactionTag,
} from '@zichan/core';

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
    ...base('expense-root'), name: '食品餐饮', type: 'expense', isActive: true,
  } satisfies Category);
  const leaf = await store.categories.put({
    ...base('food'), name: '堂食餐饮', type: 'expense', parentId: root.id, isActive: true,
  } satisfies Category);
  return { asset, account, root, leaf };
}

function expense(refs: Awaited<ReturnType<typeof seed>>, amount = '100'): Transaction {
  return {
    ...base(),
    date: '2026-07-23',
    type: 'expense',
    category: refs.leaf.id,
    amount,
    assetId: refs.asset.id,
    accountId: refs.account.id,
    status: 'cleared',
    recordState: 'active',
  } as Transaction;
}

describe('unified domain validation', () => {
  it('rejects a third category level and reports it during import preflight', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    await expect(store.categories.put({
      ...base(), name: '午餐', type: 'expense', parentId: refs.leaf.id, isActive: true,
    } satisfies Category)).rejects.toThrow('最多支持一级和二级');

    const backup = await exportLedger(store);
    backup.categories.push({
      ...base(), name: '午餐', type: 'expense', parentId: refs.leaf.id, isActive: true,
    } satisfies Category);
    expect(preflightImport(backup).issues).toContainEqual(expect.objectContaining({
      code: 'category_hierarchy_invalid',
    }));
    await store.close();
  });

  it('rejects partial direct split writes while allowing the exact aggregate command', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    const transaction = expense(refs);
    await store.transactions.put(transaction);
    await expect(store.transactionSplits.put({
      ...base(), transactionId: transaction.id, category: refs.leaf.id, amount: '60',
    })).rejects.toThrow('合计必须精确等于');
    expect(await store.transactionSplits.list()).toEqual([]);

    const saved = await saveTransactionAggregate(store, {
      transaction,
      splits: [{ ...base(), transactionId: transaction.id, category: refs.leaf.id, amount: '100' }],
    });
    await expect(store.transactionSplits.put({
      ...saved.splits[0]!,
      amount: '99',
    })).rejects.toThrow('合计必须精确等于');
    expect((await store.transactionSplits.get(saved.splits[0]!.id))?.amount).toBe('100');
    await store.close();
  });

  it('requires CAS for deletes and prevents an expense from shrinking below frozen refunds', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    const original = (await saveTransactionAggregate(store, { transaction: expense(refs) })).transaction;
    await saveTransactionAggregate(store, {
      transaction: {
        ...expense(refs, '70'),
        type: 'refund',
        refundForId: original.id,
        refundAppliedAmount: '70',
        refundAppliedAssetId: refs.asset.id,
      },
    });
    await expect(store.transactions.put({ ...original, amount: '60' })).rejects.toThrow('不能低于已退款金额');
    await expect((store.accounts as unknown as { remove: (id: string) => Promise<void> }).remove(refs.account.id))
      .rejects.toThrow('当前版本');
    await store.close();
  });

  it('blocks direct deletion of referenced master data and mathematically invalid reconciliations', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    const tag = await store.transactionTags.put({
      ...base('work-tag'), name: '工作', isActive: true,
    } satisfies TransactionTag);
    await store.transactions.put({ ...expense(refs), tagIds: [tag.id] });

    await expect(store.transactionTags.remove(tag.id, tag.version)).rejects.toThrow('仍有 1 项引用');
    await expect(store.reconciliationSessions.put({
      ...base('bad-reconciliation'),
      accountId: refs.account.id,
      assetId: refs.asset.id,
      statementDate: '2026-07-31',
      statementBalance: '10',
      openingBalance: '0',
      selectedTotal: '10',
      clearedBalance: '10',
      difference: '0',
      status: 'closed',
      closedAt: '2026-08-01T00:00:00.000Z',
    } satisfies ReconciliationSession)).rejects.toThrow('已选流水合计');
    await store.close();
  });

  it('restores an older snapshot over newer versions and atomically removes referenced extras', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    const backup = await exportLedger(store);
    await store.categories.put({ ...refs.leaf, name: '临时改名' });
    const tag = await store.transactionTags.put({
      ...base('temporary-tag'), name: '临时标签', isActive: true,
    } satisfies TransactionTag);
    const extra = await store.transactions.put({ ...expense(refs), tagIds: [tag.id] });

    const result = await restoreLedger(store, backup);

    expect(result.removed).toBe(2);
    expect((await store.categories.get(refs.leaf.id))?.name).toBe('堂食餐饮');
    expect((await store.transactionTags.get(tag.id))?.isDeleted).toBe(true);
    expect((await store.transactions.get(extra.id))?.isDeleted).toBe(true);
    await store.close();
  });

  it('quarantines a remote transaction that violates local references', async () => {
    const store = await openLedger({ deviceId: 'local' });
    const transaction = {
      ...base('remote-invalid'),
      date: '2026-07-23',
      type: 'expense',
      category: 'missing-category',
      amount: '10',
      assetId: 'missing-asset',
      status: 'cleared',
      recordState: 'active',
    } as Transaction;
    const commit: SyncCommitV2 = {
      protocol: 2,
      ledgerId: await store.getLedgerId(),
      commitId: newId(),
      originDeviceId: 'remote',
      createdAt: new Date().toISOString(),
      parentCommitIds: [],
      revisions: [{
        revisionId: newId(),
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        parentRevisionIds: [],
        op: 'put',
        payload: { transaction, splits: [], refundAllocations: [] },
      }],
    };
    await store.storeSyncCommit(commit, { source: 'remote', state: 'pending' });

    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(1);
    expect(await store.transactions.get(transaction.id)).toBeNull();
    expect((await store.listSyncCommits({ includeInvalid: true })).find((row) => row.commitId === commit.commitId))
      .toMatchObject({ state: 'invalid', error: expect.stringContaining('missing-asset') });
    await store.close();
  });
});
