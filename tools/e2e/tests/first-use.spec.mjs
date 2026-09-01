import { test, expect } from '@playwright/test';
import { DEVICE_PASSWORD, openLedger } from './helpers.mjs';

test.setTimeout(90_000);

async function controlPersistence(page, mode) {
  await page.addInitScript((initialMode) => {
    const granted = () => {
      try {
        const override = globalThis.localStorage?.getItem('zichan.e2e.persistence');
        return (override ?? initialMode) === 'granted';
      } catch {
        return initialMode === 'granted';
      }
    };
    const storage = globalThis.navigator?.storage;
    if (!storage) return;
    Object.defineProperties(storage, {
      persist: {
        configurable: true,
        value: async () => granted(),
      },
      persisted: {
        configurable: true,
        value: async () => granted(),
      },
    });
  }, mode);
}

test('blocks a new browser-only ledger when persistent storage is denied', async ({ page }) => {
  await controlPersistence(page, 'denied');
  const apiRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^纯本地使用/ }).click();

  await expect(page.getByRole('alert')).toContainText('浏览器拒绝了持久存储授权');
  await expect(page.getByRole('button', { name: '创建并打开' })).toHaveCount(0);
  expect(apiRequests).toEqual([]);
});

test('opens server onboarding without requesting browser persistence', async ({ page }) => {
  await controlPersistence(page, 'denied');
  await page.goto('/');
  await page.getByRole('button', { name: /^连接同步服务器/ }).click();

  await expect(page.getByRole('heading', { name: '连接同步服务器' })).toBeVisible();
  await expect(page.getByLabel('完整服务器地址')).toHaveValue('http://127.0.0.1:5173');
  await page.getByRole('button', { name: '高级设置' }).click();
  await expect(page.getByLabel('协议')).toHaveValue('http');
  await expect(page.getByLabel('主机或域名')).toHaveValue('127.0.0.1');
  await expect(page.getByLabel('端口')).toHaveValue('5173');
});

test('opens existing browser data in read-only recovery after persistence is lost', async ({ page }) => {
  await controlPersistence(page, 'granted');
  await openLedger(page, { grantPersistentStorage: false });
  await page.evaluate(() => { localStorage.setItem('zichan.e2e.persistence', 'denied'); });
  await page.reload();

  const recovery = page.getByRole('heading', { name: '浏览器不再保证本地数据持久保存' });
  const unlock = page.getByRole('button', { name: '解锁', exact: true });
  await expect(recovery.or(unlock)).toBeVisible({ timeout: 30_000 });
  if (await unlock.isVisible().catch(() => false)) {
    await page.getByLabel('本机数据密码').fill(DEVICE_PASSWORD);
    await unlock.click();
  }

  await expect(recovery).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('只读恢复模式', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出加密 .zcbak' })).toBeVisible();
  await expect(page.getByRole('button', { name: '改为连接服务器' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^\+ 记(?:账|支出)$/ })).toHaveCount(0);
});
