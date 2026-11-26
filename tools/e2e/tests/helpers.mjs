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
  const quickExpense = page.getByRole('dialog', { name: '记一笔支出' });

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
    await quickStart.click();
  }
  await expect(appReady).toBeVisible({ timeout: 30_000 });

  if (options.keepQuickExpense !== true && await quickExpense.isVisible().catch(() => false)) {
    await quickExpense.getByRole('button', { name: '取消', exact: true }).click();
    await expect(quickExpense).toBeHidden();
  }
}

export async function openTransactions(page) {
  await openLedger(page);
  await page.locator('.zc-sidebar nav').getByRole('button', { name: '流水', exact: true }).click();
  await expect(page.locator('#transaction-records').getByRole('button', { name: /^\+ 记(账|支出)$/ })).toBeVisible();
}

export async function syntheticPng(page, width = 1, height = 1, noise = false) {
  const base64 = await page.evaluate(({ width, height, noise }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, width, height);
    if (noise) {
      const image = ctx.createImageData(width, height);
      for (let offset = 0; offset < image.data.length; offset += 65536) crypto.getRandomValues(image.data.subarray(offset, Math.min(offset + 65536, image.data.length)));
      for (let offset = 3; offset < image.data.length; offset += 4) image.data[offset] = 255;
      ctx.putImageData(image, 0, 0);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height, noise });
  return Buffer.from(base64, 'base64');
}

/** Review the selected synthetic image through its own attachment action. */
export async function reviewImageAttachment(page) {
  const item = page.locator('.zc-attachment-item').last();
  await item.getByRole('button', { name: '提取信息', exact: true }).click();
  const panel = page.locator('.zc-attachment-processing');
  await expect(panel).toBeVisible();
  await panel.locator('.zc-attachment-file-tools > summary').click();
  const cancel = panel.getByRole('button', { name: '取消识别', exact: true });
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  const privacyTab = panel.getByRole('tab', { name: /^图片与隐私/ });
  if (await privacyTab.isVisible()) await privacyTab.click();
  await panel.getByRole('checkbox', { name: '已检查整张图片并确认隐私遮盖', exact: true }).check();
  const apply = page.getByRole('button', { name: '确认并应用', exact: true });
  await expect(apply).toBeEnabled(); await apply.click(); await expect(panel).toBeHidden();
}
