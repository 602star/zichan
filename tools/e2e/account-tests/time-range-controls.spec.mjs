import { test, expect } from '../tests/fixtures.mjs';
import { openLedger, openTransactions } from '../tests/helpers.mjs';

test.use({ timezoneId: 'Asia/Shanghai' });

async function chooseDate(page, label, date) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const picker = page.getByRole('dialog', { name: label, exact: true });
  await picker.getByRole('tab', { name: '年', exact: true }).click();
  await picker.getByRole('button', { name: `${Number(date.slice(0, 4))} 年`, exact: true }).click();
  await picker.getByRole('button', { name: `${Number(date.slice(0, 4))} 年 ${Number(date.slice(5, 7))} 月`, exact: true }).click();
  await picker.getByRole('button', { name: date, exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('button', { name: label, exact: true })).toBeFocused();
}

async function fits(page, locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('touch range selection uses the same calendar without opening text input and supports mobile back', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
  try {
    const page = await context.newPage();
    await openLedger(page);
    await page.getByRole('navigation', { name: '移动端主导航' }).getByRole('button', { name: '收支', exact: true }).tap();
    await page.getByRole('combobox', { name: '快捷时间范围', exact: true }).selectOption('custom');
    const start = page.getByRole('button', { name: '开始日期', exact: true });
    const before = await start.innerText();
    await start.tap();
    const picker = page.getByRole('dialog', { name: '开始日期', exact: true });
    await fits(page, picker);
    expect(await picker.locator('input, textarea, select').count()).toBe(0);
    expect(await page.evaluate(() => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))).toBe(false);
    await page.screenshot({ path: test.info().outputPath('front-calendar-touch.png') });
    await page.goBack();
    await expect(picker).toBeHidden();
    await expect(start).toHaveText(before);
    await expect(start).toBeFocused();
  } finally { await context.close(); }
});

