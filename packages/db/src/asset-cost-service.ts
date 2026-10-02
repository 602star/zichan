import { accountChainPostings, accountOpeningPostings, accountTransactionPostings, assertCostBasisOpening, dayOfInstant,
  calculateAssetCostHistory, canonicalJson, computeBalances, costOpeningFingerprint, D, newId, normalizeOccurrence, sum,
  type AssetCostLedgerInput, type AssetCostState, type CostBasisOpening, type CostBasisOpeningItem } from '@zichan/core';
import type { SqlLedgerStore } from './repository.js';

export async function readCostLedgerInput(store: SqlLedgerStore, opening: CostBasisOpening): Promise<AssetCostLedgerInput> {
  const [chainRows, transactions, accounts, settings] = await Promise.all([
    store.conversionChains.list(), store.transactions.list(), store.accounts.list(), store.settings.list(),
  ]);
  const steps = await store.listStepsByChains(chainRows.map((chain) => chain.id));
  return { opening, chains: chainRows.map((chain) => ({ chain, steps: steps.get(chain.id) ?? [] })),
    transactions, accounts, timezone: opening.timezone ?? settings[0]?.timezone ?? 'UTC' };
}

export async function readAssetCostState(store: SqlLedgerStore): Promise<AssetCostState | undefined> {
  return store.transaction(async (transactionStore) => {
    const openings = (await transactionStore.costBasisOpenings.list()).sort((a, b) => Date.parse(b.occurredAtUtc) - Date.parse(a.occurredAtUtc) || b.id.localeCompare(a.id));
    const opening = openings[0];
    return opening ? calculateAssetCostHistory({ ...await readCostLedgerInput(transactionStore, opening), openings }) : undefined;
  });
}

export interface CostOpeningPreview {
  opening: CostBasisOpening;
  assets: { assetId: string; quantity: string; accountBalances: { accountId: string | null; quantity: string }[]; suggestedItems: CostBasisOpeningItem[] }[];
  dependencyFingerprint: string;
}

