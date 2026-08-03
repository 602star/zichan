/**
 * Portfolio valuation (§30, dashboard). Values balances in the base currency using
 * the latest PriceMark per asset, computes allocation %, and unrealized P&L for
 * crypto (current value − remaining cost basis of open lots). This fills the plan
 * gap where the UI shows 现价/现值/未实现盈亏 with no supporting data model.
 */
import { D, safeDiv, sum } from './decimal.js';
import type { Balance } from './postings.js';
import type { Asset, Lot, PriceMark } from './types.js';

/** Latest reachable price for each asset in the report currency.
 * Direct, inverse and shortest cross-currency paths are supported. */
export function latestPrices(
  marks: PriceMark[],
  baseCurrencyAssetId: string,
  asOf?: string,
): Map<string, string> {
  const best = new Map<string, PriceMark>();
  for (const m of marks) {
    if (m.isDeleted) continue;
    if (D(m.price).lte(0)) continue;
    if (asOf && m.date > asOf) continue;
    const key = `${m.assetId}\u0000${m.quoteAssetId}`;
    const cur = best.get(key);
    if (!cur || m.date.localeCompare(cur.date) > 0) best.set(key, m);
  }
  const graph = new Map<string, { to: string; rate: import('./decimal.js').Decimal }[]>();
  const addEdge = (from: string, to: string, rate: import('./decimal.js').Decimal) => {
    const edges = graph.get(from) ?? [];
    edges.push({ to, rate });
    graph.set(from, edges);
  };
  for (const mark of best.values()) {
    const rate = D(mark.price);
    addEdge(mark.assetId, mark.quoteAssetId, rate);
    if (mark.assetId !== mark.quoteAssetId) addEdge(mark.quoteAssetId, mark.assetId, D(1).div(rate));
  }
  const out = new Map<string, string>();
  out.set(baseCurrencyAssetId, '1');
  const nodes = new Set<string>([baseCurrencyAssetId, ...graph.keys(), ...[...graph.values()].flatMap((edges) => edges.map((edge) => edge.to))]);
  for (const start of nodes) {
    if (start === baseCurrencyAssetId) continue;
    const queue: { id: string; rate: import('./decimal.js').Decimal }[] = [{ id: start, rate: D(1) }];
    const visited = new Set<string>([start]);
    while (queue.length) {
      const current = queue.shift()!;
      const edges = [...(graph.get(current.id) ?? [])]
        .sort((a, b) => Number(b.to === baseCurrencyAssetId) - Number(a.to === baseCurrencyAssetId));
      for (const edge of edges) {
        const rate = current.rate.times(edge.rate);
        if (edge.to === baseCurrencyAssetId) {
          out.set(start, rate.toString());
          queue.length = 0;
          break;
        }
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push({ id: edge.to, rate });
        }
      }
    }
  }
  return out;
}

export interface HoldingValue {
  assetId: string;
  amount: string;
  priceInBase?: string;
  valueInBase: string;
  /** Fraction of total portfolio value, 0..1. */
  weight: string;
  /** Remaining cost basis (crypto lots), when available. */
  costBasis?: string;
  /** valueInBase − costBasis, when cost basis is known. */
  unrealizedPnl?: string;
}

export interface PortfolioValuation {
  baseCurrencyAssetId: string;
  totalValue: string;
  totalCostBasis: string;
  totalUnrealizedPnl: string;
  holdings: HoldingValue[];
}

export interface ValuePortfolioInput {
  baseCurrencyAssetId: string;
  balances: Balance[]; // net balances per asset (from postings)
  priceMarks: PriceMark[];
  lots?: Lot[]; // for cost basis / unrealized P&L
  assets?: Asset[]; // to skip game assets etc. from valuation if desired
  /** Asset types to include in valuation. Defaults to all financial types. */
  includeTypes?: Set<string>;
}

export function valuePortfolio(input: ValuePortfolioInput): PortfolioValuation {
  const prices = latestPrices(input.priceMarks, input.baseCurrencyAssetId);
  const assetById = new Map((input.assets ?? []).map((a) => [a.id, a]));
  const include = input.includeTypes;

  // Aggregate balances per asset (in case they were split per account).
  const byAsset = new Map<string, import('./decimal.js').Decimal>();
  for (const b of input.balances) {
    const a = assetById.get(b.assetId);
    if (include && a && !include.has(a.type)) continue;
    byAsset.set(b.assetId, (byAsset.get(b.assetId) ?? D(0)).plus(D(b.amount)));
  }

  const raw = [...byAsset.entries()].map(([assetId, amount]) => {
    const price = prices.get(assetId);
    const value = price ? amount.times(D(price)) : D(0);
    const costBasis = input.lots ? costBasisInQuote(input.lots, assetId, prices) : undefined;
    return { assetId, amount, price, value, costBasis };
  });

  const total = sum(raw.map((r) => r.value));

  const holdings: HoldingValue[] = raw.map((r) => {
    const h: HoldingValue = {
      assetId: r.assetId,
      amount: r.amount.toString(),
      valueInBase: r.value.toString(),
      weight: safeDiv(r.value, total).toString(),
    };
    if (r.price !== undefined) h.priceInBase = r.price;
    if (r.costBasis !== undefined && D(r.costBasis).isPositive()) {
      h.costBasis = r.costBasis;
      h.unrealizedPnl = r.value.minus(D(r.costBasis)).toString();
    }
    return h;
  });

  const totalCostBasis = sum(holdings.map((h) => h.costBasis ?? 0));
  const totalUnrealized = sum(holdings.map((h) => h.unrealizedPnl ?? 0));

  return {
    baseCurrencyAssetId: input.baseCurrencyAssetId,
    totalValue: total.toString(),
    totalCostBasis: totalCostBasis.toString(),
    totalUnrealizedPnl: totalUnrealized.toString(),
    holdings: holdings.sort((a, b) => D(b.valueInBase).minus(D(a.valueInBase)).toNumber()),
  };
}

function costBasisInQuote(lots: Lot[], assetId: string, prices: Map<string, string>): string | undefined {
  let total = D(0);
  for (const lot of lots.filter((row) => row.assetId === assetId && !row.isDeleted && D(row.remainingAmount).gt(0))) {
    const rate = prices.get(lot.baseCurrencyAssetId);
    if (!rate) return undefined;
    if (D(lot.originalAmount).isZero()) continue;
    total = total.plus(D(lot.baseCost).times(D(lot.remainingAmount).div(lot.originalAmount)).times(rate));
  }
  return total.toString();
}
