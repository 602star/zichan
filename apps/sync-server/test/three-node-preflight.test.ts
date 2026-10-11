import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

const runFile = promisify(execFile);

describe('three-node deployment preflight', () => {
  it('accepts three actual independent hosted nodes over loopback HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-three-node-preflight-'));
    const webDir = join(root, 'web');
    mkdirSync(webDir);
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Test</title>');
    const nodes = [0, 1, 2].map((index) => createTestSyncServer({
      dataDir: join(root, `node-${index}`), webDir, basePath: '/ledger', allowInsecureHttp: true,
    }));
    try {
      await Promise.all(nodes.map((node) => node.ready));
      await Promise.all(nodes.map((node) => new Promise<void>((done) => node.server.listen(0, '127.0.0.1', done))));
      const urls = nodes.map((node) => `http://127.0.0.1:${(node.server.address() as AddressInfo).port}/ledger`);
      for (const [index, url] of urls.entries()) {
        await registerAccount(url, `owner${index}`, 'owner-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      }
      const script = resolve(process.cwd(), '../../scripts/three-node-preflight.mjs');
      const { stdout } = await runFile(process.execPath, [script, '--allow-local-http', ...urls]);
      const result = JSON.parse(stdout) as { ok: boolean; issues: string[];
        nodes: { serverId: string; nodeKeySha256: string }[] };
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(new Set(result.nodes.map((node) => node.serverId)).size).toBe(3);
      expect(new Set(result.nodes.map((node) => node.nodeKeySha256)).size).toBe(3);
    } finally {
      await Promise.all(nodes.map((node) => node.close()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
