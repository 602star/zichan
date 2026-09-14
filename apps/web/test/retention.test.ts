import { describe, expect, it } from 'vitest';
import {
  RETENTION_DAILY_WINDOW_MS,
  RETENTION_HOURLY_WINDOW_MS,
  RETENTION_WEEKLY_LIMIT,
  retentionBucketKey,
  retentionTier,
  selectRetained,
} from '../src/db/retention.js';

/*
 * Backup retention had no coverage before this file, which is exactly how the
 * UTC/local day split survived: the bug only appears for a few hours a day, in
 * a non-UTC zone, and nothing asserted the policy.
 *
 * Zones are passed explicitly rather than read from the machine so these stay
 * deterministic on every developer box and in CI.
 */

const BEIJING = 'Asia/Shanghai';

/** `2026-09-14 07:00` Beijing, which is `2026-09-13T23:00Z` — the previous UTC day. */
const earlyBeijing = (day: string) => `${day}T07:00:00+08:00`;

/** `2026-09-14 09:00` Beijing, which is `2026-09-14T01:00Z` — the same UTC day. */
const lateBeijing = (day: string) => `${day}T09:00:00+08:00`;

const iso = (ms: number) => new Date(ms).toISOString();
const at = (value: string) => Date.parse(value);

/** The UTC calendar date an instant falls on — what naive `slice(0, 10)` produced. */
const utcDay = (value: string) => new Date(value).toISOString().slice(0, 10);

const rowsOf = (createdAts: readonly string[]) => createdAts.map((createdAt) => ({ createdAt }));

describe('retention tier', () => {
  it('buckets by age: hourly until a day, daily until a month, then weekly', () => {
    const now = at('2026-09-14T12:00:00Z');
    expect(retentionTier(iso(now - (RETENTION_HOURLY_WINDOW_MS - 1)), now)).toBe('hourly');
    expect(retentionTier(iso(now - RETENTION_HOURLY_WINDOW_MS), now)).toBe('daily');
    expect(retentionTier(iso(now - (RETENTION_DAILY_WINDOW_MS - 1)), now)).toBe('daily');
    expect(retentionTier(iso(now - RETENTION_DAILY_WINDOW_MS), now)).toBe('weekly');
  });

  it('treats a future-dated archive as the newest tier instead of a negative age', () => {
    const now = at('2026-09-14T12:00:00Z');
    expect(retentionTier(iso(now + 86_400_000), now)).toBe('hourly');
  });
});

describe('retention buckets cut on the ledger calendar, not the UTC one', () => {
  /*
   * The regression this whole module exists for. Both archives are on the same
   * Beijing day; their UTC dates differ. Slicing the UTC date kept two "daily"
   * restore points for one local day — and then none for the next.
   */
  it('puts archives from one local day in one daily bucket, despite different UTC dates', () => {
    const now = at('2026-09-16T01:00:00Z');
    const early = earlyBeijing('2026-09-14');
    const late = lateBeijing('2026-09-14');
    expect(utcDay(early)).toBe('2026-09-13');
    expect(utcDay(late)).toBe('2026-09-14');

    const kept = selectRetained(rowsOf([early, late]), (row) => row.createdAt, { now, timeZone: BEIJING });
    expect(kept.map((row) => row.createdAt)).toEqual([late]);
  });

  /*
   * The mirror failure: two archives on *different* local days share one UTC
   * date, so UTC bucketing silently dropped a genuine daily restore point.
   */
  it('keeps a restore point for each local day across a local midnight', () => {
    const now = at('2026-09-16T12:00:00Z');
    const beforeMidnight = '2026-09-14T23:00:00+08:00';
    const afterMidnight = '2026-09-15T01:00:00+08:00';
    // Different local days, but one shared UTC day.
    expect(utcDay(beforeMidnight)).toBe('2026-09-14');
    expect(utcDay(afterMidnight)).toBe('2026-09-14');

    const kept = selectRetained(
      rowsOf([beforeMidnight, afterMidnight]),
      (row) => row.createdAt,
      { now, timeZone: BEIJING },
    );
    expect(kept).toHaveLength(2);
  });

  it('cuts the hourly bucket on the local hour', () => {
    expect(retentionBucketKey('hourly', earlyBeijing('2026-09-14'), BEIJING)).toBe('hourly:2026-09-14T07');
    expect(retentionBucketKey('hourly', lateBeijing('2026-09-14'), BEIJING)).toBe('hourly:2026-09-14T09');
  });

  it('aligns the weekly bucket to the local calendar week', () => {
    // 2026-09-14 is a Monday; the Sunday before still belongs to the prior week.
    expect(retentionBucketKey('weekly', '2026-09-14T12:00:00+08:00', BEIJING))
      .toBe(retentionBucketKey('weekly', '2026-09-15T12:00:00+08:00', BEIJING));
    expect(retentionBucketKey('weekly', '2026-09-13T12:00:00+08:00', BEIJING))
      .not.toBe(retentionBucketKey('weekly', '2026-09-14T12:00:00+08:00', BEIJING));
  });
});

