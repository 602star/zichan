import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

/*
 * The desktop sweep walks the sidebar and a page-level scroll container. On a
 * phone the same forms are reached through the bottom bar and the 更多 drawer,
 * and the form panel is its own scroll container capped at 90vh. So the two
 * questions this file answers that the desktop sweep cannot:
 *
 *   1. does the refuse-then-jump recovery still work when the field is inside a
 *      nested scroll panel rather than the document, and
 *   2. is the recovery affordance itself usable by a thumb.
 */

test.use({ hasTouch: true, isMobile: true });

test.setTimeout(300_000);

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
  /*
   * Past 767px the shell goes back to the sidebar, but a coarse pointer still
   * pulls in the 44px / 16px touch rules - so these are the desktop columns
   * holding phone-sized controls, not a wider phone. Landscape also squeezes the
   * panel to 90vh of 390px, the shortest frame any of these forms has to fit in.
   */
  { name: '844x390', width: 844, height: 390 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1024x768', width: 1024, height: 768 },
];

const SCREENS = [
  ['总览', 'dashboard'],
  ['资产转换', 'convert'],
  ['日常支出', 'transactions'],
  ['游戏赛季', 'game'],
  ['物品资产', 'fixed'],
  ['报表', 'reports'],
  ['历史', 'history'],
  ['管理', 'manage'],
  ['设置', 'settings'],
];

/** Navigate through whichever chrome this viewport uses: bottom bar or sidebar. */
async function clickNav(page, label) {
  const first = await page.evaluate((target) => {
    const norm = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, '');
    const nav = document.querySelector('.zc-mobile-bottom-nav');
    if (!nav || getComputedStyle(nav).display === 'none') {
      // 768px and wider keeps the desktop shell even with a coarse pointer.
      const sidebar = document.querySelector('.zc-sidebar');
      if (!sidebar || getComputedStyle(sidebar).display === 'none') return 'no-nav';
      const items = [...sidebar.querySelectorAll('nav button')];
      const hit = items.find((b) => norm(b).endsWith(target));
      if (!hit) return `no-sidebar-item:${items.map(norm).join('|')}`;
      hit.click();
      return 'sidebar';
    }
    const buttons = [...nav.querySelectorAll('button')];
    const direct = buttons.find((b) => norm(b).endsWith(target));
    if (direct) { direct.click(); return 'nav'; }
    const more = buttons.find((b) => norm(b).includes('更多'));
    if (!more) return `no-more:${buttons.map(norm).join('|')}`;
    more.click();
    return 'drawer';
  }, label);
  if (first === 'drawer') {
    await page.waitForTimeout(300);
    const second = await page.evaluate((target) => {
      const drawer = document.querySelector('.zc-mobile-drawer');
      if (!drawer) return 'no-drawer';
      const buttons = [...drawer.querySelectorAll('button')].filter((b) => !b.classList.contains('zc-mobile-drawer-add'));
      const hit = buttons.find((b) => (b.textContent || '').replace(/\s+/g, '').endsWith(target));
      if (!hit) return `missing:${buttons.map((b) => (b.textContent || '').trim()).join('|')}`;
      hit.click();
      return 'ok';
    }, label);
    if (second !== 'ok') throw new Error(`drawer navigation failed for ${label}: ${second}`);
  } else if (first !== 'nav' && first !== 'sidebar') {
    throw new Error(`navigation failed for ${label}: ${first}`);
  }
  await page.waitForTimeout(450);
}

/**
 * Enable the hidden modules the way a phone user does: 更多 → 未启用模块 → 启用.
 * This is a different code path from the Settings checkboxes the desktop sweep
 * drives, so it needs its own coverage. The drawer stays open across taps, so
 * the whole run happens inside one drawer session.
 */
