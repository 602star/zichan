import { isValidDay } from '@zichan/core';

export const ADMIN_TREND_SPANS: Record<string, number> = {
  '15m': 900_000, '1h': 3_600_000, '24h': 86_400_000,
  '7d': 604_800_000, '30d': 2_592_000_000, '90d': 7_776_000_000,
};

export class AdminTimeWindowError extends Error {}

/** Bounded history queries; explicit timestamps always include a timezone. */
export function adminTimeWindow(search: URLSearchParams, options: {
  presets: string[]; maxDays: number; now?: Date; defaultRange?: string;
  buckets?: 'minute' | 'trend' | 'day';
}) {
  const range = search.get('range') ?? options.defaultRange ?? '24h';
  const rawFrom = search.get('from'); const rawUntil = search.get('until');
  const custom = rawFrom !== null || rawUntil !== null || range === 'custom';
  const parse = (value: string | null) => {
    if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
      || !isValidDay(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59
      || (value[16] === ':' && Number(value.slice(17, 19)) > 59) || !Number.isFinite(Date.parse(value))) throw new AdminTimeWindowError('请提供带时区的起止时间。');
    return Date.parse(value);
  };
  if (!custom && !options.presets.includes(range)) throw new AdminTimeWindowError('不支持此快捷时间范围。');
  let untilMs = custom ? parse(rawUntil) : (options.now ?? new Date()).getTime();
  let fromMs = custom ? parse(rawFrom) : untilMs - ADMIN_TREND_SPANS[range]!;
  const requestedSpan = untilMs - fromMs;
  if (!(requestedSpan > 0)) throw new AdminTimeWindowError('起始时间必须早于结束时间。');
  if (requestedSpan > options.maxDays * 86_400_000) throw new AdminTimeWindowError(`时间区间最多 ${options.maxDays} 天。`);
  const granularity = requestedSpan <= 3_600_000 ? 'minute' : requestedSpan > 604_800_000 ? 'day' : 'hour';
  const bucketMs = options.buckets === 'minute' ? 60_000 : options.buckets === 'day' ? 86_400_000
    : options.buckets === 'trend' ? granularity === 'minute' ? 60_000 : 3_600_000 : 0;
  // Aggregated rows cannot reconstruct a partial bucket. Return the actual covered edges.
  if (bucketMs && (custom || options.buckets !== 'trend')) {
    untilMs = Math.ceil(untilMs / bucketMs) * bucketMs;
    fromMs = custom ? Math.floor(fromMs / bucketMs) * bucketMs : untilMs - requestedSpan;
  }
  return { range: custom ? 'custom' : range, from: new Date(fromMs), until: new Date(untilMs),
    spanMs: untilMs - fromMs, granularity, bucketMs: granularity === 'minute' ? 60_000 : granularity === 'day' ? 86_400_000 : 3_600_000 };
}
