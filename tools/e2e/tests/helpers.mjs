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
  const login = page.getByRole('heading', { name: '账号登录', exact: true });
  const create = page.getByRole('button', { name: '创建并打开' });
  const createPersonal = page.getByRole('button', { name: '创建个人账本' });
  const unlock = page.getByRole('button', { name: '解锁', exact: true });
  const quickStart = page.getByRole('button', { name: '开始记账', exact: true });
  const appReady = page.locator('.zc-app-shell');
  const quickExpense = page.getByRole('dialog', { name: '新增 · 日常收支' });
  let startedQuickLedger = false;

  await expect(login.or(create).or(createPersonal).or(unlock).or(appReady).or(quickStart)).toBeVisible({ timeout: 30_000 });
  if (await login.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: '注册新账号', exact: true }).click();
    await page.getByLabel('昵称', { exact: true }).fill('端到端测试用户');
    await page.getByLabel('服务器用户名').fill(`member-${crypto.randomUUID()}`);
    await page.getByLabel('服务器账号密码', { exact: true }).fill('E2E-account-password');
    await page.getByLabel('确认账号密码', { exact: true }).fill('E2E-account-password');
    await page.getByRole('button', { name: '注册并登录', exact: true }).click();
    await expect(create.or(createPersonal).or(unlock).or(appReady).or(quickStart)).toBeVisible({ timeout: 30_000 });
  }

  if (await createPersonal.isVisible().catch(() => false)) await createPersonal.click();

  if (await create.isVisible().catch(() => false)) {
    await page.getByLabel('账本密码', { exact: true }).fill(DEVICE_PASSWORD);
    await page.getByLabel('再输入一次').fill(DEVICE_PASSWORD);
    await create.click();
  } else {
    if (await unlock.isVisible().catch(() => false)) {
      await page.getByLabel('账本密码', { exact: true }).fill(DEVICE_PASSWORD);
      await unlock.click();
    }
  }
  await expect(appReady.or(quickStart)).toBeVisible({ timeout: 30_000 });
  if (await quickStart.isVisible().catch(() => false)) {
    startedQuickLedger = true;
    await quickStart.click();
  }
  await expect(appReady).toBeVisible({ timeout: 30_000 });
  if (startedQuickLedger) await expect(quickExpense).toBeVisible({ timeout: 30_000 });

  if (options.keepQuickExpense !== true && await quickExpense.isVisible().catch(() => false)) {
    await quickExpense.getByRole('button', { name: '取消', exact: true }).click();
    await expect(quickExpense).toBeHidden();
  }
}

export async function openTransactions(page) {
  await openLedger(page);
  const dailyExpenses = page.locator('.zc-sidebar').getByText('日常支出', { exact: true });
  await dailyExpenses.click();
  await expect(page.getByRole('button', { name: '+ 记支出' })).toBeVisible();
}
