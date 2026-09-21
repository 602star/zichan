import { test, expect } from './fixtures.mjs';

async function register(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '注册新账号', exact: true }).click();
  await page.getByLabel('服务器用户名').fill(`payee-${crypto.randomUUID()}`);
  await page.getByLabel('服务器账号密码', { exact: true }).fill('E2E-payee-password');
  await page.getByLabel('确认账号密码', { exact: true }).fill('E2E-payee-password');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你希望怎样开始记账？' })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
}

async function category(page, entry, name) {
  await entry.getByLabel(/^分类/).click();
  const picker = page.getByRole('dialog', { name: '选择分类', exact: true });
  await picker.getByLabel('搜索分类', { exact: true }).fill(name);
  await picker.getByRole('option', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
}

test('contextual platforms, aliases and personal history share a single optional field', async ({ page }) => {
  await register(page);
  let entry = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await category(page, entry, '打车/网约车');
  await entry.getByLabel(/^金额/).fill('23');
  await entry.getByLabel('描述', { exact: true }).fill('平台目录第一次使用');
  const originalCategory = await entry.getByLabel(/^分类/).textContent();
  const originalAccount = await entry.getByLabel('收付款账户').textContent();
  await entry.getByRole('textbox', { name: '商家 / 平台', exact: true }).click();
  await expect(entry.getByRole('button', { name: '滴滴出行', exact: true })).toBeVisible();
  await expect(entry.getByRole('button', { name: '神州租车', exact: true })).toHaveCount(0);
  await entry.getByRole('textbox', { name: '商家 / 平台', exact: true }).fill('JD');
  await entry.getByRole('button', { name: '京东', exact: true }).click();
  await expect(entry.getByLabel(/^分类/)).toHaveText(originalCategory);
  await expect(entry.getByLabel('收付款账户')).toHaveText(originalAccount);
  await expect(entry.getByRole('textbox', { name: '已有商户', exact: true })).toHaveCount(0);
  await expect(entry.getByRole('textbox', { name: '新商户名称', exact: true })).toHaveCount(0);
  await entry.getByRole('button', { name: '保存', exact: true }).last().click();
  await expect(entry).toBeHidden();
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  entry = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await entry.getByRole('textbox', { name: '商家 / 平台', exact: true }).click();
  await expect(entry.getByRole('button', { name: '京东', exact: true })).toBeVisible();
  await entry.getByRole('button', { name: '常用对象', exact: true }).click();
  await expect(entry.getByRole('button', { name: '京东', exact: true })).toBeVisible();
  await entry.getByRole('button', { name: '按场景浏览', exact: true }).click();
  await entry.getByRole('button', { name: '电影与演出', exact: true }).click();
  await expect(entry.getByRole('button', { name: '大麦', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/payee-picker-desktop.png' });
  await entry.getByLabel(/^类型/).selectOption('income');
  await expect(entry.getByRole('textbox', { name: '付款方', exact: true })).toBeVisible();
  await entry.getByRole('textbox', { name: '付款方', exact: true }).fill('项目合作方');
  await entry.getByLabel(/^金额/).fill('200');
  await entry.getByRole('button', { name: '保存', exact: true }).last().click();
  await expect(entry).toBeHidden();
  await page.getByText('平台目录第一次使用', { exact: true }).first().click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '商家 / 平台', exact: true })).toHaveValue('京东');
});

test('scene browsing stays usable on a phone and custom counterpart text saves directly', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page);
  const entry = page.getByRole('dialog');
  const input = entry.getByRole('textbox', { name: '商家 / 平台', exact: true });
  await input.click();
  await entry.getByRole('button', { name: '按场景浏览', exact: true }).click();
  for (const name of ['外卖与餐饮', '商超与生鲜', '电商购物', '打车与用车', '旅行与住宿', '电影与演出', '会员与数字服务', '通信缴费', '快递物流']) {
    await expect(entry.getByRole('button', { name, exact: true })).toBeVisible();
  }
  expect(await entry.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/payee-picker-mobile.png' });
  await input.fill('楼下便利店');
  await entry.getByLabel(/^金额/).fill('12');
  await entry.getByLabel('描述', { exact: true }).fill('自定义交易对象');
  await entry.getByRole('button', { name: '保存', exact: true }).last().click();
  await expect(entry).toBeHidden();
  await page.getByText('自定义交易对象', { exact: true }).first().click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '商家 / 平台', exact: true })).toHaveValue('楼下便利店');
});
