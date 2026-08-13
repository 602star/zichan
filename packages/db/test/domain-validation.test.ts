import { describe, expect, it } from 'vitest';
import {
  applyPendingCommits,
  archiveMasterData,
  exportLedger,
  importLedger,
  preflightImport,
  recordConversion,
  restoreLedger,
  saveTransactionAggregate,
} from '../src/index.js';
import { openLedger } from '../src/node.js';
import {
  newId,
  type Account,
  type Asset,
  type Category,
  type ConversionChain,
  type ConversionStep,
  type FixedAsset,
  type FixedAssetCategory,
  type Payee,
  type ReconciliationSession,
  type SyncCommitV2,
  type Transaction,
  type TransactionLocation,
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

function businessSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(businessSnapshot)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  const entity = typeof row['id'] === 'string';
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key !== 'exportedAt' && (!entity || !['createdAt', 'updatedAt', 'version'].includes(key)))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, businessSnapshot(nested)]),
  );
}

describe('unified domain validation', () => {
  it('rejects third-asset conversion fees without a frozen book-currency value', async () => {
    const store = await openLedger();
    const refs = await seed(store);
    await store.assets.put({
      ...base('BTC'), code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8, isActive: true,
    } satisfies Asset);
    await store.assets.put({
      ...base('FEE'), code: 'FEE', name: 'Fee token', type: 'crypto', decimals: 8, isActive: true,
    } satisfies Asset);
    const chain = {
      ...base('conversion-with-unvalued-fee'), date: '2026-08-01', type: 'buy', baseCurrencyAssetId: refs.asset.id,
    } satisfies ConversionChain;
    const steps = [{
      id: 'conversion-step', chainId: chain.id, order: 1,
      fromAssetId: refs.asset.id, fromAmount: '100', toAssetId: 'BTC', toAmount: '0.001',
      fees: [{ id: 'fee', assetId: 'FEE', amount: '1', treatment: 'third_asset_extra' }],
    }] satisfies ConversionStep[];

    await expect(store.saveChainWithSteps(chain, steps)).rejects.toThrow('非本位币手续费必须填写本位币金额');
    expect(await store.conversionChains.get(chain.id)).toBeNull();
    await store.close();
  });

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

  it('requires CAS for deletes and protects refund-linked asset and amount bounds', async () => {
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
    const otherAsset = await store.assets.put({
      ...base('USD'), code: 'USD', name: '美元', type: 'fiat', decimals: 2, isActive: true,
    } satisfies Asset);
    await expect(store.transactions.put({ ...original, assetId: otherAsset.id })).rejects.toThrow('不能修改币种');
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

  it('round-trips archived historical references in one non-undoable import batch', async () => {
    const source = await openLedger({ deviceId: 'source' });
    const refs = await seed(source);
    const btc = await source.assets.put({
      ...base('BTC'), code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8, isActive: true,
    } satisfies Asset);
    const payee = await source.payees.put({
      ...base('payee'), name: '商户', defaultCategory: refs.leaf.id, defaultAccountId: refs.account.id, isActive: true,
    } satisfies Payee);
    const tag = await source.transactionTags.put({
      ...base('tag'), name: '标签', isActive: true,
    } satisfies TransactionTag);
    const location = await source.transactionLocations.put({
      ...base('location'), name: '地点', isActive: true,
    } satisfies TransactionLocation);
    const fixedRoot = await source.fixedAssetCategories.put({
      ...base('fixed-root'), name: '电子产品', isActive: true,
    } satisfies FixedAssetCategory);
    const fixedLeaf = await source.fixedAssetCategories.put({
      ...base('fixed-leaf'), name: '电脑', parentId: fixedRoot.id, isActive: true,
    } satisfies FixedAssetCategory);
    await source.fixedAssets.put({
      ...base('fixed-asset'), name: '工作电脑', categoryId: fixedLeaf.id, status: 'active',
      purchaseDate: '2026-07-01', baseCurrencyAssetId: refs.asset.id,
    } satisfies FixedAsset);
    await saveTransactionAggregate(source, {
      transaction: { ...expense(refs), id: 'historical-expense', payeeId: payee.id, tagIds: [tag.id], locationId: location.id },
    });
    await recordConversion(source, {
      chain: {
        ...base('historical-conversion'), date: '2026-07-24', type: 'buy', baseCurrencyAssetId: refs.asset.id,
      } satisfies ConversionChain,
      steps: [{
        id: 'historical-step', chainId: 'historical-conversion', order: 1,
        fromAssetId: refs.asset.id, fromAmount: '100', toAssetId: btc.id, toAmount: '0.001',
        accountFromId: refs.account.id,
      } satisfies ConversionStep],
    });

    await archiveMasterData(source, 'payee', payee.id, payee.version);
    await archiveMasterData(source, 'tag', tag.id, tag.version);
    await archiveMasterData(source, 'location', location.id, location.version);
    await archiveMasterData(source, 'category', refs.leaf.id, refs.leaf.version);
    await archiveMasterData(source, 'category', refs.root.id, refs.root.version);
    await archiveMasterData(source, 'fixed_category', fixedLeaf.id, fixedLeaf.version);
    await archiveMasterData(source, 'account', refs.account.id, refs.account.version);
    await archiveMasterData(source, 'asset', refs.asset.id, refs.asset.version);
    await archiveMasterData(source, 'asset', btc.id, btc.version);

    const backup = await exportLedger(source);
    expect(preflightImport(backup).ok).toBe(true);
    const deletedTargetBackup = structuredClone(backup);
    deletedTargetBackup.assets.find((row) => row.id === refs.asset.id)!.isDeleted = true;
    expect(preflightImport(deletedTargetBackup)).toMatchObject({ ok: false });
    expect(preflightImport(deletedTargetBackup).issues).toContainEqual(expect.objectContaining({ code: 'missing_asset_ref' }));

    const fresh = await openLedger({ deviceId: 'fresh' });
    await importLedger(fresh, backup);
    expect(businessSnapshot(await exportLedger(fresh))).toEqual(businessSnapshot(backup));
    const importBatches = await fresh.listAuditBatches();
    expect(importBatches).toHaveLength(1);
    expect(importBatches[0]).toMatchObject({ type: 'import', outcome: 'applied' });
    const importLogs = await fresh.operationLog();
    expect(new Set(importLogs.map((row) => row.batchId))).toEqual(new Set([importBatches[0]!.id]));
    expect(importBatches[0]!.entityCount).toBe(importLogs.length);
    expect(await fresh.getBusinessCompensationByBatch(importBatches[0]!.id)).toBeNull();
    expect(await fresh.listSyncCommits()).toEqual([
      expect.objectContaining({ commitId: importBatches[0]!.id, sealed: true }),
    ]);

    const extra = await fresh.assets.put({
      ...base('extra'), code: 'EXTRA', name: '待移除资产', type: 'fiat', decimals: 2, isActive: true,
    } satisfies Asset);
    const beforeBatchIds = new Set((await fresh.listAuditBatches()).map((row) => row.id));
    const beforeLogIds = new Set((await fresh.operationLog()).map((row) => row.id));
    const beforeCommitIds = new Set((await fresh.listSyncCommits()).map((row) => row.commitId));
    expect((await restoreLedger(fresh, backup)).removed).toBe(1);
    expect((await fresh.assets.get(extra.id))?.isDeleted).toBe(true);
    const restoreBatches = (await fresh.listAuditBatches()).filter((row) => !beforeBatchIds.has(row.id));
    const restoreLogs = (await fresh.operationLog()).filter((row) => !beforeLogIds.has(row.id));
    const restoreCommits = (await fresh.listSyncCommits()).filter((row) => !beforeCommitIds.has(row.commitId));
    expect(restoreBatches).toHaveLength(1);
    expect(restoreBatches[0]).toMatchObject({ type: 'import', outcome: 'applied', entityCount: restoreLogs.length });
    expect(new Set(restoreLogs.map((row) => row.batchId))).toEqual(new Set([restoreBatches[0]!.id]));
    expect(restoreCommits).toEqual([expect.objectContaining({ commitId: restoreBatches[0]!.id, sealed: true })]);
    expect(await fresh.getBusinessCompensationByBatch(restoreBatches[0]!.id)).toBeNull();

    await expect(fresh.transactions.put({ ...expense(refs), id: 'ordinary-write-after-import' }))
      .rejects.toThrow(/归档|停用/);
    let escapedHistoricalStore: typeof fresh | undefined;
    await fresh.withBackupImportContext(async (historicalStore) => {
      escapedHistoricalStore = historicalStore;
    });
    await expect(escapedHistoricalStore!.transactions.put({
      ...expense(refs), id: 'escaped-historical-scope',
    })).rejects.toThrow(/归档|停用/);
    const callbackProbe = await openLedger({ deviceId: 'callback-probe' });
    await expect(importLedger(callbackProbe, backup, {
      afterImport: async (normalStore) => {
        await normalStore.transactions.put({ ...expense(refs), id: 'after-import-scope-leak' });
      },
    })).rejects.toThrow(/归档|停用/);
    expect(await callbackProbe.transactions.get('after-import-scope-leak')).toBeNull();
    await source.close();
    await fresh.close();
    await callbackProbe.close();
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
