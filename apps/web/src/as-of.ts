import {
  asOfState,
  normalizeAsOfMode,
  resolveAsOfDate,
  todayIn,
  type AsOfMode,
  type AsOfResolutionInput,
  type AsOfState,
} from '@zichan/core';
import type { Snapshot } from './db/snapshot.js';

/**
 * Newest business day the user actually recorded. Voided and soft-deleted rows
 * are skipped so that undoing a mistaken entry cannot drag the cut-off backwards.
 */
export function latestRecordedDay(snap: Snapshot): string | undefined {
  let latest: string | undefined;
  for (const transaction of snap.transactions) {
    if (transaction.isDeleted || transaction.recordState === 'voided') continue;
    if (!latest || transaction.date > latest) latest = transaction.date;
  }
  return latest;
}

/**
 * Oldest business day recorded. Used to warn before a cut-off that would push
 * every existing entry out of the reports.
 */
export function earliestRecordedDay(snap: Snapshot): string | undefined {
  let earliest: string | undefined;
  for (const transaction of snap.transactions) {
    if (transaction.isDeleted || transaction.recordState === 'voided') continue;
    if (!earliest || transaction.date < earliest) earliest = transaction.date;
  }
  return earliest;
}

/**
 * Inputs for the cut-off resolver. Scanning every transaction is O(n) and only
 * `auto_on_record` needs it, so the default `manual` path stays O(1).
 */
export function ledgerAsOfInput(snap: Snapshot): AsOfResolutionInput {
  const asOfMode = snap.setting?.asOfMode;
  return {
    asOfDate: snap.setting?.asOfDate,
    asOfMode,
    latestRecordDate: normalizeAsOfMode(asOfMode) === 'auto_on_record' ? latestRecordedDay(snap) : undefined,
  };
}

/**
 * The day "now" falls on in this ledger's zone.
 *
 * This is the ledger's single answer to "what is today" (§0.6). Business days
 * carry no zone, so this is what decides which one current activity belongs to;
 * reading the device clock instead makes one ledger report two different days.
 */
export function ledgerToday(snap: Snapshot, now: Date = new Date()): string {
  return todayIn(snap.setting?.timezone, now);
}

/** Effective cut-off day shared by reports, valuation, seasons and entry defaults. */
export function ledgerAsOfDate(snap: Snapshot, today = ledgerToday(snap)): string {
  return resolveAsOfDate(ledgerAsOfInput(snap), today);
}

/** Effective cut-off plus how far it lags today, for banners and headers. */
export function ledgerAsOf(snap: Snapshot, today = ledgerToday(snap)): AsOfState {
  return asOfState(ledgerAsOfInput(snap), today);
}

/**
 * Whether the cut-off needs the user's attention on a report surface. The
 * automatic modes advance themselves, so only a manual cut-off can fall behind;
 * a future-dated cut-off always deserves a warning.
 */
export function needsAsOfAttention(state: AsOfState): boolean {
  return state.future || (state.stale && state.mode === 'manual');
}

/** Menu copy for the settings page; the type itself lives in `@zichan/core`. */
export const AS_OF_MODE_LABELS: readonly (readonly [AsOfMode, string])[] = [
  ['manual', '手动维护 · 报表固定截止日'],
  ['auto_today', '每天自动跟到今天'],
  ['auto_on_record', '随最新流水自动推进'],
];

/** Explain the effective cut-off in one line, including why it is not today. */
export function asOfSummary(state: AsOfState): string {
  if (state.future) return `比今天晚 ${Math.abs(state.daysBehind)} 天，报表会包含预记账日期`;
  if (state.stale) return `停在 ${state.asOf}，比今天早 ${state.daysBehind} 天`;
  if (state.mode === 'auto_today') return '每天自动跟到今天';
  if (state.mode === 'auto_on_record') return '跟随最新流水';
  return '与今天一致';
}
