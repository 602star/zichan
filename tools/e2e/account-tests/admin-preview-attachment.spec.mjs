import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { httpCommitTransport, loginAccount, registerAccount, syncReplica } from '../../../packages/db/dist/index.js';
import { openLedger } from '../../../packages/db/dist/node.js';
import {
  attachmentRemoteBlobId,
  deriveAttachmentCryptoContext,
  encryptAttachmentChunk,
  sha256Bytes,
  unlockLedgerKeyEnvelope,
} from '../../../packages/core/dist/index.js';

/**
 * Downloading a user's attachment from an administrator preview, in a real browser.
 *
 * The unit tests prove the server decrypts the right object, using the real upload routes. What
 * they cannot prove is the last hop: the console has to fetch a *binary* response, read the
 * filename out of `Content-Disposition`, and hand it to the browser as a download. A JSON-only
 * admin client, or a missing header, would break only here.
 *
 * The ledger is seeded through the same APIs a device uses, including the blob upload, and the
 * user's own navigation preference is set to show 管理 — a preview shows the navigation the user
 * chose, so the attachment list is only reachable if the user had it reachable.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const adminPassword = ['preview', 'attach', 'admin', '0001'].join('-');
const setupToken = 'test-preview-attachment-owner-000000000000';
const userPassword = ['preview', 'attach', 'user', '0001'].join('-');
const fileName = '发票.pdf';
const fileBody = '%PDF-1.4 preview attachment body';

/** Every screen, in the order the app lists them; the preview hides the device-only ones. */
const ALL_SCREENS = ['dashboard', 'convert', 'transactions', 'game', 'fixed', 'reports', 'history', 'manage', 'settings'];

async function listen() {
  const instance = createSyncServer({
    webDir: resolve(root, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    ownerSetupToken: setupToken,
    custodyEnabled: true,
    accountProtection: 'managed',
  });
  await instance.ready;
  await instance.started;
  await new Promise((done) => instance.server.listen(0, '127.0.0.1', done));
  return instance;
}

/** Seed one user ledger holding a single transaction with one encrypted attachment on the server. */
async function seedUserLedger(origin) {
  await registerAccount(origin, 'preview-user', userPassword);
  const account = await loginAccount(origin, 'preview-user', userPassword, {
    deviceId: 'preview-seed-device',
    deviceName: 'Seed device',
  });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${account.accessToken}` };

  const initialized = await fetch(`${origin}/api/v3/protection/initialize`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'managed' }),
  });
  expect(initialized.status).toBe(200);
  const protection = await initialized.json();
  const crypto = await unlockLedgerKeyEnvelope(protection.secret, protection.envelope);

  // Encrypt and upload the body the way a device does, so the server holds a real encrypted blob.
  const plaintext = new TextEncoder().encode(fileBody);
  const sha256 = await sha256Bytes(plaintext);
  const context = await deriveAttachmentCryptoContext(crypto, {
    serverId: protection.envelope.serverId ?? (await (await fetch(`${origin}/api/health`)).json()).serverId,
    ledgerId: crypto.ledgerId,
    username: account.session.username,
  });
  const blobId = await attachmentRemoteBlobId(context, sha256);
  const encrypted = await encryptAttachmentChunk(context, sha256, plaintext, 0, 1, plaintext.byteLength);

  const begun = await fetch(`${origin}/api/v3/blobs/uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      manifest: {
        v: 1,
        blobId,
        cipherBytes: encrypted.ciphertext.byteLength,
        chunkCount: 1,
        chunks: [{
          index: 0,
          sizeBytes: encrypted.ciphertext.byteLength,
          ciphertextSha256: encrypted.ciphertextSha256,
          iv: encrypted.iv,
        }],
      },
    }),
  });
  expect(begun.status).toBe(201);
  const plan = await begun.json();
  const put = await fetch(`${origin}/api/v3/blobs/uploads/${plan.uploadId}/chunks/0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${account.accessToken}` },
    body: encrypted.ciphertext,
  });
  expect(put.status).toBe(200);
  const completed = await fetch(`${origin}/api/v3/blobs/uploads/${plan.uploadId}/complete`, {
    method: 'POST', headers, body: '{}',
  });
  expect(completed.status).toBe(200);

  const ledger = await openLedger({ deviceId: 'PREVIEW-SEED' });
  await ledger.adoptLedgerId(protection.envelope.ledgerId);
  await ledger.assets.put({
    id: 'CNY', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true,
  });
  await ledger.transactions.put({
    id: 'seed-transaction', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    date: '2026-09-01', type: 'expense', category: 'food', amount: '88.00', assetId: 'CNY',
  });
  await ledger.attachments.put({
    id: 'seed-attachment', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    entityType: 'transaction', entityId: 'seed-transaction',
    fileName, mimeType: 'application/pdf', sizeBytes: plaintext.byteLength, sha256,
  });
  // Show 管理 in the sidebar, which is where a ledger keeps its attachment list. The preview uses
  // the user's chosen navigation, so without this the list is unreachable there by design.
  await ledger.settings.put({
    id: 'settings', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    baseCurrencyAssetId: 'CNY', defaultLotMethod: 'fifo', ledgerMode: 'spending',
    navigationLayoutJson: JSON.stringify({ version: 1, order: ALL_SCREENS, visible: ALL_SCREENS }),
  });

  const bound = await fetch(`${origin}/api/v3/replica/bind`, {
    method: 'POST', headers, body: JSON.stringify({ ledgerId: protection.envelope.ledgerId }),
  });
  expect(bound.status).toBe(200);
  await syncReplica(ledger, httpCommitTransport({
    baseUrl: origin,
    token: account.accessToken,
    cryptoSession: crypto,
    keyEnvelope: protection.envelope,
  }), origin);
  await ledger.close();
}

