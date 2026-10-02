import { D, conversionStepAmounts, isLotTrackedAssetType, resolveLatestPrices,
  type AssetType, type ConversionStep, type ConversionType, type PriceMark } from '@zichan/core';

export interface AssetConversionAction { type: ConversionType; label: string; source: boolean; requiresCostOpening?: boolean }

/** Keep acquisition/disposal visible for every financial asset; guide old currency ledgers through a cost opening first. */
export function assetConversionActions(assetType: AssetType, unifiedCost: boolean): AssetConversionAction[] {
  const requiresCostOpening = !unifiedCost && !isLotTrackedAssetType(assetType);
  return [
    { type: 'buy', label: '买入', source: false, requiresCostOpening },
    { type: 'sell', label: '卖出', source: true, requiresCostOpening },
    { type: 'deposit', label: '转入', source: false },
    { type: 'withdraw', label: '转出', source: true },
    ...(unifiedCost && isLotTrackedAssetType(assetType) ? [{ type: 'swap' as const, label: '互换', source: true }] : []),
  ];
}

/** Suggest a book value without mutating the entered fee. Prefer this trade's quote. */
export function suggestFeeValue(step: ConversionStep | null, assetId: string, amount: string, baseId: string, marks: PriceMark[], date: string): { value: string; basis: string; priceMarkIds?: string[]; quoteDate?: string } | null {
  if (!amount || !assetId || !baseId) return null;
  try {
    if (!D(amount).gt(0)) return null;
    if (assetId === baseId) return { value: D(amount).toString(), basis: '手续费与记账币种相同' };
    if (step) {
      const { tradeRate } = conversionStepAmounts(step);
      if (tradeRate && D(tradeRate).gt(0)) {
        if (assetId === step.fromAssetId && baseId === step.toAssetId) return { value: D(amount).times(tradeRate).toString(), basis: '按本步骤成交汇率折算' };
        if (assetId === step.toAssetId && baseId === step.fromAssetId) return { value: D(amount).div(tradeRate).toString(), basis: '按本步骤成交汇率折算' };
      }
    }
    const resolved = resolveLatestPrices(marks.filter((mark) => !mark.isDeleted), baseId, { asOf: date }).get(assetId);
    return resolved && D(resolved.priceInBase).gt(0) ? { value: D(amount).times(resolved.priceInBase).toString(),
      basis: `当日或此前行情 · 实际采用 ${resolved.priceMarkIds.map((id) => marks.find((mark) => mark.id === id)?.date ?? '').join(' / ')}`,
      priceMarkIds: resolved.priceMarkIds, quoteDate: resolved.oldestMarkDate } : null;
  } catch { return null; }
}

export function conversionGap(previous: ConversionStep, next: ConversionStep, code: string): string | null {
  if (previous.toAssetId !== next.fromAssetId) return '下一步来源资产应与上一步到账资产一致。';
  const difference = D(conversionStepAmounts(previous).targetCredit).minus(conversionStepAmounts(next).sourceDebit);
  if (difference.isZero()) return null;
  return difference.gt(0)
    ? `上一步到账后剩余 ${difference.toFixed()} ${code}。如需保留余额，请拆成两笔转换记录；否则调整下一步实扣数量。`
    : `下一步还需补入 ${difference.abs().toFixed()} ${code}。请拆成独立转换记录，或调整数量使前后实扣与到账一致。`;
}
