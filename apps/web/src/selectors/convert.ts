/** Convert view-model — grouped by asset, each group foldable (unit-tested). */
import {
  D, traceChain, conversionStepAmounts, remainingHoldings, usesAssetCostState, assetCostSourceSummary,
  type ChainWithSteps, type ConversionChain, type ConversionStep,
} from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import { assetById, balances, priceInBase } from '../db/derive.js';
import { money, signedMoney, amount as fmtAmount, significant } from '../format.js';

export interface ConvertStepVM { n: number; from: string; to: string; rate: string; fullRate: string; fee: string; accounts: string; details: string[] }
export interface ConvertCalcRow { l: string; v: string; strong?: boolean; color?: string }
export interface ConvertChainVM {
  chain: ConversionChain;
  title: string;
  occurred: string;
  assetIds: string[];
  chips: string[];
  steps: ConvertStepVM[];
  calc: ConvertCalcRow[];
  result: string;
  deltaLabel: string;
  delta: string;
  deltaColor: string;
}
export interface ConvertGroup {
  assetId: string;
  assetCode: string;
  decimals: number;
  hasPosition: boolean;
  holdings: string;
  value: string | null;
  avgCost: string | null;
  costTotal: string | null;
  costCurrencyAssetId: string | null;
  knownPartialCost: string | null;
  missingCostRateAssetId: string | null;
  pnl: string | null;
  pnlPct: string | null;
  costBasisKnown: boolean;
  costStatus: string;
  chains: ConvertChainVM[];
}
export interface ConvertVM {
  groups: ConvertGroup[];
}

export function conversionRateText(step: ConversionStep, from: string, to: string, full = false): string {
  if (step.fromAssetId === step.toAssetId) return '同币种账户转移';
  const amounts = conversionStepAmounts(step);
  const fmt = (value: string | undefined) => value === undefined ? '—' : full ? value : significant(value);
  const same = amounts.tradeRate !== undefined && amounts.effectiveRate !== undefined && D(amounts.tradeRate).eq(amounts.effectiveRate);
  return `${same ? '' : '成交 '}1 ${from} ≈ ${fmt(amounts.tradeRate)} ${to}`
    + (same ? '' : ` · 净到账 1 ${from} ≈ ${fmt(amounts.effectiveRate)} ${to}`)
    + (step.referenceRate ? ` · 参考 1 ${from} ≈ ${fmt(step.referenceRate)} ${to}` : '')
    + ((step.fees ?? []).some((fee) => fee.treatment === 'third_asset_extra') ? '（未含第三资产另付费用）' : '');
}