async function enableHiddenModulesFromDrawer(page) {
  await page.locator('.zc-mobile-bottom-nav button', { hasText: '更多' }).click();
  const drawer = page.getByRole('dialog', { name: '更多功能' });
  await expect(drawer).toBeVisible();
  const add = drawer.locator('.zc-mobile-drawer-add');
  const enabled = [];
  for (let round = 0; round < 12; round += 1) {
    const left = await add.count();
    if (left === 0) break;
    const name = (await add.first().innerText()).replace(/\s+/g, ' ').trim();
    await add.first().click();
    // Enabling is a settings write; the button reports progress and the entry
    // then moves out of 未启用模块 into the drawer grid.
    await expect(add).toHaveCount(left - 1, { timeout: 20_000 });
    enabled.push(name);
  }
  expect(await add.count(), '抽屉里仍有未启用的模块').toBe(0);
  await drawer.getByRole('button', { name: '关闭更多菜单' }).click();
  await expect(drawer).toBeHidden();
  return enabled;
}

/**
 * Enable every module using whichever control this chrome actually offers: the
 * drawer below 768px, the Settings checkboxes above it. Both are real user paths
 * and they are separate code, so neither can stand in for the other.
 */
async function enableAllModules(page) {
  const usesBottomBar = await page.evaluate(() => {
    const nav = document.querySelector('.zc-mobile-bottom-nav');
    return !!nav && getComputedStyle(nav).display !== 'none';
  });
  if (usesBottomBar) return enableHiddenModulesFromDrawer(page);

  await clickNav(page, '设置');
  const boxes = page.locator('input[aria-label^="在侧边栏显示"]');
  await expect(boxes.first()).toBeVisible({ timeout: 15_000 });
  const total = await boxes.count();
  const enabled = [];
  for (let i = 0; i < total; i += 1) {
    const box = boxes.nth(i);
    // Fixed entrances (日常收支 / 设置) stay disabled by design.
    if (!(await box.isEnabled())) continue;
    if (await box.isChecked()) continue;
    await box.click();
    await expect(box).toBeChecked({ timeout: 10_000 });
    await expect(box).toBeEnabled({ timeout: 10_000 });
    enabled.push(i);
  }
  return enabled;
}

/**
 * Once everything is on, all ten modules must be reachable from the chrome this
 * viewport uses: three slots plus the 更多 drawer on a phone, the whole sidebar
 * above 768px. A module that is enabled but unreachable is still a lost module.
 */
async function assertEveryModuleReachable(page) {
  const usesBottomBar = await page.evaluate(() => {
    const nav = document.querySelector('.zc-mobile-bottom-nav');
    return !!nav && getComputedStyle(nav).display !== 'none';
  });
  if (!usesBottomBar) {
    const labels = await page.locator('.zc-sidebar nav .zc-sidebar-nav-label').allInnerTexts();
    expect(labels.length, '侧栏应露出全部 10 个模块').toBe(10);
    return;
  }
  await page.locator('.zc-mobile-bottom-nav button', { hasText: '更多' }).click();
  const drawer = page.getByRole('dialog', { name: '更多功能' });
  await expect(drawer).toBeVisible();
  const drawerLabels = await drawer.locator('.zc-mobile-drawer-grid button b').allInnerTexts();
  await drawer.getByRole('button', { name: '关闭更多菜单' }).click();
  await expect(drawer).toBeHidden();
  expect(drawerLabels.length + 3, '底栏与抽屉应合起来露出全部 10 个模块').toBe(10);
  expect(drawerLabels.join(' '), '未启用模块区应已清空').not.toContain('启用');
}

/** Open every "+ …" create action in the current view and empty-submit it. */
async function sweepCurrentView(page, scope, report) {
  const buttons = page.locator('.zc-page-content button');
  const total = await buttons.count();
  const labels = new Set();
  for (let i = 0; i < total; i += 1) {
    const text = ((await buttons.nth(i).innerText().catch(() => '')) || '').trim().split('\n')[0];
    if (text.startsWith('+') || text === '开始记录') labels.add(text);
  }
  for (const label of labels) {
    const button = page.locator('.zc-page-content button').filter({ hasText: label }).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    if (await button.isDisabled().catch(() => false)) { report.push(`${scope} / ${label}: disabled`); continue; }
    await button.click();
    const dialog = page.getByRole('dialog').last();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    report.push(`${scope} / ${label}: ${await saveAndCheckRecovery(page, `${scope} / ${label}`, dialog)}`);
  }
}

