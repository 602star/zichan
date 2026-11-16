import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.mjs';
import { openTransactions } from './helpers.mjs';

function twoPagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 6 0 R >>',
    ...['0.7 0.1 0 rg 20 20 360 560 re f\n1 1 1 rg BT /F1 24 Tf 40 500 Td (Receipt / Page 1) Tj ET', '0 0.2 0.7 rg 20 20 360 560 re f\n1 1 1 rg BT /F2 36 Tf 40 500 Td <53D17968> Tj ET'].map((content) => `<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [9 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 10 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 800 /StemV 80 >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`previews original images and PDF pages without losing the form at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const errors = [];
    const pdfResources = [];
    page.on('request', (request) => { if (/\.(bcmap|ttf|pfb)(?:\?|$)/.test(request.url())) pdfResources.push(request.url()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await openTransactions(page);
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: viewport.width < 600 ? '快速记账' : '+ 记账', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
    await form.getByLabel(/^金额/).fill('26.80');
    await form.getByLabel('描述', { exact: true }).fill('附件预览验收');
    await form.locator('summary').filter({ hasText: '更多信息' }).click();
    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1200;
      const context = canvas.getContext('2d'); context.fillStyle = '#faf9f5'; context.fillRect(0, 0, 1800, 1200);
      context.fillStyle = '#211d18'; context.font = '72px sans-serif'; context.fillText('Receipt / 26.80', 120, 250);
      context.fillStyle = '#b63226'; context.fillRect(120, 350, 1560, 12);
      return Array.from(Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (value) => value.charCodeAt(0)));
    }));
    await form.getByLabel('附件 / 图片', { exact: true }).setInputFiles([
      { name: '原图凭证.png', mimeType: 'image/png', buffer: png },
      { name: '两页发票.pdf', mimeType: 'application/pdf', buffer: twoPagePdf() },
      { name: '损坏文件.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') },
    ]);
    const imageTrigger = form.getByRole('button', { name: '预览 原图凭证.png', exact: true });
    await imageTrigger.click();
    const viewer = page.getByRole('dialog', { name: '附件预览 · 原图凭证.png', exact: true });
    const image = viewer.getByRole('img', { name: '原图凭证.png', exact: true });
    await expect(image).toBeVisible();
    expect(await image.evaluate((element) => element.naturalWidth)).toBe(1800);
    const initialWidth = await image.evaluate((element) => element.width);
    await viewer.getByRole('button', { name: '放大', exact: true }).click();
    await expect.poll(() => image.evaluate((element) => element.width)).toBeGreaterThan(initialWidth);
    await viewer.getByRole('button', { name: '适应窗口', exact: true }).click();
    const downloadEvent = page.waitForEvent('download');
    await viewer.getByRole('link', { name: '保存', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('原图凭证.png');
    expect(await readFile(await download.path())).toEqual(png);
    await page.screenshot({ path: testInfo.outputPath(`image-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(form).toBeVisible();
    await expect(imageTrigger).toBeFocused();
    await expect(form.getByLabel('描述', { exact: true })).toHaveValue('附件预览验收');

    await form.getByRole('button', { name: '预览 两页发票.pdf', exact: true }).click();
    const pdf = page.getByRole('dialog', { name: '附件预览 · 两页发票.pdf', exact: true });
    await expect(pdf.getByRole('img', { name: 'PDF 第 1 页', exact: true })).toBeVisible();
    await expect(pdf).toContainText('第 1 / 2 页');
    const originalPdfWidth = await pdf.locator('canvas').evaluate((element) => element.width);
    await pdf.getByRole('button', { name: '放大', exact: true }).click();
    await expect.poll(() => pdf.locator('canvas').evaluate((element) => element.width)).toBeGreaterThan(originalPdfWidth);
    await pdf.getByRole('button', { name: '适应窗口', exact: true }).click();
    await pdf.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(pdf.getByRole('img', { name: 'PDF 第 2 页', exact: true })).toBeVisible();
    const canvas = pdf.locator('canvas');
    await expect.poll(() => canvas.evaluate((element) => {
      const pixel = element.getContext('2d').getImageData(element.width / 2, element.height / 2, 1, 1).data;
      return pixel[0] === 0 && pixel[2] > 150 && pixel[3] === 255;
    })).toBe(true);
    expect(await canvas.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const stage = element.closest('.zc-attachment-stage').getBoundingClientRect();
      return bounds.left >= stage.left && bounds.right <= stage.right && bounds.top >= stage.top && bounds.bottom <= stage.bottom;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`pdf-${viewport.width}.png`) });
    expect(pdfResources.some((url) => url.endsWith('.bcmap'))).toBe(true);
    expect(await pdf.evaluate((element) => element.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
    await pdf.getByRole('button', { name: '关闭附件预览', exact: true }).click();
    await form.getByRole('button', { name: '预览 损坏文件.pdf', exact: true }).click();
    const invalid = page.getByRole('dialog', { name: '附件预览 · 损坏文件.pdf', exact: true });
    await expect(invalid.getByRole('alert')).toContainText('PDF 无法读取');
    await expect(invalid.getByRole('link', { name: '保存', exact: true })).toBeVisible();
    await invalid.getByRole('button', { name: '关闭附件预览', exact: true }).click();
    await form.getByRole('button', { name: '移除 损坏文件.pdf', exact: true }).click();
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form).toBeHidden();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'manage', tab: 'attachments' } })));
    await page.getByRole('button', { name: '预览 原图凭证.png', exact: true }).click();
    const storedImage = page.getByRole('dialog', { name: '附件预览 · 原图凭证.png', exact: true }).getByRole('img');
    await expect(storedImage).toBeVisible();
    expect(await storedImage.evaluate((element) => element.naturalWidth)).toBe(1800);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '预览 两页发票.pdf', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '附件预览 · 两页发票.pdf', exact: true }).getByRole('img', { name: 'PDF 第 1 页', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