function chainVM(snap: Snapshot, input: ChainWithSteps, sourceIds = [input.chain.id]): ConvertChainVM {
  const cws = { chain: input.chain, steps: [...input.steps].sort((a, b) => a.order - b.order) };
  const byId = assetById(snap);
  const account = (id?: string) => snap.accounts.find((row) => row.id === id)?.name ?? (id ? '未知账户' : '未指定账户');
  const code = (id: string) => byId.get(id)?.code ?? '?';
  const dec = (id: string) => byId.get(id)?.decimals ?? 2;
  const fmt = (id: string, v: string) => {
    const a = byId.get(id);
    if (a?.type === 'fiat') return money(v, a.symbol ?? `${a.code} `, a.decimals);
    return `${fmtAmount(v, dec(id))} ${code(id)}`;
  };
  const t = traceChain(cws);
  const c = cws;
  const costState = usesAssetCostState(snap.costState, c.chain) ? snap.costState : undefined;
  const costSummary = costState ? assetCostSourceSummary(costState, sourceIds) : undefined;
  const acquiredCost = costState?.events.find((event) => event.eventId === `${c.steps.at(-1)?.id}:2-target`)?.costInBase ?? null;
  const bookAsset = byId.get(c.chain.baseCurrencyAssetId);
  const bookSymbol = bookAsset?.symbol ?? (bookAsset?.code ? `${bookAsset.code} ` : '');
  const bookMoney = (value: string) => money(value, bookSymbol, bookAsset?.decimals ?? 2);
  const pnlValue = costSummary ? costSummary.realizedGainLoss : c.chain.realizedGainLoss ?? null;
  const pnl = pnlValue === null ? null : D(pnlValue);
  const pnlColor = pnl === null ? 'var(--fg-muted)' : pnl.isNegative() ? 'var(--negative)' : 'var(--positive)';
  const chips = c.steps.length ? [code(c.steps[0]!.fromAssetId), ...c.steps.map((s) => code(s.toAssetId))] : [];
  const isSell = c.chain.type === 'sell';
  const isBuy = c.chain.type === 'buy' || c.chain.type === 'dca';
  const paid = t.nativeCostAssetId && t.nativeCostAmount ? fmt(t.nativeCostAssetId, t.nativeCostAmount) : '—';
  const result = `${isBuy ? '获得' : '到账'} ${fmt(t.finalAssetId, t.finalAmount)}`;
  const calc: ConvertCalcRow[] = isSell
    ? [
        { l: '实际到账', v: fmt(t.finalAssetId, t.finalAmount), strong: true },
        { l: '账面收入', v: bookMoney(t.totalBaseProceeds) },
        { l: '总手续费', v: bookMoney(t.totalFeesInBase) },
        { l: '实现盈亏', v: pnl === null ? '未完整核算' : signedMoney(pnl, bookSymbol), color: pnlColor, strong: true },
      ]
    : isBuy ? [
        { l: '实际总成本', v: bookMoney(t.totalBaseCost), strong: true },
        ...(t.nativeCostAssetId && t.nativeCostAmount ? [{ l: '原始账户实扣', v: fmt(t.nativeCostAssetId, t.nativeCostAmount) }] : []),
        { l: '总手续费', v: bookMoney(t.totalFeesInBase) },
        { l: '获得数量', v: fmt(t.finalAssetId, t.finalAmount) },
        ...(t.unitCost ? [{ l: '实际单位成本', v: `${bookSymbol}${significant(t.unitCost)} / ${code(t.finalAssetId)}`, color: 'var(--accent)', strong: true }] : []),
      ] : [
        { l: '实际付出', v: paid },
        { l: '实际到账', v: fmt(t.finalAssetId, t.finalAmount), strong: true },
        { l: '手续费折算合计', v: bookMoney(t.totalFeesInBase) },
      ];
  if (isBuy || isSell || c.chain.bookValueInBase) calc.push({ l: '折算依据', v: c.chain.bookValueInBase ? `手动填写 ${bookMoney(c.chain.bookValueInBase)}` : `链路实际 ${code(c.chain.baseCurrencyAssetId)} 净收付及手续费` });
  if (isSell) {
    const methods = { fifo: 'FIFO · 先进先出', lifo: 'LIFO · 后进先出', average: '平均成本', manual: '手动选择批次' };
    calc.push({ l: '成本匹配', v: methods[c.chain.lotMethod ?? 'fifo'] });
    for (const row of snap.lotConsumptions.filter((row) => !row.isDeleted && row.sellChainId === c.chain.id)) {
      const lot = snap.lots.find((lot) => lot.id === row.lotId);
      calc.push({ l: `批次 ${lot?.acquiredDate ?? row.lotId}`, v: `${fmt(c.steps[0]!.fromAssetId, row.consumedAmount)} · 成本 ${bookMoney(row.allocatedCostBase)}` });
    }
  }
  if (costState && costSummary) {
    calc.splice(0, calc.length,
      { l: '成本核算币种', v: bookAsset?.code ?? costState.baseCurrencyAssetId },
      { l: '实际付出', v: paid },
      { l: '实际到账', v: fmt(t.finalAssetId, t.finalAmount), strong: true },
      { l: '到账资产新成本', v: acquiredCost === null ? '成本未知' : bookMoney(acquiredCost) },
      { l: '实现盈亏（含费用资产）', v: pnl === null ? `未完整核算 · 已知部分 ${signedMoney(costSummary.knownRealizedGainLoss, bookSymbol)}` : signedMoney(pnl, bookSymbol), color: pnlColor, strong: true });
    for (const row of costState.consumptions.filter((row) => sourceIds.includes(row.sourceId) && row.reason !== 'deficit_settlement')) {
      calc.push({ l: row.lotId ? '消耗成本批次' : '成本数量缺口', v: `${fmt(row.assetId, row.quantity)} · ${row.costInBase === null ? '成本未知' : bookMoney(row.costInBase)}` });
    }
    for (const row of costState.events.filter((row) => sourceIds.includes(row.sourceId) && row.eventId.includes(':1-fee:'))) {
      calc.push({ l: '第三资产手续费处置盈亏', v: `${snap.assets.find((asset) => asset.id === row.assetId)?.code ?? row.assetId} · ${row.realizedGainLoss === null ? '未完整核算' : signedMoney(row.realizedGainLoss, bookSymbol)}` });
    }
    for (const quote of c.chain.costQuotes ?? []) {
      calc.push({ l: '冻结价值依据', v: `${quote.source === 'manual' ? '手动确认' : quote.source === 'transaction' ? '实际成交' : quote.source === 'price_mark' ? `行情 ${quote.quoteDate ?? ''}` : '价值未知'}${quote.valueInBase === null ? '' : ` · ${bookMoney(quote.valueInBase)}`}` });
      for (const fee of quote.feeValues) if (fee.evidence) calc.push({ l: '手续费折算依据', v: `${fee.evidence.explanation ?? fee.evidence.source}${fee.evidence.quoteDate ? ` · ${fee.evidence.quoteDate}` : ''}${fee.valueInBase === null ? ' · 价值未知' : ` · ${bookMoney(fee.valueInBase)}`}` });
    }
  } else if (snap.costState) calc.push({ l: '核算边界', v: '成本起点之前，保留原有统计口径' });
  const execution = snap.dcaExecutions.find((row) => !row.isDeleted && sourceIds.includes(row.chainId ?? ''));
  if (execution) calc.push({ l: '定投计划', v: snap.dcaPlans.find((row) => row.id === execution.planId)?.name ?? '已移除计划' });
  return {
    chain: c.chain,
    title: c.chain.title?.trim() || chips.join(' → '),
    occurred: `${c.chain.date}${c.chain.time ? ` ${c.chain.time}` : ' · 时间未记录'}${c.chain.timezone ? ` · ${c.chain.timezone}` : ''}`,
    assetIds: [...new Set(c.steps.flatMap((s) => [s.fromAssetId, s.toAssetId, ...(s.fees ?? []).map((fee) => fee.assetId)]))],
    chips,
    steps: c.steps.map((s) => {
      const amounts = conversionStepAmounts(s);
      const rate = conversionRateText(s, code(s.fromAssetId), code(s.toAssetId));
      const treatment = { source_extra: '来源另付', source_included: '来源实扣内含', target_deducted: '目标扣除', third_asset_extra: '第三资产另付' };
      const fees = (s.fees ?? []).map((fee) => `${treatment[fee.treatment]} ${fmt(fee.assetId, fee.amount)} · 折算 ${fee.assetId === c.chain.baseCurrencyAssetId ? bookMoney(fee.amount) : fee.valueInBase ? bookMoney(fee.valueInBase) : '未记录'} · ${account(fee.accountId ?? (fee.assetId === s.fromAssetId ? s.accountFromId : fee.assetId === s.toAssetId ? s.accountToId : undefined))}${fee.note ? ` · ${fee.note}` : ''}`).join('；');
      return {
        n: s.order,
        from: fmt(s.fromAssetId, amounts.sourceDebit),
        to: fmt(s.toAssetId, amounts.targetCredit),
        rate,
        fullRate: conversionRateText(s, code(s.fromAssetId), code(s.toAssetId), true),
        accounts: `${account(s.accountFromId)} → ${account(s.accountToId)}`,
        details: [`成交本金 ${fmt(s.fromAssetId, amounts.sourcePrincipal)} · 成交毛额 ${fmt(s.toAssetId, amounts.targetGross)}`, ...(s.platform ? [`平台：${s.platform}`] : []), ...(s.note ? [`备注：${s.note}`] : [])],
        fee: fees ? `手续费 ${fees}` : '',
      };
    }),
    calc,
    result,
    deltaLabel: isSell ? '实现盈亏' : isBuy ? '本次投入' : '实际付出',
    delta: isSell ? pnl === null ? '未完整核算' : signedMoney(pnl, bookSymbol)
      : isBuy ? costState ? acquiredCost === null ? '成本未知' : bookMoney(acquiredCost) : bookMoney(t.totalBaseCost) : paid,
    deltaColor: isSell ? pnlColor : 'var(--fg)',
  };
}

