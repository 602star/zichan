/**
 * Date helpers. Dates are `YYYY-MM-DD` local calendar days (§0.6). Day counting
 * is done on UTC-midnight anchors to avoid DST drift, but the *input* is treated
 * as a plain calendar day, not a timestamp.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateRange {
  from?: string;
  to?: string;
}

export type DateRangePreset =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'last_3_months'
  | 'this_year'
  | 'all'
  | 'custom';

/** Parse `YYYY-MM-DD` to a UTC-midnight epoch. Throws on malformed input. */
export function parseDay(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`invalid date: ${day}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const date = Number(m[3]);
  const value = Date.UTC(year, month - 1, date);
  const parsed = new Date(value);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date) {
    throw new Error(`invalid date: ${day}`);
  }
  return value;
}

export function isValidDay(day: string): boolean {
  try {
    parseDay(day);
    return true;
  } catch {
    return false;
  }
}

function formatUtcDay(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function addDays(day: string, amount: number): string {
  return formatUtcDay(parseDay(day) + amount * DAY_MS);
}

export function addMonths(day: string, amount: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m || !isValidDay(day)) throw new Error(`invalid date: ${day}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const date = Number(m[3]);
  const targetStart = new Date(Date.UTC(year, month - 1 + amount, 1));
  const lastDate = new Date(Date.UTC(targetStart.getUTCFullYear(), targetStart.getUTCMonth() + 1, 0)).getUTCDate();
  return formatUtcDay(Date.UTC(targetStart.getUTCFullYear(), targetStart.getUTCMonth(), Math.min(date, lastDate)));
}

export function startOfMonth(day: string): string {
  parseDay(day);
  return `${day.slice(0, 7)}-01`;
}

export function endOfMonth(day: string): string {
  return addDays(addMonths(startOfMonth(day), 1), -1);
}

export function startOfYear(day: string): string {
  parseDay(day);
  return `${day.slice(0, 4)}-01-01`;
}

export function endOfYear(day: string): string {
  parseDay(day);
  return `${day.slice(0, 4)}-12-31`;
}

export function startOfWeek(day: string): string {
  const weekday = new Date(parseDay(day)).getUTCDay();
  return addDays(day, -(weekday === 0 ? 6 : weekday - 1));
}

/**
 * Calendar days between two `YYYY-MM-DD` days (b − a). Same day => 0.
 * Used as the *exclusive* count; add 1 for inclusive spans (see seasonDays /
 * heldDays which apply "含头不含尾" per §0.6).
 */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

/** Days an asset has been held: from purchase to `asOf` (or sale), min 1. */
export function heldDays(purchaseDate: string, endDate: string): number {
  return Math.max(1, daysBetween(purchaseDate, endDate) + 1);
}

/** Today as `YYYY-MM-DD` (UTC). */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Today in the machine's local calendar, without UTC date shifting. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Inclusive business-date range for a common preset. */
export function dateRangeForPreset(preset: DateRangePreset, anchor = localToday()): DateRange {
  parseDay(anchor);
  if (preset === 'all' || preset === 'custom') return {};
  if (preset === 'today') return { from: anchor, to: anchor };
  if (preset === 'this_week') return { from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 6) };
  if (preset === 'this_month') return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
  if (preset === 'last_month') {
    const previous = addMonths(startOfMonth(anchor), -1);
    return { from: startOfMonth(previous), to: endOfMonth(previous) };
  }
  if (preset === 'last_3_months') {
    const first = addMonths(startOfMonth(anchor), -2);
    return { from: first, to: endOfMonth(anchor) };
  }
  return { from: startOfYear(anchor), to: endOfYear(anchor) };
}

export function isDateInRange(day: string, range: DateRange): boolean {
  if (!isValidDay(day)) return false;
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}

export function isDateRangeValid(range: DateRange): boolean {
  if (range.from && !isValidDay(range.from)) return false;
  if (range.to && !isValidDay(range.to)) return false;
  return !(range.from && range.to && range.from > range.to);
}
