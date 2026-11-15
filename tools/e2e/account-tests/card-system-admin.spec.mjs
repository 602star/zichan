import { test, expect } from '../tests/fixtures.mjs';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';

test('admin user sheets retain status and controls with single ink borders', async ({ page, baseURL }) => {
  page.setDefaultTimeout(15_000);
  await registerAccount(baseURL, 'card-member', 'card-member-password');
  await registerAccount(baseURL, 'card-disabled', 'card-member-password');
  const owner = await loginAccount(baseURL, 'test-owner', 'test-owner-password');
  const headers = { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' };
  const users = await fetch(`${baseURL}/api/admin/users?limit=25`, { headers }).then((response) => response.json());
  const target = users.users.find((user) => user.username === 'card-disabled');
  const disabled = await fetch(`${baseURL}/api/admin/users/card-disabled/disable`, {
    method: 'POST', headers, body: JSON.stringify({ disabled: true, expectedVersion: target.revision }),
  });
  expect(disabled.ok).toBe(true);
  await page.goto(`${baseURL}/e2e-private-entry/admin/`);
  await page.getByLabel('管理账号用户名').fill('test-owner');
  await page.getByLabel('管理账号密码').fill('test-owner-password');
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await expect(page.locator('.zc-admin-content')).toBeVisible();
  await page.getByRole('link', { name: '用户管理', exact: true }).click();
  await expect(page.locator('.zc-admin-user-card')).toHaveCount(3);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const mode of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: mode });
      await expect(page.locator('.zc-admin-root')).toHaveAttribute('data-mode', mode);
      await expect(page.locator('.zc-admin-user-card[data-disabled="true"]')).toContainText('已禁用');
      const borders = await page.locator('.zc-admin-user-card').evaluateAll((nodes) => nodes.map((node) => {
        const style = getComputedStyle(node);
        return { left: style.borderLeftWidth, top: style.borderTopWidth, radius: style.borderRadius, shadow: style.boxShadow };
      }));
      expect(borders).toEqual(Array(3).fill({ left: '1px', top: '1px', radius: '8px', shadow: 'none' }));
      // The list wrapper and quota group must not recreate two more nested sheets.
      await expect(page.locator('.zc-admin-user-records')).toHaveCSS('border-top-width', '0px');
      const quota = page.locator('.zc-admin-user-quota').first();
      await expect(quota).toHaveCSS('border-top-width', '1px');
      await expect(quota).toHaveCSS('border-left-width', '0px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`users-${mode}-${width}.png`), fullPage: true });
    }
  }
  const member = page.locator('.zc-admin-user-card').filter({ has: page.getByRole('button', { name: 'card-member', exact: true }) });
  await member.getByRole('checkbox').check();
  await expect(page.getByText('已选 1 个账号（仅当前页）')).toBeVisible();
});