/**
 * Empty-submit and demand that every field the form complains about is reachable
 * on a phone: focusable, inside the panel's own scroll box (not just the window),
 * and clear of the bottom bar.
 */
async function saveAndCheckRecovery(page, label, dialog) {
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  if (!(await save.isVisible().catch(() => false))) {
    /*
     * 资产转换 is the one dialog outside the entity-form contract: its refusals are
     * plain strings with no field to point at, and the panel is taller than any
     * phone screen. A refusal still has to be readable where the user just tapped,
     * so this asserts the message is announced and lands inside the panel.
     */
    const conversionSave = dialog.getByRole('button', { name: /保存转换|预览影响/ }).first();
    if (!(await conversionSave.isVisible().catch(() => false))) {
      await dismissDialog(page, dialog);
      return 'not-an-entity-form';
    }
    await conversionSave.click();
    const refused = dialog.getByRole('alert');
    await expect(refused, `${label}：被拒后没有可朗读的提示`).toBeVisible({ timeout: 15_000 });
    const seen = await refused.evaluate((node) => {
      const panel = node.closest('[role="dialog"]');
      const rect = node.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return {
        inside: rect.top >= panelRect.top - 2 && rect.bottom <= panelRect.bottom + 2,
        text: (node.textContent || '').trim(),
      };
    });
    expect(seen.inside, `${label}：拒绝原因滚出了弹窗可视区`).toBe(true);
    expect(seen.text.length, `${label}：拒绝原因不能是空提示`).toBeGreaterThan(3);
    await dismissDialog(page, dialog);
    return 'refused-visibly';
  }
  await save.scrollIntoViewIfNeeded();
  await save.click();
  await page.waitForTimeout(400);
  if (!(await dialog.isVisible().catch(() => false))) return 'saved';

  const alert = dialog.getByRole('alert');
  if (!(await alert.isVisible().catch(() => false))) {
    const text = await dialog.innerText();
    expect(text, `${label}：被拦但没有任何可见提示`).toMatch(/必须|无效|请|不能|需要/);
    await dismissDialog(page, dialog);
    return 'blocked-with-message';
  }

  // On a phone the panel is about 90vh tall, and a refused save jumps the panel to
  // the first bad field, which can push the summary out of view. That is fine as
  // long as the reason is still on screen: the summary, or the field's own message.
  const refusal = await dialog.evaluate((panel) => {
    const panelRect = panel.getBoundingClientRect();
    const inView = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && rect.top >= panelRect.top - 2 && rect.bottom <= panelRect.bottom + 2;
    };
    const alert = panel.querySelector('[role="alert"]');
    const messages = alert
      ? [...alert.querySelectorAll('button')].map((b) => b.getAttribute('title')).filter(Boolean)
      : [];
    const inlineVisible = messages.filter((message) => [...panel.querySelectorAll('div, span, small, p')]
      .some((el) => el.children.length === 0 && (el.textContent || '').trim() === message && inView(el)));
    return {
      alertInView: !!alert && inView(alert),
      inlineVisible,
      messageCount: messages.length,
      activeTag: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
      activeInsidePanel: !!document.activeElement && panel.contains(document.activeElement),
    };
  });
  expect(
    refusal.alertInView || refusal.inlineVisible.length > 0,
    `${label}：被拦后屏幕上既看不到错误条，也看不到字段自身的错误文案`,
  ).toBe(true);

  const chips = alert.getByRole('button');
  const count = await chips.count();
  expect(count, `${label}：错误条没有列出字段`).toBeGreaterThan(0);

  const smallChips = [];
  for (let i = 0; i < count; i += 1) {
    const chip = chips.nth(i);
    const name = (await chip.innerText()).trim();
    const box = await chip.boundingBox();
    // 44px is the same floor the layout contract holds the rest of the phone UI to.
    if (box && box.height < 44 - 1) smallChips.push(`${name}=${Math.round(box.height)}px`);

    await chip.click();
    await page.waitForTimeout(700);
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const panel = el.closest('[role="dialog"]');
      const rect = el.getBoundingClientRect();
      const panelRect = panel ? panel.getBoundingClientRect() : null;
      const nav = document.querySelector('.zc-mobile-bottom-nav');
      const navRect = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
      return {
        tag: el.tagName.toLowerCase(),
        visible: rect.width > 0 && rect.height > 0,
        insideDialog: !!panel,
        // The panel scrolls, so the window is not the frame that matters.
        withinPanel: panelRect
          ? rect.top >= panelRect.top - 2 && rect.bottom <= panelRect.bottom + 2
          : null,
        behindNav: navRect ? rect.bottom > navRect.top + 1 && rect.top < navRect.bottom : false,
      };
    });
    expect(focused, `${label} / ${name}：点击字段标签后没有焦点`).not.toBeNull();
    expect(['input', 'select', 'textarea'], `${label} / ${name}：焦点落在 ${focused.tag}`).toContain(focused.tag);
    expect(focused.visible, `${label} / ${name}：字段存在但不可见`).toBe(true);
    expect(focused.insideDialog, `${label} / ${name}：焦点跑到弹窗之外`).toBe(true);
    expect(focused.withinPanel, `${label} / ${name}：跳转后字段仍在面板滚动区之外`).toBe(true);
    expect(focused.behindNav, `${label} / ${name}：跳转后字段被底部导航遮住`).toBe(false);
  }
  expect(smallChips.join(', '), `${label}：错误标签小于 44px 触控高度`).toBe('');

  await dismissDialog(page, dialog);
  return `blocked(${count})`;
}

