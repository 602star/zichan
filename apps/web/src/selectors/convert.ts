/** Convert view-model — grouped by asset, each group foldable (unit-tested). */
import {
  D, isLotTrackedAssetType, traceChain, conversionStepAmounts, remainingHoldings,
  type ChainWithSteps, type ConversionChain,
} from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import { assetById, priceInBase } from '../db/derive.js';
import { money, signedMoney, amount as fmtAmount } from '../format.js';

export interface ConvertStepVM { n: number; from: string; to: string; rate: string; fee: string }
export interface ConvertCalcRow { l: string; v: string; strong?: boolean; color?: string }
export interface ConvertChainVM {
  chain: ConversionChain;
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
  hasPosition: boolean;
  holdings: string;
  value: string;
  avgCost: string;
  price: string;
  pnl: number;
  pnlPct: number;
  costBasisKnown: boolean;
  chains: ConvertChainVM[];
}
export interface ConvertVM {
  groups: ConvertGroup[];
}

function chainVM(snap: Snapshot, cws: ChainWithSteps): ConvertChainVM {
  const byId = assetById(snap);
  const code = (id: string) => byId.get(id)?.code ?? '?';
  const dec = (id: string) => byId.get(id)?.decimals ?? 2;
  const fmt = (id: string, v: string) => {
    const a = byId.get(id);
    if (a?.type === 'fiat') return money(v, a.symbol ?? `${a.code} `, a.decimals);
    return `${fmtAmount(v, dec(id))} ${code(id)}`;
  };
  const t = traceChain(cws);
  const c = cws;
  const bookAsset = byId.get(c.chain.baseCurrencyAssetId);
  const bookSymbol = bookAsset?.symbol ?? (bookAsset?.code ? `${bookAsset.code} ` : '');
  const bookMoney = (value: string) => money(value, bookSymbol, bookAsset?.decimals ?? 2);
  const pnl = D(c.chain.realizedGainLoss ?? '0');
  const pnlColor = pnl.isNegative() ? 'var(--negative)' : 'var(--positive)';
  const chips = c.steps.length ? [code(c.steps[0]!.fromAssetId), ...c.steps.map((s) => code(s.toAssetId))] : [];
  const isSell = c.chain.type === 'sell';
  const result = isSell
    ? `到账 ${bookMoney(t.totalBaseProceeds)}`
    : c.chain.type === 'exchange' || c.chain.type === 'deposit'
      ? `到账 ${fmt(t.finalAssetId, t.finalAmount)}`
      : `获得 ${fmt(t.finalAssetId, t.finalAmount)}`;
  const calc: ConvertCalcRow[] = isSell
    ? [
        { l: '最终到账法币', v: bookMoney(t.totalBaseProceeds), strong: true },
        { l: '总手续费', v: bookMoney(t.totalFeesInBase) },
        { l: '实现盈亏', v: signedMoney(pnl, bookSymbol), color: pnlColor, strong: true },
      ]
    : [
        { l: '实际总成本', v: bookMoney(t.totalBaseCost), strong: true },
        ...(t.nativeCostAssetId && t.nativeCostAmount ? [{ l: '原始账户实扣', v: fmt(t.nativeCostAssetId, t.nativeCostAmount) }] : []),
        { l: '总手续费', v: bookMoney(t.totalFeesInBase) },
        { l: '获得数量', v: fmt(t.finalAssetId, t.finalAmount) },
        ...(t.unitCost ? [{ l: '实际单位成本', v: `${bookMoney(t.unitCost)} / ${code(t.finalAssetId)}`, color: 'var(--accent)', strong: true }] : []),
      ];
  return {
    chain: c.chain,
    chips,
    steps: c.steps.map((s) => {
      const amounts = conversionStepAmounts(s);
      const rate = `成交 ${amounts.tradeRate ?? '—'} · 有效 ${amounts.effectiveRate ?? '—'}`
        + (s.referenceRate ? ` · 参考 ${s.referenceRate}` : '');
      const fees = (s.fees ?? []).map((fee) => fmt(fee.assetId, fee.amount)).join(' + ');
      return {
        n: s.order,
        from: fmt(s.fromAssetId, amounts.sourceDebit),
        to: fmt(s.toAssetId, amounts.targetCredit),
        rate,
        fee: fees ? `手续费 ${fees}` : '',
      };
    }),
    calc,
    result,
    deltaLabel: isSell ? '实现盈亏' : c.chain.type === 'deposit' ? '到账' : '本次投入',
    delta: isSell ? signedMoney(c.chain.realizedGainLoss ?? '0', bookSymbol) : bookMoney(isSell ? t.totalBaseProceeds : c.chain.type === 'deposit' ? t.finalAmount : t.totalBaseCost),
    deltaColor: isSell ? pnlColor : 'var(--fg)',
  };
}

/** The asset a chain "belongs to": what you sold, else what you acquired. */
function mainAssetId(c: ChainWithSteps): string {
  if (c.chain.type === 'sell') return c.steps[0]?.fromAssetId ?? '';
  return c.chain.finalAssetId ?? c.steps[c.steps.length - 1]?.toAssetId ?? '';
}

export function buildConvert(snap: Snapshot): ConvertVM {
  const byId = assetById(snap);
  const byAsset = new Map<string, ConvertChainVM[]>();
  for (const c of snap.chains.filter((row) => row.chain.recordState !== 'voided')) {
    const aid = mainAssetId(c);
    const arr = byAsset.get(aid) ?? [];
    arr.push(chainVM(snap, c));
    byAsset.set(aid, arr);
  }

  const groups: ConvertGroup[] = [...byAsset.entries()].map(([aid, chains]) => {
    const a = byId.get(aid);
    const hasPosition = a ? isLotTrackedAssetType(a.type) : false;
    const holdings = hasPosition ? remainingHoldings(snap.lots, aid) : '0';
    const cost = hasPosition ? costBasisInReportCurrency(snap, aid) : { value: '0', known: true };
    const costBasis = cost.value;
    const price = (hasPosition && priceInBase(snap, aid)) || '0';
    const value = D(holdings).times(D(price));
    const pnl = value.minus(D(costBasis));
    const avgCost = D(holdings).isZero() ? D(0) : D(costBasis).div(D(holdings));
    return {
      assetId: aid,
      assetCode: a?.code ?? '?',
      hasPosition,
      holdings,
      value: value.toString(),
      avgCost: avgCost.toString(),
      price,
      pnl: pnl.toNumber(),
      pnlPct: costBasis && !D(costBasis).isZero() ? pnl.div(D(costBasis)).times(100).toNumber() : 0,
      costBasisKnown: cost.known,
      chains: chains.sort((x, y) => y.chain.date.localeCompare(x.chain.date)),
    };
  });

  // Position-bearing assets first (by value desc), then pure transfer groups.
  groups.sort((a, b) => Number(b.hasPosition) - Number(a.hasPosition) || Number(b.value) - Number(a.value));
  return { groups };
}

function costBasisInReportCurrency(snap: Snapshot, assetId: string): { value: string; known: boolean } {
  let total = D(0);
  let known = true;
  for (const lot of snap.lots.filter((row) => row.assetId === assetId && !row.isDeleted && D(row.remainingAmount).gt(0))) {
    const rate = priceInBase(snap, lot.baseCurrencyAssetId);
    if (!rate) {
      known = false;
      continue;
    }
    if (D(lot.originalAmount).isZero()) continue;
    total = total.plus(D(lot.baseCost).times(D(lot.remainingAmount).div(lot.originalAmount)).times(rate));
  }
  return { value: total.toString(), known };
}
