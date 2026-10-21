import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test('shows browser backup usage and deletes one local copy', async ({ page }) => {
  test.setTimeout(120_000);
  await openLedger(page);
  await page.locator('.zc-sidebar nav').getByRole('button', { name: /设置/ }).click();
  await page.getByRole('tab', { name: '本机备份', exact: true }).click();
  const device = page.getByRole('region', { name: '当前设备' });
  const deleteButtons = device.getByRole('button', { name: '删除本机副本' });
  const create = device.getByRole('button', { name: '创建手动备份' });
  await create.click();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(create).toBeEnabled();
  await expect.poll(() => deleteButtons.count()).toBeGreaterThanOrEqual(2);
  const beforeDelete = await deleteButtons.count();
  await expect(device.getByText(new RegExp(`${beforeDelete} 份 · .*KB`))).toBeVisible();
  await deleteButtons.first().click();
  await page.getByRole('dialog', { name: '删除本机备份' }).getByRole('button', { name: '删除本机副本' }).click();
  await expect(deleteButtons).toHaveCount(beforeDelete - 1);
  await expect(device.getByText(new RegExp(`${beforeDelete - 1} 份 · .*KB`))).toBeVisible();
});
