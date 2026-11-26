import { test, expect } from './fixtures.mjs';
import { readFile } from 'node:fs/promises';
import { entry, receipt, addAndExtract } from './local-order-helpers.mjs';
test.setTimeout(180_000);
test.use({ actionTimeout: 15_000 });

test('retention choices are staged, original downloads match source, and ordinary PDF attachments still save', async ({ page }) => {
  const form = await entry(page), image = await receipt(page);
  const panel = await addAndExtract(page, form, image);
  const mode = panel.getByLabel('附件保留与隐私', { exact: true });
  await expect(mode.locator('option')).toHaveCount(3); await expect(mode).toHaveValue('redacted');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('请先确认并应用或放弃');
  await mode.selectOption('none');
  await expect(form.locator('.zc-attachment-item')).toHaveCount(1);
  await mode.selectOption('original');
  await expect(panel.getByRole('region',{name:'附件隐私核对',exact:true})).toBeHidden();
  await expect(panel).toContainText('原图将按普通附件参与同步与备份');
  await panel.getByRole('button',{name:'确认并应用',exact:true}).click();
  const item = form.locator('.zc-attachment-item');
  await expect(item).toHaveCount(1); await expect(item).toContainText('保留原图');
  const downloaded = page.waitForEvent('download'); await item.getByRole('button',{name:`保存 ${image.name}`,exact:true}).click();
  expect(await readFile(await (await downloaded).path())).toEqual(image.buffer);
  await form.getByLabel('附件 / 图片',{exact:true}).setInputFiles({name:'normal.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 sample')});
  await expect(form.locator('.zc-attachment-item')).toHaveCount(2);
  await expect(form.locator('.zc-attachment-item').last().getByRole('button',{name:'提取信息',exact:true})).toHaveCount(0);
  await form.getByRole('button',{name:'保存',exact:true}).click(); await expect(form).toBeHidden();
});

test('mask selection, view switching and edits invalidate review; removing the image retains extracted fields', async ({ page }) => {
  const form=await entry(page),panel=await addAndExtract(page,form,await receipt(page));
  const privacy=panel.getByRole('region',{name:'附件隐私核对',exact:true});
  await privacy.getByRole('button',{name:'取消全选',exact:true}).click(); await expect(privacy).toContainText('当前图片未打码');
  await privacy.getByRole('button',{name:'全选 / 恢复默认打码',exact:true}).click();
  await privacy.getByRole('checkbox',{name:'已检查整张图片并确认隐私遮盖',exact:true}).check();
  await expect(panel.getByRole('button',{name:'确认并应用',exact:true})).toBeEnabled();
  await privacy.getByRole('button',{name:'遮盖整张图片',exact:true}).click();
  await expect(panel.getByRole('button',{name:'确认并应用',exact:true})).toBeDisabled();
  await panel.getByLabel('附件保留与隐私',{exact:true}).selectOption('none');
  await panel.getByRole('button',{name:'确认并应用',exact:true}).click();
  await expect(form.locator('.zc-attachment-item')).toHaveCount(0); await expect(form.getByLabel(/^金额/)).toHaveValue('49.9');
});

test('late form edits win over selected OCR values and save-and-continue starts a clean attachment session', async ({page})=>{
  await page.setViewportSize({width:1280,height:960});
  const form=await entry(page),panel=await addAndExtract(page,form,await receipt(page));
  await form.getByLabel(/^金额/).fill('88.00');
  await panel.getByLabel('附件保留与隐私',{exact:true}).selectOption('none');
  await panel.getByRole('button',{name:'确认并应用',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('已取消冲突字段');
  await expect(form.getByLabel(/^金额/)).toHaveValue('88.00');
  await panel.getByRole('button',{name:'确认并应用',exact:true}).click();
  await expect(panel).toBeHidden();await form.getByLabel('描述',{exact:true}).fill('冲突保护验收');
  await form.getByRole('button',{name:'保存并继续',exact:true}).click();
  await expect(form.getByLabel(/^金额/)).toHaveValue('');await expect(form.locator('.zc-attachment-item')).toHaveCount(0);
  await expect(form.getByLabel('描述',{exact:true})).toHaveValue('');
  await form.getByRole('button',{name:'字段模式：完整',exact:true}).click();
  await expect(form.getByLabel('订单号',{exact:true})).toHaveValue('');await expect(form.getByLabel('物流单号',{exact:true})).toHaveValue('');
});
