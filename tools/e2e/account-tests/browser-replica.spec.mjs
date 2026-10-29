import { test, expect } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'browser-replica-account-password';
const setupToken = 'browser-replica-setup-secret-000000';
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const largeDocument = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4 * 1024 * 1024 + 1024, 0x41)]);

async function listen(node, host) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = randomInt(20_000, 49_000);
    try {
      await new Promise((done, fail) => {
        const onError = (error) => { node.server.off('listening', onListening); fail(error); };
        const onListening = () => { node.server.off('error', onError); done(); };
        node.server.once('error', onError);
        node.server.once('listening', onListening);
        node.server.listen(port, host);
      });
      return `http://${host}:${port}`;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No available test port');
}

async function openSync(page) {
  await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
  await page.getByRole('button', { name: '查看服务器上的账本' }).click();
  const settings = page.getByRole('button', { name: /^客户端同步与服务器连接/ });
  if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
}

async function saveExpense(page, note, attachmentName, attachmentBytes = photo) {
  await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
  await page.getByRole('button', { name: /^\+ 记(支出|账)$/ }).click();
  await page.getByRole('textbox', { name: /^金额/ }).fill('12.34');
  await page.getByLabel('描述').fill(note);
  if (attachmentName) await page.getByRole('dialog').locator('input[type="file"]').first()
    .setInputFiles({ name: attachmentName,
      mimeType: attachmentName.endsWith('.pdf') ? 'application/pdf' : 'image/png', buffer: attachmentBytes });
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).last().click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
}

async function syncSite(page) {
  await openSync(page);
  await page.getByRole('button', { name: '同步账本', exact: true }).first().click();
  await expect(page.getByText(/^(?:本机提交已|本次同步：|已完成 \d+ 轮同步)/).first()).toBeVisible();
}

test.setTimeout(120_000);

