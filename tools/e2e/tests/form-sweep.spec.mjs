import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.setTimeout(240_000);

/** Labels differ by ledger mode (日常支出 vs 日常收支), so accept both. */
const SCREENS = [
  ['总览'],
  ['资产转换'],
  ['日常支出', '日常收支'],
  ['游戏赛季'],
  ['物品资产'],
  ['支出报表', '报表'],
  ['历史'],
  ['管理'],
  ['同步'],
  ['设置'],
];

async function navigate(page, labels) {
  for (const label of labels) {
    const button = page.locator('.zc-sidebar nav button').filter({ hasText: label }).first();
    if (await button.count()) {
      await button.click();
      await page.waitForTimeout(120);
      return label;
    }
  }
  throw new Error(`找不到导航项：${labels.join(' / ')}`);
}

/** Turn every optional module on, so the sweep covers the whole product, not the default three. */
async function enableAllModules(page) {
  await navigate(page, ['设置']);
  const boxes = page.locator('input[aria-label^="在侧边栏显示"]');
  await expect(boxes.first()).toBeVisible();
  const total = await boxes.count();
  for (let i = 0; i < total; i += 1) {
    const box = boxes.nth(i);
    // Fixed entrances (日常收支 / 设置) stay disabled by design.
    if (!(await box.isEnabled())) continue;
    if (await box.isChecked()) continue;
    await box.click();
    // Each toggle writes settings and disables every switch until the write lands.
    await expect(box).toBeChecked({ timeout: 10_000 });
    await expect(box).toBeEnabled({ timeout: 10_000 });
  }
  return total;
}

async function sidebarLabels(page) {
  return page.locator('.zc-sidebar nav .zc-sidebar-nav-label').allInnerTexts();
}

/** Close a dialog that refused to save; the draft guard may ask for confirmation. */
async function dismissDialog(page, dialog) {
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const guard = page.getByRole('button', { name: '保留草稿并关闭' });
  if (await guard.isVisible().catch(() => false)) await guard.click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Empty-submit a create form and demand that every field it complains about is
 * something the user can actually see, focus and scroll to. This is the exact
 * invariant that was broken before: a required field that is not rendered used
 * to block the save with the message pointing at nothing.
 */
async function saveAndCheckRecovery(page, label) {
  const dialog = page.getByRole('dialog').last();
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  if (!(await save.isVisible().catch(() => false))) {
    // 资产转换 uses its own modal (保存转换), outside the entity-form contract.
    await dismissDialog(page, dialog);
    return 'not-an-entity-form';
  }
  await save.click();
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return 'saved';

  const alert = dialog.getByRole('alert');
  if (!(await alert.isVisible().catch(() => false))) {
    // A string-level refusal still has to say something on screen.
    const text = await dialog.innerText();
    expect(text, `${label}：被拦但没有任何可见提示`).toMatch(/必须|无效|请|不能|需要/);
    await dismissDialog(page, dialog);
    return 'blocked-with-message';
  }

  const chips = alert.getByRole('button');
  const count = await chips.count();
  expect(count, `${label}：错误条没有列出字段`).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const chip = chips.nth(i);
    const name = (await chip.innerText()).trim();
    await chip.click();
    await page.waitForTimeout(500);
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        visible: rect.width > 0 && rect.height > 0,
        inViewport: rect.top >= -2 && rect.bottom <= window.innerHeight + 2,
        insideDialog: !!el.closest('[role="dialog"]'),
        name: el.getAttribute('name') ?? el.id ?? '',
      };
    });
    expect(focused, `${label} / ${name}：点击字段标签后没有焦点`).not.toBeNull();
    expect(['input', 'select', 'textarea'], `${label} / ${name}：焦点落在 ${focused.tag}`).toContain(focused.tag);
    expect(focused.visible, `${label} / ${name}：字段存在但不可见`).toBe(true);
    expect(focused.insideDialog, `${label} / ${name}：焦点跑到弹窗之外`).toBe(true);
    expect(focused.inViewport, `${label} / ${name}：字段没有滚入视口（top/bottom 越界）`).toBe(true);
  }
  await dismissDialog(page, dialog);
  return `blocked(${count})`;
}

/** Open every "+ …" create action in the current view and empty-submit it. */
async function sweepCurrentView(page, screenLabel) {
  const buttons = page.locator('main button');
  const total = await buttons.count();
  const labels = new Set();
  for (let i = 0; i < total; i += 1) {
    const text = ((await buttons.nth(i).innerText().catch(() => '')) || '').trim().split('\n')[0];
    if (text.startsWith('+') || text === '开始记录') labels.add(text);
  }
  const results = [];
  for (const label of labels) {
    const button = page.locator('main button').filter({ hasText: label }).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    if (await button.isDisabled().catch(() => false)) { results.push(`${label}: disabled`); continue; }
    await button.click();
    await expect(page.getByRole('dialog').last()).toBeVisible({ timeout: 10_000 });
    const outcome = await saveAndCheckRecovery(page, `${screenLabel} / ${label}`);
    results.push(`${label}: ${outcome}`);
  }
  return results;
}

