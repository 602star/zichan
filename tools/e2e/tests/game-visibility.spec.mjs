import { test, expect } from './fixtures.mjs';

async function start(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '注册新账号', exact: true }).click();
  await page.getByLabel('服务器用户名').fill(`game-visibility-${crypto.randomUUID()}`);
  await page.getByLabel('服务器账号密码', { exact: true }).fill('Payee-unified-password');
  await page.getByLabel('确认账号密码', { exact: true }).fill('Payee-unified-password');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  await page.getByRole('dialog', { name: '新增 · 日常收支' }).getByRole('button', { name: '取消', exact: true }).click();
}


async function navigate(page, name) {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: '••• 更多', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '更多功能' });
  const enable = drawer.getByRole('button', { name: new RegExp(`${name}.*启用`) });
  if (await enable.count()) await enable.click();
  await drawer.getByRole('button', { name: '关闭更多菜单', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.zc-sidebar nav button').filter({ hasText: name }).click();
}

async function save(form) {
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
}

test('game records remain visible, unassigned history can be assigned, and accounts are created in place', async ({ page }, testInfo) => {
  await start(page);
  await navigate(page, '游戏赛季');
  await page.getByLabel('游戏名称').fill('可见性测试游戏');
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await page.getByRole('button', { name: '+ 账号', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新增 · 游戏账号', exact: true });
  await expect(form.getByLabel(/^游戏\*?$/)).toHaveValue(/.+/);
  await form.getByLabel('账号名称').fill('主账号');
  await form.getByLabel('角色名').fill('测试角色');
  await save(form);
  await expect(page.getByLabel('游戏账号筛选').getByRole('option', { name: '主账号' })).toHaveCount(1);
  await page.getByLabel('游戏记录类型筛选').selectOption('produce');
  await page.getByRole('button', { name: '+ 记录', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏记录', exact: true });
  const seasonId = await form.getByLabel('赛季', { exact: true }).inputValue();
  expect(seasonId).not.toBe('');
  await expect(form.getByLabel('账号（可选）')).toHaveValue(/.+/);
  await form.getByLabel('备注', { exact: true }).fill('保存即见的记录');
  await save(form);
  await expect(page.getByRole('button', { name: '编辑游戏记录 保存即见的记录', exact: true })).toBeVisible();
  await expect(page.getByLabel('游戏记录类型筛选')).toHaveValue('all');

  await page.getByRole('button', { name: '+ 赛季', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏赛季', exact: true });
  const seasonLabels = await form.locator('label.zc-label').allTextContents();
  await form.getByLabel('赛季名称').fill('第二赛季');
  await form.getByLabel('游戏时长（h）').fill('8');
  await save(form);
  await expect(page.getByRole('button', { name: /第二赛季/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '+ 记录', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏记录', exact: true });
  const secondSeasonId = await form.getByLabel('赛季', { exact: true }).inputValue();
  expect(secondSeasonId).not.toBe(seasonId);
  await form.getByLabel('赛季', { exact: true }).selectOption('');
  await form.getByLabel('备注', { exact: true }).fill('未归属旧记录');
  await save(form);
  await expect(page.getByRole('button', { name: '编辑游戏记录 未归属旧记录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^未分配赛季/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '编辑游戏记录 未归属旧记录', exact: true }).click();
  form = page.getByRole('dialog', { name: '编辑 · 游戏记录', exact: true });
  await form.getByLabel('赛季', { exact: true }).selectOption(secondSeasonId);
  await save(form);
  await expect(page.getByRole('button', { name: /第二赛季/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '编辑游戏记录 未归属旧记录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(page.getByRole('button', { name: /^编辑游戏记录 / })).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.locator('.zc-game-record-row > :nth-child(3)').first().evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(150);
  await page.screenshot({ path: testInfo.outputPath('game-phone.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: '全部记录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(page.getByRole('button', { name: /^编辑游戏记录 / })).toHaveCount(2);
  await navigate(page, '管理');
  await page.getByRole('tab', { name: '其他资料', exact: true }).click();
  await page.getByRole('button', { name: '+ 新增游戏赛季', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏赛季', exact: true });
  expect(await form.locator('label.zc-label').allTextContents()).toEqual(seasonLabels);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '+ 新增游戏', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏', exact: true });
  await form.getByLabel(/^名称\*?$/).fill('另一款游戏');
  await save(form);
  await navigate(page, '游戏赛季');
  await page.getByLabel('当前游戏').selectOption({ label: '另一款游戏' });
  await page.getByRole('button', { name: '+ 赛季', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏赛季', exact: true });
  await expect(form.getByLabel(/^游戏\*?$/).locator('option:checked')).toHaveText('另一款游戏');
  await form.getByLabel('赛季名称').fill('另一游戏赛季');
  await save(form);
  await page.getByRole('button', { name: '+ 记录', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 游戏记录', exact: true });
  await expect(form.getByLabel(/^游戏\*?$/).locator('option:checked')).toHaveText('另一款游戏');
  await expect(form.getByLabel('赛季', { exact: true }).locator('option:checked')).toHaveText('另一游戏赛季');
  await form.getByLabel('备注', { exact: true }).fill('另一游戏记录');
  await save(form);
  await expect(page.getByRole('button', { name: '编辑游戏记录 另一游戏记录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑游戏记录 保存即见的记录', exact: true })).toHaveCount(0);
});
