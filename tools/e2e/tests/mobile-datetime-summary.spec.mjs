import { test, expect } from './fixtures.mjs';
import { openLedger, openTransactions } from './helpers.mjs';

async function fits(panel) {
  const box = await panel.boundingBox();
  const viewport = await panel.page().evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await panel.locator('input, textarea, select').count()).toBe(0);
  expect(await panel.page().evaluate(() => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))).toBe(false);
}

test.setTimeout(90_000);

async function quick(page) {
  const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  if (!await form.isVisible()) await page.getByRole('button', { name: '快速记账', exact: true }).click();
  return form;
}

test.describe('mobile date/time and spending', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai' });

  test('touch picking avoids text focus and daily/weekly totals include all matching records', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-13T12:00:00+08:00') });
    await openLedger(page, { keepQuickExpense: true });
    for (const [amount, date] of [['0.10', 'today'], ['0.20', 'today'], ['10', 'yesterday'], ['100', 'previous-week']]) {
      const form = await quick(page);
      await form.getByLabel(/^金额/).fill(amount);
      if (date !== 'today') {
        await form.getByLabel('日期', { exact: true }).click();
        const picker = page.getByRole('dialog', { name: '选择日期', exact: true });
        await fits(picker);
        await expect(picker.locator('.zc-calendar-sublabel').first()).toBeVisible();
        if (date === 'yesterday') await picker.getByRole('button', { name: '昨天', exact: true }).click();
        else await picker.getByRole('button', { name: '2026-11-08', exact: true }).click();
        await picker.getByRole('button', { name: /^确定日期/ }).click();
        await expect(form.getByLabel('日期', { exact: true })).toBeFocused();
      }
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect(form).toBeHidden();
    }
    const periods = page.getByRole('group', { name: /^每日每周支出/ });
    await expect(periods.getByRole('button', { name: /今日支出/ })).toContainText('0.30');
    await expect(periods.getByRole('button', { name: /本周支出/ })).toContainText('10.30');
    await expect(page.locator('.zc-transaction-day-summary').filter({ hasText: '今天' })).toContainText(/支出.*0.30/);
    await expect(page.locator('.zc-transaction-day-summary').filter({ hasText: '昨天' })).toContainText(/支出.*10.00/);
    await periods.getByRole('button', { name: /本周支出/ }).click();
    await expect(page.getByLabel('快捷时间范围')).toHaveValue('this_week');
    await expect(page.locator('.zc-transaction-row')).toHaveCount(3);
    await periods.getByRole('button', { name: /今日支出/ }).click();
    await expect(page.locator('.zc-transaction-row')).toHaveCount(2);
    const guide = page.getByRole('region', { name: '首次记账引导' });
    if (await guide.isVisible()) await guide.getByRole('button', { name: '收起', exact: true }).click();
    await expect(page.getByText('已保存流水', { exact: true })).toBeHidden({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('spending-phone.png'), fullPage: false });

    const form = await quick(page);
    await form.getByLabel(/^金额/).fill('38');
    await form.getByText('更多信息', { exact: true }).click();
    await form.getByLabel('交易时间', { exact: true }).click();
    const time = page.getByRole('dialog', { name: '选择交易时间', exact: true });
    await fits(time);
    const minutes = time.locator('.zc-time-options').nth(1);
    const scrollBefore = await minutes.evaluate((node) => node.scrollTop);
    const minuteBox = await minutes.boundingBox();
    const session = await page.context().newCDPSession(page);
    const x = minuteBox.x + minuteBox.width / 2;
    const y = minuteBox.y + minuteBox.height - 20;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 20 }] });
      await page.waitForTimeout(20);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => minutes.evaluate((node) => node.scrollTop)).toBeGreaterThan(scrollBefore);
    await session.detach();
    await time.getByRole('button', { name: '23时', exact: true }).click();
    await time.getByRole('button', { name: '59分', exact: true }).click();
    await expect(time.locator('output')).toHaveText('23:59');
    await page.screenshot({ path: test.info().outputPath('time-phone.png'), fullPage: false });
    await time.getByRole('button', { name: '确定时间', exact: true }).click();
    await expect(form.getByLabel('交易时间', { exact: true })).toHaveText('23:59');
    await expect(form.getByLabel('交易时间', { exact: true })).toBeFocused();
    await form.getByLabel('日期', { exact: true }).click();
    const date = page.getByRole('dialog', { name: '选择日期', exact: true });
    await date.getByRole('button', { name: '昨天', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('date-phone.png'), fullPage: false });
    await date.getByRole('button', { name: '取消', exact: true }).click();
    await expect(form.getByLabel('日期', { exact: true })).toHaveText('2026-11-13');
  });

  test('full entry picker supports year/month/day at 320px and dark mode', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await openLedger(page);
    await page.locator('#transaction-records').getByRole('button', { name: /^\+ 记(账|支出)$/ }).click();
    const form = page.getByRole('dialog', { name: /^新增 · 日常(收支|支出)$/ });
    await form.getByLabel(/^金额/).fill('12');
    await form.getByText('更多信息', { exact: true }).click();
    await form.getByLabel('日期', { exact: true }).click();
    const date = page.getByRole('dialog', { name: '选择日期', exact: true });
    await fits(date);
    await date.getByRole('button', { name: '年', exact: true }).click();
    await date.getByRole('button', { name: '2024 年', exact: true }).click();
    await date.getByRole('button', { name: '2 月', exact: true }).click();
    await date.getByRole('button', { name: '2024-02-29', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('date-dark-320.png'), fullPage: false });
    await date.getByRole('button', { name: /^确定日期/ }).click();
    await expect(form.getByLabel('日期', { exact: true })).toHaveText('2024-02-29');
    await expect(form.getByLabel(/^金额/)).toHaveValue('12');
  });
});

test('desktop retains keyboard date and time entry', async ({ page }) => {
  await openTransactions(page);
  await page.locator('#transaction-records').getByRole('button', { name: /^\+ 记(账|支出)$/ }).click();
  const form = page.getByRole('dialog', { name: /^新增 · 日常(收支|支出)$/ });
  await form.getByLabel('日期', { exact: true }).fill('2026-11-12');
  await form.getByText('更多信息', { exact: true }).click();
  await form.getByLabel('交易时间', { exact: true }).fill('09:35');
  await expect(form.getByLabel('日期', { exact: true })).toHaveValue('2026-11-12');
  await expect(form.getByLabel('交易时间', { exact: true })).toHaveValue('09:35');
  await expect(page.locator('.zc-datetime-panel')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('datetime-desktop.png'), fullPage: false });
});
