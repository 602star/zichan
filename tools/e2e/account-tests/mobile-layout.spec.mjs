import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { mobileLayoutProbe, scrollToPageBottom } from './mobile-layout-probe.mjs';
import { enableEveryNavigationModule, openSpendingLedger } from './mobile-onboarding.mjs';

// A touch device is what these rules are written for, so the whole file runs
// with coarse-pointer emulation; a mouse-driven context would never match
// `@media (pointer: coarse)` and would silently pass.
test.use({ hasTouch: true, isMobile: true });

test.setTimeout(1_200_000);

const SCREENS = [
  { id: 'dashboard', label: '总览' },
  { id: 'convert', label: '资产转换' },
  { id: 'transactions', label: '日常收支' },
  { id: 'game', label: '游戏赛季' },
  { id: 'fixed', label: '物品资产' },
  { id: 'reports', label: '报表' },
  { id: 'history', label: '历史' },
  { id: 'manage', label: '管理' },
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
  { name: '820x1180', width: 820, height: 1180 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1180x820', width: 1180, height: 820 },
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
  test.setTimeout(1_440_000);
  const ownerSetupToken = 'e2e-mobile-layout-owner-setup-00000000';
  const server = createSyncServer({
    enableWeb: true,
    webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
    registrationMode: 'open',
    ownerSetupToken,
  });

  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const base = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(base, 'layout-owner', 'layout-owner-password', { ownerSetupToken });
    await registerAccount(base, 'layout-user', 'layout-user-password');

    await openSpendingLedger(page, base, 'layout-user', 'layout-user-password');

    // Empty ledgers hide most layout bugs, so seed through the real UI. The
    // 7-figure amount is deliberate: it is what pushed the dashboard date off screen.
    await clickNav(page, '日常收支');
    const samples = [
      ['午餐', '38.50'], ['地铁通勤', '6'], ['超市采购', '236.80'], ['咖啡', '28'],
      ['房租', '3200'], ['手机话费', '99'], ['宽带年付', '1280'], ['年终奖金', '1280246.79'],
    ];
    for (const [text, amount] of samples) {
      await page.getByRole('button', { name: '+ 记账' }).click();
      const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
      await form.waitFor({ timeout: 20_000 });
      await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
      await page.getByLabel('描述').fill(text);
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(650);
    }

    // Enable every module through the phone drawer, which is the first-run
    // navigation path and avoids a settings write racing a checkbox click.
    await page.setViewportSize({ width: 390, height: 844 });
    await enableEveryNavigationModule(page);

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

    // Phone density after compacting the ledger settings and transaction filters:
    //   settings:    4.19 -> 1.71 screens, 65 -> 21 visible controls
    //   transactions: current account entry and guide use 4.23 screens and 67 controls
    // Keep ceilings near those measured values so later fields do not silently
    // restore the long first-run pages.
    const DENSITY_BUDGET = {
      settings: { screens: 2.0, controls: 25, surfaces: 6, boldShare: 0.3 },
      // Collapsing the detail table removes many regular-weight cells, raising
      // the bold percentage even though there is less emphasized text overall.
      reports: { screens: 2.8, controls: 26, surfaces: 12, boldCount: 45 },
      transactions: { screens: 4.35, controls: 70, surfaces: 7, boldShare: 0.25 },
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
          boldCount: bold,
          boldShare: textBlocks.length ? bold / textBlocks.length : 0,
        };
      });

      const round = (value) => Math.round(value * 100) / 100;
      if (measured.screens > budget.screens) overBudget.push(`${screen}: ${round(measured.screens)} screens > ${budget.screens}`);
      if (measured.controls > budget.controls) overBudget.push(`${screen}: ${measured.controls} controls > ${budget.controls}`);
      if (measured.surfaces > budget.surfaces) overBudget.push(`${screen}: ${measured.surfaces} bordered surfaces > ${budget.surfaces}`);
      if (budget.boldCount !== undefined && measured.boldCount > budget.boldCount) overBudget.push(`${screen}: ${measured.boldCount} bold text blocks > ${budget.boldCount}`);
      if (budget.boldShare !== undefined && measured.boldShare > budget.boldShare) overBudget.push(`${screen}: ${round(measured.boldShare * 100)}% of text bold > ${budget.boldShare * 100}%`);
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

    /*
     * Same quick action, tablet rail. It used to be an 8px rounded rectangle
     * stretched to the rail width, so the control that is a circle on the phone
     * bar read as a different object here. Assert the circle survives the rail
     * too, and that the desktop sidebar still uses its own full-width variant
     * instead of leaving a stray circle behind.
     */
    const railFailures = [];
    for (const width of [768, 900, 1024, 1100, 1199]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(350);
      const rail = await page.evaluate(() => {
        const button = document.querySelector('.zc-sidebar-quick-rail');
        const sidebar = document.querySelector('.zc-sidebar');
        if (!button || !sidebar) return null;
        const label = document.querySelector('.zc-sidebar-nav-label');
        const rect = button.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          radius: getComputedStyle(button).borderRadius,
          offset: Math.round((rect.left + rect.right) / 2
            - (sidebar.getBoundingClientRect().left + sidebar.getBoundingClientRect().right) / 2),
          labelVisible: !!label && getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 0,
        };
      });
      expect(rail, 'the tablet rail must render its quick action').not.toBeNull();
      if (rail.radius !== '50%') railFailures.push(`${width}px: rail quick action radius is ${rail.radius}, not a circle`);
      if (rail.width !== rail.height) railFailures.push(`${width}px: rail quick action is ${rail.width}x${rail.height}, not round`);
      // 44px is the minimum touch target the rail is built around.
      if (rail.height < 44) railFailures.push(`${width}px: rail quick action is only ${rail.height}px tall`);
      if (Math.abs(rail.offset) > 2) railFailures.push(`${width}px: rail quick action sits ${rail.offset}px off centre`);
      if (!rail.labelVisible) railFailures.push(`${width}px: navigation label is hidden`);
    }
    expect(railFailures.join('\n')).toBe('');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(350);
    const desktopQuick = await page.evaluate(() => {
      const rail = document.querySelector('.zc-sidebar-quick-rail');
      const inline = document.querySelector('.zc-sidebar-quick-inline');
      const inlineRect = inline ? inline.getBoundingClientRect() : null;
      const mark = inline ? inline.querySelector('svg') : null;
      const markRect = mark ? mark.getBoundingClientRect() : null;
      const centre = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
      const boxCentre = inlineRect ? centre(inlineRect) : null;
      const markCentre = markRect ? centre(markRect) : null;
      return {
        railVisible: rail ? rail.getBoundingClientRect().width > 0 : false,
        inlineVisible: inline ? getComputedStyle(inline).display !== 'none' : false,
        inlineWidth: inlineRect ? Math.round(inlineRect.width) : null,
        inlineHeight: inlineRect ? Math.round(inlineRect.height) : null,
        inlineRadius: inline ? getComputedStyle(inline).borderRadius : null,
        markOffsetX: boxCentre && markCentre ? Math.abs(markCentre.x - boxCentre.x) : null,
        markOffsetY: boxCentre && markCentre ? Math.abs(markCentre.y - boxCentre.y) : null,
      };
    });
    expect(desktopQuick.railVisible).toBe(false);
    expect(desktopQuick.inlineVisible).toBe(true);
    /*
     * Shape, not just presence. This assertion used to stop at `inlineVisible`,
     * which is how a 34x38 oval survived here: the global
     * `button { min-height: var(--control-h) }` baseline outranked the declared
     * height, and `@media (pointer: coarse) { button { min-width: 44px } }` then
     * widened it the other way on touch. A circle is only round if the box is
     * square, so assert the box.
     */
    expect(desktopQuick.inlineRadius).toBe('50%');
    expect({
      width: desktopQuick.inlineWidth,
      height: desktopQuick.inlineHeight,
    }).toEqual({ width: 44, height: 44 });
    /*
     * And the mark has to sit on the centre, not merely exist inside the box.
     * A text glyph lands where the font's baseline and math axis put it, which
     * left it ~2px low in every variant, so the mark is drawn as two symmetric
     * SVG strokes instead. Measure the mark against the box so a regression to a
     * glyph - or a stray line-height - cannot quietly reintroduce the drift.
     */
    expect(desktopQuick.markOffsetX).toBeLessThanOrEqual(0.5);
    expect(desktopQuick.markOffsetY).toBeLessThanOrEqual(0.5);

    for (const viewport of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }, { width: 3840, height: 2160 }]) {
      await page.setViewportSize(viewport);
      for (const screen of SCREENS) {
        await clickNav(page, screen.label);
        const wide = await page.evaluate(() => {
          const main = document.querySelector('.zc-app-main');
          const rect = main.getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth - innerWidth,
            mainWidth: rect.width, bodyFont: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-body')) };
        });
        expect(wide.overflow, `${viewport.width}px ${screen.id} overflow`).toBeLessThanOrEqual(1);
        if (viewport.width >= 2560) expect(wide.mainWidth).toBeLessThanOrEqual(2081);
        if (viewport.width >= 3840) expect(wide.bodyFont).toBeGreaterThanOrEqual(17);
      }
    }
  } finally {
    await page.close();
    await closeTestSyncServer(server);
  }
});
