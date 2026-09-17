import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServerBackup } from '../src/backup.js';
import { applyBackupRetention, planBackupRetention } from '../src/backup-retention.js';
import { SyncServerStore } from '../src/store.js';

/**
 * Retention may only delete a backup that still verifies, and must never delete the newest
 * valid one. Both rules are asserted against real backup directories produced by the same
 * code path the deployment uses, plus one deliberately broken copy.
 */
async function dataDirectory(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-retention-'));
  writeFileSync(join(dir, 'server-id'), 'srv-retention\n', 'utf8');
  writeFileSync(join(dir, 'server.secret'), 'a'.repeat(64), 'utf8');
  writeFileSync(join(dir, 'opaque.server-setup'), 'b'.repeat(64), 'utf8');
  // A real schema, because verification opens the copied database and checks its version.
  const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-retention');
  await store.ready;
  await store.close();
  return dir;
}

/** Copy of a valid backup with a corrupted payload, which verification must reject. */
function breakBackup(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as { files: { path: string }[] };
  // Keep the manifest untouched: the sizes and hashes no longer match what is on disk, so the
  // copy must be reported as unverified rather than deleted.
  for (const file of manifest.files) writeFileSync(join(target, file.path), 'corrupted', 'utf8');
  writeFileSync(join(target, 'server-id'), 'srv-retention\n', 'utf8');
  writeFileSync(join(target, 'server.secret'), 'a'.repeat(64), 'utf8');
  writeFileSync(join(target, 'opaque.server-setup'), 'b'.repeat(64), 'utf8');
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

describe('backup retention', () => {
  it('keeps the newest verified backups and only removes verified ones', async () => {
    const data = await dataDirectory();
    const root = mkdtempSync(join(tmpdir(), 'zichan-backups-'));
    try {
      const older = join(root, 'backup-older');
      const newer = join(root, 'backup-newer');
      await createServerBackup(data, older);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await createServerBackup(data, newer);
      const broken = join(root, 'backup-broken');
      breakBackup(older, broken);

      const plan = await planBackupRetention(root, 1);
      // Two verified copies exist, keep=1 keeps the newest and offers the older one.
      expect(plan.retained.map((entry) => entry.recordId)).toEqual(['backup-newer']);
      expect(plan.removable.map((entry) => entry.recordId)).toEqual(['backup-older']);
      // The broken copy is reported, not scheduled for deletion.
      expect(plan.unverified.map((entry) => entry.path)).toContain(broken);

      const result = await applyBackupRetention(root, 1);
      expect(result.applied).toBe(true);
      expect(result.removed.map((entry) => entry.path)).toEqual([older]);
      expect(existsSync(newer)).toBe(true);
      expect(existsSync(broken)).toBe(true);
      expect(result.freedBytes).toBeGreaterThan(0);
    } finally {
      rmSync(data, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never deletes the only valid backup even when the count is misconfigured', async () => {
    const data = await dataDirectory();
    const root = mkdtempSync(join(tmpdir(), 'zichan-backups-single-'));
    try {
      const only = join(root, 'backup-only');
      await createServerBackup(data, only);
      // keep=1 with one valid copy: nothing removable, and the copy stays.
      const result = await applyBackupRetention(root, 1);
      expect(result.removed).toEqual([]);
      expect(existsSync(only)).toBe(true);
      // A count that cannot be honoured is refused rather than treated as "delete all".
      await expect(planBackupRetention(root, 0)).rejects.toThrow();
      await expect(planBackupRetention(root, 1.5)).rejects.toThrow();
    } finally {
      rmSync(data, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a dry run without deleting anything', async () => {
    const data = await dataDirectory();
    const root = mkdtempSync(join(tmpdir(), 'zichan-backups-dry-'));
    try {
      await createServerBackup(data, join(root, 'backup-a'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await createServerBackup(data, join(root, 'backup-b'));
      const result = await applyBackupRetention(root, 1, { dryRun: true });
      expect(result.applied).toBe(false);
      expect(result.removed).toEqual([]);
      expect(result.removable).toHaveLength(1);
      expect(existsSync(result.removable[0]!.path)).toBe(true);
    } finally {
      rmSync(data, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores directories that are not backups and reports them as skipped', async () => {
    const data = await dataDirectory();
    const root = mkdtempSync(join(tmpdir(), 'zichan-backups-skip-'));
    try {
      await createServerBackup(data, join(root, 'backup-real'));
      mkdirSync(join(root, 'not-a-backup'));
      writeFileSync(join(root, 'loose-file.txt'), 'x', 'utf8');
      const plan = await planBackupRetention(root, 5);
      expect(plan.skipped.map((entry) => entry.split(/[\\/]/).pop())).toEqual(['not-a-backup']);
      expect(plan.retained).toHaveLength(1);
    } finally {
      rmSync(data, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
