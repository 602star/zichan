import { test, expect } from '../tests/fixtures.mjs';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { enableEveryNavigationModule, openSpendingLedger } from './mobile-onboarding.mjs';

/*
 * Opt-in visual baselines for the phone layout.
 *
 * Deliberately NOT part of the default run. Pixel output here is tied to the
 * exact Chrome build, font stack and rasteriser of the machine that produced
 * it, so a committed baseline would go red on any other machine (and in CI)
 * for reasons that are not product regressions. The usual outcome is that
 * someone regenerates the baseline, which is how a visual gate stops being one.
 *
 * What it is good for: a local before/after when changing layout or CSS. Run
 * `npm run test:visual:update` to record, make the change, then
 * `npm run test:visual` and read the diff report. Baselines live in a
 * gitignored directory on purpose.
 *
 * The geometric contract in `mobile-layout.spec.mjs` stays the enforced gate:
 * it covers overflow, clipping, touch size, occlusion and density, and fails
 * with a readable reason instead of a pixel count.
 *
 * Screens are captured with the clock pinned, because record dates come from
 * "today" - without it the baselines would differ every day.
 *
 * This file is excluded by `account.config.mjs` and only runs under
 * `visual.config.mjs`, so it never takes part in the enforced suite.
 */

test.use({ hasTouch: true, isMobile: true });
test.setTimeout(1_200_000);

const FIXED_NOW = new Date('2026-03-15T10:00:00+08:00');

const SCREENS = ['总览', '资产转换', '日常收支', '游戏赛季', '物品资产', '报表', '历史', '管理', '设置'];

async function clickNav(page, label) {
  const where = await page.evaluate((target) => {
    const norm = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, '');
    const nav = document.querySelector('.zc-mobile-bottom-nav');
    if (nav && getComputedStyle(nav).display !== 'none') {
      const direct = [...nav.querySelectorAll('button')].find((b) => norm(b).endsWith(target));
      if (direct) { direct.click(); return 'bar'; }
      const more = [...nav.querySelectorAll('button')].find((b) => norm(b).endsWith('更多'));
      if (!more) return 'no-more';
      more.click();
      return 'drawer';
    }
    const sidebar = document.querySelector('.zc-sidebar');
    if (!sidebar || getComputedStyle(sidebar).display === 'none') return 'no-sidebar';
    const item = [...sidebar.querySelectorAll('nav button')].find((b) => norm(b).endsWith(target));
    if (!item) return 'no-sidebar-item';
    item.click();
    return 'sidebar';
  }, label);
  if (where === 'drawer') {
    const drawer = page.getByRole('dialog', { name: '更多功能' });
    await expect(drawer).toBeVisible();
    await drawer.locator('.zc-mobile-drawer-grid button', { hasText: label }).first().click({ timeout: 15_000 });
  } else if (where !== 'bar' && where !== 'sidebar') {
    throw new Error(`navigation failed for ${label}: ${where}`);
  }
  await page.waitForTimeout(200);
}

test('phone visual baselines', async ({ page, baseURL }) => {
  await registerAccount(baseURL, 'visual-user', 'visual-user-password');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(FIXED_NOW);
  await openSpendingLedger(page, baseURL, 'visual-user', 'visual-user-password');
  const dismissGuide = page.getByRole('button', { name: '暂时收起' });
  if (await dismissGuide.isVisible().catch(() => false)) await dismissGuide.click();

  // A fixed sample set: the 7-figure amount is what used to push the dashboard
  // date off screen, so the baseline should keep showing it.
  await clickNav(page, '日常收支');
  for (const [text, amount] of [['午餐', '38.50'], ['地铁通勤', '6'], ['年终奖金', '1280246.79']]) {
    await page.getByRole('button', { name: '+ 记账' }).click();
    const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
    await form.waitFor({ timeout: 20_000 });
    await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
    await page.getByLabel('描述').fill(text);
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await form.waitFor({ state: 'hidden', timeout: 20_000 });
  }

  // Everything on, so each screen shows its real content rather than an empty state.
  await enableEveryNavigationModule(page);

  const shot = (name) => expect(page).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
    maxDiffPixelRatio: 0.02,
    timeout: 20_000,
  });

  // Saving raises an undo toast that outranks the dialog layer, so it would sit in
  // the capture and make the baseline depend on how long the toast lives.
  await page.locator('.zc-undo-toast').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);

  for (const label of SCREENS) {
    await clickNav(page, label);
    await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
    await page.waitForTimeout(250);
    await shot(`screen-${SCREENS.indexOf(label)}-${label}.png`);
  }

  // The two modal shapes that carry a refusal: the shared entity form and the
  // one dialog outside that contract.
  await clickNav(page, '日常收支');
  await page.getByRole('button', { name: '+ 记账' }).click();
  const entityForm = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await expect(entityForm).toBeVisible();
  // 记支出 keeps the previous entry's draft, so an untouched form can save
  // straight through. Clear the amount to guarantee the refusal branch.
  const amount = entityForm.getByRole('textbox', { name: /^金额/ });
  await amount.fill('');
  await entityForm.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entityForm.getByRole('alert')).toBeVisible();
  await page.waitForTimeout(200);
  await shot('dialog-entity-form-refusal.png');
  await entityForm.getByRole('button', { name: '取消', exact: true }).click();
  const guard = page.getByRole('button', { name: '保留草稿并关闭' });
  if (await guard.isVisible().catch(() => false)) await guard.click();
  await expect(entityForm).toBeHidden();

  await clickNav(page, '资产转换');
  await page.getByRole('button', { name: '+ 新增转换' }).click();
  const conversion = page.getByRole('dialog', { name: /资产转换/ });
  await expect(conversion).toBeVisible();
  await conversion.getByRole('button', { name: '保存转换' }).click();
  await expect(conversion.getByRole('alert').first()).toBeVisible();
  await page.waitForTimeout(200);
  await shot('dialog-conversion-refusal.png');
});
