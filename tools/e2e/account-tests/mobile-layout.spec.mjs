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

    // Density budget. The complaint this addresses was not a broken layout but
    // the sheer amount of it. Measured on the phone viewport, before -> after:
    //   settings: 7.3 -> 3.9 screens, 95 -> 62 controls, 65% -> 17% bold text
    //   reports:  4.8 -> 4.2 screens
    // The ceilings sit just above the current values so the next feature cannot
    // quietly spend the gain, while still being far below the pre-change state.
    const DENSITY_BUDGET = {
      settings: { screens: 4.5, controls: 70, surfaces: 16, boldShare: 0.3 },
      // Reports is a figures-first screen: its headline metrics are the content,
      // so they stay bold and its ceiling is the measured 32% rather than the
      // 17% Settings now reaches. Recorded here so the difference is deliberate.
      reports: { screens: 4.5, controls: 24, surfaces: 14, boldShare: 0.35 },
    };

    await page.setViewportSize({ width: 390, height: 844 });
    const overBudget = [];
    for (const [screen, budget] of Object.entries(DENSITY_BUDGET)) {
      await clickNav(page, SCREENS.find((row) => row.id === screen).label);
      await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
      await page.waitForTimeout(300);

      const measured = await page.evaluate(() => {
        const scroller = document.scrollingElement;
        const visible = (el) => {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        // A "surface" is a panel: bordered on all four sides and large enough
        // that it reads as a container rather than a chip or an input. A card
        // inside a card is what made the page feel like a form.
        const surfaces = [...document.querySelectorAll('section, div, aside')]
          .filter(visible)
          .filter((el) => {
            const style = getComputedStyle(el);
            const bordered = ['Top', 'Right', 'Bottom', 'Left']
              .every((side) => parseFloat(style[`border${side}Width`]) > 0);
            const rect = el.getBoundingClientRect();
            return bordered && rect.width * rect.height >= 10000;
          }).length;

        const controls = [...document.querySelectorAll('button, select, input, textarea')]
          .filter(visible).length;

        // Emphasis share: how much of the visible text is shouting.
        const textBlocks = [...document.querySelectorAll('body *')].filter((el) => {
          if (!visible(el)) return false;
          const own = [...el.childNodes]
            .some((node) => node.nodeType === 3 && (node.textContent ?? '').trim());
          return own;
        });
        const bold = textBlocks
          .filter((el) => Number(getComputedStyle(el).fontWeight) >= 700).length;

        return {
          screens: scroller.scrollHeight / window.innerHeight,
          controls,
          surfaces,
          boldShare: textBlocks.length ? bold / textBlocks.length : 0,
        };
      });

      const round = (value) => Math.round(value * 100) / 100;
      if (measured.screens > budget.screens) overBudget.push(`${screen}: ${round(measured.screens)} screens > ${budget.screens}`);
      if (measured.controls > budget.controls) overBudget.push(`${screen}: ${measured.controls} controls > ${budget.controls}`);
      if (measured.surfaces > budget.surfaces) overBudget.push(`${screen}: ${measured.surfaces} bordered surfaces > ${budget.surfaces}`);
      if (measured.boldShare > budget.boldShare) overBudget.push(`${screen}: ${round(measured.boldShare * 100)}% of text bold > ${budget.boldShare * 100}%`);
      console.log(`density ${screen}: ${JSON.stringify(measured)}`);
    }

    expect(overBudget.join('\n')).toBe('');

    /*
     * The records header packed five actions into five forced equal columns.
     * At 320px that left 44px per button while 「作废记录」needs 53px, so its
     * label spilled past the button edge - the row has to size buttons to their
     * content and wrap instead. Overlap at exactly the widths people hold.
     */
    await clickNav(page, '日常收支');
    const overflowFailures = [];
    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(350);
      const measured = await page.evaluate(() => {
        const row = document.querySelector('.zc-responsive-header > div:last-child');
        if (!row) return null;
        const buttons = [...row.querySelectorAll('button')].map((button) => ({
          label: (button.textContent || '').trim(),
          overflow: button.scrollWidth - button.clientWidth,
        }));
        const quick = document.querySelector('.zc-mobile-quick > span');
        const nav = document.querySelector('.zc-mobile-bottom-nav');
        const quickRect = quick ? quick.getBoundingClientRect() : null;
        const navRect = nav ? nav.getBoundingClientRect() : null;
        return {
          buttons,
          quickOffset: quickRect && navRect
            ? Math.round((quickRect.left + quickRect.right) / 2 - (navRect.left + navRect.right) / 2)
            : null,
          quickWidth: quickRect ? Math.round(quickRect.width) : null,
          quickHeight: quickRect ? Math.round(quickRect.height) : null,
          quickRadius: quick ? getComputedStyle(quick).borderRadius : null,
        };
      });
      expect(measured, 'the records header must render its action row').not.toBeNull();
      for (const button of measured.buttons) {
        // 1px absorbs sub-pixel text measurement; anything more is real clipping.
        if (button.overflow > 1) overflowFailures.push(`${width}px ${button.label}: ${button.overflow}px past its button`);
      }
      // The quick action is the primary target, so it belongs on the centre line,
      // and it has to read as a circle rather than a rounded rectangle.
      if (measured.quickOffset !== null && Math.abs(measured.quickOffset) > 2) {
        overflowFailures.push(`${width}px: quick action sits ${measured.quickOffset}px off centre`);
      }
      if (measured.quickRadius !== '50%') {
        overflowFailures.push(`${width}px: quick action radius is ${measured.quickRadius}, not a circle`);
      }
      if (measured.quickWidth !== measured.quickHeight) {
        overflowFailures.push(`${width}px: quick action is ${measured.quickWidth}x${measured.quickHeight}, not round`);
      }
    }
    expect(overflowFailures.join('\n')).toBe('');
  } finally {
    server.server.closeAllConnections();
    await server.close();
  }
});
