import { describe, expect, it } from 'vitest';
import {
  newId,
  sha256Json,
  wireSyncCommit,
  type Account,
  type Asset,
  type Category,
  type PriceMark,
  type ReconciliationItem,
  type ReconciliationSession,
  type SyncCommitV2,
  type Transaction,
} from '@zichan/core';
import {
  aggregateKey,
  applyPendingCommits,
  archiveMasterData,
  closeReconciliation,
  exportLedger,
  importLedger,
  memoryCommitTransport,
  mergeMasterData,
  resolveConflictGroup,
  restoreLedger,
  restoreTransaction,
  saveTransactionAggregate,
  syncReplica,
  syncReplicas,
  undoLatestReconciliation,
  voidTransaction,
  replicaKey,
  type CommitTransport,
} from '../src/index.js';
import { openLedger } from '../src/node.js';
import { openDiagnosticLedger } from './diagnostic-ledger.js';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

function asset(code: string): Asset {
  return { ...base(), code, name: code, type: 'crypto', decimals: 8, isActive: true } as Asset;
}

function mark(id: string, price: string): PriceMark {
  return { ...base(), id, assetId: 'BTC', quoteAssetId: 'USD', price, date: '2026-07-13', source: 'manual' } as PriceMark;
}

async function shareLedgerId(...stores: Awaited<ReturnType<typeof openLedger>>[]) {
  const ledgerId = await stores[0]!.getLedgerId();
  for (const store of stores.slice(1)) await store.adoptLedgerId(ledgerId);
}

async function openPriceLedger(deviceId: string) {
  const { store, rawPut } = await openDiagnosticLedger({ deviceId });
  await rawPut('assets', { ...asset('BTC'), id: 'BTC' });
  await rawPut('assets', { ...asset('USD'), id: 'USD' });
  return store;
}

async function seedTransactionReferences(store: Awaited<ReturnType<typeof openLedger>>) {
  const currency = await store.assets.put({
    ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true,
  } as Asset);
  const account = await store.accounts.put({
    ...base(), id: 'bank', name: 'Bank', kind: 'bank', isActive: true,
  } as Account);
  const targetAccount = await store.accounts.put({
    ...base(), id: 'bank-target', name: 'Target bank', kind: 'bank', isActive: true,
  } as Account);
  const expenseRoot = await store.categories.put({
    ...base(), id: 'expense-root', name: 'Expense', type: 'expense', isActive: true,
  } as Category);
  const expenseCategory = await store.categories.put({
    ...base(), id: 'food', name: 'Food', type: 'expense', parentId: expenseRoot.id, isActive: true,
  } as Category);
  const targetCategory = await store.categories.put({
    ...base(), id: 'groceries', name: 'Groceries', type: 'expense', parentId: expenseRoot.id, isActive: true,
  } as Category);
  return { currency, account, targetAccount, expenseCategory, targetCategory };
}

function expenseTransaction(
  refs: Awaited<ReturnType<typeof seedTransactionReferences>>,
  overrides: Partial<Transaction> = {},
): Transaction {
  return {
    ...base(),
    date: '2026-03-12',
    timePrecision: 'day',
    type: 'expense',
    category: refs.expenseCategory.id,
    amount: '80',
    assetId: refs.currency.id,
    accountId: refs.account.id,
    status: 'pending',
    recordState: 'active',
    ...overrides,
  } as Transaction;
}

async function syncOneWay(
  source: Awaited<ReturnType<typeof openLedger>>,
  target: Awaited<ReturnType<typeof openLedger>>,
  transport: ReturnType<typeof memoryCommitTransport>,
) {
  await syncReplica(source, transport, 'memory');
  return syncReplica(target, transport, 'memory');
}

async function expectHealthyReplica(store: Awaited<ReturnType<typeof openLedger>>) {
  expect(await store.listConflicts()).toEqual([]);
  expect((await store.listSyncCommits({ includeInvalid: true })).filter((row) => row.state === 'invalid')).toEqual([]);
}

