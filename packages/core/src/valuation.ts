/**
 * Portfolio valuation (§30, dashboard). Values balances in the base currency using
 * the latest PriceMark per asset, computes allocation %, and unrealized P&L for
 * crypto (current value − remaining cost basis of open lots). This fills the plan
 * gap where the UI shows 现价/现值/未实现盈亏 with no supporting data model.
 */
import { daysBetween } from './dates.js';
import { D, safeDiv, sum, type Decimal } from './decimal.js';
import type { Balance } from './postings.js';
import type { Asset, Lot, PriceMark } from './types.js';

export type PriceFreshness = 'base' | 'fresh' | 'stale' | 'unknown';

/** Details for the deterministic quote path selected for one asset. */
export interface ResolvedPrice {
  assetId: string;
  priceInBase: string;
  /** Asset ids from the report currency to the valued asset, inclusive. */
  pathAssetIds: string[];
  /** Price marks used by the path, in traversal order. */
  priceMarkIds: string[];
  /** Oldest mark in a cross-currency path; this governs path freshness. */
  oldestMarkDate?: string;
  ageDays?: number;
  freshness: PriceFreshness;
}

export interface ResolveLatestPricesOptions {
  /** Ignore marks after this business date. */
  asOf?: string;
  /** A path is stale when its oldest leg is more than this many days old. Requires asOf. */
  staleAfterDays?: number;
}

interface QuoteEdge {
  to: string;
  rate: Decimal;
  mark: PriceMark;
  /** True when traversing the reciprocal rather than the stored quote direction. */
  inverse: boolean;
}

