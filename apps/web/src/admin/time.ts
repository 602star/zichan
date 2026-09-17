/**
 * Time-range helpers for the management filters.
 *
 * The URL and the API keep talking ISO-8601 UTC; only the `<input type="datetime-local">`
 * speaks local wall-clock time. Keeping that conversion in two pure functions means the
 * console can show local time without ever sending a timezone-less string to the server,
 * and the round trip can be asserted without a DOM.
 */

/** `datetime-local` value (`YYYY-MM-DDTHH:mm`, local time) to ISO-8601 UTC. */
export function localInputToIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

const pad = (value: number) => String(value).padStart(2, '0');

/** ISO-8601 (or any parseable timestamp) to a `datetime-local` value in local time. */
export function isoToLocalInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return '';
  // `toISOString()` is UTC; shifting by the offset first gives the local wall clock.
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return `${String(local.getUTCFullYear())}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

export interface TrendWindow {
  from: string;
  until?: string;
}

/** Fixed windows offered as one-click presets, so the operator does not hand-write ISO. */
export const RANGE_PRESETS = [
  { label: '近 1 小时', hours: 1 },
  { label: '近 24 小时', hours: 24 },
  { label: '近 7 天', hours: 168 },
  { label: '近 30 天', hours: 720 },
] as const;

/** Open-ended window: `from` only, so new records keep appearing. */
export function presetWindow(hours: number, now: Date = new Date()): TrendWindow {
  return { from: new Date(now.getTime() - hours * 3_600_000).toISOString() };
}

/**
 * Rejects an inverted range instead of silently returning nothing: an operator who swapped
 * the two dates should be told, not shown an empty table.
 */
export function describeRange(from: string, until: string): string | undefined {
  if (!from || !until) return undefined;
  return Date.parse(from) <= Date.parse(until) ? undefined : '起始时间晚于结束时间，请调换或清空其中一项。';
}
