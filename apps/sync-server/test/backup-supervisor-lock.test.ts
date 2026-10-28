import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireBackupExecutorLock } from '../src/backup-supervisor.js';

describe('backup supervisor lock', () => {
  it('refuses a second owner and can be acquired again after a clean release', () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-backup-lock-'));
    try {
      const release = acquireBackupExecutorLock(root);
      expect(() => acquireBackupExecutorLock(root)).toThrow('该数据目录已有备份执行器');
      release();
      const releaseAgain = acquireBackupExecutorLock(root);
      releaseAgain();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux')('replaces a lock from an earlier process with the same PID', () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-backup-lock-reused-pid-'));
    try {
      const release = acquireBackupExecutorLock(root);
      const lock = join(root, 'backup-executor.lock');
      const record = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; identity: string };
      release();
      writeFileSync(lock, JSON.stringify({ ...record, identity: 'previous-boot:1' }));
      const releaseAfterReuse = acquireBackupExecutorLock(root);
      releaseAfterReuse();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
