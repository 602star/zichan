import { canonicalJson } from './crypto.js';
import { dayOfInstant } from './dates.js';
import { D, sum } from './decimal.js';
import { buildAssetCostEvents, type CostEventInput, type CostEventIssue } from './asset-cost-events.js';
import { replayAssetCosts, type AssetCostReplay, type AssetCostRefundHistory, type CostBasisOpening } from './asset-cost.js';
import type { Account } from './types.js';

export interface AssetCostLedgerInput extends CostEventInput { accounts: readonly Account[]; }
export interface AssetCostState extends AssetCostReplay {
  boundaries?: { openingId: string; occurredAtUtc: string; baseCurrencyAssetId: string }[];
  timezone: string;
  openingId: string;
  occurredAtUtc: string;
  baseCurrencyAssetId: string;
  invalidAssetIds: string[];
  issues: CostEventIssue[];
}

export function assetCostSourceSummary(state: AssetCostState, sourceId: string | readonly string[]) {
  const sources = new Set(typeof sourceId === 'string' ? [sourceId] : sourceId);
  const events = state.events.filter((event) => sources.has(event.sourceId) && event.realize);
  const complete = events.every((event) => event.realizedGainLoss !== null);
  const knownRealizedGainLoss = sum(events.map((event) => event.knownRealizedGainLoss)).toString();
  return { complete, realizedGainLoss: complete ? knownRealizedGainLoss : null, knownRealizedGainLoss,
    costInBase: events.every((event) => event.costInBase !== null) ? sum(events.map((event) => event.costInBase!)).toString() : null,
    gapQuantity: sum(state.gaps.filter((gap) => events.some((event) => event.eventId === gap.eventId) && gap.reason === 'missing_quantity').map((gap) => gap.quantity)).toString() };
}

export function usesAssetCostState(state: AssetCostState | undefined, row: { occurredAtUtc?: string; date: string }): state is AssetCostState {
  const boundary = state?.boundaries?.[0]?.occurredAtUtc ?? state?.occurredAtUtc;
  return !!state && !!boundary && (row.occurredAtUtc ? Date.parse(row.occurredAtUtc) > Date.parse(boundary) : row.date >= dayOfInstant(boundary, state.timezone));
}

/** Semantic history only: titles, notes, prices and reporting currency are excluded. */
export function costOpeningFingerprint(input: AssetCostLedgerInput): string {
  const byAsset: Record<string, unknown[]> = {};
  const add = (assetId: string | undefined, row: unknown) => {
    if (assetId) (byAsset[assetId] ??= []).push(row);
  };
  const before = (row: { occurredAtUtc?: string; date: string }) => row.occurredAtUtc
    ? Date.parse(row.occurredAtUtc) <= Date.parse(input.opening.occurredAtUtc)
    : row.date <= dayOfInstant(input.opening.occurredAtUtc, input.timezone);
  for (const account of input.accounts) {
    if (account.isDeleted || (account.balanceStartAt && Date.parse(account.balanceStartAt) > Date.parse(input.opening.occurredAtUtc))) continue;
    add(account.openingAssetId, { accountId: account.id, quantity: account.openingBalance ?? null,
      start: account.balanceStartAt ?? account.balanceStartDate ?? null, kind: account.kind, purpose: account.purpose ?? null });
  }
  for (const { chain, steps } of input.chains) {
    if (!before(chain) || chain.isDeleted || chain.recordState === 'voided') continue;
    for (const step of steps) {
      const row = { id: step.id, chainId: chain.id, occurredAtUtc: chain.occurredAtUtc ?? null, date: chain.date,
        type: chain.type, baseCurrencyAssetId: chain.baseCurrencyAssetId, bookValueInBase: chain.bookValueInBase ?? null,
        method: chain.lotMethod ?? null, manualLotIds: chain.manualLotIds ?? [], costQuotes: chain.costQuotes ?? [],
        order: step.order, fromAssetId: step.fromAssetId, fromAmount: step.fromAmount, toAssetId: step.toAssetId, toAmount: step.toAmount,
        accountFromId: step.accountFromId ?? null, accountToId: step.accountToId ?? null,
        fees: (step.fees ?? []).map(({ id, assetId, amount, treatment, accountId, valueInBase }) => ({ id, assetId, amount, treatment, accountId: accountId ?? null, valueInBase: valueInBase ?? null })) };
      for (const assetId of new Set([step.fromAssetId, step.toAssetId, ...(step.fees ?? []).map((fee) => fee.assetId)])) add(assetId, row);
    }
  }
  for (const transaction of input.transactions) {
    if (!before(transaction) || transaction.isDeleted || transaction.recordState === 'voided') continue;
    const { id, date, occurredAtUtc, type, amount, assetId, accountId, transferAssetId, transferAccountId,
      transferAmount, adjustmentDirection, refundForId, costQuote, balanceTiming, balanceTimingAccountId } = transaction;
    const row = { id, date, occurredAtUtc: occurredAtUtc ?? null, type, amount, assetId, accountId: accountId ?? null,
      transferAssetId: transferAssetId ?? null, transferAccountId: transferAccountId ?? null, transferAmount: transferAmount ?? null,
      adjustmentDirection: adjustmentDirection ?? null, refundForId: refundForId ?? null, costQuote: costQuote ?? null,
      balanceTiming: balanceTiming ?? null, balanceTimingAccountId: balanceTimingAccountId ?? null };
    for (const id of new Set([assetId, transferAssetId].filter((value): value is string => !!value))) add(id, row);
  }
  return canonicalJson(Object.fromEntries(Object.entries(byAsset).map(([assetId, rows]) => [assetId, rows.map(canonicalJson).sort()])));
}

