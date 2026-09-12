import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The address a phone on the same network would actually type in. */
function lanIPv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  throw new Error('no non-loopback IPv4 address is available on this machine');
}

/** Quick start opens a modal that must be dismissed before the sidebar is clickable. */
async function dismissQuickStart(page, quickStart) {
  if (!await quickStart.isVisible().catch(() => false)) return;
  await quickStart.click();
  const close = page.getByRole('button', { name: '关闭快速记账' });
  await expect(close).toBeVisible({ timeout: 30_000 });
  await close.click();
  await expect(close).toBeHidden({ timeout: 30_000 });
}

async function signIn(page) {
  const loginHeading = page.getByRole('heading', { name: '账号登录', exact: true });
  if (await loginHeading.isVisible().catch(() => false)) {
    await page.getByLabel('服务器用户名').fill('lan-member');
    await page.getByLabel('服务器账号密码').fill('lan-account-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
  }
}

test('plain-HTTP LAN origin unlocks the ledger, saves a record and reloads it', async ({ page }) => {
  test.setTimeout(180_000);
  const address = lanIPv4();
  const marker = 'LAN-HTTP-明文验收';
  const ownerSetupToken = 'e2e-insecure-lan-owner-setup-000000000000';
  const server = createSyncServer({
    webDir: resolve(repositoryRoot, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    allowInsecureHttp: true,
    ownerSetupToken,
  });
  try {
    await server.ready;
    await new Promise((done, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '0.0.0.0', done);
    });
    const port = server.server.address().port;
    const origin = `http://${address}:${port}`;
    await registerAccount(`http://127.0.0.1:${port}`, 'lan-owner', 'lan-owner-password', { ownerSetupToken });
    await registerAccount(`http://127.0.0.1:${port}`, 'lan-member', 'lan-account-password');

    await page.goto(`${origin}/app/`);

    // Exactly the reported environment: a real plain-HTTP LAN origin where the
    // browser withholds every secure-context-only API.
    expect(await page.evaluate(() => globalThis.isSecureContext)).toBe(false);
    expect(await page.evaluate(() => typeof globalThis.crypto?.subtle)).toBe('undefined');
    expect(await page.evaluate(() => typeof globalThis.navigator?.locks)).toBe('undefined');

    const quickStart = page.getByRole('button', { name: '直接开始记支出', exact: true });
    const appShell = page.locator('.zc-app-shell');
    await signIn(page);
    await expect(quickStart.or(appShell)).toBeVisible({ timeout: 30_000 });
    await dismissQuickStart(page, quickStart);
    await expect(appShell).toBeVisible({ timeout: 30_000 });

    // Record an expense through the ordinary transactions screen.
    await page.locator('.zc-sidebar').getByText('日常支出', { exact: true }).click();
    await page.getByRole('button', { name: '+ 记支出' }).click();
    await page.getByRole('textbox', { name: /^金额/ }).fill('12.50');
    await page.getByLabel('描述').fill(marker);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 });

    // The snapshot in IndexedDB must be the encrypted envelope, not a raw SQLite
    // file: local storage keeps working, and it is still ciphertext.
    const snapshot = await page.evaluate(async () => {
      const names = (await indexedDB.databases()).map((row) => row.name).filter(Boolean);
      const name = names.find((value) => value.includes('database')) ?? names[0];
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get('ledger.sqlite');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const bytes = value?.ciphertext instanceof Uint8Array ? value.ciphertext : new Uint8Array();
      return {
        format: value?.format,
        ivLength: value?.iv?.length,
        length: bytes.length,
        head: new TextDecoder().decode(bytes.subarray(0, 16)),
      };
    });
    expect(snapshot.format).toBe('zichan-encrypted-database');
    expect(snapshot.ivLength).toBe(12);
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot.head.startsWith('SQLite format 3')).toBe(false);

    // Reload and confirm the record survives a full re-open through the fallback backend.
    await page.reload();
    await expect(page.getByRole('heading', { name: '账号登录', exact: true }).or(quickStart).or(appShell))
      .toBeVisible({ timeout: 30_000 });
    await signIn(page);
    await expect(quickStart.or(appShell)).toBeVisible({ timeout: 30_000 });
    await dismissQuickStart(page, quickStart);
    await expect(appShell).toBeVisible({ timeout: 30_000 });
    await page.locator('.zc-sidebar').getByText('日常支出', { exact: true }).click();
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await page.close();
    const closing = server.close();
    server.server.closeAllConnections();
    await closing;
  }
});
