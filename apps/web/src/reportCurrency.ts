import { D, latestPrices, type Decimal, type Numeric } from '@zichan/core';
import type { Snapshot } from './db/snapshot.js';
import { baseAsset } from './db/derive.js';
import { amount as formatAmount, money, num, signedMoney } from './format.js';

export interface ReportCurrency {
  assetId: string;
  code: string;
  symbol: string;
  decimals: number;
  missingAssetIds: Set<string>;
  missingItems: MissingRateItem[];
  convert: (value: Numeric, sourceAssetId: string) => ReportConversionResult;
  convertAt: (value: Numeric, sourceAssetId: string, date: string) => ReportConversionResult;
  toReport: (value: Numeric, sourceAssetId: string) => Decimal | undefined;
  toReportAt: (value: Numeric, sourceAssetId: string, date: string) => Decimal | undefined;
  formatReport: (value: Numeric) => string;
  formatSignedReport: (value: Numeric) => string;
  formatNative: (value: Numeric, sourceAssetId: string) => string;
  missingCodes: () => string[];
}

export interface MissingRateItem {
  sourceAssetId: string;
  date?: string;
  originalAmount: string;
}

export type ReportConversionResult =
  | { status: 'valued'; amount: Decimal }
  | { status: 'missing_rate'; item: MissingRateItem };

/** Convert record-native amounts into the global report currency without hiding missing rates. */
export function createReportCurrency(snap: Snapshot, asOf?: string): ReportCurrency {
  const reportAsset = baseAsset(snap);
  const assetId = reportAsset?.id ?? snap.setting?.baseCurrencyAssetId ?? '';
  const code = reportAsset?.code ?? 'BASE';
  const symbol = reportAsset?.symbol ?? `${code} `;
  const decimals = reportAsset?.decimals ?? 2;
  const missingAssetIds = new Set<string>();
  const missingItems: MissingRateItem[] = [];
  const missingKeys = new Set<string>();
  const priceCache = new Map<string, Map<string, string>>();
  const pricesFor = (date?: string) => {
    const key = date ?? '__latest__';
    const cached = priceCache.get(key);
    if (cached) return cached;
    const next = assetId ? latestPrices(snap.priceMarks, assetId, date) : new Map<string, string>();
    priceCache.set(key, next);
    return next;
  };
  const prices = pricesFor(asOf);

  const convertWith = (value: Numeric, sourceAssetId: string, date?: string): ReportConversionResult => {
    const amount = D(value);
    if (amount.isZero()) return { status: 'valued', amount: D(0) };
    const rate = (date ? pricesFor(date) : prices).get(sourceAssetId);
    if (!rate) {
      missingAssetIds.add(sourceAssetId);
      const item = { sourceAssetId, date, originalAmount: amount.toString() };
      const key = `${sourceAssetId}\0${date ?? ''}\0${item.originalAmount}`;
      if (!missingKeys.has(key)) {
        missingKeys.add(key);
        missingItems.push(item);
      }
      return { status: 'missing_rate', item };
    }
    return { status: 'valued', amount: amount.times(rate) };
  };

  const convert = (value: Numeric, sourceAssetId: string): ReportConversionResult => convertWith(value, sourceAssetId);
  const convertAt = (value: Numeric, sourceAssetId: string, date: string): ReportConversionResult => convertWith(value, sourceAssetId, date);

  const toReport = (value: Numeric, sourceAssetId: string): Decimal | undefined => {
    const result = convert(value, sourceAssetId);
    return result.status === 'valued' ? result.amount : undefined;
  };

  const toReportAt = (value: Numeric, sourceAssetId: string, date: string): Decimal | undefined => {
    const result = convertAt(value, sourceAssetId, date);
    return result.status === 'valued' ? result.amount : undefined;
  };

  const formatNative = (value: Numeric, sourceAssetId: string): string => {
    const asset = snap.assets.find((row) => row.id === sourceAssetId);
    if (!asset) return `${num(value)} ${sourceAssetId.slice(0, 8)}`;
    if (asset.symbol) return money(value, asset.symbol, asset.decimals);
    return `${formatAmount(value, asset.decimals)} ${asset.code}`;
  };

  return {
    assetId,
    code,
    symbol,
    decimals,
    missingAssetIds,
    missingItems,
    convert,
    convertAt,
    toReport,
    toReportAt,
    formatReport: (value) => money(value, symbol, decimals),
    formatSignedReport: (value) => signedMoney(value, symbol, decimals),
    formatNative,
    missingCodes: () => [...missingAssetIds]
      .map((id) => snap.assets.find((asset) => asset.id === id)?.code ?? id.slice(0, 8))
      .sort((a, b) => a.localeCompare(b)),
  };
}