/** Screens that group their forms behind tabs (管理 has four) must all be visited. */
async function sweepScreen(page, screenLabel) {
  const tabs = page.locator('main [role="tab"]');
  const tabCount = await tabs.count();
  if (!tabCount) return sweepCurrentView(page, screenLabel);
  const tabLabels = [];
  for (let i = 0; i < tabCount; i += 1) tabLabels.push(((await tabs.nth(i).innerText()) || '').trim());
  const results = [];
  for (const tabLabel of tabLabels) {
    await page.locator('main [role="tab"]').filter({ hasText: tabLabel }).first().click();
    await page.waitForTimeout(150);
    results.push(...await sweepCurrentView(page, `${screenLabel}/${tabLabel}`));
  }
  return results;
}

test('spending mode with every module on: no create form blocks on an invisible field', async ({ page }) => {
  await openLedger(page);
  expect(await sidebarLabels(page)).toEqual(['总览', '日常支出', '物品资产', '设置']);

  const moduleCount = await enableAllModules(page);
  expect(moduleCount).toBe(10);
  expect(await sidebarLabels(page)).toEqual([
    '总览', '资产转换', '日常支出', '游戏赛季', '物品资产', '支出报表', '历史', '管理', '同步', '设置',
  ]);

  const report = {};
  for (const labels of SCREENS) {
    const label = await navigate(page, labels);
    report[label] = await sweepScreen(page, label);
  }
  console.log(`SPENDING_SWEEP ${JSON.stringify(report)}`);
  expect(Object.keys(report)).toHaveLength(10);
});

test('accounts mode with every module on: no create form blocks on an invisible field', async ({ page }) => {
  await openLedger(page);
  await navigate(page, ['设置']);
  await page.getByLabel('记账模式 · 录入深度').selectOption('accounts');
  await page.waitForTimeout(200);
  await enableAllModules(page);

  const report = {};
  for (const labels of SCREENS) {
    const label = await navigate(page, labels);
    report[label] = await sweepScreen(page, label);
  }
  console.log(`ACCOUNTS_SWEEP ${JSON.stringify(report)}`);
  expect(Object.keys(report)).toHaveLength(10);
});

test('spending mode with every module on: a full record-keeping pass end to end', async ({ page }) => {
  await openLedger(page);
  await enableAllModules(page);

  // 1. Daily expense: the amount is the only thing must-type.
  await navigate(page, ['日常支出', '日常收支']);
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const expense = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expect(expense.getByLabel('账户')).toHaveCount(0);
  await expect(expense.getByLabel('类型')).toHaveCount(0);
  await page.getByRole('textbox', { name: /^金额/ }).fill('26.5');
  await page.getByLabel('描述').fill('扫描午餐');
  await expense.getByRole('button', { name: '保存', exact: true }).click();
  await expect(expense).toBeHidden();
  await expect(page.getByText('扫描午餐', { exact: true })).toBeVisible();

  // 2. Game module: creating a game also creates its current season, then a record.
  await navigate(page, ['游戏赛季']);
  await page.getByLabel('游戏名称').fill('扫描游戏');
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ 记录' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '+ 记录' }).click();
  const record = page.getByRole('dialog').last();
  await expect(record).toBeVisible();
  await record.getByRole('button', { name: '保存', exact: true }).click();
  await expect(record).toBeHidden({ timeout: 10_000 });

  // 3. Item asset, record-only cashflow — the shape that used to be impossible to save.
  await navigate(page, ['物品资产']);
  await page.getByRole('button', { name: '+ 新增物品' }).click();
  const asset = page.getByRole('dialog', { name: /新增 · 物品资产/ });
  await expect(asset).toBeVisible();
  await asset.getByLabel('名称').fill('扫描物品');
  await asset.getByRole('button', { name: '保存', exact: true }).click();
  await expect(asset).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText('扫描物品', { exact: true })).toBeVisible();

  // 4. Manage: the base records each module leans on, across all four tabs.
  await navigate(page, ['管理']);
  const manageTab = (name) => page.locator('main [role="tab"]').filter({ hasText: name }).first();
  await manageTab('其他资料').click();
  // Lightweight mode hides the whole 账户 section rather than showing an empty one.
  await expect(page.getByRole('button', { name: '+ 新增账户' })).toHaveCount(0);
  await manageTab('标签与商户').click();
  for (const [action, value] of [
    ['+ 新增商户', '扫描商户'],
    ['+ 新增标签', '扫描标签'],
    ['+ 新增地点', '扫描地点'],
  ]) {
    await page.getByRole('button', { name: action, exact: true }).first().click();
    const dialog = page.getByRole('dialog').last();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('名称').fill(value);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  }
  await expect(page.getByText('扫描商户', { exact: true })).toBeVisible();

  // Nothing above should have needed an account field anywhere.
  await navigate(page, ['总览']);
  await expect(page.locator('main')).toBeVisible();
});
