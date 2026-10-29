import { expect } from '@playwright/test';

/** Follow the same grouped navigation that an operator uses, including on a narrow screen. */
export async function clickAdminLink(page, name) {
  const nav = page.locator('nav[aria-label="管理后台导航"]');
  const link = nav.getByRole('link', { name, exact: true, includeHidden: true });
  const menu = page.getByRole('button', { name: '菜单' });
  await expect(nav).toHaveCount(1, { timeout: 30_000 });
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') {
    await menu.click();
    await expect(nav).toHaveAttribute('data-open', 'true');
  }
  await expect(link).toBeVisible();
  await link.click();
}
