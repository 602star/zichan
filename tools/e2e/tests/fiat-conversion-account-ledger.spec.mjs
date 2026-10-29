import { test, expect } from './fixtures.mjs';

test('fiat conversion appears in account ledger without becoming daily income or expense', async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    Object.defineProperties(navigator.storage, {
      persist: { configurable: true, value: async () => true },
      persisted: { configurable: true, value: async () => true },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '注册新账号', exact: true }).click();
  await page.getByLabel('昵称', { exact: true }).fill('端到端测试用户');
  await page.getByLabel('服务器用户名').fill(`fiat-${crypto.randomUUID()}`);
  await page.getByLabel('服务器账号密码', { exact: true }).fill('E2E-account-password');
  await page.getByLabel('确认账号密码', { exact: true }).fill('E2E-account-password');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  await page.getByRole('button', { name: '记第一笔', exact: true }).click();
  await page.getByRole('dialog', { name: '新增 · 日常收支' }).getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '添加银行卡 / 钱包', exact: true }).click();
  const setup = page.getByRole('dialog', { name: '添加银行卡或钱包' });
  await setup.getByLabel('账户名称').fill('外币账户');
  await setup.getByLabel('当前余额').fill('1000');
  const yesterday = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return date.toLocaleDateString('sv-SE');
  });
  await setup.getByLabel('余额截至').fill(`${yesterday}T00:00`);
  await setup.getByRole('button', { name: '保存并开始使用' }).click();
  await expect(setup).toBeHidden();

  await page.locator('.zc-sidebar nav button').filter({ hasText: '设置' }).click();
  const toggle = page.getByLabel('在侧边栏显示资产转换');
  if (!(await toggle.isChecked())) await toggle.click();
  await page.locator('.zc-sidebar nav button').filter({ hasText: '资产转换' }).click();
  await page.getByRole('button', { name: '+ 新增转换' }).click();
  const conversion = page.getByRole('dialog', { name: '新增资产转换' });
  await conversion.getByLabel('类型', { exact: true }).selectOption('exchange');
  await conversion.getByLabel('标题', { exact: true }).fill('换入美元');
  await conversion.getByRole('button', { name: /USD · 美元/ }).click();
  await conversion.getByLabel('目标资产', { exact: true }).selectOption({ label: 'USD · 美元' });
  await conversion.getByLabel('来源数量', { exact: true }).fill('100');
  await conversion.getByLabel('目标数量', { exact: true }).fill('20');
  const accountId = await conversion.getByLabel('来源账户', { exact: true }).locator('option').filter({ hasText: '外币账户' }).getAttribute('value');
  await conversion.getByLabel('来源账户', { exact: true }).selectOption(accountId);
  await conversion.getByLabel('目标账户', { exact: true }).selectOption(accountId);
  await conversion.getByRole('button', { name: '保存转换', exact: true }).click();
  await expect(conversion).toBeHidden();

  await page.locator('.zc-sidebar nav button').filter({ hasText: '日常收支' }).click();
  await page.getByRole('button', { name: '账户', exact: true }).click();
  const rows = page.getByRole('row').filter({ hasText: '换入美元' });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: '−100 CNY' })).toContainText('900 CNY');
  await expect(rows.filter({ hasText: '+20 USD' })).toContainText('20 USD');
  await page.getByRole('button', { name: '核对账单', exact: true }).click();
  const reconciliation = page.getByRole('dialog', { name: '核对账单' });
  const cnyId = await reconciliation.getByLabel('币种').locator('option').filter({ hasText: 'CNY' }).getAttribute('value');
  await reconciliation.getByLabel('币种').selectOption(cnyId);
  await reconciliation.getByLabel('账单期末余额').fill('900');
  await expect(reconciliation.getByText('期间资产转换 · 自动计入 -100 CNY')).toBeVisible();
  await expect(reconciliation.getByText('差额').locator('..')).toContainText('0');
  await reconciliation.getByRole('button', { name: '完成对账', exact: true }).click();
  await expect(reconciliation).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: '流水', exact: true }).click();
  await expect(page.getByText('换入美元', { exact: true })).toHaveCount(0);
});