/** The asset a chain "belongs to": what you sold, else what you acquired. */
function mainAssetId(c: ChainWithSteps): string {
  const steps = [...c.steps].sort((a, b) => a.order - b.order);
  if (c.chain.type === 'sell') return steps[0]?.fromAssetId ?? '';
  return steps.at(-1)?.toAssetId ?? '';
}

export function buildConvert(snap: Snapshot): ConvertVM {
  const byId = assetById(snap);
  const currentBalances = new Map(balances(snap).map((row) => [row.assetId, row.amount]));
  const byAsset = new Map<string, ConvertChainVM[]>();
  const active = snap.chains.filter((row) => !row.chain.isDeleted && row.chain.recordState !== 'voided');
  const seen = new Set<string>();
  for (const original of active) {
    const groupId = original.chain.operationId;
    if (groupId && seen.has(groupId)) continue;
    if (groupId) seen.add(groupId);
    const segments = groupId ? active.filter((row) => row.chain.operationId === groupId).sort((a, b) => (a.chain.operationOrder ?? 0) - (b.chain.operationOrder ?? 0)) : [original];
    const first = segments[0]!;
    const last = segments.at(-1)!;
    const c = segments.length === 1 ? first : { chain: { ...first.chain, type: last.chain.type,
      costQuotes: segments.flatMap((row) => row.chain.costQuotes ?? []) }, steps: segments.flatMap((row) => row.steps).map((step, index) => ({ ...step, order: index + 1 })) };
    const aid = mainAssetId(c);
    const arr = byAsset.get(aid) ?? [];
    arr.push(chainVM(snap, c, segments.map((row) => row.chain.id)));
    byAsset.set(aid, arr);
  }

  for (const [id, quantity] of currentBalances) {
    const asset = byId.get(id);
    if (asset && asset.type !== 'game' && asset.type !== 'fixed' && !D(quantity).isZero() && !byAsset.has(id)) byAsset.set(id, []);
  }
  for (const asset of snap.assets) {
    if (asset.isDeleted || asset.isActive === false || asset.type === 'game' || asset.type === 'fixed') continue;
    if (!byAsset.has(asset.id)) byAsset.set(asset.id, []);
  }
  const groups: ConvertGroup[] = [...byAsset.entries()].map(([aid, chains]) => {
    const a = byId.get(aid);
    const holdings = currentBalances.get(aid) ?? '0';
    const hasPosition = !D(holdings).isZero();
    const position = snap.costState?.positions.find((row) => row.assetId === aid);
    const tracked = snap.costState ? position?.quantity ?? '0' : remainingHoldings(snap.lots, aid);
    const cost = costBasisInReportCurrency(snap, aid);
    const bookAssetId = snap.costState?.baseCurrencyAssetId;
    const bookRate = bookAssetId ? priceInBase(snap, bookAssetId) : undefined;
    const nativeKnown = position?.costStatus === 'known';
    const costBasisKnown = D(holdings).gt(0) && D(tracked).eq(holdings) && cost.hasLots
      && (snap.costState ? nativeKnown : cost.known);
    const costBasis = cost.value;
    const costTotal = costBasisKnown ? (cost.known ? costBasis : position?.costInBase ?? null) : null;
    const costCurrencyAssetId = cost.known ? snap.setting?.baseCurrencyAssetId ?? null : bookAssetId ?? null;
    const price = priceInBase(snap, aid);
    const value = price === undefined ? null : D(holdings).times(price);
    const pnl = costBasisKnown && cost.known && value !== null ? value.minus(costBasis) : null;
    const avgCost = costTotal !== null ? D(costTotal).div(holdings) : null;
    return {
      assetId: aid,
      assetCode: a?.code ?? '?',
      decimals: a?.decimals ?? 8,
      hasPosition,
      holdings,
      value: value?.toString() ?? null,
      avgCost: avgCost?.toString() ?? null,
      costTotal,
      costCurrencyAssetId,
      knownPartialCost: position && position.costStatus !== 'known' && D(position.knownCostInBase).gt(0) ? position.knownCostInBase : null,
      missingCostRateAssetId: snap.costState && nativeKnown && bookRate === undefined ? bookAssetId ?? null : null,
      pnl: pnl?.toString() ?? null,
      pnlPct: pnl !== null && D(costBasis).gt(0) ? pnl.div(costBasis).times(100).toString() : null,
      costBasisKnown,
      costStatus: snap.costState?.invalidAssetIds.includes(aid) ? '成本起点需要重新核对'
        : position?.costStatus !== undefined && position.costStatus !== 'known' ? `${position.costStatus === 'partial' ? '部分成本已知' : '成本未知'} · 未知数量 ${fmtAmount(position.unknownQuantity, a?.decimals ?? 8)} · 数量缺口 ${fmtAmount(position.deficitQuantity, a?.decimals ?? 8)}`
          : snap.costState && nativeKnown && bookRate === undefined ? `成本已知，缺少 ${byId.get(bookAssetId ?? '')?.code ?? '核算币种'} → ${byId.get(snap.setting?.baseCurrencyAssetId ?? '')?.code ?? '报表币种'} 汇率`
          : !cost.hasLots ? '成本未记录' : !D(tracked).eq(holdings) ? '成本批次与余额不一致' : !cost.known ? '缺少成本汇率' : '无持仓成本',
      chains: chains.sort((x, y) => y.chain.date.localeCompare(x.chain.date) || (y.chain.time ?? '').localeCompare(x.chain.time ?? '') || y.chain.id.localeCompare(x.chain.id)),
    };
  });

  // Position-bearing assets first (by value desc), then pure transfer groups.
  groups.sort((a, b) => Number(b.hasPosition) - Number(a.hasPosition) || D(b.value ?? 0).comparedTo(a.value ?? 0) || a.assetCode.localeCompare(b.assetCode));
  return { groups };
}

function costBasisInReportCurrency(snap: Snapshot, assetId: string): { value: string; known: boolean; hasLots: boolean } {
  if (snap.costState) {
    const position = snap.costState.positions.find((row) => row.assetId === assetId);
    const rate = priceInBase(snap, snap.costState.baseCurrencyAssetId);
    return { value: position && rate !== undefined ? D(position.knownCostInBase).times(rate).toString() : '0',
      known: position?.costStatus === 'known' && rate !== undefined, hasLots: !!position && D(position.quantity).gt(0) };
  }
  let total = D(0);
  let known = true;
  const lots = snap.lots.filter((row) => row.assetId === assetId && !row.isDeleted && D(row.remainingAmount).gt(0));
  for (const lot of lots) {
    const rate = priceInBase(snap, lot.baseCurrencyAssetId);
    if (rate === undefined || D(lot.originalAmount).lte(0)) {
      known = false;
      continue;
    }
    if (D(lot.originalAmount).isZero()) continue;
    total = total.plus(D(lot.baseCost).times(D(lot.remainingAmount).div(lot.originalAmount)).times(rate));
  }
  return { value: total.toString(), known, hasLots: lots.length > 0 };
}
