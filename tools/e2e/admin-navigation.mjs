import { expect } from '@playwright/test';

/** Follow the same grouped navigation that an operator uses, including on a narrow screen. */
export async function clickAdminLink(page, name) {
  const nav = page.getByRole('navigation', { name: '管理后台导航' });
  const link = nav.getByRole('link', { name, exact: true, includeHidden: true });
  await expect(link).toBeVisible();
  await link.click();
}
