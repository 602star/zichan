/**
 * Lot cost basis (§12) and sell matching (§13). A buy/dca chain produces a Lot;
 * a sell consumes lots by FIFO / LIFO / manual selection, yielding realized P&L.
 */
import { D, safeDiv, sum } from './decimal.js';
import { newId } from './ids.js';
import type { ChainTrace } from './conversion.js';
import type { Lot, LotConsumption, LotMethod } from './types.js';

/** Build a Lot from a buy/dca chain trace. */
export function lotFromTrace(
  trace: ChainTrace,
  meta: {
    sourceChainId?: string;
    sourceDcaExecutionId?: string;
    acquiredDate: string;
    now?: string;
  },
): Lot {
  const now = meta.now ?? new Date().toISOString();
  return {
    id: newId(),
    assetId: trace.finalAssetId,
    sourceChainId: meta.sourceChainId,
    sourceDcaExecutionId: meta.sourceDcaExecutionId,
    acquiredDate: meta.acquiredDate,
    originalAmount: trace.finalAmount,
    baseCost: trace.totalBaseCost,
    baseCurrencyAssetId: trace.baseCurrencyAssetId,
    nativeCostAssetId: trace.nativeCostAssetId,
    nativeCostAmount: trace.nativeCostAmount,
    remainingAmount: trace.finalAmount,
    status: D(trace.finalAmount).isZero() ? 'closed' : 'open',
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
  };
}

export interface SellMatchInput {
  sellChainId: string;
  assetId: string;
  amount: string; // amount of asset being sold
  proceedsBase: string; // total base-currency proceeds for the whole sell
  method: LotMethod;
  /** For manual method: ordered lot ids to consume first. */
  selectedLotIds?: string[];
  now?: string;
}

export interface SellMatchResult {
  consumptions: LotConsumption[];
  /** Lots with updated remainingAmount/status after this sell. */
  updatedLots: Lot[];
  totalCostBase: string;
  totalProceedsBase: string;
  realizedPnlBase: string;
  /** Amount that couldn't be matched to any lot (sold more than held). */
  unmatchedAmount: string;
}

/** Order open lots per the matching method. */
function orderLots(lots: Lot[], input: SellMatchInput): Lot[] {
  const open = lots.filter(
    (l) => l.assetId === input.assetId && !l.isDeleted && D(l.remainingAmount).isPositive(),
  );
  switch (input.method) {
    case 'fifo':
      return [...open].sort((a, b) => a.acquiredDate.localeCompare(b.acquiredDate));
    case 'lifo':
      return [...open].sort((a, b) => b.acquiredDate.localeCompare(a.acquiredDate));
    case 'manual': {
      const order = input.selectedLotIds ?? [];
      const rank = new Map(order.map((id, i) => [id, i]));
      return open
        .filter((lot) => rank.has(lot.id))
        .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    }
    case 'average':
      // handled in matchSell (single synthetic pool); ordering irrelevant.
      return [...open].sort((a, b) => a.acquiredDate.localeCompare(b.acquiredDate));
  }
}

/**
 * Match a sell against lots. Proceeds are allocated pro-rata by consumed amount,
 * so realized P&L per slice = allocatedProceeds − allocatedCost.
 */
export function matchSell(lots: Lot[], input: SellMatchInput): SellMatchResult {
  const now = input.now ?? new Date().toISOString();
  const sellAmount = D(input.amount);
  const proceeds = D(input.proceedsBase);

  const ordered = orderLots(lots, input);
  const byId = new Map(lots.map((l) => [l.id, { ...l }]));

  const consumptions: LotConsumption[] = [];
  let remainingToSell = sellAmount;
  let totalCost = D(0);

  if (input.method === 'average') {
    // Average cost across the open pool.
    const poolAmount = sum(ordered.map((l) => l.remainingAmount));
    const poolCost = sum(
      ordered.map((l) => D(l.baseCost).times(safeDiv(l.remainingAmount, l.originalAmount))),
    );
    const avgUnit = safeDiv(poolCost, poolAmount);
    for (const lot of ordered) {
      if (remainingToSell.lte(0)) break;
      const take = DecimalMin(remainingToSell, D(lot.remainingAmount));
      const cost = avgUnit.times(take);
      totalCost = totalCost.plus(cost);
      applyConsumption(byId, lot.id, take, cost, now);
      consumptions.push(makeConsumption(input, lot.id, take, cost, now));
      remainingToSell = remainingToSell.minus(take);
    }
  } else {
    for (const lot of ordered) {
      if (remainingToSell.lte(0)) break;
      const take = DecimalMin(remainingToSell, D(lot.remainingAmount));
      // Cost basis for the slice = lot cost pro-rated by consumed fraction of original.
      const unit = safeDiv(lot.baseCost, lot.originalAmount);
      const cost = unit.times(take);
      totalCost = totalCost.plus(cost);
      applyConsumption(byId, lot.id, take, cost, now);
      consumptions.push(makeConsumption(input, lot.id, take, cost, now));
      remainingToSell = remainingToSell.minus(take);
    }
  }

  const matchedAmount = sellAmount.minus(remainingToSell);
  // Allocate total proceeds pro-rata across matched slices.
  for (const c of consumptions) {
    const share = safeDiv(c.consumedAmount, matchedAmount);
    const alloc = proceeds.times(share);
    c.proceedsBase = alloc.toString();
    c.realizedPnlBase = alloc.minus(D(c.allocatedCostBase)).toString();
  }

  const realized = proceeds.minus(totalCost);
  return {
    consumptions,
    updatedLots: [...byId.values()],
    totalCostBase: totalCost.toString(),
    totalProceedsBase: proceeds.toString(),
    realizedPnlBase: realized.toString(),
    unmatchedAmount: remainingToSell.isPositive() ? remainingToSell.toString() : '0',
  };
}

function DecimalMin(a: import('./decimal.js').Decimal, b: import('./decimal.js').Decimal) {
  return a.lte(b) ? a : b;
}

function applyConsumption(
  byId: Map<string, Lot>,
  lotId: string,
  take: import('./decimal.js').Decimal,
  _cost: import('./decimal.js').Decimal,
  now: string,
): void {
  const lot = byId.get(lotId);
  if (!lot) return;
  const remaining = D(lot.remainingAmount).minus(take);
  lot.remainingAmount = remaining.toString();
  lot.status = remaining.lte(0) ? 'closed' : 'open';
  lot.updatedAt = now;
}

function makeConsumption(
  input: SellMatchInput,
  lotId: string,
  take: import('./decimal.js').Decimal,
  cost: import('./decimal.js').Decimal,
  now: string,
): LotConsumption {
  return {
    id: newId(),
    lotId,
    sellChainId: input.sellChainId,
    consumedAmount: take.toString(),
    allocatedCostBase: cost.toString(),
    proceedsBase: '0', // filled in after pro-rata allocation
    realizedPnlBase: '0',
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
  };
}

/** Remaining cost basis of all open lots for an asset (for unrealized P&L). */
export function remainingCostBasis(lots: Lot[], assetId: string): string {
  return sum(
    lots
      .filter((l) => l.assetId === assetId && !l.isDeleted && D(l.remainingAmount).isPositive())
      .map((l) => D(l.baseCost).times(safeDiv(l.remainingAmount, l.originalAmount))),
  ).toString();
}

/** Remaining holdings (sum of remainingAmount) of an asset across open lots. */
export function remainingHoldings(lots: Lot[], assetId: string): string {
  return sum(
    lots
      .filter((l) => l.assetId === assetId && !l.isDeleted)
      .map((l) => l.remainingAmount),
  ).toString();
}
