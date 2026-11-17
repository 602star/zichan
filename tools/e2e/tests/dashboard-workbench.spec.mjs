import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
test.setTimeout(180_000);
const go = (page, screen, tab) => page.evaluate((detail) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail })), { screen, tab });

test('workbench sheets show real pending bills, card dates and recent entries without inventing repayment amounts', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-15T11:00:00+08:00'));
  await openLedger(page);
  await go(page, 'manage', 'accounts');
  await page.getByRole('button', { name: '+ 新增账户', exact: true }).click();
  let form = page.getByRole('dialog', { name: '添加银行卡或钱包', exact: true });
  await form.getByRole('combobox', { name: '账户类型', exact: true }).selectOption('credit_card');
  await form.getByLabel('账户名称', { exact: true }).fill('生活信用卡');
  await form.getByLabel('当前余额', { exact: true }).fill('-500');
  await form.getByLabel('账单日', { exact: true }).fill('10');
  await form.getByLabel('还款日', { exact: true }).fill('18');
  await form.getByRole('button', { name: '保存并开始使用', exact: true }).click();
  await expect(form).toBeHidden();
  await go(page, 'transactions', 'bills');
  for (const [name, amount, date] of [['房租', '2800', '2026-11-17'], ['网络月费', '35', '2026-11-15'], ['待补记订阅', '12.90', '2026-11-13']]) {
    await page.getByRole('button', { name: '+ 新增账单', exact: true }).click();
    form = page.getByRole('dialog', { name: '新增 · 账单计划', exact: true });
    await form.getByLabel(/^名称/).fill(name);
    await form.getByLabel(/^金额/).fill(amount);
    await form.getByLabel('频率', { exact: true }).selectOption('monthly');
    await form.getByLabel(/^开始日期/).fill(date);
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form).toBeHidden();
  }
  const bill = page.locator('tr').filter({ hasText: '网络月费' });
  await bill.getByRole('button', { name: '登记流水', exact: true }).click();
  await go(page, 'dashboard');
  const agenda = page.getByRole('region', { name: '账单与还款', exact: true });
  const recent = page.getByRole('region', { name: '最近流水', exact: true });
  await expect(agenda.locator('.zc-agenda-row').filter({ hasText: '网络月费' })).toContainText('12-15');
  await expect(agenda.locator('.zc-agenda-row').filter({ hasText: '待补记订阅' })).toContainText('计划日已过 2 天');
  const repayment = agenda.locator('.zc-agenda-row').filter({ hasText: '生活信用卡' });
  await expect(repayment).toContainText('11-18');
  await expect(repayment).toContainText('应还金额请核对账单');
  await expect(repayment).not.toContainText('500');
  const calendar = page.getByRole('region', { name: '日历', exact: true });
  await expect(calendar.getByRole('button', { name: /^2026-11-17，/ })).toContainText('房租');
  await expect(calendar.getByRole('button', { name: /^2026-11-18，/ })).toContainText('生活信用卡');
  // The existing -500 balance also includes the 35 expense just recorded above.
  await expect(page.getByRole('region', { name: '资产配置', exact: true })).toContainText('-535.00 CNY');
  await expect(page.getByRole('region', { name: '资产配置', exact: true })).toContainText('含负余额，仅展示净额');
  await expect(recent).toHaveClass(/zc-card/);
  await expect(recent.getByRole('button', { name: '网络月费', exact: true })).toBeVisible();
  await agenda.getByRole('button', { name: '账户日期', exact: true }).click();
  await expect(agenda.locator('.zc-agenda-row')).toHaveCount(1);
  await agenda.getByRole('button', { name: '全部', exact: true }).click();
  await recent.getByRole('button', { name: '网络月费', exact: true }).click();
  await expect(page.locator('.zc-record-expansion')).toBeVisible();
  await go(page, 'dashboard');
  await page.clock.setFixedTime(new Date('2026-11-16T00:01:00+08:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(repayment).toContainText('2 天后');
  await page.clock.setFixedTime(new Date('2026-11-15T11:00:00+08:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(repayment).toContainText('3 天后');
  await page.getByLabel('快捷时间范围', { exact: true }).selectOption('last_month');
  await expect(calendar.locator('.zc-home-calendar-period')).toContainText('2026 年 11 月');
  await expect(repayment).toContainText('11-18');
  await expect(recent).toContainText('所选期间没有流水');
  await page.getByLabel('快捷时间范围', { exact: true }).selectOption('this_month');
  await repayment.click();
  await expect(page.locator('h1')).toHaveText('账户与核对');
  for (const paper of ['文献纸 · 墨朱', '青灰纸 · 墨朱', '紫灰纸 · 墨朱']) for (const mode of ['浅色', '深色']) {
    await go(page, 'settings');
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: paper, exact: true }).click();
    await page.getByRole('radio', { name: mode, exact: true }).click();
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await go(page, 'dashboard');
      await expect(agenda).toBeVisible();
      if (width <= 390) {
        await expect(agenda.locator('.zc-agenda-row')).toHaveCount(2);
        await agenda.getByRole('button', { name: '展开其余 2 项', exact: true }).click();
        await expect(agenda.locator('.zc-agenda-row')).toHaveCount(4);
        await agenda.getByRole('button', { name: '收起提醒', exact: true }).click();
        const positions = await page.evaluate(() => ({ recent: document.querySelector('.zc-dashboard-recent').getBoundingClientRect().top, agenda: document.querySelector('.zc-dashboard-agenda').getBoundingClientRect().top }));
        expect(positions.recent).toBeLessThan(positions.agenda);
      }
      await expect(page.locator('.zc-card .zc-card')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      await page.screenshot({ path: test.info().outputPath(`${paper}-${mode}-${width}-workbench.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});