test('front-end range fields share the admin calendar and keep preset and clear semantics', async ({ page }) => {
  await openTransactions(page);
  const preset = page.getByRole('combobox', { name: '快捷时间范围', exact: true });
  await preset.selectOption('all');
  await chooseDate(page, '开始日期', '2026-11-10');
  await expect(preset).toHaveValue('custom');
  await chooseDate(page, '结束日期', '2026-11-12');
  const start = page.getByRole('button', { name: '开始日期', exact: true });
  const end = page.getByRole('button', { name: '结束日期', exact: true });
  await expect(start).toHaveText('2026-11-10');
  await expect(end).toHaveText('2026-11-12');
  await start.click();
  await page.getByRole('dialog', { name: '开始日期', exact: true }).getByRole('button', { name: '下一页' }).click();
  await page.keyboard.press('Escape');
  await expect(start).toHaveText('2026-11-10');
  await expect(start).toBeFocused();
  await preset.selectOption('last_month');
  await expect(preset).toHaveValue('last_month');
  await preset.selectOption('custom');
  for (const [width, dark] of [[1280, false], [390, false], [320, false], [390, true]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await start.click();
    const picker = page.getByRole('dialog', { name: '开始日期', exact: true });
    await fits(page, picker);
    expect(await picker.locator('input, textarea, select').count()).toBe(0);
    expect(await picker.locator('.zc-calendar-grid-day').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(7);
    await page.screenshot({ path: test.info().outputPath(`front-calendar-${width}-${dark ? 'dark' : 'light'}.png`) });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.zc-date-range-bar').getByRole('button', { name: '清除', exact: true }).click();
  await expect(preset).toHaveValue('all');
  await expect(start).toHaveText('选择日期');
  await expect(end).toHaveText('选择日期');
});

test('admin preset dropdowns keep exact local times, UTC boundaries and page-specific options', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/e2e-private-entry/admin/');
  await page.getByLabel('管理账号用户名').fill('test-owner');
  await page.getByLabel('管理账号密码').fill('test-owner-password');
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.getByRole('link', { name: '运行概览', exact: true })).toBeVisible();
  await page.goto('/e2e-private-entry/admin/sync');
  const range = page.getByRole('group', { name: '时间范围', exact: true });
  const preset = range.getByRole('combobox', { name: '快捷时间范围', exact: true });
  await preset.selectOption('24');
  await expect(preset).toHaveValue('24');
  await expect(page).toHaveURL(/from=/);
  expect(new URL(page.url()).searchParams.has('until')).toBe(false);
  await preset.selectOption('custom');
  await chooseDate(page, '起始日期', '2026-11-10');
  await range.getByLabel('起始时分').fill('09:15');
  await chooseDate(page, '结束日期', '2026-11-12');
  await range.getByLabel('结束时分').fill('18:45');
  const unappliedUrl = page.url();
  await range.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page).not.toHaveURL(unappliedUrl);
  expect(new URL(page.url()).searchParams.get('from')).toBe('2026-11-10T01:15:00.000Z');
  expect(new URL(page.url()).searchParams.get('until')).toBe('2026-11-12T10:45:00.000Z');
  await chooseDate(page, '起始日期', '2026-11-11');
  await expect(range.getByLabel('起始时分')).toHaveValue('09:15');
  await expect(range.getByLabel('结束时分')).toHaveValue('18:45');
  await chooseDate(page, '起始日期', '2026-11-15');
  await expect(range.getByRole('button', { name: '应用', exact: true })).toBeDisabled();
  await expect(range.getByText('起始时间晚于结束时间', { exact: false })).toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await range.getByRole('button', { name: '结束日期', exact: true }).click();
    await fits(page, page.getByRole('dialog', { name: '结束日期', exact: true }));
    await page.screenshot({ path: test.info().outputPath(`admin-calendar-${width}.png`) });
    await page.keyboard.press('Escape');
  }
  await preset.selectOption('all');
  await expect(range.getByLabel('起始时分')).toBeDisabled();
  await expect(range.getByLabel('结束时分')).toBeDisabled();
  expect(new URL(page.url()).searchParams.has('from')).toBe(false);
  expect(new URL(page.url()).searchParams.has('until')).toBe(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/e2e-private-entry/admin/monitor');
  await page.getByRole('combobox', { name: '历史趋势时间范围' }).selectOption('1h');
  await expect(page).toHaveURL(/range=1h/);
  await page.goto('/e2e-private-entry/admin/requests');
  const requests = page.getByRole('combobox', { name: '统计时间范围' });
  await expect(requests.locator('option[value="15m"]')).toHaveCount(1);
  await expect(requests.locator('option[value="90d"]')).toHaveCount(1);
  await requests.selectOption('7d');
  await expect(page).toHaveURL(/range=7d/);
  await page.goto('/e2e-private-entry/admin/traffic');
  const traffic = page.getByRole('combobox', { name: '统计时间范围' });
  await expect(traffic.locator('option[value="15m"]')).toHaveCount(0);
  await traffic.selectOption('90d');
  await expect(page).toHaveURL(/range=90d/);
  await page.goto('/e2e-private-entry/admin/logs');
  await expect(page.getByRole('button', { name: '起始日期', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '结束日期', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: '时间范围', exact: true }).getByRole('combobox', { name: '日志时间范围', exact: true })).toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`admin-inline-logs-${width}.png`) });
  }
  await page.getByRole('combobox', { name: '日志时间范围' }).selectOption('custom');
  await expect(page.getByRole('button', { name: '起始日期', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '快捷时间范围', exact: true })).toHaveCount(0);
  await chooseDate(page, '起始日期', '2026-11-10');
  await page.getByLabel('起始时分').fill('09:15');
  await chooseDate(page, '结束日期', '2026-11-11');
  await page.getByLabel('结束时分').fill('10:30');
  const logWindow = page.waitForResponse(response => response.url().includes('/api/admin/log-workspace/system?') && response.url().includes('from='));
  await page.getByRole('group', { name: '时间范围', exact: true }).getByRole('button', { name: '应用', exact: true }).click();
  const logResult = await logWindow; expect(logResult.status()).toBe(200);
  expect((await logResult.json()).meta).toMatchObject({ from: '2026-11-10T01:15:00.000Z', until: '2026-11-11T02:30:00.000Z' });
  expect(errors).toEqual([]);
});