/** Always rebuilt from facts, so import, undo and remote application use identical rules. */
export function calculateAssetCostState(input: AssetCostLedgerInput, refundHistory?: AssetCostRefundHistory): AssetCostState {
  const built = buildAssetCostEvents(input);
  const replay = replayAssetCosts(built.events, input.opening.baseCurrencyAssetId, refundHistory);
  for (const event of replay.events) event.baseCurrencyAssetId = input.opening.baseCurrencyAssetId;
  const now = JSON.parse(costOpeningFingerprint(input)) as Record<string, unknown>;
  let confirmed: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(input.opening.sourceFingerprint);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) confirmed = parsed as Record<string, unknown>;
  } catch { /* Old/malformed evidence cannot confirm a basis. */ }
  const invalid = new Set([...Object.keys(now), ...Object.keys(confirmed)]
    .filter((assetId) => canonicalJson(now[assetId] ?? null) !== canonicalJson(confirmed[assetId] ?? null)));
  for (const issue of built.issues) if (issue.code === 'ambiguous_time') for (const assetId of issue.assetIds) invalid.add(assetId);
  // Invalid source basis contaminates downstream acquisitions, even when their
  // fair value is frozen: the opening must be reviewed before claiming completeness.
  const affectedSources = new Set(built.events.filter((event) => invalid.has(event.assetId)).map((event) => event.sourceId));
  for (const row of replay.events) {
    if (!affectedSources.has(row.sourceId)) continue;
    row.costStatus = 'unknown'; row.costInBase = null; row.realizedGainLoss = null;
    row.knownCostInBase = '0'; row.knownRealizedGainLoss = '0';
  }
  for (const row of replay.consumptions) {
    if (affectedSources.has(row.sourceId)) { row.costInBase = null; row.realizedGainLoss = null; }
  }
  for (const row of replay.positions) {
    if (!invalid.has(row.assetId)) continue;
    row.costStatus = 'unknown'; row.costInBase = null; row.knownCostInBase = '0';
    row.unknownQuantity = D(row.quantity).gt(0) ? row.quantity : '0';
  }
  return { ...replay, timezone: input.timezone, openingId: input.opening.id, occurredAtUtc: input.opening.occurredAtUtc,
    baseCurrencyAssetId: input.opening.baseCurrencyAssetId, invalidAssetIds: [...invalid].sort(), issues: built.issues };
}

/** Keep closed accounting periods in their original frozen currency; only the latest period owns current positions. */
export function calculateAssetCostHistory(input: Omit<AssetCostLedgerInput, 'opening'> & { openings: readonly CostBasisOpening[] }): AssetCostState | undefined {
  const openings = input.openings.filter((opening) => !opening.isDeleted && (!input.asOfUtc || Date.parse(opening.occurredAtUtc) <= Date.parse(input.asOfUtc)))
    .sort((a, b) => Date.parse(a.occurredAtUtc) - Date.parse(b.occurredAtUtc) || a.id.localeCompare(b.id));
  const periods: AssetCostState[] = [];
  for (const [index, opening] of openings.entries()) {
    periods.push(calculateAssetCostState({ ...input, opening, timezone: opening.timezone ?? input.timezone,
      asOfUtc: openings[index + 1]?.occurredAtUtc ?? input.asOfUtc }, periods.at(-1)?.refundHistory));
  }
  const latest = periods.at(-1);
  if (!latest) return undefined;
  return { ...latest, boundaries: openings.map((opening) => ({ openingId: opening.id, occurredAtUtc: opening.occurredAtUtc, baseCurrencyAssetId: opening.baseCurrencyAssetId })),
    events: periods.flatMap((period) => period.events), consumptions: periods.flatMap((period) => period.consumptions),
    gaps: periods.flatMap((period) => period.gaps), issues: periods.flatMap((period) => period.issues) };
}
