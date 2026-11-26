import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { entry, receipt, addAndExtract } from './local-order-helpers.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const test = base.extend({ baseURL: async ({}, use) => {
  const directory = await mkdtemp(join(tmpdir(), 'zichan-packed-release-'));
  let server;
  try {
    const output = join(directory, 'package');
    execFileSync(process.execPath, [join(root, 'scripts/release/create-update-package.mjs'), '--unsigned', output]);
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    const artifact = join(output, `zichan-${version}.json`), data = await readFile(artifact);
    expect(data.length).toBeLessThanOrEqual(64 * 1024 ** 2);
    // Exercise the unchanged v1 signature and byte limits with an isolated test key.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = join(directory, 'key.pem'), publicPath = join(directory, 'public.pem');
    await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
    execFileSync(process.execPath, [join(root, 'scripts/release/sign-update-package.mjs'), `v${version}`, key, artifact, output]);
    execFileSync(process.execPath, [join(root, 'scripts/release/verify-update-package.mjs'), publicPath, join(output, 'latest.json'), artifact]);
    const release = JSON.parse(data), runtime = join(directory, 'runtime');
    expect(release.files.some((file) => /^web-dist\/ocr\/.*\.gz$/.test(file.path))).toBe(true);
    for (const file of release.files) {
      const target = resolve(runtime, file.path);
      if (!target.startsWith(runtime + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unexpected package path');
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(file.data, 'base64'));
    }
    const token = 'packed-update-owner-000000000000000000000';
    server = createSyncServer({ enableWeb: true, webDir: join(runtime, 'web-dist'), registrationMode: 'open', ownerSetupToken: token });
    await server.ready; await listenOnSafePort(server.server, '127.0.0.1');
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(origin, 'packed-owner', 'packed-owner-password', { ownerSetupToken: token });
    await use(origin);
  } finally { if (server) await closeTestSyncServer(server); await rm(directory, { recursive: true, force: true }); }
} });
test.setTimeout(180_000);
test('the actual signed v1 release package loads its compressed workers and models and completes local OCR', async ({ page, context }) => {
  const failures = []; page.on('response', (response) => { if (response.status() >= 400 && /\/(?:ocr|assets)\//.test(response.url())) failures.push(response.url()); });
  const form = await entry(page), panel = await addAndExtract(page, form, await receipt(page));
  await expect(panel.getByLabel('实付金额候选', { exact: true })).toHaveValue('49.9');
  await panel.getByLabel('附件保留与隐私', { exact: true }).selectOption('none');
  await panel.getByRole('button', { name: '确认并应用', exact: true }).click();
  await expect(form.getByLabel(/^金额/)).toHaveValue('49.9'); expect(failures).toEqual([]);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  const offline = await addAndExtract(page, form, await receipt(page, '29.90'));
  await expect(offline.getByLabel('实付金额候选', { exact: true })).toHaveValue('29.9');
  await expect(offline.getByRole('checkbox', { name: '实付金额', exact: true })).not.toBeChecked();
  await context.setOffline(false);
});
