import { test, expect } from './fixtures.mjs';
import { openLedger, openTransactions } from './helpers.mjs';
import { enableEveryNavigationModule } from '../account-tests/mobile-onboarding.mjs';

const go = (page, screen) => page.evaluate((screen) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen } })), screen);
test.beforeEach(async ({ page }) => page.setDefaultTimeout(15_000));

async function bounds(dialog) {
  return dialog.evaluate((panel) => {
    const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const outer = box(panel);
    const children = [...panel.children].filter((node) => node.getBoundingClientRect().height > 0).map(box);
    const body = panel.querySelector(':scope > .zc-dialog-body');
    return { outer, children, radius: getComputedStyle(panel).borderRadius, overflow: getComputedStyle(panel).overflow,
      bodyOverflows: body ? body.scrollWidth > body.clientWidth + 1 : false,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}
async function contained(dialog, viewport = true) {
  await expect(dialog).toBeVisible();
  const result = await bounds(dialog);
  for (const child of result.children) {
    expect(child.left).toBeGreaterThanOrEqual(result.outer.left - 1);
    expect(child.right).toBeLessThanOrEqual(result.outer.right + 1);
    expect(child.top).toBeGreaterThanOrEqual(result.outer.top - 1);
    expect(child.bottom).toBeLessThanOrEqual(result.outer.bottom + 1);
  }
  if (viewport) {
    expect(result.outer.left).toBeGreaterThanOrEqual(-1); expect(result.outer.right).toBeLessThanOrEqual(result.viewport.width + 1);
    expect(result.outer.top).toBeGreaterThanOrEqual(-1); expect(result.outer.bottom).toBeLessThanOrEqual(result.viewport.height + 1);
  }
  expect(result.bodyOverflows).toBe(false);
  return result;
}
async function scrollBody(dialog) {
  const before = await dialog.locator(':scope > .zc-dialog-head').boundingBox();
  const footerBefore = await dialog.locator(':scope > .zc-dialog-foot').count() ? await dialog.locator(':scope > .zc-dialog-foot').boundingBox() : null;
  await dialog.locator(':scope > .zc-dialog-body').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await contained(dialog);
  const after = await dialog.locator(':scope > .zc-dialog-head').boundingBox();
  expect(after.y).toBeCloseTo(before.y, 0); expect(after.width).toBeCloseTo(before.width, 0);
  if (footerBefore) expect((await dialog.locator(':scope > .zc-dialog-foot').boundingBox()).y).toBeCloseTo(footerBefore.y, 0);
}

test('long workspace forms retain rounded bounds, fixed actions and full titles at desktop and phone sizes', async ({ page }) => {
  await openLedger(page); await go(page, 'settings'); await enableEveryNavigationModule(page); await go(page, 'fixed');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '+ 新增物品', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新增 · 物品资产', exact: true });
    const more = dialog.locator('summary').filter({ hasText: '更多信息' }); if (await more.count()) await more.first().click();
    const result = await contained(dialog); if (viewport.width >= 768) expect(parseFloat(result.radius)).toBeGreaterThan(0);
    await scrollBody(dialog);
    await page.screenshot({ path: test.info().outputPath(`workspace-${viewport.width}-${viewport.height}.png`) });
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toBeHidden();
  }
});

test('modal forms and nested confirmation keep their header and footer inside the surface while the body scrolls', async ({ page }) => {
  await openTransactions(page);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }, { width: 390, height: 320 }]) {
    await page.setViewportSize(viewport); await page.getByRole('button', { name: '+ 记账', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
    const reset = dialog.getByRole('button', { name: '重新开始', exact: true });
    if (await reset.isVisible()) await reset.click();
    const more = dialog.locator('summary').filter({ hasText: '更多信息' }); if (await more.count()) await more.first().click();
    await contained(dialog); await scrollBody(dialog);
    await dialog.getByLabel(/^金额/).fill('12.34'); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    const confirm = page.locator('.zc-confirm-panel'); await expect(confirm).toHaveAccessibleName('关闭未保存表单');
    await contained(confirm);
    // Stress the same mounted surface with server-sized error copy and an unbroken title.
    await confirm.locator('.zc-dialog-head').evaluate((node) => { node.firstElementChild.textContent = '超长确认标题LongUnbrokenAccountName'.repeat(12); });
    await confirm.locator('.zc-dialog-body').evaluate((node) => { for (let i = 0; i < 30; i++) { const line = document.createElement('p'); line.textContent = `详细说明 ${i}：关闭后保留原有账本记录，请核对本次操作。`; node.append(line); } });
    await contained(confirm); await scrollBody(confirm);
    await page.screenshot({ path: test.info().outputPath(`confirmation-${viewport.width}-${viewport.height}.png`) });
    await confirm.getByRole('button', { name: '继续编辑', exact: true }).click();
    await dialog.getByLabel(/^金额/).fill(''); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toBeHidden();
  }
});

test('nested category pickers preserve focus and stay within portrait and landscape viewports', async ({ page }) => {
  await openTransactions(page);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); await page.getByRole('button', { name: '+ 记账', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
    await form.getByLabel(/^分类/).click(); const picker = page.getByRole('dialog', { name: '选择分类', exact: true });
    await contained(picker); await picker.getByLabel('搜索分类', { exact: true }).fill('交通'); await contained(picker);
    await picker.getByRole('button', { name: '关闭分类选择', exact: true }).click(); await expect(picker).toBeHidden(); await expect(form).toBeVisible();
    await form.getByRole('button', { name: '取消', exact: true }).click();
  }
});

test.describe('touch date and time sheets', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('keyboard-sized viewports retain the title and cancel action above a scrolling calendar', async ({ page }) => {
    await openTransactions(page); await page.setViewportSize({ width: 320, height: 568 });
    await page.getByRole('button', { name: '+ 记账', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
    const more = form.locator('summary').filter({ hasText: '更多信息' }); if (await more.count()) await more.first().click();
    for (const height of [568, 320]) {
      await page.setViewportSize({ width: 320, height });
      await form.getByLabel(/^日期/).click();
      const picker = page.getByRole('dialog', { name: /选择.*日期/ }); await contained(picker); await scrollBody(picker);
      await picker.getByRole('button', { name: '取消', exact: true }).click(); await expect(form).toBeVisible();
      const time = form.getByLabel('时间', { exact: true });
      if (await time.count()) {
        await time.click(); const clock = page.getByRole('dialog', { name: /选择.*时间/ });
        await contained(clock); await scrollBody(clock); await clock.getByRole('button', { name: '取消', exact: true }).click();
      }
    }
  });
});
