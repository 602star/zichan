import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }) => { page.setDefaultTimeout(12_000); await page.clock.setFixedTime(new Date('2026-11-16T11:00:00Z')); });
const nav = (page, id) => page.locator(`.zc-sidebar [data-destination="${id}"] .zc-sidebar-nav-item`);
const detail = (page) => page.locator('.zc-account-workspace-detail');
const form = (page) => page.getByRole('dialog', { name: '核对账单', exact: true });
const metric = (scope, label) => scope.locator('.zc-card-metric').filter({ has: scope.page().getByText(label, { exact: true }) }).locator('.zc-card-metric-value');
const go = (page, screen, tab) => page.evaluate((data) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: data })), { screen, tab });
async function ownAccount(page, name, kind = 'bank') {
  await nav(page, 'accounts').click();
  await page.getByRole('button', { name: '添加银行卡 / 钱包', exact: true }).click();
  const setup = page.getByRole('dialog', { name: '添加银行卡或钱包', exact: true });
  await setup.getByLabel('账户类型', { exact: true }).selectOption(kind);
  await setup.getByLabel('账户名称', { exact: true }).fill(name);
  await setup.getByLabel('当前余额', { exact: true }).fill('0');
  await setup.getByLabel('余额截至', { exact: true }).fill('2026-11-15T08:00');
  await setup.getByLabel('今后支出默认使用这个账户', { exact: true }).check();
  await setup.getByLabel('今后收入默认使用这个账户', { exact: true }).check();
  await setup.getByRole('button', { name: '保存并开始使用', exact: true }).click();
  await expect(setup).toBeHidden();
}