describe('sync protocol v2', () => {
  it('applies reconciliation adjustments before their closed snapshot and replays an undo', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const refs = await seedTransactionReferences(a);
    const original = (await saveTransactionAggregate(a, { transaction: expenseTransaction(refs) })).transaction;
    await syncOneWay(a, b, transport);

    const session = await closeReconciliation(a, {
      accountId: refs.account.id,
      assetId: refs.currency.id,
      statementDate: '2026-03-31',
      statementBalance: '-100',
      selectedTransactionIds: [original.id],
      createAdjustment: true,
    });
    const result = await syncOneWay(a, b, transport);

    expect(result).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    const adjustment = await b.transactions.get(session.adjustmentTransactionId!);
    expect(adjustment).toMatchObject({
      type: 'adjustment', amount: '20', adjustmentDirection: 'decrease', reconciliationSessionId: session.id,
    });
    expect(await b.transactions.get(original.id)).toMatchObject({ status: 'cleared' });
    expect(await b.reconciliationSessions.get(session.id)).toMatchObject({
      status: 'closed', difference: '0', adjustmentTransactionId: adjustment!.id,
    });
    expect(await b.reconciliationItems.list({ where: { reconciliationId: session.id } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transactionId: original.id, postingAmount: '-80' }),
        expect.objectContaining({ transactionId: adjustment!.id, postingAmount: '-20' }),
      ]),
    );
    await expectHealthyReplica(b);

    await undoLatestReconciliation(a, session.id);
    const undoResult = await syncOneWay(a, b, transport);

    expect(undoResult).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    expect(await b.reconciliationSessions.get(session.id)).toMatchObject({ isDeleted: true });
    expect(await b.reconciliationItems.list({
      where: { reconciliationId: session.id }, includeDeleted: true,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ transactionId: original.id, isDeleted: true }),
      expect.objectContaining({ transactionId: adjustment!.id, isDeleted: true }),
    ]));
    expect(await b.transactions.get(original.id)).toMatchObject({ status: 'pending', recordState: 'active' });
    expect(await b.transactions.get(adjustment!.id)).toMatchObject({
      recordState: 'voided', voidReason: '撤销对账调整',
    });
    await expectHealthyReplica(b);

    await a.close();
    await b.close();
  });

  it('rejects a commit that changes a reconciled posting without updating its reconciliation', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const refs = await seedTransactionReferences(a);
    const original = (await saveTransactionAggregate(a, { transaction: expenseTransaction(refs) })).transaction;
    await syncOneWay(a, b, transport);

    const session = await closeReconciliation(a, {
      accountId: refs.account.id,
      assetId: refs.currency.id,
      statementDate: '2026-03-31',
      statementBalance: '-80',
      selectedTransactionIds: [original.id],
    });
    await syncOneWay(a, b, transport);

    const reconciled = (await a.transactions.get(original.id))!;
    const graph = await b.syncGraph();
    const malicious: SyncCommitV2 = {
      protocol: 2,
      ledgerId: await b.getLedgerId(),
      commitId: newId(),
      originDeviceId: 'malicious-device',
      createdAt: new Date().toISOString(),
      parentCommitIds: graph.ledgerHeads,
      revisions: [{
        revisionId: newId(),
        aggregateType: 'transaction',
        aggregateId: original.id,
        parentRevisionIds: graph.entityHeads.get(aggregateKey('transaction', original.id)) ?? [],
        op: 'put',
        payload: { transaction: { ...reconciled, amount: '81' }, splits: [], refundAllocations: [] },
      }],
    };
    await b.storeSyncCommit(malicious, { source: 'remote', state: 'pending' });
    const result = await applyPendingCommits(b);

    expect(result).toMatchObject({ conflicts: 0, invalid: 1, pending: 0 });
    expect(await b.transactions.get(original.id)).toMatchObject({ amount: '80', status: 'cleared' });
    expect(await b.reconciliationSessions.get(session.id)).toMatchObject({
      selectedTotal: '-80', clearedBalance: '-80', difference: '0', status: 'closed',
    });
    expect((await b.listSyncCommits({ includeInvalid: true })).find((row) => row.state === 'invalid')?.error)
      .toContain('对账项目金额与流水实际过账金额不一致');

    await a.close();
    await b.close();
  });

  it('replays a concurrent historical transaction and reconciliation after its account was archived', async () => {
    const store = await openLedger({ deviceId: 'receiver' });
    const refs = await seedTransactionReferences(store);
    const beforeArchive = await store.syncGraph();
    await archiveMasterData(store, 'account', refs.account.id, refs.account.version);

    const transaction = expenseTransaction(refs, { id: 'offline-expense', status: 'cleared' });
    const session: ReconciliationSession = {
      ...base(),
      id: 'offline-reconciliation',
      accountId: refs.account.id,
      assetId: refs.currency.id,
      statementDate: '2026-03-31',
      statementBalance: '-80',
      openingBalance: '0',
      selectedTotal: '-80',
      clearedBalance: '-80',
      difference: '0',
      status: 'closed',
      closedAt: '2026-04-01T00:00:00.000Z',
    };
    const item: ReconciliationItem = {
      ...base(),
      id: 'offline-reconciliation-item',
      reconciliationId: session.id,
      transactionId: transaction.id,
      accountId: refs.account.id,
      assetId: refs.currency.id,
      postingAmount: '-80',
      previousStatus: 'cleared',
      selectedAt: '2026-04-01T00:00:00.000Z',
    };
    const commit: SyncCommitV2 = {
      protocol: 2,
      ledgerId: await store.getLedgerId(),
      commitId: newId(),
      originDeviceId: 'offline-device',
      createdAt: '2026-04-01T00:00:01.000Z',
      parentCommitIds: beforeArchive.ledgerHeads,
      revisions: [{
        revisionId: newId(),
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        parentRevisionIds: [],
        op: 'put',
        payload: { transaction, splits: [], refundAllocations: [] },
      }, {
        revisionId: newId(),
        aggregateType: 'reconciliation',
        aggregateId: session.id,
        parentRevisionIds: [],
        op: 'put',
        payload: { session, items: [item] },
      }],
    };
    await store.storeSyncCommit(commit, { source: 'remote', state: 'pending' });

    expect(await applyPendingCommits(store)).toMatchObject({ invalid: 0, conflicts: 0, pending: 0 });
    expect((await store.listSyncCommits()).find((row) => row.commitId === commit.commitId)).toMatchObject({ state: 'applied' });
    expect(await store.transactions.get(transaction.id)).toMatchObject({ accountId: refs.account.id, amount: '80' });
    expect(await store.reconciliationSessions.get(session.id)).toMatchObject({ status: 'closed' });
    await store.close();
  });

  it('syncs a restore as one final aggregate state without exposing reconciliation intermediates', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const refs = await seedTransactionReferences(a);
    const original = (await saveTransactionAggregate(a, { transaction: expenseTransaction(refs) })).transaction;
    const beforeReconciliation = await exportLedger(a);
    await syncOneWay(a, b, transport);

    const session = await closeReconciliation(a, {
      accountId: refs.account.id,
      assetId: refs.currency.id,
      statementDate: '2026-03-31',
      statementBalance: '-80',
      selectedTransactionIds: [original.id],
    });
    await syncOneWay(a, b, transport);
    expect(await b.reconciliationSessions.get(session.id)).toMatchObject({ status: 'closed' });

    await restoreLedger(a, beforeReconciliation);
    const result = await syncOneWay(a, b, transport);

    expect(result).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    expect(await b.transactions.get(original.id)).toMatchObject({ status: 'pending', recordState: 'active' });
    expect(await b.reconciliationSessions.get(session.id)).toMatchObject({ isDeleted: true });
    expect(await b.reconciliationItems.list({
      where: { reconciliationId: session.id }, includeDeleted: true,
    })).toEqual([expect.objectContaining({ transactionId: original.id, isDeleted: true })]);
    await expectHealthyReplica(b);

    await a.close();
    await b.close();
  });

  it('publishes a closed reconciliation import as one sync commit', async () => {
    const source = await openLedger({ deviceId: 'source' });
    const refs = await seedTransactionReferences(source);
    const original = (await saveTransactionAggregate(source, {
      transaction: expenseTransaction(refs, { status: 'cleared' }),
    })).transaction;
    const session = await closeReconciliation(source, {
      accountId: refs.account.id,
      assetId: refs.currency.id,
      statementDate: '2026-03-31',
      statementBalance: '-80',
      selectedTransactionIds: [original.id],
    });
    const backup = await exportLedger(source);
    await source.close();

    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    await importLedger(a, backup);

    const result = await syncOneWay(a, b, transport);

    expect(result).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    expect(await b.transactions.get(original.id)).toMatchObject({ status: 'cleared', amount: '80' });
    expect(await b.reconciliationSessions.get(session.id)).toMatchObject({ status: 'closed', difference: '0' });
    expect(await b.reconciliationItems.list({ where: { reconciliationId: session.id } }))
      .toEqual([expect.objectContaining({ transactionId: original.id, postingAmount: '-80' })]);
    await expectHealthyReplica(b);

    await a.close();
    await b.close();
  });

  it('syncs an account merge together with its open reconciliation aggregate', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const refs = await seedTransactionReferences(a);
    const transaction = (await saveTransactionAggregate(a, {
      transaction: expenseTransaction(refs, { amount: '10', status: 'cleared' }),
    })).transaction;
    const session = {
      ...base(), id: 'open-reconciliation', accountId: refs.account.id, assetId: refs.currency.id,
      statementDate: '2026-03-31', statementBalance: '-10', openingBalance: '0', selectedTotal: '-10',
      clearedBalance: '-10', difference: '0', status: 'open',
    } as ReconciliationSession;
    const item = {
      ...base(), id: 'open-reconciliation-item', reconciliationId: session.id, transactionId: transaction.id,
      accountId: refs.account.id, assetId: refs.currency.id, postingAmount: '-10', previousStatus: 'cleared',
    } as ReconciliationItem;
    await a.withAuditContext({ batchId: newId(), source: 'local' }, (scoped) => scoped.transaction(async (tx) => {
      await tx.assertReconciliationAggregate(session, [item]);
      await tx.withPrevalidatedAggregates([`reconciliation:${session.id}`], async (aggregateStore) => {
        await aggregateStore.reconciliationSessions.put(session);
        await aggregateStore.reconciliationItems.put(item);
      });
    }));
    await syncOneWay(a, b, transport);

    await mergeMasterData(a, 'account', refs.account.id, refs.targetAccount.id, refs.account.version);
    const result = await syncOneWay(a, b, transport);

    expect(result).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    expect(await b.transactions.get(transaction.id)).toMatchObject({ accountId: refs.targetAccount.id });
    expect(await b.reconciliationSessions.get(session.id)).toMatchObject({ accountId: refs.targetAccount.id });
    expect(await b.reconciliationItems.get(item.id)).toMatchObject({ accountId: refs.targetAccount.id });
    expect(await b.accounts.get(refs.account.id)).toMatchObject({ isActive: false, mergedIntoId: refs.targetAccount.id });
    await expectHealthyReplica(b);

    await a.close();
    await b.close();
  });

  it('syncs a category merge with an active refund after its original expense', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const refs = await seedTransactionReferences(a);
    const original = (await saveTransactionAggregate(a, {
      transaction: expenseTransaction(refs, { amount: '100', status: 'cleared' }),
    })).transaction;
    const refund = await saveTransactionAggregate(a, {
      transaction: expenseTransaction(refs, {
        date: '2026-03-20', type: 'refund', amount: '20', refundForId: original.id,
        refundAppliedAmount: '20', status: 'cleared',
      }),
    });
    await syncOneWay(a, b, transport);

    await mergeMasterData(a, 'category', refs.expenseCategory.id, refs.targetCategory.id, refs.expenseCategory.version);
    const result = await syncOneWay(a, b, transport);

    expect(result).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    expect(await b.transactions.get(original.id)).toMatchObject({ category: refs.targetCategory.id });
    expect(await b.transactions.get(refund.transaction.id)).toMatchObject({
      category: refs.targetCategory.id, refundForId: original.id, recordState: 'active',
    });
    expect(await b.refundAllocations.get(refund.refundAllocations[0]!.id)).toMatchObject({ categoryId: refs.targetCategory.id });
    expect(await b.categories.get(refs.expenseCategory.id)).toMatchObject({
      isActive: false, mergedIntoId: refs.targetCategory.id,
    });
    await expectHealthyReplica(b);

    await a.close();
    await b.close();
  });

  it('replays refund void, restore and aggregate deletion without leaving active children', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const refs = await seedTransactionReferences(a);
    const original = (await saveTransactionAggregate(a, {
      transaction: expenseTransaction(refs, { amount: '100', status: 'cleared' }),
    })).transaction;
    const refund = await saveTransactionAggregate(a, {
      transaction: expenseTransaction(refs, {
        date: '2026-03-20', type: 'refund', amount: '20', refundForId: original.id,
        refundAppliedAmount: '20', status: 'cleared',
      }),
    });
    await syncOneWay(a, b, transport);

    await voidTransaction(a, refund.transaction.id, 'duplicate refund');
    const voidResult = await syncOneWay(a, b, transport);
    expect(voidResult).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    expect(await b.transactions.get(refund.transaction.id)).toMatchObject({
      recordState: 'voided', voidReason: 'duplicate refund',
    });

    await restoreTransaction(a, refund.transaction.id);
    const restoreResult = await syncOneWay(a, b, transport);
    expect(restoreResult).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    expect(await b.transactions.get(refund.transaction.id)).toMatchObject({ recordState: 'active' });

    const activeRefund = (await a.transactions.get(refund.transaction.id))!;
    const activeAllocations = await a.refundAllocations.list({ where: { refundTransactionId: activeRefund.id } });
    await a.withAuditContext({ batchId: newId(), source: 'local' }, (scoped) => scoped.transaction(async (tx) => {
      await tx.withPrevalidatedAggregates([`transaction:${activeRefund.id}`], async (aggregateStore) => {
        for (const allocation of activeAllocations) {
          await aggregateStore.refundAllocations.remove(allocation.id, allocation.version);
        }
        await aggregateStore.transactions.remove(activeRefund.id, activeRefund.version);
      });
    }));
    const deleteResult = await syncOneWay(a, b, transport);

    expect(deleteResult).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 });
    expect(await b.transactions.get(activeRefund.id)).toMatchObject({ isDeleted: true });
    expect(await b.refundAllocations.list({
      where: { refundTransactionId: activeRefund.id }, includeDeleted: true,
    })).toEqual(activeAllocations.map((allocation) => expect.objectContaining({ id: allocation.id, isDeleted: true })));
    expect(await b.transactions.get(original.id)).toMatchObject({ recordState: 'active', amount: '100' });
    await expectHealthyReplica(b);

    await a.close();
    await b.close();
  });

  it('converges disjoint commits through one replica', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();

    const btc = await a.assets.put(asset('BTC'));
    await b.assets.put(asset('ETH'));

    await syncReplica(a, transport, 'memory');
    await syncReplica(b, transport, 'memory');
    await syncReplica(a, transport, 'memory');

    expect((await a.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
    expect((await b.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
    expect(transport.log).toHaveLength(2);
    const remoteLog = await b.operationLog({ entityType: 'asset', entityId: btc.id });
    expect(remoteLog).toEqual([expect.objectContaining({ source: 'remote_sync', actorName: 'A', deviceId: 'B' })]);
    const remoteBatch = (await b.listAuditBatches()).find((row) => row.sourceCommitId === remoteLog[0]!.batchId);
    expect(remoteBatch).toMatchObject({ type: 'sync', outcome: 'applied', appliedCount: 1, deviceId: 'A', sourceCommitId: remoteLog[0]!.batchId });

    await a.close();
    await b.close();
  });

  it('converges two servers in one pull-all/apply/push-all operation', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    await shareLedgerId(a, b);
    const first = memoryCommitTransport('server-1');
    const second = memoryCommitTransport('server-2');

    await a.assets.put(asset('BTC'));
    await b.assets.put(asset('ETH'));
    await syncReplica(a, first, 'server-1');
    await syncReplica(b, second, 'server-2');

    const targets = [
      { id: 'first', endpoint: 'server-1', transport: first },
      { id: 'second', endpoint: 'server-2', transport: second },
    ];
    const aResult = await syncReplicas(a, targets);
    const bResult = await syncReplicas(b, targets);

    expect(aResult.converged, JSON.stringify(aResult)).toBe(true);
    expect(bResult.converged).toBe(true);
    expect((await a.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
    expect((await b.assets.list()).map((row) => row.code).sort()).toEqual(['BTC', 'ETH']);
    expect(first.log.map((row) => row.commit.commitId).sort()).toEqual(second.log.map((row) => row.commit.commitId).sort());
    expect(first.log).toHaveLength(2);

    await a.close();
    await b.close();
  });

  it('preserves concurrent branches and resolves them with an explicit merge commit', async () => {
    const a = await openPriceLedger('A');
    const b = await openPriceLedger('B');
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const id = newId();

    await a.priceMarks.put(mark(id, '100'));
    await syncReplica(a, transport, 'memory');
    await syncReplica(b, transport, 'memory');

    await a.priceMarks.put({ ...(await a.priceMarks.get(id))!, price: '101' });
    await syncReplica(a, transport, 'memory');
    await b.priceMarks.put({ ...(await b.priceMarks.get(id))!, price: '102' });
    const result = await syncReplica(b, transport, 'memory');
    const [group] = await b.listConflicts();

    expect(result.conflicts).toBe(1);
    expect(group?.changedPaths).toContain('price_mark.price');
    expect(group?.branches.filter((branch) => branch.aggregateId === id)).toHaveLength(2);
    expect((await b.priceMarks.get(id))?.price).toBe('102');

    await syncReplica(a, transport, 'memory');
    expect(await a.listConflicts()).toHaveLength(1);

    const remote = group!.branches.find((branch) => branch.role === 'remote' && branch.originDeviceId === 'A')!;
    const merge = await resolveConflictGroup(b, group!.id, {
      action: 'keep_branch',
      branchRevisionIds: { [aggregateKey('price_mark', id)]: remote.revisionId },
    });

    expect(merge.parentCommitIds).toEqual(expect.arrayContaining(group!.remoteCommitIds));
    expect((await b.priceMarks.get(id))?.price).toBe('101');
    expect(await b.listConflicts()).toHaveLength(0);
    expect(await b.listConflictResolutions()).toEqual([
      expect.objectContaining({ groupId: group!.id, action: 'keep_branch', resolvedCommitId: merge.commitId }),
    ]);
    expect((await b.listAuditBatches()).find((batch) => batch.id === merge.commitId)).toMatchObject({
      type: 'conflict_resolution', outcome: 'applied', conflictCount: group!.remoteCommitIds.length,
    });

    await syncReplica(b, transport, 'memory');
    await syncReplica(a, transport, 'memory');
    expect((await a.priceMarks.get(id))?.price).toBe('101');
    expect(await a.listConflicts()).toHaveLength(0);
    expect(await a.listConflictResolutions()).toEqual([
      expect.objectContaining({ action: 'accept_remote_merge', resolvedCommitId: merge.commitId, resolverDeviceId: 'B' }),
    ]);

    await a.close();
    await b.close();
  });

  it('quarantines an atomic commit and every descendant when one aggregate conflicts', async () => {
    const a = await openPriceLedger('A');
    const b = await openPriceLedger('B');
    await shareLedgerId(a, b);
    const transport = memoryCommitTransport();
    const priceId = newId();

    await a.priceMarks.put(mark(priceId, '100'));
    await syncReplica(a, transport, 'memory');
    await syncReplica(b, transport, 'memory');
    await b.priceMarks.put({ ...(await b.priceMarks.get(priceId))!, price: '102' });

    const eth = asset('ETH');
    const batchId = newId();
    await a.withAuditContext({ batchId, source: 'local', actorName: 'atomic-test' }, (scoped) => scoped.transaction(async (tx) => {
      await tx.assets.put(eth);
      await tx.priceMarks.put({ ...(await tx.priceMarks.get(priceId))!, price: '101' });
    }));
    const ltc = await a.assets.put(asset('LTC'));
    await syncReplica(a, transport, 'memory');

    const result = await syncReplica(b, transport, 'memory');
    const [group] = await b.listConflicts();
    expect(result.conflicts).toBe(2);
    expect(group?.remoteCommitIds).toHaveLength(2);
    expect(await b.assets.get(eth.id)).toBeNull();
    expect(await b.assets.get(ltc.id)).toBeNull();
    expect((await b.priceMarks.get(priceId))?.price).toBe('102');
    expect(group?.branches.some((branch) => branch.aggregateId === eth.id)).toBe(true);
    expect(group?.branches.some((branch) => branch.aggregateId === ltc.id)).toBe(true);

    await a.close();
    await b.close();
  });

  it('rejects a merge claim that does not cover every resolved revision', async () => {
    const store = await openPriceLedger('A');
    const transport = memoryCommitTransport();
    const original = await store.priceMarks.put(mark(newId(), '100'));
    await syncReplica(store, transport, 'memory');
    const parent = transport.log[0]!.commit;
    const injected = asset('INJECTED');
    const malicious: SyncCommitV2 = {
      protocol: 2,
      ledgerId: await store.getLedgerId(),
      commitId: newId(),
      originDeviceId: 'malicious-device',
      createdAt: new Date().toISOString(),
      parentCommitIds: [parent.commitId],
      resolvesConflictCommitIds: [parent.commitId],
      revisions: [{
        revisionId: newId(),
        aggregateType: 'asset',
        aggregateId: injected.id,
        parentRevisionIds: [],
        op: 'put',
        payload: injected as unknown as Record<string, unknown>,
      }],
    };

    await store.storeSyncCommit(malicious, { source: 'remote', state: 'pending' });
    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(1);
    expect(await store.assets.get(injected.id)).toBeNull();
    expect((await store.listSyncCommits({ includeInvalid: true })).find((row) => row.commitId === malicious.commitId))
      .toMatchObject({ state: 'invalid', error: '冲突合并声明没有覆盖对应提交及修订' });
    expect(await store.priceMarks.get(original.id)).not.toBeNull();
    await store.close();
  });

  it('marks an unapplyable authenticated payload invalid without crashing the sync engine', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const malformed: SyncCommitV2 = {
      protocol: 2,
      ledgerId: await store.getLedgerId(),
      commitId: newId(),
      originDeviceId: 'broken-client',
      createdAt: new Date().toISOString(),
      parentCommitIds: [],
      revisions: [{
        revisionId: newId(), aggregateType: 'conversion', aggregateId: newId(),
        parentRevisionIds: [], op: 'put', payload: {},
      }],
    };
    await store.storeSyncCommit(malformed, { source: 'remote', state: 'pending' });

    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(1);
    expect((await store.listSyncCommits({ includeInvalid: true })).find((row) => row.commitId === malformed.commitId))
      .toMatchObject({ state: 'invalid', error: '应用失败：资产转换同步快照缺少 chain' });
    expect(await store.operationLog()).toEqual([]);
    await store.close();
  });

  it('rejects an aggregate whose signed child owner differs from its revision id', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const aggregateId = newId();
    const malformed: SyncCommitV2 = {
      protocol: 2,
      ledgerId: await store.getLedgerId(),
      commitId: newId(),
      originDeviceId: 'broken-client',
      createdAt: new Date().toISOString(),
      parentCommitIds: [],
      revisions: [{
        revisionId: newId(),
        aggregateType: 'conversion',
        aggregateId,
        parentRevisionIds: [],
        op: 'put',
        payload: {
          chain: {
            ...base(), id: aggregateId, date: '2026-07-23', type: 'buy', baseCurrencyAssetId: 'GBP',
          },
          steps: [{
            id: newId(), chainId: 'different-chain', order: 1,
            fromAssetId: 'GBP', fromAmount: '1', toAssetId: 'BTC', toAmount: '0.00001', fees: [],
          }],
        },
      }],
    };
    await store.storeSyncCommit(malformed, { source: 'remote', state: 'pending' });

    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(1);
    expect(await store.conversionChains.get(aggregateId)).toBeNull();
    expect((await store.listSyncCommits({ includeInvalid: true })).find((row) => row.commitId === malformed.commitId)?.error)
      .toContain('资产转换步骤与同步聚合');
    await store.close();
  });

  it('applies a parent before a child even when the child has an earlier timestamp', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const row = asset('ORDERED');
    const parentRevisionId = newId();
    const parentCommitId = newId();
    const parent: SyncCommitV2 = {
      protocol: 2, ledgerId: await store.getLedgerId(), commitId: parentCommitId,
      originDeviceId: 'remote', createdAt: '2026-07-13T00:00:02.000Z', parentCommitIds: [],
      revisions: [{
        revisionId: parentRevisionId, aggregateType: 'asset', aggregateId: row.id,
        parentRevisionIds: [], op: 'put', payload: row as unknown as Record<string, unknown>,
      }],
    };
    const child: SyncCommitV2 = {
      protocol: 2, ledgerId: parent.ledgerId, commitId: newId(),
      originDeviceId: 'remote', createdAt: '2026-07-13T00:00:01.000Z', parentCommitIds: [parentCommitId],
      revisions: [{
        revisionId: newId(), aggregateType: 'asset', aggregateId: row.id,
        parentRevisionIds: [parentRevisionId], op: 'put',
        payload: { ...(row as unknown as Record<string, unknown>), name: 'ORDERED CHILD' },
      }],
    };
    await store.storeSyncCommit(child, { source: 'remote', state: 'pending' });
    await store.storeSyncCommit(parent, { source: 'remote', state: 'pending' });

    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(0);
    expect(result.applied).toBe(2);
    expect((await store.assets.get(row.id))?.name).toBe('ORDERED CHILD');
    expect(await store.operationLog({ entityType: 'asset', entityId: row.id })).toHaveLength(2);
    await store.close();
  });

  it('marks cyclic commit dependencies invalid', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const firstId = newId();
    const secondId = newId();
    const makeCyclic = (commitId: string, parentCommitId: string, row: Asset): SyncCommitV2 => ({
      protocol: 2, ledgerId: '', commitId, originDeviceId: 'remote',
      createdAt: new Date().toISOString(), parentCommitIds: [parentCommitId],
      revisions: [{
        revisionId: newId(), aggregateType: 'asset', aggregateId: row.id,
        parentRevisionIds: [], op: 'put', payload: row as unknown as Record<string, unknown>,
      }],
    });
    const first = makeCyclic(firstId, secondId, asset('CYCLE-A'));
    const second = makeCyclic(secondId, firstId, asset('CYCLE-B'));
    first.ledgerId = await store.getLedgerId();
    second.ledgerId = first.ledgerId;
    await store.storeSyncCommit(first, { source: 'remote', state: 'pending' });
    await store.storeSyncCommit(second, { source: 'remote', state: 'pending' });

    const result = await applyPendingCommits(store);

    expect(result.invalid).toBe(2);
    expect((await store.listSyncCommits({ includeInvalid: true })).filter((row) => row.state === 'invalid')).toHaveLength(2);
    expect(await store.assets.list()).toEqual([]);
    await store.close();
  });

  it('rejects a replica already bound to another ledger', async () => {
    const a = await openLedger({ deviceId: 'A' });
    const b = await openLedger({ deviceId: 'B' });
    const transport = memoryCommitTransport();
    await syncReplica(a, transport, 'memory');
    await expect(syncReplica(b, transport, 'memory')).rejects.toThrow('LEDGER_MISMATCH');
    await a.close();
    await b.close();
  });

  it('rejects a pulled page that skips a server sequence without advancing the cursor', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const identity = {
      serverId: 'hostile-server', replicaId: 'hostile-replica', streamEpoch: 'hostile-epoch',
      ledgerId: await store.getLedgerId(),
    };
    const remote = asset('REMOTE');
    const commit: SyncCommitV2 = {
      protocol: 2, ledgerId: identity.ledgerId, commitId: newId(), originDeviceId: 'remote',
      createdAt: new Date().toISOString(), parentCommitIds: [],
      revisions: [{
        revisionId: newId(), aggregateType: 'asset', aggregateId: remote.id,
        parentRevisionIds: [], op: 'put', payload: remote as unknown as Record<string, unknown>,
      }],
    };
    const contentHash = await sha256Json(wireSyncCommit(commit));
    const transport: CommitTransport = {
      async connect() { return { ...identity, headSeq: 2 }; },
      async pullCommits() {
        return { commits: [{ seq: 2, commit, contentHash }], nextSeq: 2, headSeq: 2, hasMore: false };
      },
      async pushCommits() { return { assigned: [], headSeq: 2 }; },
    };

    await expect(syncReplica(store, transport, 'hostile')).rejects.toThrow('提交序号不连续');
    expect((await store.getReplicaState(identity)).cursor).toBe(0);
    expect(await store.assets.get(remote.id)).toBeNull();
    await store.close();
  });

  it('advances across a signed quarantine marker without applying or counting the old write', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const ledgerId = await store.getLedgerId();
    const identity = { serverId: 'reviewed-server', replicaId: 'reviewed-replica',
      streamEpoch: 'reviewed-epoch', ledgerId };
    const newAsset = asset('REPAIRED');
    const commit: SyncCommitV2 = {
      protocol: 2, ledgerId, commitId: newId(), originDeviceId: 'owner',
      createdAt: new Date().toISOString(), parentCommitIds: [],
      revisions: [{ revisionId: newId(), aggregateType: 'asset', aggregateId: newAsset.id,
        parentRevisionIds: [], op: 'put', payload: newAsset as unknown as Record<string, unknown> }],
    };
    const contentHash = await sha256Json(wireSyncCommit(commit));
    const transport: CommitTransport = {
      async connect() { return { ...identity, headSeq: 2 }; },
      async pullCommits(_identity, afterSeq) {
        if (afterSeq === 2) return { commits: [], nextSeq: 2, headSeq: 2, hasMore: false };
        return { commits: [
          { seq: 1, commitId: 'commit-rejected-old-0001', contentHash: 'a'.repeat(64), quarantined: true },
          { seq: 2, commit, contentHash },
        ], nextSeq: 2, headSeq: 2, hasMore: false };
      },
      async pushCommits() { return { assigned: [], headSeq: 2 }; },
    };

    const result = await syncReplica(store, transport, 'reviewed');
    expect(result.pulled).toBe(1);
    expect((await store.getReplicaState(identity)).cursor).toBe(2);
    expect((await store.listSyncCommits()).map((row) => row.commitId)).toEqual([commit.commitId]);
    expect((await store.assets.get(newAsset.id))?.code).toBe('REPAIRED');
    await store.close();
  });

  it('does not acknowledge a push response with a mismatched content hash', async () => {
    const store = await openLedger({ deviceId: 'A' });
    await store.assets.put(asset('LOCAL'));
    const identity = {
      serverId: 'hostile-server', replicaId: 'hostile-replica', streamEpoch: 'hostile-epoch',
      ledgerId: await store.getLedgerId(),
    };
    const transport: CommitTransport = {
      async connect() { return { ...identity, headSeq: 0 }; },
      async pullCommits(_identity, afterSeq) {
        return { commits: [], nextSeq: afterSeq, headSeq: 0, hasMore: false };
      },
      async pushCommits(_identity, commits) {
        return {
          assigned: commits.map((commit) => ({ commitId: commit.commitId, seq: 1, contentHash: 'b'.repeat(64) })),
          headSeq: 1,
        };
      },
    };

    await expect(syncReplica(store, transport, 'hostile')).rejects.toThrow('返回了错误哈希');
    expect(await store.commitsPendingForReplica(replicaKey(identity))).toHaveLength(1);
    await store.close();
  });

  it('rejects a remote commit-id collision before assigning a hash to the local commit', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const local = await store.assets.put(asset('LOCAL'));
    const existing = (await store.listSyncCommits())[0]!;
    const collision = wireSyncCommit(existing);
    collision.originDeviceId = 'remote';
    collision.revisions[0]!.payload = {
      ...(collision.revisions[0]!.payload ?? {}), id: local.id, code: 'COLLISION', name: 'COLLISION',
    };
    const contentHash = await sha256Json(collision);
    const identity = {
      serverId: 'hostile-server', replicaId: 'hostile-replica', streamEpoch: 'hostile-epoch',
      ledgerId: await store.getLedgerId(),
    };
    const transport: CommitTransport = {
      async connect() { return { ...identity, headSeq: 1 }; },
      async pullCommits() {
        return { commits: [{ seq: 1, commit: collision, contentHash }], nextSeq: 1, headSeq: 1, hasMore: false };
      },
      async pushCommits() { return { assigned: [], headSeq: 1 }; },
    };

    await expect(syncReplica(store, transport, 'hostile')).rejects.toThrow('对应了不同内容');
    expect((await store.getReplicaState(identity)).cursor).toBe(0);
    expect((await store.assets.get(local.id))?.code).toBe('LOCAL');
    await store.close();
  });

  it('does not expose a local atomic batch until the batch is sealed', async () => {
    const store = await openLedger({ deviceId: 'A' });
    const transport = memoryCommitTransport();
    const batchId = newId();
    let release!: () => void;
    let written!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstWrite = new Promise<void>((resolve) => { written = resolve; });

    const ongoing = store.withAuditContext({ batchId, source: 'local' }, async (scoped) => {
      await scoped.assets.put(asset('BTC'));
      written();
      await gate;
      await scoped.assets.put(asset('ETH'));
    });
    await firstWrite;

    expect(await store.commitsPendingForReplica('test-replica')).toEqual([]);
    const blocked = await syncReplicas(store, [{ id: 'test', endpoint: 'memory', transport }]);
    expect(blocked.endpoints[0]?.error).toContain('未完成的原子批次');

    release();
    await ongoing;
    const pending = await store.commitsPendingForReplica('test-replica');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.revisions).toHaveLength(2);
    expect((await syncReplicas(store, [{ id: 'test', endpoint: 'memory', transport }])).converged).toBe(true);
    expect(transport.log).toHaveLength(1);

    await store.close();
  });

  it('can explicitly discard a local ledger before joining an existing ledger id', async () => {
    const store = await openLedger({ deviceId: 'new-device' });
    const local = await store.assets.put(asset('LOCAL'));
    await store.attachmentState.putBlob({ sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'text/plain', state: 'ready' });
    await store.attachmentState.putReplicaBlob({
      profileId: 'old-profile', sha256: 'a'.repeat(64), remoteBlobId: 'b'.repeat(64), state: 'available',
      keyVersion: 1, updatedAt: new Date().toISOString(),
    });
    const remoteLedgerId = 'ledger-remote-000001';
    await store.resetToLedger(remoteLedgerId);

    expect(await store.getLedgerId()).toBe(remoteLedgerId);
    expect(await store.assets.get(local.id)).toBeNull();
    expect(await store.listSyncCommits()).toEqual([]);
    expect(await store.operationLog()).toEqual([]);
    expect(await store.attachmentState.listReplicaBlobs()).toEqual([]);
    expect(await store.attachmentState.listBlobs()).toHaveLength(1);
    await store.close();
  });

  it('does not browser-bridge a remote commit into a controlled ledger as a new member write', async () => {
    const store = await openLedger({ deviceId: 'current-device' });
    try {
      const ledgerId = await store.getLedgerId();
      await store.storeSyncCommit({ protocol: 2, ledgerId, commitId: newId(),
        originDeviceId: 'old-device', createdAt: new Date().toISOString(),
        parentCommitIds: [], revisions: [] }, { source: 'remote', state: 'applied' });
      const relay = memoryCommitTransport();
      const transport: CommitTransport = { ...relay,
        async connect(id) { return { ...await relay.connect(id), currentKeyEpoch: 2 }; } };
      const result = await syncReplicas(store, [{ id: 'controlled', endpoint: 'memory', transport }]);
      expect(result.endpoints[0]?.error).toContain('远端提交必须由节点后台复制');
      expect(relay.log).toEqual([]);
    } finally { await store.close(); }
  });
});
