import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs the bundled supervisor through actual stop, backup, restart, failure and restart deduplication', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.execPath, [join(here, 'support/backup-supervisor-harness.mjs')], {
    cwd: resolve(here, '../../..'), encoding: 'utf8', timeout: 320_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('backup-supervisor-ok');
}, 360_000);
