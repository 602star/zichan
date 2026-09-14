/**
 * Backup retention bucketing, shared by local (IndexedDB) archives and remote
 * server copies.
 *
 * Both tiers must agree on what "keep one per hour / per day / per week" means,
 * so the policy lives here once instead of being spelled out twice.
 *
 * Buckets are cut on the *ledger's* calendar rather than the UTC one. A 09:00
 * and a 07:00 Beijing backup share a local day even though their UTC dates
 * differ; slicing the UTC date instead would keep two "daily" restore points on
 * one local day and none on the next.
 */
import { dayOfInstant, hourBucketOfInstant, startOfWeek } from '@zichan/core';

export type RetentionTier = 'hourly' | 'daily' | 'weekly';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Age below which backups are kept one per hour. */
export const RETENTION_HOURLY_WINDOW_MS = DAY_MS;

/** Age below which backups are kept one per day. */
export const RETENTION_DAILY_WINDOW_MS = 31 * DAY_MS;

/** Hard cap on how many weekly restore points survive. */
export const RETENTION_WEEKLY_LIMIT = 12;

export interface RetentionOptions {
  /** Reference instant; injectable so the policy is testable. */
  now?: number;
  /** Ledger IANA zone used to cut day and week boundaries. */
  timeZone?: string;
}

/** Which tier an archive falls into, based purely on its age. */
export function retentionTier(createdAt: string, now: number = Date.now()): RetentionTier {
  const age = Math.max(0, now - Date.parse(createdAt));
  if (age < RETENTION_HOURLY_WINDOW_MS) return 'hourly';
  if (age < RETENTION_DAILY_WINDOW_MS) return 'daily';
  return 'weekly';
}

/**
 * Bucket key for one tier: same key means "same slot, keep only the newest".
 *
 * An unparseable `createdAt` falls back to a raw-string bucket instead of
 * throwing. Retention runs as part of backup housekeeping, and a corrupt row
 * must never be able to abort the pass that protects the ledger.
 */
export function retentionBucketKey(
  tier: RetentionTier,
  createdAt: string,
  timeZone?: string,
): string {
  if (Number.isNaN(Date.parse(createdAt))) return `${tier}:raw:${createdAt}`;
  if (tier === 'hourly') return `hourly:${hourBucketOfInstant(createdAt, timeZone)}`;
  const day = dayOfInstant(createdAt, timeZone);
  if (tier === 'daily') return `daily:${day}`;
  // A real week boundary, so "one per week" lines up with the calendar week.
  return `weekly:${startOfWeek(day)}`;
}

/**
 * Keep the newest archive in every bucket, oldest tiers first, capped at
 * `RETENTION_WEEKLY_LIMIT` weekly slots.
 *
 * Input order is irrelevant: rows are sorted newest-first, so the survivor of a
 * contested bucket is always the most recent one. Pinned and non-auto rows are
 * the caller's responsibility and must not be passed in.
 */
export function selectRetained<T>(
  rows: readonly T[],
  createdAtOf: (row: T) => string,
  options: RetentionOptions = {},
): T[] {
  const now = options.now ?? Date.now();
  const ordered = [...rows].sort((left, right) => createdAtOf(right).localeCompare(createdAtOf(left)));
  const kept: T[] = [];
  const buckets = new Set<string>();
  let weekly = 0;
  for (const row of ordered) {
    const createdAt = createdAtOf(row);
    const tier = retentionTier(createdAt, now);
    const key = retentionBucketKey(tier, createdAt, options.timeZone);
    if (buckets.has(key)) continue;
    if (tier === 'weekly' && weekly >= RETENTION_WEEKLY_LIMIT) continue;
    buckets.add(key);
    if (tier === 'weekly') weekly += 1;
    kept.push(row);
  }
  return kept;
}