test('the browser carries a personal ledger between independent servers', async ({ page, context }) => {
  page.setDefaultTimeout(20_000);
  const dataRoot = mkdtempSync(join(tmpdir(), 'zichan-browser-replica-'));
  const nodes = [];
  const stores = [];
  let secondPage;
  try {
    for (const [index, name] of ['first', 'second'].entries()) {
      const node = createSyncServer({ dataDir: join(dataRoot, name), registrationMode: 'open',
        ownerSetupToken: setupToken, allowInsecureHttp: true,
        webDir: resolve(root, 'apps/web/dist'), enableWeb: true });
      nodes.push(node);
      await node.ready;
      node.url = await listen(node, `127.0.0.${index + 1}`);
    }
    const [first, second] = nodes;
    await registerAccount(first.url, 'owner', password, { ownerSetupToken: setupToken });
    await registerAccount(second.url, 'owner', password, { ownerSetupToken: setupToken });
    for (const node of nodes) {
      const store = new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId);
      stores.push(store);
      await store.ready;
    }
    await page.goto(`${first.url}/app/`);
    await page.getByLabel('服务器用户名').fill('owner');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await page.keyboard.press('Escape');
    await saveExpense(page, 'first-browser-entry', 'browser-photo.png');
    await syncSite(page);
    await page.getByRole('button', { name: '新增服务器' }).click();
    await page.getByLabel('完整服务器地址').fill(second.url);
    await page.getByRole('button', { name: '保存地址', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill('owner');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('服务器账号密码', { exact: true })).toHaveValue('');
    await page.getByLabel('这台服务器的账号密码').fill(password);
    await page.getByRole('button', { name: '添加为浏览器同步副本' }).click();
    await expect(page.getByText('由当前浏览器同步的服务器')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '自动同步' })).toBeChecked();
    await expect(page.getByRole('progressbar', { name: '附件传输进度' })).toBeVisible();
    const source = await stores[0].getReplica('owner');
    await expect.poll(async () => (await stores[1].getReplica('owner'))?.ledgerId).toBe(source.ledgerId);
    await expect.poll(async () => (await stores[1].replicaInventory('owner', source.ledgerId)).commitHash)
      .toBe((await stores[0].replicaInventory('owner', source.ledgerId)).commitHash);
    await expect.poll(async () => (await stores[1].replicaInventory('owner', source.ledgerId)).promisedBlobCount)
      .toBeGreaterThan(0);
    const firstInventory = await stores[0].replicaInventory('owner', source.ledgerId);
    const secondInventory = await stores[1].replicaInventory('owner', source.ledgerId);
    expect(secondInventory.promisedBlobHash).toBe(firstInventory.promisedBlobHash);
    expect(secondInventory.missingPromisedBlobCount).toBe(0);
    expect(await stores[0].listNodeReplicationLinks()).toHaveLength(0);
    expect(await stores[1].listNodeReplicationLinks()).toHaveLength(0);

    secondPage = await context.newPage();
    await secondPage.goto(`${second.url}/app/`);
    await secondPage.getByLabel('服务器用户名').fill('owner');
    await secondPage.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await secondPage.getByRole('button', { name: '登录' }).click();
    await expect(secondPage.locator('.zc-app-shell')).toBeVisible();
    await secondPage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await secondPage.getByText('first-browser-entry', { exact: true }).click();
    await expect(secondPage.getByRole('dialog').getByText('browser-photo.png', { exact: true })).toBeVisible();
    await expect.poll(async () => secondPage.getByRole('dialog').getByRole('img', { name: 'browser-photo.png' })
      .evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    await secondPage.keyboard.press('Escape');
    await saveExpense(secondPage, 'second-browser-entry');
    await syncSite(secondPage);
    await page.getByRole('button', { name: '立即同步' }).click();
    await expect.poll(async () => (await stores[0].replicaInventory('owner', source.ledgerId)).commitHash)
      .toBe((await stores[1].replicaInventory('owner', source.ledgerId)).commitHash);
    await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(page.getByText('second-browser-entry', { exact: true })).toBeVisible();

    const beforeLarge = (await stores[1].replicaInventory('owner', source.ledgerId)).promisedBlobCount;
    await saveExpense(secondPage, 'resume-browser-entry', 'large.pdf', largeDocument);
    await syncSite(secondPage);
    await expect.poll(async () => (await stores[1].replicaInventory('owner', source.ledgerId)).promisedBlobCount)
      .toBeGreaterThan(beforeLarge);
    let interrupted = false;
    await page.route('**/api/v3/blobs/*/chunks/1', (route) => {
      interrupted = true;
      return route.abort('failed');
    });
    await openSync(page);
    await page.getByRole('button', { name: '立即同步' }).click();
    await expect.poll(() => interrupted).toBe(true);
    await expect(page.getByText(/上次同步有问题/)).toBeVisible();
    await page.unroute('**/api/v3/blobs/*/chunks/1');
    await page.evaluate(() => {
      window.__browserReplicaResumeProgress = [];
      window.addEventListener('zichan:attachment-transfer-progress', (event) => {
        window.__browserReplicaResumeProgress.push(event.detail);
      });
    });
    const repeatedChunks = [];
    page.on('request', (request) => {
      if (request.url().startsWith(second.url) && /\/api\/v3\/blobs\/[^/]+\/chunks\/\d+$/.test(request.url())) {
        repeatedChunks.push(Number(request.url().split('/').at(-1)));
      }
    });
    await page.getByRole('button', { name: '立即同步' }).click();
    await expect.poll(() => repeatedChunks.includes(1)).toBe(true);
    expect(repeatedChunks).toContain(1);
    expect(repeatedChunks).not.toContain(0);
    await expect.poll(() => page.evaluate(() => window.__browserReplicaResumeProgress
      .some((row) => row.direction === 'download' && row.resumedBytes >= 4 * 1024 * 1024)))
      .toBe(true);
  } finally {
    await secondPage?.close();
    await page.close();
    await Promise.all(stores.map((store) => store.close()));
    for (const node of nodes) node.server.closeAllConnections();
    await Promise.all(nodes.map((node) => node.close()));
    const safePrefix = `${resolve(tmpdir())}${sep}zichan-browser-replica-`;
    if (!resolve(dataRoot).startsWith(safePrefix)) throw new Error('unsafe browser replica test directory');
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
