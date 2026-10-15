import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('standalone ESM server bundle starts without repository dependencies', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'zichan-bundle-startup-'));
  const bundle = join(temporary, 'server.mjs');
  copyFileSync(join(root, 'apps/sync-server/dist/server.mjs'), bundle);
  const port = await freePort();
  const child = spawn(process.execPath, [bundle], {
    cwd: temporary, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR: join(temporary, 'data'), HOST: '127.0.0.1', PORT: String(port),
      ENABLE_WEB: '0', CONTROL_STDIN: '1' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(output);
      return fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.status).catch(() => 0);
    }, { timeout: 20_000 }).toBe(200);
    expect(output).not.toContain('Dynamic require');
    const url = `http://127.0.0.1:${port}`;
    const ownerSetupToken = readFileSync(join(temporary, 'data', 'owner-setup.secret'), 'utf8').trim();
    await registerAccount(url, 'bundle-owner', 'bundle-test-login-0001', { ownerSetupToken });
    const owner = await loginAccount(url, 'bundle-owner', 'bundle-test-login-0001');
    const reading = await fetch(`${url}/api/admin/system`, { headers: { Authorization: `Bearer ${owner.accessToken}` } });
    expect(reading.status).toBe(200);
    const mode = (await reading.json()).mode;
    expect(process.platform === 'win32' ? ['windows'] : process.platform === 'linux' ? ['linux', 'docker'] : ['other']).toContain(mode);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.write('shutdown\n');
      const timer = setTimeout(() => child.kill(), 10_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
