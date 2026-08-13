import { expect } from '@playwright/test';

export const DEVICE_PASSWORD = 'E2E-ledger-2026';

export async function openLedger(page) {
  await page.goto('/');
  const create = page.getByRole('button', { name: '创建并打开' });
  if (await create.isVisible().catch(() => false)) {
    await page.getByLabel('本机数据密码').fill(DEVICE_PASSWORD);
    await page.getByLabel('再输入一次').fill(DEVICE_PASSWORD);
    await create.click();
  } else {
    const unlock = page.getByRole('button', { name: '解锁', exact: true });
    if (await unlock.isVisible().catch(() => false)) {
      await page.getByLabel('本机数据密码').fill(DEVICE_PASSWORD);
      await unlock.click();
    }
  }
  const dashboard = page.getByText('总览', { exact: true }).first();
  const initializeEmpty = page.getByRole('button', { name: '确认创建空账本', exact: true });
  await expect(dashboard.or(initializeEmpty)).toBeVisible({ timeout: 30_000 });
  if (await initializeEmpty.isVisible().catch(() => false)) await initializeEmpty.click();
  await expect(dashboard).toBeVisible({ timeout: 30_000 });
}

export async function openTransactions(page) {
  await openLedger(page);
  await page.getByText('日常收支', { exact: true }).first().click();
  await expect(page.getByRole('button', { name: '+ 记账' })).toBeVisible();
}
