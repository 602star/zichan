import { test, expect } from './fixtures.mjs';

async function start(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '注册新账号', exact: true }).click();
  await page.getByLabel('昵称', { exact: true }).fill('端到端测试用户');
  await page.getByLabel('服务器用户名').fill(`icons-${crypto.randomUUID()}`);
  await page.getByLabel('服务器账号密码', { exact: true }).fill('Icon-upload-password');
  await page.getByLabel('确认账号密码', { exact: true }).fill('Icon-upload-password');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  await page.getByRole('button', { name: '记第一笔', exact: true }).click();
  await page.getByRole('dialog', { name: '新增 · 日常收支' }).getByRole('button', { name: '取消', exact: true }).click();
}

async function upload(page, form, color = '#0f766e') {
  const data = await page.evaluate((fill) => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = fill; ctx.fillRect(0, 0, 240, 120);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  await form.getByLabel('上传自定义图标').setInputFiles({ name: 'my-icon.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
  const preview = form.locator('.zc-icon-preview img');
  await expect(preview).toHaveAttribute('src', /^data:image\/webp;base64,/);
  expect(await preview.evaluate((img) => img.complete && img.naturalWidth === 128)).toBe(true);
  return preview.getAttribute('src');
}

for (const width of [390, 1280]) test(`payee uploads survive reload and reset at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await start(page);
  await page.getByRole('button', { name: '+ 交易对象', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 交易对象', exact: true });
  await form.getByLabel(/^名称/).fill('我的图标商店');
  const source = await upload(page, form);
  // A rejected file keeps the current preview and remains correctable.
  await form.getByLabel('上传自定义图标').setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(form.getByRole('alert')).toContainText('PNG');
  await expect(form.locator('.zc-icon-preview img')).toHaveAttribute('src', source);
  expect(await form.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await form.screenshot({ path: `test-results/entity-icons-${width}.png` });
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.reload();
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  if (width === 390) {
    await entry.getByRole('button', { name: '常用附加字段', exact: true }).click();
    await entry.getByRole('checkbox', { name: '商家 / 平台', exact: true }).check();
    await entry.getByRole('button', { name: '常用附加字段', exact: true }).click();
  }
  await entry.getByRole('textbox', { name: '商家 / 平台', exact: true }).fill('我的图标商店');
  await expect(entry.getByRole('button', { name: '我的图标商店', exact: true }).locator('img')).toHaveAttribute('src', source);
  await entry.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: '••• 更多', exact: true }).click();
  await page.getByRole('dialog', { name: '更多功能' }).getByRole('button', { name: /管理.*启用/ }).click();
  await page.getByRole('dialog', { name: '更多功能' }).getByRole('button', { name: '⊞ 管理', exact: true }).click();
  await page.setViewportSize({ width, height: 900 });
  await page.getByRole('tab', { name: '标签与交易对象', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: '我的图标商店' });
  await expect(row.locator('img')).toHaveAttribute('src', source);
  await row.click();
  const edit = page.getByRole('dialog', { name: '编辑 · 交易对象', exact: true });
  await upload(page, edit, '#c2410c');
  await edit.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
  await expect(row.locator('img')).toHaveAttribute('src', source);
  await row.click();
  const discard = edit.getByRole('button', { name: '重新开始', exact: true });
  if (await discard.count()) await discard.click();
  await edit.getByRole('button', { name: '恢复默认图标', exact: true }).click();
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(row.locator('img')).toHaveCount(0);
  await expect(row.locator('svg')).toHaveCount(1);
  await row.click();
  await edit.getByText('选择内置图标', { exact: true }).click();
  await edit.getByRole('button', { name: '图标：个人', exact: true }).click();
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(row.locator('svg.lucide-user-round')).toHaveCount(1);
});

test('custom category images appear in search and selection without clipping labels', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: '+ 分类', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 收支分类', exact: true });
  await form.getByLabel(/^名称/).fill('自定义演出票务与交通');
  await form.getByLabel('父级分类', { exact: true }).selectOption({ label: '交通出行' });
  const source = await upload(page, form);
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  const trigger = entry.getByLabel(/^分类/);
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '选择分类', exact: true });
  await picker.getByLabel('搜索分类', { exact: true }).fill('自定义演出票务与交通');
  const option = picker.getByRole('option', { name: /自定义演出票务与交通/ });
  await expect(option.locator('img')).toHaveAttribute('src', source);
  await option.click();
  await expect(trigger.locator('img')).toHaveAttribute('src', source);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await trigger.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});