async function dismissDialog(page, dialog) {
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const guard = page.getByRole('button', { name: '保留草稿并关闭' });
  if (await guard.isVisible().catch(() => false)) await guard.click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
}

/** Screens that group their forms behind tabs (管理 has four) must all be visited. */
async function sweepScreen(page, label, report) {
  report[label] = report[label] ?? [];
  const tabs = page.locator('.zc-page-content [role="tab"]');
  const tabCount = await tabs.count();
  if (!tabCount) return sweepCurrentView(page, label, report[label]);
  const tabLabels = [];
  for (let i = 0; i < tabCount; i += 1) tabLabels.push(((await tabs.nth(i).innerText()) || '').trim());
  for (const tabLabel of tabLabels) {
    await page.locator('.zc-page-content [role="tab"]').filter({ hasText: tabLabel }).first().click();
    await page.waitForTimeout(200);
    await sweepCurrentView(page, `${label}/${tabLabel}`, report[label]);
  }
}

for (const vp of VIEWPORTS) {
  test(`${vp.name}: with every module on, no create form blocks on a field that cannot be reached`, async ({ page }) => {
    const ownerSetupToken = 'test-mobile-sweep-owner-000000000000';
    const server = createSyncServer({
      enableWeb: true,
      webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
      registrationMode: 'open',
      ownerSetupToken,
    });

    try {
      await server.ready;
      await new Promise((done, reject) => {
        server.server.once('error', reject);
        server.server.listen(0, '127.0.0.1', done);
      });
      const base = `http://127.0.0.1:${server.server.address().port}`;
      await registerAccount(base, 'sweep-owner', 'sweep-owner-password', { ownerSetupToken });
      await registerAccount(base, 'sweep-user', 'sweep-user-password');

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${base}/app/`);
      await page.getByLabel('服务器用户名').fill('sweep-user');
      await page.getByLabel('服务器账号密码').fill('sweep-user-password');
      await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
      await page.getByRole('button', { name: '直接开始记支出', exact: true }).click({ timeout: 30_000 });
      await page.getByRole('dialog', { name: '记一笔支出' }).waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: '关闭快速记账' }).click();
      await page.getByRole('dialog', { name: '记一笔支出' }).waitFor({ state: 'hidden' });

      const enabled = await enableAllModules(page);
      expect(enabled.length, `启用全部模块后应点过若干次“启用”`).toBeGreaterThan(0);
      await assertEveryModuleReachable(page);

      const report = {};
      for (const [label] of SCREENS) {
        await clickNav(page, label);
        await sweepScreen(page, label, report);
      }
      console.log(`MOBILE_SWEEP ${vp.name} enabled=${enabled.length} ${JSON.stringify(report)}`);
      expect(Object.keys(report), '每个模块都要真的走一遍').toHaveLength(10);
      const flat = Object.values(report).flat();
      expect(flat.filter((line) => /blocked/.test(line)).length).toBeGreaterThan(15);
      // Lightweight mode has no accounts at all, at any width.
      expect(flat.join('\n')).not.toContain('新增账户');
      expect(flat.filter((line) => /没有焦点|不可见|面板滚动区之外|被底部导航遮住|触控高度|没有任何可见提示/.test(line))).toEqual([]);
    } finally {
      server.server.closeAllConnections();
      await server.close();
    }
  });
}

test(`phone 390x844: a record-keeping pass fills and saves at phone size`, async ({ page }) => {
  const ownerSetupToken = 'test-mobile-save-owner-000000000000';
  const server = createSyncServer({
    enableWeb: true,
    webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
    registrationMode: 'open',
    ownerSetupToken,
  });

  try {
    await server.ready;
    await new Promise((done, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', done);
    });
    const base = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(base, 'save-owner', 'save-owner-password', { ownerSetupToken });
    await registerAccount(base, 'save-user', 'save-user-password');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/app/`);
    await page.getByLabel('服务器用户名').fill('save-user');
    await page.getByLabel('服务器账号密码').fill('save-user-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click({ timeout: 30_000 });
    await page.getByRole('dialog', { name: '记一笔支出' }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: '关闭快速记账' }).click();
    await page.getByRole('dialog', { name: '记一笔支出' }).waitFor({ state: 'hidden' });

    await enableAllModules(page);

    // 1. A daily expense whose only must-type field is the amount.
    await clickNav(page, '日常支出');
    await page.getByRole('button', { name: '+ 记支出' }).click();
    const expense = page.getByRole('dialog', { name: '新增 · 日常支出' });
    await expect(expense).toBeVisible();
    await expect(expense.getByLabel('账户')).toHaveCount(0);
    await expense.getByRole('textbox', { name: /^金额/ }).fill('18.8');
    await expense.getByLabel('描述').fill('手机午餐');
    await expense.getByRole('button', { name: '保存', exact: true }).click();
    await expect(expense).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('手机午餐', { exact: true })).toBeVisible();

    // 2. A game record with no cash flow: the shape that had no save path at all
    //    until the settlement currency became clearable.
    await clickNav(page, '游戏赛季');
    await page.getByLabel('游戏名称').fill('手机游戏');
    await page.getByRole('button', { name: '开始记录', exact: true }).click();
    await expect(page.getByRole('button', { name: '+ 记录' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: '+ 记录' }).click();
    const record = page.getByRole('dialog').last();
    await expect(record).toBeVisible();
    await expect(record.getByLabel('实际收支币种')).toHaveValue('');
    await record.getByRole('button', { name: '保存', exact: true }).click();
    await expect(record, '无现金流的游戏记录在手机上也要能存下来').toBeHidden({ timeout: 15_000 });

    // 3. An item asset that only registers the purchase.
    await clickNav(page, '物品资产');
    await page.getByRole('button', { name: '+ 新增物品' }).click();
    const asset = page.getByRole('dialog', { name: /新增 · 物品资产/ });
    await expect(asset).toBeVisible();
    await asset.getByLabel('名称').fill('手机物品');
    await asset.getByRole('button', { name: '保存', exact: true }).click();
    await expect(asset).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('手机物品', { exact: true })).toBeVisible();

    // 4. The base records the other modules lean on, through the 管理 tabs.
    await clickNav(page, '管理');
    await page.locator('.zc-page-content [role="tab"]').filter({ hasText: '标签与商户' }).first().click();
    for (const [action, value] of [
      ['+ 新增商户', '手机商户'],
      ['+ 新增标签', '手机标签'],
      ['+ 新增地点', '手机地点'],
    ]) {
      await page.getByRole('button', { name: action, exact: true }).first().click();
      const dialog = page.getByRole('dialog').last();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('名称').fill(value);
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
    }
    await expect(page.getByText('手机商户', { exact: true })).toBeVisible();

    // 资产转换 is covered by the sweep above, which runs it at every viewport.
  } finally {
    server.server.closeAllConnections();
    await server.close();
  }
});
