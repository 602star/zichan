import { D, sum } from './decimal.js';
import type { BaseEntity, LotMethod } from './types.js';

export type AssetCostStatus = 'known' | 'partial' | 'unknown';

/** Saved evidence, never re-resolved against today's prices during replay. */
export interface CostQuoteSnapshot {
  baseCurrencyAssetId: string;
  valueInBase: string | null;
  source: 'manual' | 'transaction' | 'price_mark' | 'unknown';
  priceMarkIds: string[];
  quoteDate?: string;
  explanation?: string;
  dependencyFingerprint: string;
}

export interface ConversionCostQuote extends CostQuoteSnapshot {
  stepId: string;
  /** Principal fair value, before fees. Fee values are frozen separately. */
  feeValues: { feeId: string; valueInBase: string | null; evidence?: CostQuoteSnapshot }[];
}

export interface CostBasisOpening extends BaseEntity {
  timezone?: string;
  occurredAtUtc: string;
  baseCurrencyAssetId: string;
  sourceFingerprint: string;
  confirmedAt: string;
  items: CostBasisOpeningItem[];
}

export interface CostBasisOpeningItem {
  id: string;
  assetId: string;
  quantity: string;
  costInBase: string | null;
  acquiredAtUtc: string;
  sourceLotId?: string;
}

export interface AssetCostEvent {
  id: string;
  sourceKind: 'opening' | 'conversion' | 'transaction' | 'adjustment';
  sourceId: string;
  occurredAtUtc: string;
  /** Stable operation/segment/step/leg ordering at the same instant. */
  orderKey: string;
  kind: 'acquire' | 'dispose' | 'refund';
  assetId: string;
  quantity: string;
  valueInBase: string | null;
  realize: boolean;
  method?: LotMethod;
  selectedLotIds?: string[];
  refundSourceId?: string;
  /** Account balance snapshots can retain the original acquisition ordering. */
  acquiredAtUtc?: string;
}

export interface AssetCostLot {
  id: string;
  assetId: string;
  sourceEventId: string;
  acquiredAtUtc: string;
  originalQuantity: string;
  originalCostInBase: string | null;
  remainingQuantity: string;
  remainingCostInBase: string | null;
}

export interface AssetCostConsumption {
  id: string;
  eventId: string;
  sourceId: string;
  assetId: string;
  lotId: string | null;
  quantity: string;
  costInBase: string | null;
  proceedsInBase: string | null;
  realizedGainLoss: string | null;
  reason: 'disposal' | 'adjustment' | 'deficit_settlement';
}

export interface AssetCostGap {
  id: string;
  eventId: string;
  assetId: string;
  quantity: string;
  /** Later inflows settle quantity only; the historical missing cost remains missing. */
  outstandingQuantity: string;
  reason: 'missing_quantity' | 'unknown_cost' | 'unknown_value';
}

export interface AssetCostEventResult {
  baseCurrencyAssetId?: string;
  eventId: string;
  occurredAtUtc: string;
  sourceId: string;
  assetId: string;
  kind: AssetCostEvent['kind'];
  realize: boolean;
  costStatus: AssetCostStatus;
  costInBase: string | null;
  knownCostInBase: string;
  realizedGainLoss: string | null;
  knownRealizedGainLoss: string;
}

export interface AssetCostPosition {
  assetId: string;
  quantity: string;
  costStatus: AssetCostStatus;
  costInBase: string | null;
  knownCostInBase: string;
  unknownQuantity: string;
  deficitQuantity: string;
}

export interface AssetCostRefundHistory {
  baseCurrencyAssetId: string;
  consumptions: AssetCostConsumption[];
  lots: AssetCostLot[];
  refunded: [string, string][];
  refundedCost: [string, string][];
  refundedProceeds: [string, string][];
}

