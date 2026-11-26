import { test as base, expect } from '@playwright/test';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { openLedger } from './helpers.mjs';
import { openLedgerSection } from '../ledger-navigation.mjs';

const lanAddress = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
const test = base.extend({ baseURL: async ({}, use) => {
  if (!lanAddress) throw new Error('A real non-loopback IPv4 address is required for the HTTP OCR test');
  const token = 'http-ocr-owner-token-000000000000000000';
  const server = createSyncServer({ enableWeb: true, webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)), registrationMode: 'open', ownerSetupToken: token, allowInsecureHttp: true });
  try {
    await server.ready; await listenOnSafePort(server.server, '0.0.0.0');
    const origin = `http://${lanAddress}:${server.server.address().port}`;
    await registerAccount(origin, 'http-ocr-owner', 'http-ocr-owner-password', { ownerSetupToken: token });
    await use(origin);
  } finally { await closeTestSyncServer(server); }
} });

test.setTimeout(180_000);
test.use({actionTimeout:15000});
test('LAN HTTP uses current attachment for OCR and local masking without persistent cache',async({page,baseURL})=>{
  const {entry,receipt,addAndExtract}=await import('./local-order-helpers.mjs');
  await page.setViewportSize({width:390,height:844});const form=await entry(page);
  expect(await page.evaluate(()=>({secure:isSecureContext,cache:typeof caches,subtle:typeof crypto.subtle,uuid:typeof crypto.randomUUID}))).toEqual({secure:false,cache:'undefined',subtle:'undefined',uuid:'undefined'});
  const external=[],resources=[];page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==new URL(baseURL).origin)external.push(r.url());if(/\/ocr\/.*\.(?:tar|wasm)$/.test(r.url()))resources.push(r.url());});
  const panel=await addAndExtract(page,form,await receipt(page));
  await expect(panel).toContainText('本页临时资源');
  await expect(panel.getByLabel('实付金额候选',{exact:true})).toHaveValue('49.9');
  await panel.getByRole('tab',{name:/^图片与隐私/}).click();
  const privacy=panel.getByRole('region',{name:'附件隐私核对',exact:true});
  await expect(privacy).toContainText('已执行本地码图检测');
  await privacy.getByRole('checkbox',{name:'已检查整张图片并确认隐私遮盖',exact:true}).check();
  await expect(page.getByRole('dialog',{name:'附件处理',exact:true}).getByRole('button',{name:'确认并应用',exact:true})).toBeEnabled();
  await page.screenshot({path:test.info().outputPath('attachment-http-mobile.png')});
  expect(external).toEqual([]);expect(resources).toHaveLength(4);expect(new Set(resources).size).toBe(4);
  await page.getByRole('dialog',{name:'附件处理',exact:true}).getByRole('button',{name:'确认并应用',exact:true}).click();
  await expect(form.getByLabel(/^金额/)).toHaveValue('49.9');await form.getByRole('button',{name:'保存',exact:true}).click();await expect(form).toBeHidden();
});
