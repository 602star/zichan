import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.mjs';
import { entry, addAndExtract } from './local-order-helpers.mjs';

test.setTimeout(180_000);
test.use({ timezoneId: 'Asia/Shanghai', actionTimeout: 15_000 });
const INVOICE = '00001234567890123456';
async function invoiceImage(page, format = 'image/png') {
  const encoded = await page.evaluate(async ({ format, INVOICE }) => {
    await document.fonts.load('42px "LXGW WenKai Screen"');
    const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1400;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1080, 1400);
    context.fillStyle = '#000'; context.font = '42px "LXGW WenKai Screen", sans-serif';
    ['电子发票（普通发票）', `发票号码：${INVOICE}`, '开票日期：2026年11月23日', '销售方名称：合成示例商店', '金额合计：100.00', '税额：13.00', '价税合计（小写）：113.00', '购买方名称：虚构测试买家', '联系电话：13800138000'].forEach((text, i) => context.fillText(text, 40, 70 + i * 80));
    return canvas.toDataURL(format, .95).split(',')[1];
  }, { format, INVOICE });
  return Buffer.from(encoded, 'base64');
}
function imagePdf(jpeg, pages = 2) {
  const pageIds = Array.from({ length: pages }, (_, index) => 3 + index);
  const imageId = 3 + pages, contentId = imageId + 1, infoId = contentId + 1;
  const content = 'q 540 0 0 700 0 0 cm /Im0 Do Q';
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`),
    ...pageIds.map(() => Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 700] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1080 /Height 1400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.from('<< /Producer (PRIVATE-PDF-META) >>'),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.concat(chunks).length); chunks.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')); }
  const xref = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

test('mobile invoice total and identifiers are editable and opening date stays separate from transaction date', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const form = await entry(page);
  const initialDate = await form.getByLabel('日期', { exact: true }).textContent();
  const panel = await addAndExtract(page, form, { name: 'invoice.png', mimeType: 'image/png', buffer: await invoiceImage(page) });
  await expect(panel.getByLabel('价税合计候选', { exact: true })).toHaveValue('113');
  await expect(panel.getByRole('note')).toContainText('不证明已经付款');
  await expect(panel.getByRole('checkbox', { name: '交易日期', exact: true })).toBeHidden();
  await panel.locator('summary').filter({ hasText: /^发票信息/ }).click();
  await expect(panel.getByLabel('发票号码候选', { exact: true })).toHaveValue(INVOICE);
  await expect(panel.getByLabel('开票日期候选', { exact: true })).toHaveValue('2026-11-23');
  await panel.getByLabel('价税合计候选', { exact: true }).fill('113.01');
  await page.screenshot({ path: test.info().outputPath('invoice-mobile-review.png') });
  await panel.getByRole('tab', { name: '图片与隐私', exact: true }).click();
  await panel.getByLabel('附件保留与隐私', { exact: true }).selectOption('none');
  await page.getByRole('dialog', { name: '附件处理', exact: true }).getByRole('button', { name: '确认并应用', exact: true }).click();
  await expect(form.getByLabel(/^金额/)).toHaveValue('113.01');
  await expect(form.getByLabel('日期', { exact: true })).toHaveText(initialDate);
  await form.getByRole('button', { name: '字段模式：完整', exact: true }).click();
  await expect(form.getByLabel('发票号码', { exact: true })).toHaveValue(INVOICE);
  await expect(form.getByLabel('开票日期', { exact: true })).toHaveValue('2026-11-23');
  await expect(form.getByLabel('订单号', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('备注', { exact: true })).toHaveValue('');
  await form.getByLabel('描述', { exact: true }).fill('发票独立字段验证');
  await form.getByRole('button', { name: '保存', exact: true }).click(); await expect(form).toBeHidden();
  await page.reload();
  await expect(page.locator('.zc-transaction-row').filter({ hasText: '发票独立字段验证' })).toHaveCount(1);
});

test('PDF capture flattens all pages and redacted output contains neither PDF metadata nor either page phone text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  const form = await entry(page), source = imagePdf(await invoiceImage(page, 'image/jpeg'));
  const external = []; page.on('request', (request) => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(page.url()).origin) external.push(request.url()); });
  const panel = await addAndExtract(page, form, { name: 'two-page-invoice.pdf', mimeType: 'application/pdf', buffer: source });
  await expect(panel).toContainText('全部 2 页 PDF');
  await expect(panel.getByLabel('价税合计候选', { exact: true })).toHaveValue('113');
  const privacy = panel.getByRole('region', { name: '附件隐私核对', exact: true });
  await expect.poll(() => privacy.locator('canvas').evaluate((canvas) => [canvas.width, canvas.height])).toEqual([1080, 2800]);
  await expect.poll(() => privacy.locator('canvas').evaluate((canvas) => [680, 2080].map((y) => [...canvas.getContext('2d').getImageData(200, y, 1, 1).data]))).toEqual([[0, 0, 0, 255], [0, 0, 0, 255]]);
  await privacy.getByRole('checkbox', { name: '已检查整张图片并确认隐私遮盖', exact: true }).check();
  await panel.getByRole('button', { name: '确认并应用', exact: true }).click();
  await expect(form.locator('.zc-attachment-item')).toHaveCount(1);
  await expect(form.getByText('订单凭证.png', { exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await form.locator('.zc-attachment-item').getByRole('button', { name: '保存 订单凭证.png', exact: true }).click();
  const saved = await downloading, bytes = await readFile(await saved.path());
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.toString('latin1')).not.toContain('PRIVATE-PDF-META'); expect(bytes.toString('latin1')).not.toContain('/Type /Page');
  await form.getByLabel('附件 / 图片', { exact: true }).setInputFiles({ name: 'keep-original.pdf', mimeType: 'application/pdf', buffer: source });
  const original = form.locator('.zc-attachment-item').last();
  await original.getByRole('button', { name: '提取信息', exact: true }).click();
  await expect(panel).toBeVisible();
  await panel.locator('.zc-attachment-file-tools > summary').click();
  const cancel = panel.getByRole('button', { name: '取消识别', exact: true });
  if (await cancel.isVisible()) await cancel.click();
  await panel.getByLabel('附件保留与隐私', { exact: true }).selectOption('original');
  await panel.getByRole('button', { name: '确认并应用', exact: true }).click();
  await expect(original).toContainText('保留原始 PDF');
  const originalDownloading = page.waitForEvent('download');
  await original.getByRole('button', { name: '保存 keep-original.pdf', exact: true }).click();
  expect(await readFile(await (await originalDownloading).path())).toEqual(source);
  expect(external).toEqual([]);
  // An earlier reviewed PNG draft must remain savable after detection-rule upgrades.
  await form.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find((row) => row.name.endsWith(':database'))?.name;
    if (!name) throw new Error('Account database missing');
    await new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('kv', 'readwrite'), cursor = tx.objectStore('kv').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result; if (!row) return;
          if (String(row.key).startsWith('form-draft.v1.')) {
            const draft = row.value;
            for (const file of Object.values(draft.files).flat()) if (file.privacyReview) file.privacyReview.rulesVersion = 'order-privacy.v1';
            row.update(draft);
          }
          row.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  });
  await page.locator('#transaction-records').getByRole('button', { name: /^\+ 记(账|支出)$/ }).click();
  await form.locator('.zc-entry-draft-list > summary').click();
  await form.getByRole('button', { name: '恢复这份草稿', exact: true }).first().click();
  await form.getByRole('button', { name: '保存', exact: true }).click(); await expect(form).toBeHidden();
});

test('PDF page limit and corrupt input leave their source attachment intact', async ({ page }) => {
  const form = await entry(page), tooMany = imagePdf(await invoiceImage(page, 'image/jpeg'), 7);
  for (const [name, buffer, message] of [['seven-pages.pdf', tooMany, '最多提取 6 页'], ['broken.pdf', Buffer.from('%PDF broken'), 'PDF']]) {
    await form.getByLabel('附件 / 图片', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer });
    const item = form.locator('.zc-attachment-item').last();
    await item.getByRole('button', { name: '提取信息', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText(message);
    await expect(item.getByText(name, { exact: true })).toBeVisible();
    await expect(form.getByLabel('附件 / 图片', { exact: true })).toBeEnabled();
  }
});
