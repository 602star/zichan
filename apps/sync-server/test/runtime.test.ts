import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { developmentDataDir, requireExplicitDataDir } from '../src/runtime-config.js';
import { watchShutdownInput } from '../src/shutdown-input.js';

describe('sync-server runtime configuration', () => {
  it('requires an explicit portable data directory without a home-directory fallback', () => {
    const expected = resolve('portable/server');
    expect(() => requireExplicitDataDir(undefined, expected)).toThrow(/缺少 DATA_DIR/);
    expect(() => requireExplicitDataDir('   ', expected)).toThrow(/不会回退/);
    expect(requireExplicitDataDir(' portable/server ', expected)).toBe(expected);
    expect(() => requireExplicitDataDir('portable/elsewhere', expected)).toThrow(/DATA_DIR 必须严格等于/);
    if (process.platform === 'win32') {
      expect(requireExplicitDataDir(expected.toUpperCase(), expected)).toBe(expected);
      expect(requireExplicitDataDir(toNamespacedPath(expected), expected)).toBe(expected);
      expect(() => requireExplicitDataDir(toNamespacedPath(resolve('portable/elsewhere')), expected))
        .toThrow(/DATA_DIR 必须严格等于/);
    }
  });

  it('keeps the development default beside the sync-server workspace', () => {
    const moduleUrl = pathToFileURL(join(resolve('apps/sync-server'), 'dist', 'server.mjs')).href;
    expect(developmentDataDir(moduleUrl)).toBe(resolve('apps/sync-server/server-data'));
  });
});

describe('desktop child shutdown input', () => {
  it('accepts a fragmented shutdown line exactly once', () => {
    const input = new PassThrough();
    const shutdown = vi.fn();
    watchShutdownInput(input, shutdown);

    input.write('ignored\nshut');
    input.write('down\r\nshutdown\n');

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith('stdin shutdown');
  });

  it('treats stdin EOF as a graceful shutdown request', async () => {
    const input = new PassThrough();
    const shutdown = vi.fn();
    watchShutdownInput(input, shutdown);

    input.end();
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));

    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith('stdin EOF');
  });
});

describe('bundled desktop server entry', () => {
  it('enforces its portable roots and releases every file after stdin shutdown', () => {
    const harness = join(dirname(fileURLToPath(import.meta.url)), 'support', 'bundled-runtime-harness.mjs');
    const result = spawnSync(process.execPath, [harness], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
      encoding: 'utf8',
      timeout: 25_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('bundled-runtime-ok');
  }, 30_000);
});
