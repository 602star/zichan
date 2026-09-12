import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { mobileLayoutProbe, scrollToPageBottom } from './mobile-layout-probe.mjs';

// A touch device is what these rules are written for, so the whole file runs
// with coarse-pointer emulation; a mouse-driven context would never match
// `@media (pointer: coarse)` and would silently pass.
test.use({ hasTouch: true, isMobile: true });

test.setTimeout(300_000);

const SCREENS = [
  { id: 'dashboard', label: '总览' },
  { id: 'convert', label: '资产转换' },
  { id: 'transactions', label: '日常收支' },
  { id: 'game', label: '游戏赛季' },
  { id: 'fixed', label: '物品资产' },
  { id: 'reports', label: '报表' },
  { id: 'history', label: '历史' },
  { id: 'manage', label: '管理' },
  { id: 'sync', label: '同步' },
  { id: 'settings', label: '设置' },
];

// Phone portrait, phone landscape, and both tablet orientations. The 768px+
// widths are the ones that used to fall back to desktop density.
const VIEWPORTS = [
  { name: '320x568', width: 320, height: 568 },
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '414x896', width: 414, height: 896 },
  { name: '844x390', width: 844, height: 390 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1024x768', width: 1024, height: 768 },
];

async function clickNav(page, label) {
  const first = await page.evaluate((target) => {
    const norm = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, '');
    const sidebar = document.querySelector('.zc-sidebar');
    if (sidebar && getComputedStyle(sidebar).display !== 'none') {
      const btn = [...sidebar.querySelectorAll('.zc-sidebar-nav-item')].find((b) => norm(b).endsWith(target));
      if (btn) { btn.click(); return 'sidebar'; }
    }
    const nav = document.querySelector('.zc-mobile-bottom-nav');
    if (!nav || getComputedStyle(nav).display === 'none') return 'no-nav';
    const buttons = [...nav.querySelectorAll('button')];
    const direct = buttons.find((b) => norm(b).endsWith(target));
    if (direct) { direct.click(); return 'nav'; }
    const more = buttons.find((b) => norm(b).includes('更多'));
    if (!more) return `no-more:${buttons.map(norm).join('|')}`;
    more.click();
    return 'drawer';
  }, label);
  if (first === 'drawer') {
    await page.waitForTimeout(250);
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

/** Collect every contract violation for the screen currently on display. */
function violationsFor(data, viewport, screen) {
  const found = [];
  if (data.docOverflow > 1) {
    found.push(`horizontal-overflow: document is ${data.docOverflow}px wider than the viewport`);
  }
  for (const item of data.overflowing) {
    found.push(`element-outside-viewport: ${item.el} right=${item.right} left=${item.left}`);
  }
  for (const item of data.smallTargets) {
    found.push(`touch-target<44px: ${item.el} is ${item.w}x${item.h} (via ${item.via})`);
  }
  if (data.smallInputCount > 0) {
    found.push(`input-zoom-risk: ${data.smallInputCount} field(s) below 16px — ${data.smallInputs.map((i) => `${i.el}=${i.fontSize}px`).join(', ')}`);
  }
  if (data.hero && !data.hero.asOfVisible) found.push(`hero-as-of-hidden: ${JSON.stringify(data.hero)}`);
  if (data.hero && data.hero.amountOverflows) found.push(`hero-amount-overflow: ${JSON.stringify(data.hero)}`);
  return found.map((line) => `[${viewport} ${screen}] ${line}`);
}

test('every screen keeps the phone/tablet layout contract across the device matrix', async ({ page }) => {
  const ownerSetupToken = 'e2e-mobile-layout-owner-setup-00000000';
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
    await registerAccount(base, 'layout-owner', 'layout-owner-password', { ownerSetupToken });
    await registerAccount(base, 'layout-user', 'layout-user-password');

    await page.goto(`${base}/app/`);
    await page.getByLabel('服务器用户名').fill('layout-user');
    await page.getByLabel('服务器账号密码').fill('layout-user-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: '直接开始记支出', exact: true }).click();
    await page.getByRole('dialog', { name: '记一笔支出' }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: '关闭快速记账' }).click();
    await page.getByRole('dialog', { name: '记一笔支出' }).waitFor({ state: 'hidden' });

    // Empty ledgers hide most layout bugs, so seed through the real UI. The
    // 7-figure amount is deliberate: it is what pushed the dashboard date off screen.
    await clickNav(page, '日常支出');
    const samples = [
      ['午餐', '38.50'], ['地铁通勤', '6'], ['超市采购', '236.80'], ['咖啡', '28'],
      ['房租', '3200'], ['手机话费', '99'], ['宽带年付', '1280'], ['年终奖金', '1280246.79'],
    ];
    for (const [text, amount] of samples) {
      await page.getByRole('button', { name: '+ 记支出' }).click();
      const form = page.getByRole('dialog', { name: '新增 · 日常支出' });
      await form.waitFor({ timeout: 20_000 });
      await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
      await page.getByLabel('描述').fill(text);
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(650);
    }

    // Full asset mode so every module is reachable from the shell.
    await clickNav(page, '设置');
    await page.getByLabel('记账模式').selectOption('assets');
    await page.waitForTimeout(600);
    const toggles = await page.evaluate(() => [...document.querySelectorAll('input[type="checkbox"]')]
      .map((box) => box.getAttribute('aria-label'))
      .filter((label) => (label || '').startsWith('在侧边栏显示')));
    for (const label of toggles) {
      const box = page.getByRole('checkbox', { name: label });
      if (!(await box.isChecked().catch(() => true))) await box.check().catch(() => undefined);
    }

    // Gate: with `overflow-x: hidden` on <body>, the viewport could not scroll at
    // all, which is what made every earlier occlusion measurement meaningless.
    const scrollModel = await page.evaluate(() => {
      const scroller = document.scrollingElement;
      const before = { tag: scroller.tagName, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
      scroller.scrollTop = 99999;
      const moved = scroller.scrollTop;
      scroller.scrollTop = 0;
      return { before, moved };
    });
    expect(scrollModel.before.tag, 'the viewport itself must be the scroll container').toBe('HTML');
    expect(scrollModel.moved, 'the viewport must actually scroll').toBeGreaterThan(0);

    const failures = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(350);
      for (const screen of SCREENS) {
        await clickNav(page, screen.label);

        // Measure at the natural (top) scroll position first so the dashboard
        // headline is actually in view, then again at the bottom for occlusion.
        await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
        await page.waitForTimeout(120);
        const data = await page.evaluate(mobileLayoutProbe, { maxScroll: false });
        failures.push(...violationsFor(data, vp.name, screen.id));

        await page.evaluate(scrollToPageBottom);
        await page.waitForTimeout(150);
        const bottom = await page.evaluate(mobileLayoutProbe, { maxScroll: true });
        if (bottom.occlusion && bottom.occlusion.reachable && bottom.occlusion.covered.length > 0) {
          failures.push(`[${vp.name} ${screen.id}] bottom-nav-occlusion: ${JSON.stringify(bottom.occlusion)}`);
        }
      }
    }

    expect(failures.join('\n')).toBe('');
  } finally {
    server.server.closeAllConnections();
    await server.close();
  }
});
