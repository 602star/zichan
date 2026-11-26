import { test as base, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { crc32 } from 'node:zlib';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';
import { buildLedgerBackup } from '../../../apps/sync-server/dist/ledger-preview.js';
import { loadCustodyKey } from '../../../apps/sync-server/dist/key-custody.js';
import { registerAccount, loginAccount } from '../../../packages/db/dist/index.js';
import { attachmentRemoteBlobId, deriveAttachmentCryptoContext, decryptAttachmentChunk } from '../../../packages/core/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { entry, receipt, addAndExtract, ORDER, TRACKING, PHONE } from './local-order-helpers.mjs';
import { openLedgerSection } from '../ledger-navigation.mjs';

let instance;
const test = base.extend({ baseURL: async ({}, use) => {
  const token = 'order-privacy-owner-token-0000000000000000';
  instance = createSyncServer({ enableWeb: true, webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)), registrationMode: 'open', ownerSetupToken: token, custodyEnabled: true, accountProtection: 'managed' });
  try { await instance.ready; await listenOnSafePort(instance.server, '127.0.0.1'); const origin = `http://127.0.0.1:${instance.server.address().port}`; await registerAccount(origin, 'privacy-owner', 'privacy-owner-password', { ownerSetupToken: token }); await use(origin); }
  finally { await closeTestSyncServer(instance); }
} });
test.setTimeout(180_000);
test.use({ actionTimeout: 15_000 });
async function pixelCheck(page, bytes, samples) {
  return page.evaluate(async ({ bytes, samples }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return samples.map(([x, y]) => [...ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data]);
  }, { bytes: [...bytes], samples });
}

test('replaces the selected attachment with flattened masks and syncs numbers as ordinary transaction data', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  const form = await entry(page); await form.getByLabel('描述', { exact: true }).fill('订单脱敏验收');
  const panel = await addAndExtract(page, form, await receipt(page));
  const privacy = panel.getByRole('region', { name: '附件隐私核对', exact: true });
  await expect(privacy).toContainText('已执行本地码图检测');
  await expect.poll(() => privacy.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(860, 1010, 1, 1).data])).toEqual([0,0,0,255]);
  await privacy.getByText('手动调整打码区域', { exact: true }).click();
  for (const [label,value] of [['左侧位置','20'],['顶部位置','880'],['遮盖宽度','240'],['遮盖高度','240']]) await privacy.getByLabel(label,{exact:true}).fill(value);
  await privacy.getByRole('button',{name:'添加遮盖区域',exact:true}).click();
  await privacy.getByRole('checkbox',{name:'已检查整张图片并确认隐私遮盖',exact:true}).check();
  await expect(panel.getByRole('button',{name:'确认并应用',exact:true})).toBeEnabled();
  await page.screenshot({path:test.info().outputPath('attachment-inline-desktop.png')});
  await panel.getByRole('button',{name:'确认并应用',exact:true}).click();
  await expect(form.locator('.zc-attachment-item')).toHaveCount(1);
  await expect(form.getByText('订单凭证.png',{exact:true})).toBeVisible();
  await form.getByRole('button',{name:'保存',exact:true}).click(); await expect(form).toBeHidden();
  const serverStore = new SyncServerStore(join(instance.dataDir, 'server.sqlite'), 'open', instance.serverId);
  try {
    const user = (await serverStore.listUsers()).users.find((value) => value.username !== 'privacy-owner'); expect(user).toBeTruthy();
    let material;
    await expect.poll(async () => {
      material = await buildLedgerBackup({ store: serverStore, serverId: instance.serverId, custodyKey: loadCustodyKey(join(instance.dataDir, 'custody.key'), true) }, user.username);
      return material.backup.transactions.some((value) => value.description === '订单脱敏验收') && material.backup.attachments.length === 1;
    }, { timeout: 30_000 }).toBe(true);
    const plaintext = JSON.stringify(material.backup);
    for (const sentinel of [PHONE, '虚构测试姓名', 'PRIVATE-SOURCE']) expect(plaintext).not.toContain(sentinel);
    expect(material.backup.transactions.find(row => row.description === '订单脱敏验收')).toMatchObject({ orderNumber: ORDER, trackingNumber: TRACKING });
    const attachment = material.backup.attachments[0]; expect(attachment.fileName).toBe('订单凭证.png');
    const session = await loginAccount(baseURL, user.username, 'E2E-account-password', { deviceId: 'privacy-verifier-device', deviceName: 'Privacy verifier' });
    const context = await deriveAttachmentCryptoContext(material.crypto, { v: 2, ledgerId: material.ledgerId });
    async function decryptedBlob(sha256, size) {
      const blobId = await attachmentRemoteBlobId(context, sha256), headers = { Authorization: `Bearer ${session.accessToken}` };
      let manifest;
      await expect.poll(async () => { const response = await fetch(`${baseURL}/api/v3/blobs/${blobId}/manifest`, { headers }); if (response.ok) manifest = (await response.json()).manifest; return !!manifest; }, { timeout: 30_000 }).toBe(true);
      const parts = [];
      for (const chunk of manifest.chunks) { const response = await fetch(`${baseURL}/api/v3/blobs/${blobId}/chunks/${chunk.index}`, { headers }); expect(response.ok).toBe(true); parts.push(await decryptAttachmentChunk(context, sha256, { ...chunk, ciphertext: new Uint8Array(await response.arrayBuffer()) }, manifest.chunks.length, size)); }
      return Buffer.concat(parts.map((part) => Buffer.from(part)));
    }
    const samples = [[170 / 1080, 610 / 1400], [170 / 1080, 690 / 1400], [860 / 1080, 1010 / 1400], [100 / 1080, 1000 / 1400]];
    for (const [sha, size] of [[attachment.sha256, attachment.sizeBytes], [attachment.thumbnailSha256, attachment.thumbnailSizeBytes]]) {
      const bytes = await decryptedBlob(sha, size);
      expect(bytes.toString('latin1')).not.toContain('PRIVATE-META');
      expect(await pixelCheck(page, bytes, samples)).toEqual(Array(4).fill([0, 0, 0, 255]));
    }
  } finally { await serverStore.close(); }
});