describe('selectRetained', () => {
  it('keeps the newest archive of a contested bucket', () => {
    const now = at('2026-09-16T01:00:00Z');
    const kept = selectRetained(
      rowsOf([lateBeijing('2026-09-14'), earlyBeijing('2026-09-14')]),
      (row) => row.createdAt,
      { now, timeZone: BEIJING },
    );
    expect(kept.map((row) => row.createdAt)).toEqual([lateBeijing('2026-09-14')]);
  });

  it('does not depend on input order', () => {
    const now = at('2026-09-16T01:00:00Z');
    const forward = selectRetained(
      rowsOf([earlyBeijing('2026-09-14'), lateBeijing('2026-09-14')]),
      (row) => row.createdAt,
      { now, timeZone: BEIJING },
    );
    const backward = selectRetained(
      rowsOf([lateBeijing('2026-09-14'), earlyBeijing('2026-09-14')]),
      (row) => row.createdAt,
      { now, timeZone: BEIJING },
    );
    expect(forward.map((row) => row.createdAt)).toEqual(backward.map((row) => row.createdAt));
  });

  it('caps weekly restore points', () => {
    const now = at('2026-09-20T12:00:00Z');
    const weekly: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      weekly.push(iso(now - (36 + index * 7) * 86_400_000));
    }
    const kept = selectRetained(rowsOf(weekly), (row) => row.createdAt, { now, timeZone: BEIJING });
    expect(kept).toHaveLength(RETENTION_WEEKLY_LIMIT);
    // The newest survive, so the oldest weeks are the ones dropped.
    expect(kept.map((row) => row.createdAt)).toEqual(
      [...weekly].sort((left, right) => right.localeCompare(left)).slice(0, RETENTION_WEEKLY_LIMIT),
    );
  });

  it('keeps one archive per hour when several share a local hour', () => {
    const now = at('2026-09-14T12:30:00Z');
    const kept = selectRetained(
      rowsOf(['2026-09-14T19:05:00+08:00', '2026-09-14T19:40:00+08:00']),
      (row) => row.createdAt,
      { now, timeZone: BEIJING },
    );
    expect(kept.map((row) => row.createdAt)).toEqual(['2026-09-14T19:40:00+08:00']);
  });

  /*
   * Retention runs as part of backup housekeeping for the whole ledger, so a
   * single corrupt row must degrade it rather than abort the pass.
   */
  it('survives an unparseable createdAt without throwing or merging valid rows', () => {
    const now = at('2026-09-14T12:00:00Z');
    const kept = selectRetained(
      rowsOf(['not-a-date', '2026-09-14T19:05:00+08:00']),
      (row) => row.createdAt,
      { now, timeZone: BEIJING },
    );
    expect(kept.map((row) => row.createdAt)).toEqual(['not-a-date', '2026-09-14T19:05:00+08:00']);
  });

  it('falls back to the machine calendar when no zone is given', () => {
    const now = at('2026-09-16T01:00:00Z');
    const kept = selectRetained(rowsOf([earlyBeijing('2026-09-14')]), (row) => row.createdAt, { now });
    expect(kept).toHaveLength(1);
  });

  it('returns an empty set for no rows', () => {
    expect(selectRetained([], (row: { createdAt: string }) => row.createdAt)).toEqual([]);
  });
});
