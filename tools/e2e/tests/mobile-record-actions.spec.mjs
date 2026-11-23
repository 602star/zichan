import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai' });
test.setTimeout(120_000);

async function record(page, amount, description, yesterday = false) {
  await page.locator('#transaction-records').getByRole('button', { name: /^\+ 记(账|支出)$/ }).click();
  const form = page.getByRole('dialog', { name: /^新增 · 日常(收支|支出)$/ });
  await form.getByLabel(/^金额/).fill(amount);
  await form.getByLabel('描述').fill(description);
  if (yesterday) {
    await form.getByRole('button', { name: '字段模式：完整', exact: true }).click();
    await form.getByLabel('日期', { exact: true }).click();
    const date = page.getByRole('dialog', { name: '选择日期', exact: true });
    await date.getByRole('button', { name: '昨天', exact: true }).click();
    await date.getByRole('button', { name: /^确定日期/ }).click();
  }
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
}

function rowFor(page, text) { return page.locator('.zc-transaction-row').filter({ hasText: text }); }

async function touchRow(page, row, { dx = 0, dy = 0, hold = 0 } = {}) {
  await row.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await row.locator('.zc-transaction-summary-title').boundingBox();
  const x = Math.max(35, box.x + Math.min(90, box.width / 2));
  const y = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (hold) await page.waitForTimeout(hold);
  if (dx || dy) for (let step = 1; step <= 8; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
    await page.waitForTimeout(20);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

test('tap reads, holding or swiping opens ledger actions, and refunds update the daily total', async ({ page }) => {
  await openLedger(page);
  await record(page, '50.10', '菜市场采购');
  await record(page, '20.20', '通勤与午餐');
  await record(page, '8', '昨日公交', true);
  const today = page.locator('.zc-transaction-day-summary').filter({ hasText: '今天' });
  const yesterday = page.locator('.zc-transaction-day-summary').filter({ hasText: '昨天' });
  await expect(today).toContainText('支出合计 70.30 CNY');
  await expect(yesterday).toContainText('支出合计 8.00 CNY');
  expect(await today.evaluate((node) => getComputedStyle(node.closest('.zc-transaction-day')).borderTopWidth)).toBe('1px');
  expect(await today.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe('0px');
  const row = rowFor(page, '菜市场采购');
  expect((await row.boundingBox()).height).toBeLessThan(150);

  await row.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scrollBefore = await page.evaluate(() => scrollY);
  await row.locator('.zc-transaction-summary-title').tap();
  const details = page.getByRole('dialog', { name: '流水详情', exact: true });
  await expect(details).toContainText('菜市场采购');
  await expect(details).toContainText('−50.10 CNY');
  await expect(details.locator('input, select, textarea')).toHaveCount(0);
  expect(await page.evaluate(() => scrollY)).toBe(scrollBefore);
  await details.getByRole('button', { name: '关闭流水详情', exact: true }).click();
  expect(await page.evaluate(() => scrollY)).toBe(scrollBefore);

  await touchRow(page, row, { hold: 650 });
  const actions = page.getByRole('dialog', { name: '流水操作', exact: true });
  await expect(actions).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('ledger-actions-phone.png') });
  await actions.getByRole('button', { name: '编辑流水', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑 · 日常收支', exact: true });
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel(/^金额/)).toHaveValue('50.1');
  await edit.getByRole('button', { name: '取消', exact: true }).click();

  // Swiping either way makes a choice visible. It never edits or deletes on release.
  for (const dx of [-80, 80]) {
    await touchRow(page, row, { dx });
    await expect(actions).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await actions.getByRole('button', { name: '关闭流水操作', exact: true }).click();
  }
  await row.getByRole('button', { name: '打开 菜市场采购 的流水操作', exact: true }).click();
  await actions.getByRole('button', { name: /^记录退款/ }).click();
  const refund = page.getByRole('dialog', { name: '新增 · 记录退款', exact: true });
  await refund.getByLabel(/^金额/).fill('10');
  await refund.getByRole('button', { name: '保存', exact: true }).click();
  await expect(refund).toBeHidden();
  await expect(today).toContainText('支出合计 60.30 CNY');
  await expect(yesterday).toContainText('支出合计 8.00 CNY');
  await expect(row.locator('.zc-refund-chip')).toContainText('部分退款');
  await row.getByRole('button', { name: '打开 菜市场采购 的流水操作', exact: true }).click();
  await expect(actions.getByRole('button', { name: '查看退款记录', exact: true })).toBeVisible();
  await actions.getByRole('button', { name: '关闭流水操作', exact: true }).click();
  await today.evaluate((node) => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); });
  await expect(page.locator('.zc-undo-toast')).toBeHidden({ timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath('ledger-days-phone.png') });
});

test('vertical scroll, short swipes and checkboxes keep their own behavior', async ({ page }) => {
  await openLedger(page);
  for (let i = 0; i < 4; i++) await record(page, '1', `日常记录 ${i}`);
  const row = rowFor(page, '日常记录 1');
  await touchRow(page, row, { dx: 25 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await touchRow(page, row, { dy: -100 });
  await page.waitForTimeout(600);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await row.getByRole('checkbox').check();
  await expect(row.getByRole('checkbox')).toBeChecked();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await row.getByRole('checkbox').uncheck();
  await row.focus();
  await page.keyboard.press('Shift+F10');
  const actions = page.getByRole('dialog', { name: '流水操作', exact: true });
  await expect(actions).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toBeHidden();
  await expect(row).toBeFocused();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await row.getByRole('button', { name: /打开.*的流水操作/ }).click();
  const toast = page.locator('.zc-undo-toast');
  if (await toast.count()) {
    const toastLayer = await toast.evaluate((node) => Number(getComputedStyle(node).zIndex));
    const dialogLayer = await actions.evaluate((node) => Number(getComputedStyle(node.parentElement).zIndex));
    expect(toastLayer).toBeLessThan(dialogLayer);
  }
  const box = await actions.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(569);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('ledger-actions-dark-320.png') });
});