/** No balances are written. The opening is exclusively a basis for cost replay. */
export async function previewCostBasisOpening(store: SqlLedgerStore, occurredAtUtc: string, baseCurrencyAssetId: string): Promise<CostOpeningPreview> {
  if (!Number.isFinite(Date.parse(occurredAtUtc))) throw new Error('请选择准确的成本起点时间');
  return store.transaction(async (transactionStore) => {
    const currency = await transactionStore.assets.get(baseCurrencyAssetId);
    if (!currency || currency.isDeleted || !currency.isActive || currency.type === 'game' || currency.type === 'fixed') throw new Error('请选择可用的金融核算币种');
    const opening: CostBasisOpening = { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      occurredAtUtc: new Date(occurredAtUtc).toISOString(), baseCurrencyAssetId, confirmedAt: new Date().toISOString(), sourceFingerprint: '', items: [] };
    const input = await readCostLedgerInput(transactionStore, opening);
    opening.timezone = input.timezone;
    const cut = Date.parse(opening.occurredAtUtc);
    const before = (row: { date: string; occurredAtUtc?: string }) => {
      if (row.occurredAtUtc) return Date.parse(row.occurredAtUtc) <= cut;
      if (row.date === dayOfInstant(opening.occurredAtUtc, input.timezone)) throw new Error('起点当天存在只有日期的记录，请先补充准确时间，明确成本起点前后关系');
      return row.date < dayOfInstant(opening.occurredAtUtc, input.timezone);
    };
    const accounts = [...input.accounts];
    const postings = accountOpeningPostings(accounts.filter((account) => account.kind !== 'other' && Date.parse(account.balanceStartAt ?? '') <= cut));
    for (const aggregate of input.chains) if (before(aggregate.chain)) postings.push(...accountChainPostings(aggregate, accounts));
    for (const row of input.transactions) if (before(row)) postings.push(...accountTransactionPostings(row, accounts));
    const assets = (await transactionStore.assets.list()).filter((asset) => asset.type !== 'game' && asset.type !== 'fixed');
    const balances = computeBalances(postings).filter((balance) => assets.some((asset) => asset.id === balance.assetId));
    const lots = await transactionStore.lots.list();
    const priorOpenings = await transactionStore.costBasisOpenings.list();
    const priorCost = calculateAssetCostHistory({ ...input, openings: priorOpenings, asOfUtc: opening.occurredAtUtc });
    const rows = balances.map((balance) => {
      const existing = lots.filter((lot) => lot.assetId === balance.assetId && lot.baseCurrencyAssetId === baseCurrencyAssetId && D(lot.remainingAmount).gt(0));
      // Remaining legacy lots are only reliable at the current frontier. A past
      // opening cannot reuse lots already consumed by later transactions.
      const hasLater = input.chains.some(({ chain, steps }) => !before(chain) && steps.some((step) => step.fromAssetId === balance.assetId || step.toAssetId === balance.assetId));
      const matches = !hasLater && sum(existing.map((lot) => lot.remainingAmount)).eq(balance.amount);
      const tracked = priorCost?.lots.filter((lot) => lot.assetId === balance.assetId && D(lot.remainingQuantity).gt(0)) ?? [];
      const carriesTrackedBasis = priorCost?.baseCurrencyAssetId === baseCurrencyAssetId && !priorCost.invalidAssetIds.includes(balance.assetId)
        && tracked.length > 0 && sum(tracked.map((lot) => lot.remainingQuantity)).eq(balance.amount);
      const suggestedItems: CostBasisOpeningItem[] = balance.assetId === baseCurrencyAssetId
        ? [{ id: newId(), assetId: balance.assetId, quantity: balance.amount, costInBase: D(balance.amount).gt(0) ? balance.amount : null, acquiredAtUtc: opening.occurredAtUtc }]
        : carriesTrackedBasis ? tracked.map((lot) => ({ id: newId(), assetId: balance.assetId, sourceLotId: lot.id,
          quantity: lot.remainingQuantity, costInBase: lot.remainingCostInBase, acquiredAtUtc: lot.acquiredAtUtc }))
        : matches && existing.length ? existing.map((lot) => ({ id: newId(), assetId: balance.assetId, sourceLotId: lot.id,
          quantity: lot.remainingAmount, costInBase: D(lot.baseCost).times(lot.remainingAmount).div(lot.originalAmount).toString(),
          acquiredAtUtc: normalizeOccurrence({ date: lot.acquiredDate, time: '00:00:00', timezone: input.timezone }).occurredAtUtc! }))
          : [{ id: newId(), assetId: balance.assetId, quantity: balance.amount, costInBase: null, acquiredAtUtc: opening.occurredAtUtc }];
      const accountIds = [...new Set(postings.filter((posting) => posting.assetId === balance.assetId).map((posting) => posting.accountId ?? null))];
      return { assetId: balance.assetId, quantity: balance.amount, suggestedItems,
        accountBalances: accountIds.map((accountId) => ({ accountId, quantity: sum(postings.filter((posting) => posting.assetId === balance.assetId && (posting.accountId ?? null) === accountId).map((posting) => posting.amount)).toString() })) };
    });
    opening.items = rows.flatMap((row) => row.suggestedItems);
    opening.sourceFingerprint = costOpeningFingerprint(input);
    return { opening, assets: rows, dependencyFingerprint: canonicalJson({ source: opening.sourceFingerprint, baseCurrencyAssetId,
      chains: input.chains, transactions: input.transactions, accounts: input.accounts, assets, lots,
      openings: (await transactionStore.costBasisOpenings.list()).map((row) => ({ id: row.id, version: row.version })).sort((a, b) => a.id.localeCompare(b.id)) }) };
  });
}

export async function confirmCostBasisOpening(store: SqlLedgerStore, input: CostOpeningPreview): Promise<CostBasisOpening> {
  return store.runInAuditBatch('确认成本起点', async (transactionStore) => {
    const fresh = await previewCostBasisOpening(transactionStore, input.opening.occurredAtUtc, input.opening.baseCurrencyAssetId);
    if (fresh.dependencyFingerprint !== input.dependencyFingerprint) throw new Error('账本依赖已变化，请刷新成本起点预览');
    const quantities = (items: CostBasisOpeningItem[]) => canonicalJson(Object.fromEntries([...new Set(items.map((item) => item.assetId))].sort()
      .map((assetId) => [assetId, sum(items.filter((item) => item.assetId === assetId).map((item) => item.quantity)).toString()])));
    if (quantities(input.opening.items) !== quantities(fresh.opening.items)) throw new Error('成本起点数量必须与实际余额逐项一致');
    const opening = { ...input.opening, sourceFingerprint: fresh.opening.sourceFingerprint, confirmedAt: new Date().toISOString() };
    assertCostBasisOpening(opening);
    return transactionStore.costBasisOpenings.put(opening);
  });
}
