import { test, expect } from './fixtures.mjs';

async function start(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '注册新账号', exact: true }).click();
  await page.getByLabel('服务器用户名').fill(`payee-unified-${crypto.randomUUID()}`);
  await page.getByLabel('服务器账号密码', { exact: true }).fill('Payee-unified-password');
  await page.getByLabel('确认账号密码', { exact: true }).fill('Payee-unified-password');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  await page.getByRole('dialog', { name: '新增 · 日常收支' }).getByRole('button', { name: '取消', exact: true }).click();
}

async function manage(page) {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: '••• 更多', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '更多功能' });
  const enable = drawer.getByRole('button', { name: /管理.*启用/ });
  if (await enable.count()) await enable.click();
  await drawer.getByRole('button', { name: '⊞ 管理', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function transactions(page) {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('navigation', { name: '移动端主导航' }).getByRole('button', { name: /日常收支/ }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function choosePayee(form, name, result = name) {
  await form.getByRole('textbox', { name: '商家 / 平台', exact: true }).fill(name);
  await form.getByRole('button', { name: result, exact: true }).click();
}

test('platform directory edits the same counterpart and management searches real names', async ({ page }, testInfo) => {
  await start(page);
  await manage(page);
  await page.getByRole('tab', { name: '标签与交易对象', exact: true }).click();
  await page.getByRole('tab', { name: '平台目录', exact: true }).click();
  await page.getByLabel('平台场景').selectOption('shopping');
  await page.getByLabel('搜索平台目录').fill('JD');
  await page.getByRole('button', { name: '添加并编辑', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新增 · 交易对象', exact: true });
  await form.getByLabel(/^名称/).fill('我的京东采购');
  await form.getByText('选择内置图标', { exact: true }).click();
  await form.getByRole('button', { name: '图标：咖啡', exact: true }).click();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('platform-directory.png'), fullPage: true });
  await page.getByRole('button', { name: '编辑交易对象', exact: true }).click();
  form = page.getByRole('dialog', { name: '编辑 · 交易对象', exact: true });
  await expect(form.getByLabel(/^名称/)).toHaveValue('我的京东采购');
  await expect(form.locator('.zc-icon-preview svg.lucide-coffee')).toBeVisible();
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '我的交易对象', exact: true }).click();
  await page.getByLabel('搜索交易对象').fill('我的京东采购');
  const row = page.getByRole('row').filter({ hasText: '我的京东采购' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '归档/合并', exact: true }).click();
  const lifecycle = page.getByRole('dialog', { name: '归档或合并：我的京东采购', exact: true });
  await expect(lifecycle).toBeVisible();
  await expect(lifecycle).not.toContainText('[object Object]');
  await lifecycle.getByRole('button', { name: '取消', exact: true }).click();
  await transactions(page);
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await entry.getByRole('textbox', { name: '商家 / 平台', exact: true }).click();
  await entry.getByRole('button', { name: '按场景浏览', exact: true }).click();
  await entry.getByRole('button', { name: '电商购物', exact: true }).click();
  await expect(entry.getByRole('button', { name: '我的京东采购', exact: true }).locator('svg.lucide-coffee')).toBeVisible();
  await entry.getByRole('button', { name: '我的京东采购', exact: true }).click();
  await entry.getByLabel(/^金额/).fill('18');
  await entry.getByLabel('描述', { exact: true }).fill('目录采购流水');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toBeHidden();
  await page.getByLabel('流水交易对象', { exact: true }).click();
  const filter = page.getByRole('dialog', { name: '流水交易对象', exact: true });
  await filter.getByLabel('搜索已有交易对象').fill('jd');
  await filter.getByRole('option', { name: '我的京东采购', exact: true }).click();
  await expect(page.getByText('目录采购流水', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除其他筛选', exact: true }).click();
  await expect(page.getByLabel('流水交易对象')).toContainText('全部交易对象');
  await page.getByRole('button', { name: /^高级查询/ }).click();
  await page.getByRole('button', { name: '+ 条件组 OR', exact: true }).click();
  await page.getByLabel('高级查询字段').first().selectOption('payeeId');
  await page.getByLabel('高级查询值', { exact: true }).click();
  const advanced = page.getByRole('dialog', { name: '高级查询值', exact: true });
  await advanced.getByLabel('搜索已有交易对象').fill('淘宝');
  await expect(advanced.getByRole('option', { name: '淘宝', exact: true })).toHaveCount(0);
  await advanced.getByLabel('搜索已有交易对象').fill('jd');
  await advanced.getByRole('option', { name: '我的京东采购', exact: true }).click();
  await expect(page.getByLabel('高级查询值')).toContainText('我的京东采购');
  await page.getByRole('button', { name: '清除其他筛选', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 目录采购流水', exact: true }).check();
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const batch = page.getByRole('dialog', { name: '批量修改流水', exact: true });
  await expect(batch.getByLabel('批量修改交易对象')).toContainText('不改交易对象');
  await batch.getByLabel('批量修改交易对象').click();
  const batchPicker = page.getByRole('dialog', { name: '批量修改交易对象', exact: true });
  await page.setViewportSize({ width: 390, height: 900 });
  const bounds = await batchPicker.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await expect(batchPicker.getByRole('option', { name: '不改交易对象', exact: true })).toBeVisible();
  expect(await batchPicker.getByRole('option', { name: '不改交易对象', exact: true }).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('payee-picker-phone.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(batchPicker.getByRole('option', { name: '不改交易对象', exact: true })).toHaveAttribute('aria-selected', 'true');
  await batchPicker.getByRole('option', { name: '清空交易对象', exact: true }).click();
  await batch.getByRole('button', { name: '预览修改', exact: true }).click();
  await batch.getByRole('button', { name: '确认应用', exact: true }).click();
  await expect(batch).toBeHidden();
  await page.getByLabel('流水交易对象', { exact: true }).click();
  await page.getByRole('dialog', { name: '流水交易对象', exact: true }).getByRole('option', { name: '我的京东采购', exact: true }).click();
  await expect(page.locator('.zc-transaction-row')).toHaveCount(0);
  await page.getByRole('button', { name: '清除其他筛选', exact: true }).click();
  await expect(page.locator('.zc-transaction-row')).toHaveCount(1);
});

test('scheduled entries and templates use the picker and generate referenced counterparts', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: '账单', exact: true }).click();
  await page.getByRole('button', { name: '+ 定期交易', exact: true }).click();
  const schedule = page.getByRole('dialog', { name: '新增 · 定期交易', exact: true });
  await schedule.getByLabel(/^名称/).fill('每月京东采购');
  await schedule.getByLabel(/^金额/).fill('20');
  await schedule.getByLabel('账户', { exact: true }).selectOption({ label: '默认支出账户' });
  await choosePayee(schedule, 'JD', '京东');
  await expect(schedule.getByLabel('商户文本', { exact: true })).toHaveCount(0);
  await schedule.getByRole('button', { name: '保存', exact: true }).click();
  await expect(schedule).toBeHidden();
  const row = page.getByRole('row').filter({ hasText: '每月京东采购' });
  await row.getByRole('button', { name: '生成', exact: true }).click();
  await page.getByRole('button', { name: '流水', exact: true }).click();
  await page.getByLabel('流水交易对象').click();
  await page.getByRole('dialog', { name: '流水交易对象' }).getByRole('option', { name: '京东', exact: true }).click();
  await expect(page.locator('.zc-transaction-row')).toHaveCount(1);
  await manage(page);
  await page.getByRole('tab', { name: '其他资料', exact: true }).click();
  await page.getByRole('button', { name: '+ 新增交易模板', exact: true }).click();
  const template = page.getByRole('dialog', { name: '新增 · 交易模板', exact: true });
  await template.getByLabel(/^名称/).fill('京东模板');
  await template.getByLabel('常用金额', { exact: true }).fill('12');
  await choosePayee(template, 'jd', '京东');
  await template.getByRole('button', { name: '保存', exact: true }).click();
  await expect(template).toBeHidden();
  await page.getByRole('tab', { name: '标签与交易对象', exact: true }).click();
  await page.getByLabel('搜索交易对象').fill('京东');
  await expect(page.getByRole('row').filter({ hasText: '京东' })).toHaveCount(1);
});