async function record(page, description, amount) {
  await nav(page, 'records').click();
  await page.locator('#transaction-records').getByRole('button', { name: '+ 记账', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await entry.getByLabel(/^金额/).fill(amount);
  await entry.getByLabel('描述', { exact: true }).fill(description);
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toBeHidden();
}
async function discard(page) {
  await form(page).getByRole('button', { name: '关闭', exact: true }).last().click();
  const guard = page.getByRole('dialog', { name: '关闭未完成的对账', exact: true });
  await guard.getByRole('button', { name: '放弃本次核对', exact: true }).click();
  await expect(form(page)).toBeHidden();
}

test('rapid account actions open one workspace and preserve dirty editing or reconciliation', async ({ page }) => {
  await openLedger(page);
  await ownAccount(page, '自建其他账户', 'other');
  for (const first of ['核对账单', '编辑账户']) {
    await detail(page).evaluate((node, label) => {
      const buttons = [...node.querySelectorAll('button')];
      buttons.find((button) => button.textContent === label).click();
      buttons.find((button) => button.textContent === (label === '核对账单' ? '编辑账户' : '核对账单')).click();
    }, first);
    const active = page.getByRole('dialog', { name: first, exact: true });
    await expect(active).toBeVisible();
    await expect(page.locator('.zc-workspace-editor')).toHaveCount(1);
    await expect(page.locator('.zc-accounts-workspace')).toBeHidden();
    if (first === '核对账单') {
      await expect(active.getByLabel('账单期末余额', { exact: true })).toHaveValue('');
      await expect(active.getByRole('button', { name: '完成对账', exact: true })).toBeDisabled();
      await active.getByLabel('账单期末余额', { exact: true }).fill('123.45');
      await nav(page, 'records').click();
      const guard = page.getByRole('dialog', { name: '关闭未完成的对账', exact: true });
      await guard.getByRole('button', { name: '继续核对', exact: true }).click();
      await expect(active.getByLabel('账单期末余额', { exact: true })).toHaveValue('123.45');
      await discard(page);
    } else {
      await active.getByLabel('账户名称', { exact: true }).fill('未保存名称');
      await detail(page).evaluate((node) => [...node.querySelectorAll('button')].find((button) => button.textContent === '核对账单').click());
      await expect(page.locator('.zc-workspace-editor')).toHaveCount(1);
      await expect(active.getByLabel('账户名称', { exact: true })).toHaveValue('未保存名称');
      await active.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('dialog', { name: '关闭未保存账户', exact: true }).getByRole('button', { name: '放弃修改', exact: true }).click();
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await detail(page).getByRole('button', { name: '核对账单', exact: true }).click();
  await form(page).getByLabel('账单期末余额', { exact: true }).fill('321');
  await page.evaluate(() => history.back());
  const guard = page.getByRole('dialog', { name: '关闭未完成的对账', exact: true });
  await guard.getByRole('button', { name: '继续核对', exact: true }).click();
  await expect(form(page).getByLabel('账单期末余额', { exact: true })).toHaveValue('321');
  await discard(page);
});

test('reconciliation explains outstanding postings, resets adjustment consent and undoes the latest adjustment', async ({ page }) => {
  await openLedger(page);
  await nav(page, 'accounts').click();
  await page.getByRole('button', { name: '添加银行卡 / 钱包', exact: true }).click();
  const setup = page.getByRole('dialog', { name: '添加银行卡或钱包', exact: true });
  await setup.getByLabel('账户名称', { exact: true }).fill('核对用钱包');
  await setup.getByLabel('当前余额', { exact: true }).fill('1000');
  await setup.getByLabel('余额截至', { exact: true }).fill('2026-11-15T08:00');
  await setup.getByLabel('今后支出默认使用这个账户', { exact: true }).check();
  await setup.getByRole('button', { name: '保存并开始使用', exact: true }).click();
  await expect(setup).toBeHidden();
  await record(page, '餐饮已入银行账单', '100');
  await record(page, '网购尚未入银行账单', '50');
  await nav(page, 'accounts').click();
  await expect(detail(page)).toContainText('850.00 CNY');
  await detail(page).getByRole('button', { name: '核对账单', exact: true }).click();
  const reconcile = form(page);
  await reconcile.getByLabel('账单期末余额', { exact: true }).fill('900');
  await expect(metric(reconcile, '余额基准')).toHaveText('1,000.00 CNY');
  await expect(metric(reconcile, '差额')).toHaveText('-100.00 CNY');
  await reconcile.getByLabel('搜索对账记录', { exact: true }).fill('餐饮');
  await reconcile.getByRole('button', { name: '勾选当前列表', exact: true }).click();
  await expect(metric(reconcile, '勾选流水净额')).toHaveText('-100.00 CNY');
  await expect(metric(reconcile, '本次核对余额')).toHaveText('900.00 CNY');
  await expect(metric(reconcile, '差额')).toHaveText('0.00 CNY');
  await expect(reconcile).toContainText('仍有 1 笔未勾选');
  await reconcile.getByRole('button', { name: '完成对账', exact: true }).click();
  await expect(reconcile).toBeHidden();
  await expect(detail(page)).toContainText('850.00 CNY');
  await detail(page).getByRole('button', { name: '核对账单', exact: true }).click();
  await reconcile.getByLabel('账单截止日', { exact: true }).fill('2026-11-17');
  await reconcile.getByLabel('账单期末余额', { exact: true }).fill('880');
  await reconcile.getByRole('button', { name: '勾选当前列表', exact: true }).click();
  await expect(metric(reconcile, '余额基准')).toHaveText('900.00 CNY');
  await expect(metric(reconcile, '差额')).toHaveText('30.00 CNY');
  await reconcile.locator('summary').filter({ hasText: '核对后仍有差额' }).click();
  const consent = reconcile.getByRole('checkbox', { name: '我确认用余额调整处理差额', exact: true });
  await consent.check();
  await expect(reconcile.getByRole('button', { name: '创建调整并完成对账', exact: true })).toBeEnabled();
  await reconcile.getByLabel('账单期末余额', { exact: true }).fill('870');
  await expect(metric(reconcile, '差额')).toHaveText('20.00 CNY');
  await expect(consent).not.toBeChecked();
  await expect(reconcile.getByRole('button', { name: '完成对账', exact: true })).toBeDisabled();
  await consent.check();
  await reconcile.getByLabel('备注', { exact: true }).fill('核实后的历史余额差额');
  await expect(page.locator('.zc-undo-toast')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: test.info().outputPath('reconciliation-adjustment-desktop.png'), fullPage: true });
  await reconcile.getByRole('button', { name: '创建调整并完成对账', exact: true }).click();
  await expect(reconcile).toBeHidden();
  await expect(detail(page)).toContainText('870.00 CNY');
  await detail(page).getByRole('tab', { name: '对账记录', exact: true }).click();
  const latest = detail(page).getByRole('row').filter({ hasText: '2026-11-17' });
  await latest.getByRole('button', { name: '查看对账', exact: true }).click();
  const saved = page.getByRole('dialog', { name: '对账详情', exact: true });
  await expect(saved).toContainText('对账余额调整');
  await saved.getByRole('button', { name: '撤销本次对账', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销本次对账', exact: true }).getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(saved).toBeHidden();
  await expect(detail(page)).toContainText('850.00 CNY');
  await expect(detail(page).getByRole('button', { name: '查看对账', exact: true })).toHaveCount(1);
});

test('reconciliation shares readable paper controls across desktop and phone sizes', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await openLedger(page);
  await ownAccount(page, '自建对账钱包');
  await record(page, '手机账单核对', '100');
  await expect(page.locator('.zc-undo-toast')).toHaveCount(0, { timeout: 15_000 });
  for (const paper of ['文献纸 · 墨朱', '青灰纸 · 墨朱', '紫灰纸 · 墨朱']) for (const mode of ['浅色', '深色']) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, 'settings', 'appearance');
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: paper, exact: true }).click();
    await page.getByRole('radio', { name: mode, exact: true }).click();
    await go(page, 'transactions', 'accounts');
    await page.getByRole('region', { name: '资金账户', exact: true }).getByRole('button', { name: '自建对账钱包', exact: true }).click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await detail(page).getByRole('button', { name: '核对账单', exact: true }).click();
      await form(page).getByLabel('账单期末余额', { exact: true }).fill('-100');
      await form(page).getByRole('button', { name: '勾选当前列表', exact: true }).click();
      await expect(form(page).getByRole('button', { name: '完成对账', exact: true })).toBeEnabled();
      await expect(metric(form(page), '差额')).toHaveText('0.00 CNY');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${paper}/${mode}/${width}`).toBe(true);
      expect(await form(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await expect(page.locator('.zc-card .zc-card')).toHaveCount(0);
      if (width < 768) await form(page).locator('.zc-reconciliation-summary').scrollIntoViewIfNeeded();
      else await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: test.info().outputPath(`${paper}-${mode}-${width}.png`), fullPage: width >= 768 });
      await discard(page);
    }
  }
  expect(errors).toEqual([]);
});
