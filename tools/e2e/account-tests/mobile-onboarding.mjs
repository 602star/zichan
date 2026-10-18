import { expect } from '@playwright/test';

/** Create a real spending ledger through the current account and first-run flow. */
export async function openSpendingLedger(page, base, username, password) {
  await page.goto(`${base}/app/`);
  await page.getByLabel('服务器用户名').fill(username);
  await page.getByLabel('服务器账号密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '创建个人账本' }).click();
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  const firstEntry = page.getByRole('dialog', { name: '新增 · 日常收支' });
  if ((page.viewportSize()?.width ?? 1280) <= 767) {
    await expect(page.getByRole('region', { name: '首次记账引导' })).toBeVisible();
    await expect(firstEntry).toBeHidden();
    return;
  }
  await expect(firstEntry).toBeVisible();
  await firstEntry.getByRole('button', { name: '取消', exact: true }).click();
  await expect(firstEntry).toBeHidden();
}

/** Expose hidden modules through the control available at the current width. */
export async function enableEveryNavigationModule(page) {
  const bottom = page.locator('.zc-mobile-bottom-nav');
  if (await bottom.isVisible()) {
    await bottom.getByRole('button', { name: /更多/ }).click();
    const drawer = page.getByRole('dialog', { name: '更多功能' });
    const add = drawer.locator('.zc-mobile-drawer-add');
    for (let round = 0; round < 12 && await add.count(); round += 1) {
      const previous = await add.count();
      await add.first().click();
      await expect(add).toHaveCount(previous - 1);
    }
    await drawer.getByRole('button', { name: '关闭更多菜单' }).click();
    return;
  }
  const boxes = page.locator('input[aria-label^="在侧边栏显示"]');
  await expect(boxes.first()).toBeVisible();
  for (let index = 0, total = await boxes.count(); index < total; index += 1) {
    const box = boxes.nth(index);
    if (!(await box.isEnabled()) || await box.isChecked()) continue;
    await box.click();
    await expect(box).toBeChecked();
    await expect(box).toBeEnabled();
  }
}
