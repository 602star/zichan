import { expect } from '@playwright/test';

/** Follow the same grouped navigation that an operator uses, including on a narrow screen. */
export async function clickAdminLink(page, name) {
  const nav = page.getByRole('navigation', { name: '管理后台导航' });
  if (!await nav.isVisible()) await page.getByRole('button', { name: /^菜单 ·/ }).click();
  const link = nav.getByRole('link', { name, exact: true, includeHidden: true });
  if (!await link.isVisible()) {
    const group = nav.locator('details').filter({ has: page.getByRole('link', { name, exact: true, includeHidden: true }) });
    await group.locator('summary').click();
  }
  await expect(link).toBeVisible();
  await link.click();
}
