import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

async function start(page) {
  await openLedger(page);
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


test('grouped tags and template creation share selection and save rules', async ({ page }) => {
  await start(page);
  await navigate(page, '管理');
  await page.getByRole('tab', { name: '标签与交易对象', exact: true }).click();
  for (const group of ['工作', '个人']) {
    await page.getByRole('button', { name: '+ 新增标签', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新增 · 标签', exact: true });
    await form.getByLabel(/^名称/).fill('差旅');
    await form.getByLabel('分组', { exact: true }).fill(group);
    await save(form);
  }
  await page.getByRole('tab', { name: '其他资料', exact: true }).click();
  await page.getByRole('tab', { name: '交易模板', exact: true }).click();
  await page.getByRole('button', { name: '+ 新增交易模板', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新增 · 交易模板', exact: true });
  await form.getByLabel(/^名称/).fill('差旅模板');
  await form.getByRole('textbox', { name: '标签', exact: true }).fill('差旅');
  await form.getByRole('textbox', { name: '标签', exact: true }).press('Enter');
  await expect(form.getByText('有多个同名标签，请选择分组。')).toBeVisible();
  await expect(form.getByRole('button', { name: /^移除标签/ })).toHaveCount(0);
  await form.getByRole('button', { name: '工作 / 差旅', exact: true }).click();
  await form.getByRole('textbox', { name: '标签', exact: true }).fill('机票');
  await form.getByLabel('新标签分组', { exact: true }).fill('项目');
  await form.getByRole('button', { name: '创建标签“项目 / 机票”', exact: true }).click();
  await save(form);
  await page.getByRole('button', { name: '编辑交易模板 差旅模板', exact: true }).click();
  form = page.getByRole('dialog', { name: '编辑 · 交易模板', exact: true });
  await expect(form.getByRole('button', { name: '移除标签 工作 / 差旅', exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: '移除标签 项目 / 机票', exact: true })).toBeVisible();
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '标签与交易对象', exact: true }).click();
  await page.getByLabel('搜索标签').fill('机票');
  await expect(page.getByRole('row').filter({ hasText: '机票' })).toHaveCount(1);
});

test('account creation and editing preserve metadata, balance origin and default directions', async ({ page }, testInfo) => {
  await start(page);
  await navigate(page, '管理');
  await page.getByRole('tab', { name: '其他资料', exact: true }).click();
  await page.getByRole('tab', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '+ 新增账户', exact: true }).click();
  let form = page.getByRole('dialog', { name: '添加银行卡或钱包', exact: true });
  await expect(form.getByLabel('账户类型').locator('option')).toHaveCount(8);
  await form.getByLabel('账户类型').selectOption('game_platform');
  await form.getByLabel('账户名称').fill('游戏平台余额');
  await form.getByLabel('当前余额').fill('200');
  await form.getByText('更多信息', { exact: true }).click();
  await form.getByLabel('平台', { exact: true }).fill('Steam');
  await form.getByLabel('备注', { exact: true }).fill('账户资料');
  await form.getByRole('button', { name: '保存并开始使用', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: '编辑账户 游戏平台余额', exact: true }).click();
  form = page.getByRole('dialog', { name: '编辑账户', exact: true });
  await expect(form.getByLabel('账户类型')).toHaveValue('game_platform');
  await expect(form.getByLabel('平台', { exact: true })).toHaveValue('Steam');
  await expect(form.getByLabel('备注', { exact: true })).toHaveValue('账户资料');
  await expect(form).toContainText('200');
  await form.getByLabel('今后支出默认使用这个账户').check();
  await form.getByLabel('备注', { exact: true }).fill('更新资料');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('account-edit-phone.png') });
  await save(form);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '编辑账户 游戏平台余额', exact: true }).click();
  form = page.getByRole('dialog', { name: '编辑账户', exact: true });
  await expect(form.getByLabel('今后支出默认使用这个账户')).toBeChecked();
  await expect(form.getByLabel('备注', { exact: true })).toHaveValue('更新资料');
  await expect(form).toContainText('200');
});


test('duplicate accounts can reuse existing data, and same-name schedules require confirmation', async ({ page }) => {
  await start(page);
  await navigate(page, '游戏赛季');
  await page.getByLabel('游戏名称').fill('查重游戏');
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: '+ 账号', exact: true }).click();
    const account = page.getByRole('dialog', { name: '新增 · 游戏账号', exact: true });
    await account.getByLabel('账号名称').fill('主账号');
    await account.getByLabel('区服', { exact: true }).fill('一区');
    await account.getByRole('button', { name: '保存', exact: true }).click();
    if (index === 1) {
      await account.getByRole('button', { name: /查看或使用已有/ }).click();
      const existing = page.getByRole('dialog', { name: '编辑 · 游戏账号', exact: true });
      await expect(existing.getByLabel('账号名称')).toHaveValue('主账号');
      await save(existing);
    }
    await expect(account).toBeHidden();
  }
  await expect(page.getByLabel('游戏账号筛选').locator('option')).toHaveCount(2);
  await navigate(page, '管理');
  await page.getByRole('tab', { name: '其他资料', exact: true }).click();
  await page.getByRole('tab', { name: '计划预算', exact: true }).click();
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: '+ 新增定期交易', exact: true }).click();
    const schedule = page.getByRole('dialog', { name: '新增 · 定期交易', exact: true });
    await schedule.getByLabel(/^名称/).fill('房租');
    await schedule.getByLabel(/^金额/).fill(index === 0 ? '100' : '200');
    await schedule.getByRole('button', { name: '保存', exact: true }).click();
    if (index === 1) {
      const confirm = page.getByRole('dialog', { name: '可能重复的定期交易', exact: true });
      await expect(confirm).toContainText('已有同名计划');
      await confirm.getByRole('button', { name: '仍然创建 / 保存', exact: true }).click();
    }
    await expect(schedule).toBeHidden();
  }
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: '房租', exact: true }) }).filter({ has: page.getByRole('button', { name: '编辑定期交易 房租', exact: true }) })).toHaveCount(2);
});
