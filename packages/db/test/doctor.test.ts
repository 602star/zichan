import { describe, it, expect } from 'vitest';
import { openLedger } from '../src/node.js';
import {
  closeReconciliation,
  archiveMasterData,
  recordConversion,
  recordSell,
  checkConsistency,
  recomputeCaches,
  purgeTombstones,
  saveTransaction,
} from '../src/index.js';
import { D, newId, round, type ConversionChain, type ConversionStep } from '@zichan/core';
import { openDiagnosticLedger } from './diagnostic-ledger.js';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}
function chain(type: ConversionChain['type'], date = '2026-03-02'): ConversionChain {
  return { ...base(), date, type, baseCurrencyAssetId: 'GBP' } as ConversionChain;
}
function step(chainId: string, order: number, fa: string, fx: string, ta: string, tx: string, fee?: { assetId: string; amount: string; base?: string }): ConversionStep {
  const targetFee = fee?.assetId === ta;
  return { id: newId(), chainId, order, fromAssetId: fa, fromAmount: fx, toAssetId: ta, toAmount: targetFee ? D(tx).plus(fee!.amount).toString() : tx, fees: fee ? [{ id: newId(), assetId: fee.assetId, amount: fee.amount, treatment: fee.assetId === fa ? 'source_extra' : targetFee ? 'target_deducted' : 'third_asset_extra', valueInBase: fee.base }] : [] };
}
async function buy(store: Awaited<ReturnType<typeof openLedger>>, date: string, btc: string) {
  if ((await store.assets.list()).length === 0) {
    await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
    await store.assets.put({ ...base(), id: 'USDT', code: 'USDT', name: 'Tether', type: 'stablecoin', decimals: 6, isActive: true } as never);
    await store.assets.put({ ...base(), id: 'BTC', code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8, isActive: true } as never);
  }
  const c = chain('dca', date);
  return recordConversion(store, {
    chain: c,
    steps: [
      step(c.id, 1, 'GBP', '250', 'USDT', '312', { assetId: 'GBP', amount: '1.50' }),
      step(c.id, 2, 'USDT', '311.50', 'BTC', btc, { assetId: 'USDT', amount: '0.50', base: '0.40' }),
    ],
  });
}

