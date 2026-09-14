/**
 * The ledger cut-off day (the "as-of date").
 *
 * Reports, valuation, holding-period and season calculations all stop at this
 * day, and new records default to it. The cut-off exists so a set of statements
 * stays reproducible: a month-end close must not silently change just because
 * the wall clock moved on. The flip side is that it therefore never advances by
 * itself, which is why the ledger needs explicit maintenance modes and a visible
 * staleness signal rather than a bare date field.
 */
import { daysBetween, isValidDay, localToday } from './dates.js';
import type { AsOfMode } from './types.js';

export interface AsOfResolutionInput {
  /** Stored `Setting.asOfDate`. Invalid or absent values fall back to today. */
  asOfDate?: string;
  /** Stored `Setting.asOfMode`; absent or unknown means `manual`. */
  asOfMode?: string;
  /** Latest business day actually recorded, used by `auto_on_record`. */
  latestRecordDate?: string;
}

export interface AsOfState {
  /** Effective cut-off used by reports, valuation and entry defaults. */
  asOf: string;
  /** Machine-local calendar day used for the comparison. */
  today: string;
  /** Whole days the cut-off sits behind today; negative when future-dated. */
  daysBehind: number;
  /** The user has to act: the stored cut-off is behind today. */
  stale: boolean;
  /** The cut-off is ahead of today, so reports may include pre-recorded days. */
  future: boolean;
  mode: AsOfMode;
}

function validDay(day?: string): string | undefined {
  return day && isValidDay(day) ? day : undefined;
}

/** Absent or unknown modes mean `manual`, so an older ledger keeps its stored day. */
export function normalizeAsOfMode(mode?: string): AsOfMode {
  return mode === 'auto_today' || mode === 'auto_on_record' ? mode : 'manual';
}

/**
 * Effective cut-off day.
 *
 * `manual` keeps the stored day, `auto_today` always reports today, and
 * `auto_on_record` follows the newest recorded day but never past today — so a
 * pre-recorded future entry cannot open the window onto future days.
 */
export function resolveAsOfDate(input: AsOfResolutionInput, today = localToday()): string {
  const stored = validDay(input.asOfDate);
  const mode = normalizeAsOfMode(input.asOfMode);
  if (mode === 'auto_today') return today;
  if (mode === 'auto_on_record') {
    const latest = validDay(input.latestRecordDate);
    if (!latest) return stored ?? today;
    return latest > today ? today : latest;
  }
  return stored ?? today;
}

/** Resolve the cut-off and describe how far it sits from today. */
export function asOfState(input: AsOfResolutionInput, today = localToday()): AsOfState {
  const asOf = resolveAsOfDate(input, today);
  const daysBehind = daysBetween(asOf, today);
  return {
    asOf,
    today,
    daysBehind,
    stale: daysBehind > 0,
    future: daysBehind < 0,
    mode: normalizeAsOfMode(input.asOfMode),
  };
}