async function signIn(page, origin) {
  await page.goto(`${origin}/e2e-private-entry/admin/`);
  await page.getByLabel('管理账号用户名').fill('owner');
  await page.getByLabel('管理账号密码').fill(adminPassword);
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('link', { name: '运行概览' })).toBeVisible();
}

test('an administrator downloads a user attachment from the read-only preview', async ({ page }, testInfo) => {
  const server = await listen();
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  try {
    // The owner claims the server first, which is what makes them an administrator.
    await registerAccount(origin, 'owner', adminPassword, { ownerSetupToken: setupToken });
    await seedUserLedger(origin);

    await signIn(page, origin);
    await page.goto(`${origin}/e2e-private-entry/admin/preview?username=preview-user`);
    await page.getByLabel('查看原因').fill('核对用户上传的发票');
    await page.getByRole('button', { name: '打开预览' }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });

    await page.locator('.zc-sidebar').getByRole('button', { name: /管理$/ }).click();
    await page.getByRole('tab', { name: '其他资料' }).click();
    await page.getByRole('tab', { name: '附件', exact: true }).click();
    const attachmentRow = page.getByRole('row').filter({ hasText: fileName });
    await expect(attachmentRow).toBeVisible({ timeout: 20_000 });

    // A preview cannot claim this device holds the file, so it says so and offers the download.
    await expect(attachmentRow).toContainText('预览不适用');
    const download = attachmentRow.getByRole('button', { name: '下载' });
    await expect(download).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('preview-attachment.png'), fullPage: true });

    const [saved] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      download.click(),
    ]);
    // Saved under the ledger's own filename, and holding the decrypted bytes rather than the
    // encrypted envelope the server stores.
    expect(saved.suggestedFilename()).toBe(fileName);
    expect(readFileSync(await saved.path()).toString()).toBe(fileBody);
    const closed = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().includes('/api/admin/previews/'));
    await page.getByRole('button', { name: '退出预览', exact: true }).click();
    expect((await closed).status()).toBe(200);
  } finally {
    await page.close();
    server.server.closeAllConnections();
    await server.close();
  }
});