describe('doctor', () => {
  it('reports a healthy ledger as consistent', async () => {
    const store = await openLedger();
    await buy(store, '2026-01-01', '0.003');
    expect(await checkConsistency(store)).toEqual([]);
    await store.close();
  });

  it('detects a tampered lot remaining and recompute fixes it', async () => {
    const { store, rawPut } = await openDiagnosticLedger();
    const { lot } = await buy(store, '2026-01-01', '0.003');
    const bitcoin = (await store.assets.get('BTC'))!;
    await archiveMasterData(store, 'asset', bitcoin.id, bitcoin.version);
    // tamper: set remaining wrong
    await rawPut('lots', { ...lot!, remainingAmount: '0.009' });

    const issues = await checkConsistency(store);
    expect(issues.some((i) => i.kind === 'lot_remaining_mismatch')).toBe(true);

    const res = await recomputeCaches(store);
    expect(res.lots).toBeGreaterThanOrEqual(1);
    expect(await checkConsistency(store)).toEqual([]);
    const fixed = await store.lots.get(lot!.id);
    expect(round(fixed!.remainingAmount, 3)).toBe('0.003');
    await store.close();
  });

  it('detects a transaction that no longer matches its closed reconciliation', async () => {
    const { store, rawPut } = await openDiagnosticLedger();
    await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
    await store.accounts.put({ ...base(), id: 'bank', name: 'Bank', kind: 'bank', isActive: true } as never);
    await store.categories.put({ ...base(), id: 'expense-root', name: '支出', type: 'expense', isActive: true } as never);
    await store.categories.put({ ...base(), id: 'food', name: '餐饮', type: 'expense', parentId: 'expense-root', isActive: true } as never);
    const transaction = await saveTransaction(store, {
      ...base(), date: '2026-03-01', type: 'expense', category: 'food', amount: '22',
      assetId: 'GBP', accountId: 'bank', status: 'cleared', recordState: 'active',
    } as never);
    const session = await closeReconciliation(store, {
      accountId: 'bank', assetId: 'GBP', statementDate: '2026-03-31', statementBalance: '-22',
      selectedTransactionIds: [transaction.id],
    });
    const current = (await store.transactions.get(transaction.id))!;
    await rawPut('transactions', { ...current, amount: '23' });

    expect(await checkConsistency(store)).toContainEqual(expect.objectContaining({
      kind: 'reconciliation_invalid',
      entityType: 'reconciliation_session',
      entityId: session.id,
      detail: expect.stringContaining('实际过账金额'),
    }));
    await store.close();
  });

  it('does not choke on ULID ids (which start with a digit)', async () => {
    const store = await openLedger();
    const aid = newId(); // ULID, begins with a digit
    await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
    await store.assets.put({ ...base(), id: aid, code: 'TEST', name: 'Test asset', type: 'crypto', decimals: 8, isActive: true } as never);
    const c = chain('dca', '2026-01-01');
    c.finalAssetId = aid; c.finalAmount = '0.5'; c.totalBaseCost = '100'; c.totalFeesInBase = '0';
    await store.saveChainWithSteps(c, [step(c.id, 1, 'GBP', '100', aid, '0.5')]);
    await expect(checkConsistency(store)).resolves.toBeInstanceOf(Array);
    await store.close();
  });

  it('purgeTombstones physically removes old soft-deleted rows', async () => {
    const store = await openLedger();
    await store.games.put({ ...base(), name: 'G', enableSeason: true } as never);
    const games = await store.games.list();
    await store.games.remove(games[0]!.id, games[0]!.version); // soft delete
    expect((await store.games.list({ includeDeleted: true })).length).toBe(1);

    const purged = await purgeTombstones(store, -1); // cutoff in the future → all tombstones are candidates
    expect(purged.purged).toBeGreaterThanOrEqual(1);
    expect((await store.games.list({ includeDeleted: true })).length).toBe(0);
    await store.close();
  });

  it('keeps tombstones until every active replica acknowledges the delete commit', async () => {
    const store = await openLedger();
    const identity = {
      serverId: 'server-gc',
      replicaId: 'replica-gc',
      streamEpoch: 'epoch-gc',
      ledgerId: await store.getLedgerId(),
    };
    const state = await store.saveReplicaState(identity, 0, 0);
    const game = await store.games.put({ ...base(), name: 'GC guarded', enableSeason: true } as never);
    await store.games.remove(game.id, game.version);

    const blocked = await purgeTombstones(store, -1);
    expect(blocked).toMatchObject({ purged: 0, blocked: 1, activeReplicaCount: 1 });
    expect(await store.games.get(game.id)).not.toBeNull();

    const deletion = (await store.listSyncCommits()).find((commit) =>
      commit.revisions.some((revision) =>
        revision.aggregateType === 'game' && revision.aggregateId === game.id && revision.op === 'delete'));
    expect(deletion).toBeTruthy();
    await store.markCommitsAcknowledged(state.replicaKey, [{
      commitId: deletion!.commitId,
      seq: 1,
      contentHash: 'a'.repeat(64),
    }]);
    const purged = await purgeTombstones(store, -1);
    expect(purged).toMatchObject({ purged: 1, blocked: 0, activeReplicaCount: 1 });
    expect(await store.games.get(game.id)).toBeNull();
    await store.close();
  });

  it('allows acknowledged-GC protection to ignore an explicitly retired replica', async () => {
    const store = await openLedger();
    const identity = {
      serverId: 'server-retired',
      replicaId: 'replica-retired',
      streamEpoch: 'epoch-retired',
      ledgerId: await store.getLedgerId(),
    };
    await store.saveReplicaState(identity, 0, 0);
    const game = await store.games.put({ ...base(), name: 'Retired replica', enableSeason: true } as never);
    await store.games.remove(game.id, game.version);
    expect(await store.retireReplica(identity)).toBe(true);

    const purged = await purgeTombstones(store, -1);
    expect(purged).toMatchObject({ purged: 1, blocked: 0, activeReplicaCount: 0 });
    await store.close();
  });

  it('recompute rebuilds sell realized P&L from consumptions', async () => {
    const store = await openLedger();
    await buy(store, '2026-01-01', '0.003');
    await buy(store, '2026-02-01', '0.004');
    const c = chain('sell', '2026-03-01');
    const { chain: sold } = await recordSell(store, {
      chain: c,
      steps: [
        step(c.id, 1, 'BTC', '0.005', 'USDT', '489', { assetId: 'USDT', amount: '0.8', base: '0.64' }),
        step(c.id, 2, 'USDT', '488', 'GBP', '387.90', { assetId: 'GBP', amount: '1.30' }),
      ],
      method: 'fifo',
    });
    // corrupt the cache, then recompute
    await store.conversionChains.put({ ...sold, realizedGainLoss: '999', totalBaseProceeds: '1' });
    expect((await checkConsistency(store)).some((i) => i.kind === 'chain_cache_stale')).toBe(true);
    await recomputeCaches(store);
    const fixed = await store.conversionChains.get(sold.id);
    expect(round(fixed!.totalBaseProceeds!, 2)).toBe('387.90');
    expect(await checkConsistency(store)).toEqual([]);
    await store.close();
  });

  it('ignores insignificant decimal dust in derived caches', async () => {
    const store = await openLedger();
    await buy(store, '2026-01-01', '0.003');
    await buy(store, '2026-02-01', '0.004');
    const c = chain('sell', '2026-03-01');
    const { chain: sold } = await recordSell(store, {
      chain: c,
      steps: [
        step(c.id, 1, 'BTC', '0.005', 'USDT', '489', { assetId: 'USDT', amount: '0.8', base: '0.64' }),
        step(c.id, 2, 'USDT', '488', 'GBP', '387.90', { assetId: 'GBP', amount: '1.30' }),
      ],
      method: 'fifo',
    });
    await store.conversionChains.put({ ...sold, realizedGainLoss: `${sold.realizedGainLoss}0000000000000000001` });
    expect(await checkConsistency(store)).toEqual([]);
    await store.close();
  });

  it('detects cross-game references, blank names, and terminal fixed-asset status drift', async () => {
    const { store, rawPut } = await openDiagnosticLedger();
    await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
    await store.games.put({ ...base(), id: 'game-a', name: 'A', enableSeason: true } as never);
    await rawPut('games', { ...base(), id: 'game-b', name: '', enableSeason: true });
    await store.gameSeasons.put({ ...base(), id: 'season-a', gameId: 'game-a', name: 'S1', status: 'active' } as never);
    await rawPut('gameRecords', { ...base(), id: 'record-b', gameId: 'game-b', seasonId: 'season-a', date: '2026-07-10', recordType: 'produce' });
    const fixedRoot = await store.fixedAssetCategories.put({ ...base(), name: '设备', isActive: true } as never);
    const fixedLeaf = await store.fixedAssetCategories.put({ ...base(), name: '电脑', parentId: fixedRoot.id, isActive: true } as never);
    await store.fixedAssets.put({ ...base(), id: 'fixed', name: 'Laptop', categoryId: fixedLeaf.id, status: 'active', purchaseDate: '2026-01-01', baseCurrencyAssetId: 'GBP' } as never);
    await store.fixedAssetEvents.put({ ...base(), fixedAssetId: 'fixed', type: 'sale', date: '2026-07-10', amountBase: '500' } as never);

    const issues = await checkConsistency(store);
    expect(issues.some((issue) => issue.kind === 'game_reference_mismatch')).toBe(true);
    expect(issues.some((issue) => issue.kind === 'required_field_missing')).toBe(true);
    expect(issues.some((issue) => issue.kind === 'fixed_status_mismatch')).toBe(true);
    await store.close();
  });

  it('detects a category parent chain cycle (A→B→A dirty data)', async () => {
    const { store, rawPut } = await openDiagnosticLedger();
    await rawPut('categories', { ...base(), id: 'cat-a', name: 'A', type: 'expense', parentId: 'cat-b' });
    await rawPut('categories', { ...base(), id: 'cat-b', name: 'B', type: 'expense', parentId: 'cat-a' });
    const issues = await checkConsistency(store);
    expect(issues.some((issue) => issue.kind === 'category_cycle')).toBe(true);
    await store.close();
  });

  it('detects invalid and over-applied refunds without treating an expense category as mismatched', async () => {
    const { store, rawPut } = await openDiagnosticLedger();
    await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
    await store.categories.put({ ...base(), id: 'expense-root', name: '支出', type: 'expense', sortOrder: 1 } as never);
    await store.categories.put({ ...base(), id: 'food', name: '餐饮', type: 'expense', parentId: 'expense-root', sortOrder: 2 } as never);
    await store.transactions.put({ ...base(), id: 'expense', date: '2026-07-01', type: 'expense', category: 'food', amount: '100', assetId: 'GBP', recordState: 'active' } as never);
    await rawPut('transactions', {
      ...base(), id: 'refund-a', date: '2026-07-02', type: 'refund', category: 'food', amount: '70',
      assetId: 'GBP', refundForId: 'expense', refundAppliedAmount: '70', refundAppliedAssetId: 'GBP',
      originalDateSnapshot: '2026-07-01', originalAmountSnapshot: '100', refundAttributionMode: 'original_date',
      refundEffectDate: '2026-07-01', refundAllocationMode: 'proportional', recordState: 'active',
    });
    await rawPut('transactions', {
      ...base(), id: 'refund-b', date: '2026-07-03', type: 'refund', category: 'food', amount: '40',
      assetId: 'GBP', refundForId: 'expense', refundAppliedAmount: '40', refundAppliedAssetId: 'GBP',
      originalDateSnapshot: '2026-07-01', originalAmountSnapshot: '100', refundAttributionMode: 'original_date',
      refundEffectDate: '2026-07-01', refundAllocationMode: 'proportional', recordState: 'active',
    });
    await rawPut('transactions', {
      ...base(), id: 'refund-broken', date: '2026-07-04', type: 'refund', category: 'food',
      amount: '5', assetId: 'GBP', recordState: 'active',
    });

    const issues = await checkConsistency(store);
    expect(issues.some((issue) => issue.kind === 'refund_amount_exceeded' && issue.entityId === 'expense')).toBe(true);
    expect(issues.some((issue) => issue.kind === 'refund_invalid' && issue.entityId === 'refund-broken')).toBe(true);
    expect(issues.some((issue) => issue.kind === 'category_mismatch' && issue.entityId.startsWith('refund-'))).toBe(false);
    await store.close();
  });

  it('detects a fixed-asset cashflow link whose frozen amounts do not reconcile', async () => {
    const store = await openLedger();
    await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
    await store.categories.put({ ...base(), id: 'expense-root', name: '支出', type: 'expense', sortOrder: 1 } as never);
    await store.categories.put({ ...base(), id: 'repairs', name: '维修', type: 'expense', parentId: 'expense-root', sortOrder: 2 } as never);
    await store.fixedAssetCategories.put({ ...base(), id: 'fixed-root', name: '居家设备', isActive: true, sortOrder: 1 } as never);
    await store.fixedAssetCategories.put({ ...base(), id: 'fixed-appliance', name: '家电', parentId: 'fixed-root', isActive: true, sortOrder: 2 } as never);
    await store.fixedAssets.put({
      ...base(), id: 'fixed', name: '空调', categoryId: 'fixed-appliance', status: 'active',
      purchaseDate: '2026-01-01', baseCurrencyAssetId: 'GBP',
    } as never);
    await store.transactions.put({
      ...base(), id: 'repair-tx', date: '2026-07-10', type: 'expense', category: 'repairs',
      amount: '50', assetId: 'GBP', status: 'cleared', recordState: 'active',
    } as never);
    await store.fixedAssetEvents.put({
      ...base(), id: 'repair-event', fixedAssetId: 'fixed', type: 'repair', date: '2026-07-10',
      amountBase: '50', cashflowMode: 'linked_transaction',
    } as never);
    await store.fixedAssetCashflowLinks.put({
      ...base(), fixedAssetId: 'fixed', sourceType: 'event', sourceId: 'repair-event',
      direction: 'outflow', ownership: 'linked', transactionId: 'repair-tx',
      sourceAssetId: 'GBP', sourceAmount: '25', baseAssetId: 'GBP', amountBase: '50',
      fxRateSnapshot: '1',
    } as never);

    const issues = await checkConsistency(store);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'fixed_cashflow_invalid', entityId: 'repair-event' }),
      expect.objectContaining({ kind: 'fixed_cashflow_invalid', entityType: 'fixed_asset_cashflow_link' }),
    ]));
    await store.close();
  });
});
