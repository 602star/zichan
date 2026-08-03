import { D, round, type Numeric } from '@zichan/core';

/** Base-currency display symbol, updated when the settlement currency changes. */
const BASE = { symbol: '£' };
export function setBaseSymbol(symbol: string): void {
  BASE.symbol = symbol || '£';
}

/** Format a base-currency amount, e.g. money(1281.07) => "£1,281.07". */
export function money(v: Numeric, symbol = BASE.symbol, decimals = 2): string {
  const n = Number(round(D(v).abs(), decimals));
  const s = n.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${symbol}${s}`;
}

/** Signed base-currency amount with a leading + / − (minus is U+2212). */
export function signedMoney(v: Numeric, symbol = BASE.symbol, decimals = 2): string {
  const d = D(v);
  // decimal.js isPositive() is true for +0, so check zero explicitly.
  const sign = d.isZero() ? '' : d.isPositive() ? '+' : '−';
  return sign + money(d, symbol, decimals);
}

/** Format a plain number with grouping to `decimals` places. */
export function num(v: Numeric, decimals = 2): string {
  return Number(round(v, decimals)).toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format a crypto/asset amount, trimming trailing zeros but keeping precision. */
export function amount(v: Numeric, decimals = 8): string {
  return D(v).toDecimalPlaces(decimals).toString();
}

/** Percent from a 0..1 weight, e.g. pct(0.164) => "16.4%". */
export function pct(weight: Numeric, decimals = 1): string {
  return `${num(D(weight).times(100), decimals)}%`;
}
