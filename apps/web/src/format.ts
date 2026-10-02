import { D, round, type Numeric } from '@zichan/core';

/** Base-currency display symbol, updated when the settlement currency changes. */
const BASE = { symbol: '£' };
export function setBaseSymbol(symbol: string): void {
  BASE.symbol = symbol || '£';
}

/** Group a fixed decimal string without coercing it through a JS number. */
function groupFixedDecimal(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction] = unsigned.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Format a base-currency amount, e.g. money(1281.07) => "£1,281.07". */
export function money(v: Numeric, symbol = BASE.symbol, decimals = 2): string {
  return `${symbol}${groupFixedDecimal(round(D(v).abs(), decimals))}`;
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
  return groupFixedDecimal(round(v, decimals));
}

/** Format a crypto/asset amount, trimming trailing zeros but keeping precision. */
export function amount(v: Numeric, decimals = 8): string {
  return D(v).toDecimalPlaces(decimals).toFixed().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Rates and unit prices need significant digits, including very small values. */
export function significant(v: Numeric, digits = 8): string {
  return groupFixedDecimal(D(v).toSignificantDigits(digits).toFixed());
}

/** Percent from a 0..1 weight, e.g. pct(0.164) => "16.4%". */
export function pct(weight: Numeric, decimals = 1): string {
  return `${num(D(weight).times(100), decimals)}%`;
}