export interface AssetCostReplay {
  /** Read-only matching evidence across cost openings; never contributes balances. */
  refundHistory?: AssetCostRefundHistory;
  lots: AssetCostLot[];
  consumptions: AssetCostConsumption[];
  gaps: AssetCostGap[];
  events: AssetCostEventResult[];
  positions: AssetCostPosition[];
}

export function assertCostBasisOpening(opening: CostBasisOpening): void {
  if (!opening.baseCurrencyAssetId || !opening.sourceFingerprint || !Number.isFinite(Date.parse(opening.occurredAtUtc))
    || !Number.isFinite(Date.parse(opening.confirmedAt)) || !Array.isArray(opening.items)) throw new Error('成本起点缺少核算币种、准确时间或确认依据');
  const ids = new Set<string>();
  for (const item of opening.items) {
    if (!item.id || ids.has(item.id) || !item.assetId || typeof item.quantity !== 'string' || !item.quantity.trim() || !D(item.quantity).isFinite()
      || !Number.isFinite(Date.parse(item.acquiredAtUtc)) || Date.parse(item.acquiredAtUtc) > Date.parse(opening.occurredAtUtc)) throw new Error('成本起点批次数量、标识或取得时间无效');
    ids.add(item.id);
    if (item.costInBase !== null) nonnegative(item.costInBase, '起点成本');
    if (D(item.quantity).lte(0) && item.costInBase !== null && !D(item.costInBase).isZero()) throw new Error('非正余额不能填写正数成本');
    if (item.assetId === opening.baseCurrencyAssetId && D(item.quantity).gt(0)
      && (item.costInBase === null || !D(item.costInBase).eq(item.quantity))) throw new Error('核算币种单位成本必须为 1');
  }
}

export function assertCostQuoteSnapshot(quote: CostQuoteSnapshot): void {
  if (!quote || !quote.baseCurrencyAssetId || !quote.dependencyFingerprint || !Array.isArray(quote.priceMarkIds)
    || !['manual', 'transaction', 'price_mark', 'unknown'].includes(quote.source)) throw new Error('价值快照缺少完整依据');
  if (quote.valueInBase !== null) nonnegative(quote.valueInBase, '冻结价值');
  if (quote.source === 'unknown' && quote.valueInBase !== null) throw new Error('未知价值必须为空');
  if (quote.source !== 'unknown' && quote.valueInBase === null) throw new Error('已确认价值不能为空');
  if (quote.source === 'price_mark' && (!quote.priceMarkIds.length || !quote.quoteDate)) throw new Error('行情快照缺少采用日期或引用');
}

function nonnegative(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  const d = D(value);
  if (!d.isFinite() || d.lt(0)) throw new Error(`${label}必须是有限的非负数`);
}

function status(known: number, unknown: number): AssetCostStatus {
  return unknown === 0 ? 'known' : known === 0 ? 'unknown' : 'partial';
}

