import Decimal from 'decimal.js';

// High precision for financial math: up to 30 integer + 10 fractional digits per
// the plan's DECIMAL(30,10), plus headroom for intermediate rate multiplications.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

/** Anything that can be coerced to a Decimal. Amounts are stored as strings. */
export type Numeric = string | number | Decimal;

/** Coerce to Decimal. Nullish / empty string => 0. */
export function D(v: Numeric | null | undefined = 0): Decimal {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return v instanceof Decimal ? v : new Decimal(v);
}

/** Sum a list of numerics. */
export function sum(vals: Iterable<Numeric>): Decimal {
  let acc = new Decimal(0);
  for (const v of vals) acc = acc.plus(D(v));
  return acc;
}

/** Round to a given number of decimal places (half-up), return string. */
export function round(v: Numeric, decimals: number): string {
  return D(v).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
}

/** Round to a decimal places, return a Decimal. */
export function roundD(v: Numeric, decimals: number): Decimal {
  return D(v).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
}

/** Safe divide: returns 0 when the divisor is 0 (used for per-day / per-hour). */
export function safeDiv(numerator: Numeric, divisor: Numeric): Decimal {
  const d = D(divisor);
  if (d.isZero()) return new Decimal(0);
  return D(numerator).div(d);
}

export function isZero(v: Numeric): boolean {
  return D(v).isZero();
}

export function eq(a: Numeric, b: Numeric): boolean {
  return D(a).eq(D(b));
}