interface QuotePath {
  id: string;
  rate: Decimal;
  pathAssetIds: string[];
  priceMarkIds: string[];
  oldestMarkDate?: string;
  inverseEdges: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTextArrays(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareText(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

/** Positive means left is the newer deterministic winner. */
function compareMarks(left: PriceMark, right: PriceMark): number {
  return compareText(left.date, right.date)
    || compareText(left.updatedAt, right.updatedAt)
    || compareText(left.createdAt, right.createdAt)
    || compareText(left.id, right.id);
}

/**
 * Order quote paths by business preference, independent of mark input order:
 * fewest hops, freshest weakest leg, fewer reciprocal edges, then lexical path.
 */
function comparePaths(left: QuotePath, right: QuotePath): number {
  const hops = left.priceMarkIds.length - right.priceMarkIds.length;
  if (hops !== 0) return hops;

  const freshness = compareText(right.oldestMarkDate ?? '', left.oldestMarkDate ?? '');
  if (freshness !== 0) return freshness;

  const inverseEdges = left.inverseEdges - right.inverseEdges;
  if (inverseEdges !== 0) return inverseEdges;

  return compareTextArrays(left.pathAssetIds, right.pathAssetIds)
    || compareTextArrays(left.priceMarkIds, right.priceMarkIds);
}

function validateResolutionOptions(options: ResolveLatestPricesOptions): void {
  if (options.staleAfterDays === undefined) return;
  if (!options.asOf) throw new Error('staleAfterDays requires asOf');
  if (!Number.isFinite(options.staleAfterDays) || options.staleAfterDays < 0) {
    throw new Error('staleAfterDays must be a non-negative finite number');
  }
}

/**
 * Resolve direct, inverse and shortest cross-currency prices with path metadata.
 * Same-day conflicting marks use updatedAt, createdAt and id as stable tie-breaks.
 */
export function resolveLatestPrices(
  marks: PriceMark[],
  baseCurrencyAssetId: string,
  options: ResolveLatestPricesOptions = {},
): Map<string, ResolvedPrice> {
  validateResolutionOptions(options);

  const best = new Map<string, PriceMark>();
  for (const mark of marks) {
    if (mark.isDeleted || D(mark.price).lte(0)) continue;
    if (options.asOf && mark.date > options.asOf) continue;
    const key = `${mark.assetId}\u0000${mark.quoteAssetId}`;
    const current = best.get(key);
    if (!current || compareMarks(mark, current) > 0) best.set(key, mark);
  }

  const graph = new Map<string, QuoteEdge[]>();
  const addEdge = (from: string, edge: QuoteEdge) => {
    const edges = graph.get(from) ?? [];
    edges.push(edge);
    graph.set(from, edges);
  };
  for (const mark of best.values()) {
    if (mark.assetId === mark.quoteAssetId) continue;
    const rate = D(mark.price);
    // Starting at the report currency, reaching an asset multiplies by the
    // amount of report currency represented by one unit of that asset.
    addEdge(mark.quoteAssetId, { to: mark.assetId, rate, mark, inverse: false });
    addEdge(mark.assetId, { to: mark.quoteAssetId, rate: D(1).div(rate), mark, inverse: true });
  }
  for (const edges of graph.values()) {
    edges.sort((left, right) => compareText(left.to, right.to)
      || Number(left.inverse) - Number(right.inverse)
      || -compareMarks(left.mark, right.mark));
  }

  const basePath: QuotePath = {
    id: baseCurrencyAssetId,
    rate: D(1),
    pathAssetIds: [baseCurrencyAssetId],
    priceMarkIds: [],
    inverseEdges: 0,
  };
  const paths = new Map<string, QuotePath>([[baseCurrencyAssetId, basePath]]);
  const queue: QuotePath[] = [basePath];

  // A small priority queue is sufficient for the number of assets normally in
  // a ledger. Hop count is the primary key, so cycles can never improve a path.
  while (queue.length > 0) {
    queue.sort(comparePaths);
    const current = queue.shift()!;
    if (paths.get(current.id) !== current) continue;

    for (const edge of graph.get(current.id) ?? []) {
      const candidate: QuotePath = {
        id: edge.to,
        rate: current.rate.times(edge.rate),
        pathAssetIds: [...current.pathAssetIds, edge.to],
        priceMarkIds: [...current.priceMarkIds, edge.mark.id],
        oldestMarkDate: current.oldestMarkDate && current.oldestMarkDate < edge.mark.date
          ? current.oldestMarkDate
          : edge.mark.date,
        inverseEdges: current.inverseEdges + Number(edge.inverse),
      };
      const known = paths.get(edge.to);
      if (!known || comparePaths(candidate, known) < 0) {
        paths.set(edge.to, candidate);
        queue.push(candidate);
      }
    }
  }

  const out = new Map<string, ResolvedPrice>();
  for (const path of paths.values()) {
    if (path.id === baseCurrencyAssetId) {
      out.set(path.id, {
        assetId: path.id,
        priceInBase: '1',
        pathAssetIds: path.pathAssetIds,
        priceMarkIds: [],
        freshness: 'base',
      });
      continue;
    }

    const canEvaluateFreshness = options.asOf !== undefined && options.staleAfterDays !== undefined;
    const ageDays = options.asOf && path.oldestMarkDate
      ? daysBetween(path.oldestMarkDate, options.asOf)
      : undefined;
    const freshness: PriceFreshness = canEvaluateFreshness
      ? ageDays! > options.staleAfterDays! ? 'stale' : 'fresh'
      : 'unknown';
    out.set(path.id, {
      assetId: path.id,
      priceInBase: path.rate.toString(),
      pathAssetIds: path.pathAssetIds,
      priceMarkIds: path.priceMarkIds,
      oldestMarkDate: path.oldestMarkDate,
      ageDays,
      freshness,
    });
  }
  return out;
}

/** Latest reachable price for each asset in the report currency.
 * Direct, inverse and shortest cross-currency paths are supported.
 * Kept as the compact, backwards-compatible API. */
export function latestPrices(
  marks: PriceMark[],
  baseCurrencyAssetId: string,
  asOf?: string,
): Map<string, string> {
  return new Map([...resolveLatestPrices(marks, baseCurrencyAssetId, { asOf })]
    .map(([assetId, resolved]) => [assetId, resolved.priceInBase]));
}

export type HoldingPricingStatus = 'base' | 'priced' | 'stale' | 'unpriced' | 'not_required';

export interface HoldingValue {
  assetId: string;
  amount: string;
  priceInBase?: string;
  /**
   * Backwards-compatible numeric value. It is `0` for an unpriced holding;
   * consult pricingStatus/includedInTotal before treating it as authoritative.
   */
  valueInBase: string;
  /** Fraction of the known priced subtotal, 0..1. */
  weight: string;
  pricingStatus: HoldingPricingStatus;
  includedInTotal: boolean;
  priceDate?: string;
  pricePathAssetIds?: string[];
  /** Remaining cost basis (crypto lots), when available. */
  costBasis?: string;
  /** valueInBase − costBasis, when both market value and cost basis are known. */
  unrealizedPnl?: string;
}

export interface PortfolioValuation {
  baseCurrencyAssetId: string;
  /** Sum of priced holdings only; completeness must be checked before treating it as net worth. */
  totalValue: string;
  totalCostBasis: string;
  totalUnrealizedPnl: string;
  completeness: 'complete' | 'partial';
  unpricedAssetIds: string[];
  stalePriceAssetIds: string[];
  freshnessEvaluated: boolean;
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
  /** Historical valuation date and upper bound for eligible marks. */
  asOf?: string;
  /** Mark paths older than this many days are reported as stale. Requires asOf. */
  staleAfterDays?: number;
}

export function valuePortfolio(input: ValuePortfolioInput): PortfolioValuation {
  const resolutions = resolveLatestPrices(input.priceMarks, input.baseCurrencyAssetId, {
    asOf: input.asOf,
    staleAfterDays: input.staleAfterDays,
  });
  const prices = new Map([...resolutions].map(([assetId, resolved]) => [assetId, resolved.priceInBase]));
  const assetById = new Map((input.assets ?? []).map((asset) => [asset.id, asset]));
  const include = input.includeTypes;

  // Aggregate balances per asset (in case they were split per account).
  const byAsset = new Map<string, Decimal>();
  for (const balance of input.balances) {
    const asset = assetById.get(balance.assetId);
    if (include && asset && !include.has(asset.type)) continue;
    byAsset.set(balance.assetId, (byAsset.get(balance.assetId) ?? D(0)).plus(D(balance.amount)));
  }

  const raw = [...byAsset.entries()].map(([assetId, amount]) => {
    const resolution = resolutions.get(assetId);
    const value = resolution ? amount.times(D(resolution.priceInBase)) : D(0);
    const costBasis = input.lots
      ? costBasisInQuote(input.lots, assetId, prices, input.baseCurrencyAssetId)
      : undefined;
    return { assetId, amount, resolution, value, costBasis };
  });

  const total = sum(raw.filter((row) => row.resolution !== undefined).map((row) => row.value));
  const unpricedAssetIds = raw
    .filter((row) => !row.amount.isZero() && row.resolution === undefined)
    .map((row) => row.assetId)
    .sort(compareText);
  const stalePriceAssetIds = raw
    .filter((row) => !row.amount.isZero() && row.resolution?.freshness === 'stale')
    .map((row) => row.assetId)
    .sort(compareText);

  const holdings: HoldingValue[] = raw.map((row) => {
    const pricingStatus: HoldingPricingStatus = row.amount.isZero() && !row.resolution
      ? 'not_required'
      : !row.resolution
        ? 'unpriced'
        : row.resolution.freshness === 'base'
          ? 'base'
          : row.resolution.freshness === 'stale'
            ? 'stale'
            : 'priced';
    const holding: HoldingValue = {
      assetId: row.assetId,
      amount: row.amount.toString(),
      valueInBase: row.value.toString(),
      weight: row.resolution ? safeDiv(row.value, total).toString() : '0',
      pricingStatus,
      includedInTotal: row.resolution !== undefined,
    };
    if (row.resolution) {
      holding.priceInBase = row.resolution.priceInBase;
      holding.priceDate = row.resolution.oldestMarkDate;
      holding.pricePathAssetIds = row.resolution.pathAssetIds;
    }
    if (row.costBasis !== undefined && D(row.costBasis).isPositive()) {
      holding.costBasis = row.costBasis;
      // Missing market prices must not turn the entire cost basis into a fake loss.
      if (row.resolution) holding.unrealizedPnl = row.value.minus(D(row.costBasis)).toString();
    }
    return holding;
  });

  const totalCostBasis = sum(holdings.map((holding) => holding.costBasis ?? 0));
  const totalUnrealized = sum(holdings.map((holding) => holding.unrealizedPnl ?? 0));

  return {
    baseCurrencyAssetId: input.baseCurrencyAssetId,
    totalValue: total.toString(),
    totalCostBasis: totalCostBasis.toString(),
    totalUnrealizedPnl: totalUnrealized.toString(),
    completeness: unpricedAssetIds.length === 0 ? 'complete' : 'partial',
    unpricedAssetIds,
    stalePriceAssetIds,
    freshnessEvaluated: input.asOf !== undefined && input.staleAfterDays !== undefined,
    holdings: holdings.sort((left, right) => D(right.valueInBase).comparedTo(D(left.valueInBase))
      || compareText(left.assetId, right.assetId)),
  };
}

function costBasisInQuote(
  lots: Lot[],
  assetId: string,
  prices: Map<string, string>,
  baseCurrencyAssetId: string,
): string | undefined {
  let total = D(0);
  for (const lot of lots.filter((row) => row.assetId === assetId && !row.isDeleted && D(row.remainingAmount).gt(0))) {
    const rate = lot.baseCurrencyAssetId === baseCurrencyAssetId
      ? '1'
      : prices.get(lot.baseCurrencyAssetId);
    if (!rate) return undefined;
    if (D(lot.originalAmount).isZero()) continue;
    total = total.plus(D(lot.baseCost).times(D(lot.remainingAmount).div(lot.originalAmount)).times(rate));
  }
  return total.toString();
}
