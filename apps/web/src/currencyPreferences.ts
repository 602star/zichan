import type { Setting } from '@zichan/core';

export type CurrencyModule = 'transaction' | 'investment' | 'fixed' | 'game';

const FIELD_BY_MODULE: Record<CurrencyModule, keyof Setting> = {
  transaction: 'transactionDefaultAssetId',
  investment: 'investmentCostAssetId',
  fixed: 'fixedAssetDefaultCurrencyAssetId',
  game: 'gameDefaultSettlementAssetId',
};

export function moduleCurrencyId(
  setting: Setting | undefined,
  module: CurrencyModule,
  fallback = '',
): string {
  const field = FIELD_BY_MODULE[module];
  const preferred = setting?.[field];
  return typeof preferred === 'string' && preferred ? preferred : setting?.baseCurrencyAssetId || fallback;
}

export function moduleCurrencyPatch(module: CurrencyModule, assetId: string): Partial<Setting> {
  return { [FIELD_BY_MODULE[module]]: assetId || undefined } as Partial<Setting>;
}