/** Pure, deterministic cost replay. Does not mutate inputs or read live market prices. */
export function replayAssetCosts(events: readonly AssetCostEvent[], baseCurrencyAssetId: string, history?: AssetCostRefundHistory): AssetCostReplay {
  const result: AssetCostReplay = { lots: [], consumptions: [], gaps: [], events: [], positions: [] };
  const prior = history?.baseCurrencyAssetId === baseCurrencyAssetId ? history : undefined;
  const refunded = new Map<string, string>(prior?.refunded);
  const refundedCost = new Map<string, string>(prior?.refundedCost);
  const refundedProceeds = new Map<string, string>(prior?.refundedProceeds);
  const ids = new Set<string>();
  const ordered = [...events].sort((a, b) => Date.parse(a.occurredAtUtc) - Date.parse(b.occurredAtUtc)
    || a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id));
  for (const event of ordered) {
    if (!event.id || ids.has(event.id)) throw new Error('成本事件 ID 缺失或重复');
    ids.add(event.id);
    if (!event.assetId || !Number.isFinite(Date.parse(event.occurredAtUtc))) throw new Error('成本事件缺少资产或准确时间');
    if (event.acquiredAtUtc && !Number.isFinite(Date.parse(event.acquiredAtUtc))) throw new Error('批次取得时间无效');
    nonnegative(event.quantity, '成本事件数量');
    if (event.valueInBase !== null) nonnegative(event.valueInBase, '成本事件价值');
    if (D(event.quantity).isZero()) continue;
    if (event.kind === 'acquire') acquire(event, event.quantity, event.valueInBase, '0');
    else if (event.kind === 'refund') refund(event);
    else if (event.kind === 'dispose') dispose(event);
    else throw new Error('成本事件类型无效');
  }
  const assets = [...new Set(ordered.map((event) => event.assetId))].sort();
  result.positions = assets.map((assetId) => {
    const lots = result.lots.filter((lot) => lot.assetId === assetId && D(lot.remainingQuantity).gt(0));
    const deficit = sum(result.gaps.filter((gap) => gap.assetId === assetId && gap.reason === 'missing_quantity').map((gap) => gap.outstandingQuantity));
    const unknown = sum(lots.filter((lot) => lot.remainingCostInBase === null).map((lot) => lot.remainingQuantity));
    const knownCost = sum(lots.map((lot) => lot.remainingCostInBase ?? '0'));
    const costStatus = status(lots.filter((lot) => lot.remainingCostInBase !== null).length, Number(unknown.gt(0)) + Number(deficit.gt(0)));
    return { assetId, quantity: sum(lots.map((lot) => lot.remainingQuantity)).minus(deficit).toString(),
      costStatus, costInBase: costStatus === 'known' ? knownCost.toString() : null,
      knownCostInBase: knownCost.toString(), unknownQuantity: unknown.toString(), deficitQuantity: deficit.toString() };
  });
  result.refundHistory = { baseCurrencyAssetId, consumptions: [...(prior?.consumptions ?? []), ...result.consumptions],
    lots: [...(prior?.lots ?? []), ...result.lots], refunded: [...refunded], refundedCost: [...refundedCost], refundedProceeds: [...refundedProceeds] };
  return result;

  function acquire(event: AssetCostEvent, quantity: string, cost: string | null, suffix: string): void {
    if (D(quantity).isZero()) return;
    const value = event.assetId === baseCurrencyAssetId ? quantity : cost;
    const lot: AssetCostLot = {
      id: `${event.id}:lot:${suffix}`, assetId: event.assetId, sourceEventId: event.id,
      acquiredAtUtc: event.acquiredAtUtc ?? event.occurredAtUtc,
      originalQuantity: quantity, originalCostInBase: value, remainingQuantity: quantity, remainingCostInBase: value,
    };
    result.lots.push(lot);
    for (const gap of result.gaps.filter((gap) => gap.assetId === event.assetId && gap.reason === 'missing_quantity' && D(gap.outstandingQuantity).gt(0))) {
      if (D(lot.remainingQuantity).isZero()) break;
      const take = D(lot.remainingQuantity).lte(gap.outstandingQuantity) ? D(lot.remainingQuantity) : D(gap.outstandingQuantity);
      const takenCost = consume(lot, take.toString());
      gap.outstandingQuantity = D(gap.outstandingQuantity).minus(take).toString();
      result.consumptions.push({ id: `${event.id}:settle:${gap.id}:${suffix}`, eventId: event.id, sourceId: event.sourceId,
        assetId: event.assetId, lotId: lot.id, quantity: take.toString(), costInBase: takenCost,
        proceedsInBase: null, realizedGainLoss: null, reason: 'deficit_settlement' });
    }
    if (value === null) result.gaps.push({ id: `${lot.id}:unknown`, eventId: event.id, assetId: event.assetId,
      quantity, outstandingQuantity: '0', reason: 'unknown_cost' });
    result.events.push({ eventId: event.id, occurredAtUtc: event.occurredAtUtc, sourceId: event.sourceId, assetId: event.assetId, kind: event.kind, realize: false, costStatus: value === null ? 'unknown' : 'known',
      costInBase: value, knownCostInBase: value ?? '0', realizedGainLoss: null, knownRealizedGainLoss: '0' });
  }

  function consume(lot: AssetCostLot, quantity: string): string | null {
    const value = lot.remainingCostInBase === null ? null : D(quantity).eq(lot.remainingQuantity)
      ? D(lot.remainingCostInBase) : D(lot.remainingCostInBase).times(quantity).div(lot.remainingQuantity);
    lot.remainingQuantity = D(lot.remainingQuantity).minus(quantity).toString();
    if (value !== null) lot.remainingCostInBase = D(lot.remainingCostInBase).minus(value).toString();
    return value?.toString() ?? null;
  }

  function dispose(event: AssetCostEvent): void {
    const method = event.method ?? 'fifo';
    if (!['fifo', 'lifo', 'average', 'manual'].includes(method)) throw new Error('成本匹配方式无效');
    const ranks = new Map((event.selectedLotIds ?? []).map((id, index) => [id, index]));
    let lots = result.lots.filter((lot) => lot.assetId === event.assetId && D(lot.remainingQuantity).gt(0));
    lots.sort((a, b) => Date.parse(a.acquiredAtUtc) - Date.parse(b.acquiredAtUtc) || a.id.localeCompare(b.id));
    if (method === 'lifo') lots.reverse();
    if (method === 'manual') lots = lots.filter((lot) => ranks.has(lot.id)).sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
    const available = sum(lots.map((lot) => lot.remainingQuantity));
    const matched = available.lte(event.quantity) ? available : D(event.quantity);
    let remaining = D(event.quantity);
    let matchedRemaining = matched;
    const rows: AssetCostConsumption[] = [];
    for (let i = 0; i < lots.length && matchedRemaining.gt(0); i++) {
      const lot = lots[i]!;
      const take = method === 'average'
        ? i === lots.length - 1 ? matchedRemaining : matched.times(lot.remainingQuantity).div(available)
        : D(lot.remainingQuantity).lte(matchedRemaining) ? D(lot.remainingQuantity) : matchedRemaining;
      const cost = consume(lot, take.toString());
      rows.push({ id: `${event.id}:consume:${lot.id}`, eventId: event.id, sourceId: event.sourceId,
        assetId: event.assetId, lotId: lot.id, quantity: take.toString(), costInBase: cost,
        proceedsInBase: null, realizedGainLoss: null, reason: event.realize ? 'disposal' : 'adjustment' });
      matchedRemaining = matchedRemaining.minus(take);
      remaining = remaining.minus(take);
    }
    if (remaining.gt(0)) {
      rows.push({ id: `${event.id}:missing`, eventId: event.id, sourceId: event.sourceId, assetId: event.assetId,
        lotId: null, quantity: remaining.toString(), costInBase: event.assetId === baseCurrencyAssetId ? remaining.toString() : null,
        proceedsInBase: null, realizedGainLoss: null, reason: event.realize ? 'disposal' : 'adjustment' });
      result.gaps.push({ id: `${event.id}:missing`, eventId: event.id, assetId: event.assetId,
        quantity: remaining.toString(), outstandingQuantity: remaining.toString(), reason: 'missing_quantity' });
    }
    let allocated = D(0);
    const value = event.assetId === baseCurrencyAssetId ? event.quantity : event.valueInBase;
    rows.forEach((row, index) => {
      if (value !== null) {
        const share = index === rows.length - 1 ? D(value).minus(allocated) : D(value).times(row.quantity).div(event.quantity);
        row.proceedsInBase = share.toString();
        allocated = allocated.plus(share);
        if (event.realize && row.costInBase !== null) row.realizedGainLoss = share.minus(row.costInBase).toString();
      }
    });
    if (value === null && event.realize) result.gaps.push({ id: `${event.id}:value`, eventId: event.id,
      assetId: event.assetId, quantity: event.quantity, outstandingQuantity: '0', reason: 'unknown_value' });
    result.consumptions.push(...rows);
    const knownCost = sum(rows.map((row) => row.costInBase ?? '0'));
    const knownPnl = sum(rows.map((row) => row.realizedGainLoss ?? '0'));
    const costStatus = status(rows.filter((row) => row.costInBase !== null).length, rows.filter((row) => row.costInBase === null).length);
    result.events.push({ eventId: event.id, occurredAtUtc: event.occurredAtUtc, sourceId: event.sourceId, assetId: event.assetId, kind: event.kind, realize: event.realize, costStatus,
      costInBase: costStatus === 'known' ? knownCost.toString() : null, knownCostInBase: knownCost.toString(),
      realizedGainLoss: event.realize && costStatus === 'known' && value !== null ? knownPnl.toString() : null,
      knownRealizedGainLoss: knownPnl.toString() });
  }

  function refund(event: AssetCostEvent): void {
    const original = [...(prior?.consumptions ?? []), ...result.consumptions].filter((row) => row.sourceId === event.refundSourceId && row.assetId === event.assetId && row.reason === 'disposal');
    const refundable = original.map((row) => ({ row, quantity: D(row.quantity).minus(refunded.get(row.id) ?? '0') }))
      .filter((item) => item.quantity.gt(0));
    const available = sum(refundable.map((item) => item.quantity));
    const matched = available.lte(event.quantity) ? available : D(event.quantity);
    let rest = matched;
    const resultStart = result.events.length;
    let knownPnl = D(0);
    let unknownPnl = D(event.quantity).gt(matched);
    refundable.forEach(({ row, quantity }, index) => {
      if (quantity.lte(0) || rest.lte(0)) return;
      const take = index === refundable.length - 1 ? rest : matched.times(quantity).div(available);
      refunded.set(row.id, D(refunded.get(row.id) ?? '0').plus(take).toString());
      const cost = row.costInBase === null ? null : (take.eq(quantity)
        ? D(row.costInBase).minus(refundedCost.get(row.id) ?? '0') : D(row.costInBase).times(take).div(row.quantity)).toString();
      const proceeds = row.proceedsInBase === null ? null : (take.eq(quantity)
        ? D(row.proceedsInBase).minus(refundedProceeds.get(row.id) ?? '0') : D(row.proceedsInBase).times(take).div(row.quantity)).toString();
      if (cost !== null) refundedCost.set(row.id, D(refundedCost.get(row.id) ?? '0').plus(cost).toString());
      if (proceeds !== null) refundedProceeds.set(row.id, D(refundedProceeds.get(row.id) ?? '0').plus(proceeds).toString());
      if (cost !== null && proceeds !== null) knownPnl = knownPnl.plus(cost).minus(proceeds);
      else unknownPnl = true;
      const originalLot = [...(prior?.lots ?? []), ...result.lots].find((lot) => lot.id === row.lotId);
      acquire({ ...event, acquiredAtUtc: originalLot?.acquiredAtUtc }, take.toString(), cost, row.id);
      rest = rest.minus(take);
    });
    const unknown = D(event.quantity).minus(matched);
    if (unknown.gt(0)) acquire(event, unknown.toString(), null, 'unmatched');
    const parts = result.events.splice(resultStart);
    const knownCost = sum(parts.map((part) => part.knownCostInBase)).toString();
    const costStatus = status(parts.filter((part) => part.costStatus === 'known').length,
      parts.filter((part) => part.costStatus !== 'known').length);
    result.events.push({ eventId: event.id, occurredAtUtc: event.occurredAtUtc, sourceId: event.sourceId, assetId: event.assetId, kind: event.kind, realize: true, costStatus,
      costInBase: costStatus === 'known' ? knownCost : null, knownCostInBase: knownCost,
      realizedGainLoss: unknownPnl ? null : knownPnl.toString(), knownRealizedGainLoss: knownPnl.toString() });
  }
}
