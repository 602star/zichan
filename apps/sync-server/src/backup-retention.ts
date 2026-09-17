/**
 * Backup retention.
 *
 * Only a backup that has been verified may be deleted, and the most recent valid backup is
 * never deleted: retention exists to free space, not to remove the only thing that could
 * still be restored. Anything that fails verification is left in place and reported, so a
 * retention run can never quietly turn "kept too much" into "lost the last backup".
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { verifyServerBackup } from './backup.js';

export interface BackupCandidate {
  path: string;
  recordId: string;
  createdAt: string;
  totalBytes: number;
}

export interface RetentionPlan {
  keep: number;
  /** Verified, beyond the retention count: the only ones allowed to be deleted. */
  removable: BackupCandidate[];
  /** Verified and inside the retention count. */
  retained: BackupCandidate[];
  /** Could not be verified: kept, and listed so the operator can look into it. */
  unverified: { path: string; reason: string }[];
  skipped: string[];
}

/** A backup directory is a directory that contains a manifest. */
function looksLikeBackup(path: string): boolean {
  return existsSync(join(path, 'manifest.json'));
}

function directorySize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

export async function planBackupRetention(backupRoot: string, keep: number): Promise<RetentionPlan> {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('保留份数必须是 1 以上的整数');
  if (!existsSync(backupRoot)) throw new Error(`备份目录不存在：${backupRoot}`);
  const entries = readdirSync(backupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const verified: BackupCandidate[] = [];
  const unverified: { path: string; reason: string }[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const path = join(backupRoot, entry.name);
    if (!looksLikeBackup(path)) { skipped.push(path); continue; }
    try {
      const result = await verifyServerBackup(path);
      if (!result.ok) { unverified.push({ path, reason: result.issues.join('；') || '校验未通过' }); continue; }
      verified.push({ path, recordId: entry.name, createdAt: result.manifest.createdAt, totalBytes: directorySize(path) });
    } catch (error) {
      unverified.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  // Newest first: the retention count is about age, not about directory names.
  verified.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const retained = verified.slice(0, keep);
  const removable = verified.slice(keep);
  // Even with an unusual count, the newest valid backup stays: never delete the only restore point.
  if (!retained.length && removable.length) retained.push(removable.shift()!);
  return { keep, removable, retained, unverified, skipped };
}

export interface RetentionResult extends RetentionPlan {
  removed: { path: string; totalBytes: number }[];
  freedBytes: number;
  applied: boolean;
}

export async function applyBackupRetention(backupRoot: string, keep: number, options: { dryRun?: boolean } = {}): Promise<RetentionResult> {
  const plan = await planBackupRetention(backupRoot, keep);
  const removed: { path: string; totalBytes: number }[] = [];
  if (options.dryRun) return { ...plan, removed, freedBytes: 0, applied: false };
  for (const candidate of plan.removable) {
    rmSync(candidate.path, { recursive: true, force: true });
    removed.push({ path: candidate.path, totalBytes: candidate.totalBytes });
  }
  return {
    ...plan,
    removed,
    freedBytes: removed.reduce((sum, entry) => sum + entry.totalBytes, 0),
    applied: true,
  };
}
