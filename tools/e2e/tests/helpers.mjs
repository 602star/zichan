import { expect } from '@playwright/test';

export const DEVICE_PASSWORD = 'E2E-ledger-2026';

async function grantDeterministicPersistentStorage(page) {
  await page.addInitScript(() => {
    const storage = globalThis.navigator?.storage;
    if (!storage) return;
    Object.defineProperties(storage, {
      persist: {
        configurable: true,
        value: async () => true,
      },
      persisted: {
        configurable: true,
        value: async () => true,
      },
    });
  });
}

export async function openLedger(page, options = {}) {
  if (options.grantPersistentStorage !== false) await grantDeterministicPersistentStorage(page);
  await page.goto('/');
  const localMode = page.getByRole('button', { name: /^纯本地使用/ });
  const create = page.getByRole('button', { name: '创建并打开' });
  const unlock = page.getByRole('button', { name: '解锁', exact: true });
  const dashboard = page.getByText('总览', { exact: true }).first();
  const initializeEmpty = page.getByRole('button', { name: '确认创建空账本', exact: true });

  await expect(localMode.or(create).or(unlock).or(dashboard).or(initializeEmpty)).toBeVisible({ timeout: 30_000 });
  if (await localMode.isVisible().catch(() => false)) {
    await localMode.click();
    await expect(create.or(unlock).or(dashboard).or(initializeEmpty)).toBeVisible({ timeout: 30_000 });
  }

  if (await create.isVisible().catch(() => false)) {
    await page.getByLabel('本机数据密码').fill(DEVICE_PASSWORD);
    await page.getByLabel('再输入一次').fill(DEVICE_PASSWORD);
    await create.click();
  } else {
    if (await unlock.isVisible().catch(() => false)) {
      await page.getByLabel('本机数据密码').fill(DEVICE_PASSWORD);
      await unlock.click();
    }
  }
  await expect(dashboard.or(initializeEmpty)).toBeVisible({ timeout: 30_000 });
  if (await initializeEmpty.isVisible().catch(() => false)) await initializeEmpty.click();
  await expect(dashboard).toBeVisible({ timeout: 30_000 });
}

export async function openTransactions(page) {
  await openLedger(page);
  await page.getByText('日常收支', { exact: true }).first().click();
  await expect(page.getByRole('button', { name: '+ 记账' })).toBeVisible();
}
