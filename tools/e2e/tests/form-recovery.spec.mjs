import { test, expect } from './fixtures.mjs';
import { openLedger, openTransactions } from './helpers.mjs';

test.setTimeout(480_000);

test('points at the field that blocks a save instead of only refusing', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '+ 记账' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await expect(form).toBeVisible();

  const amount = form.getByRole('textbox', { name: /^金额/ });
  await expect(amount).toHaveValue('');
  await page.getByRole('button', { name: '保存', exact: true }).click();

  // The refusal now names the fields and offers a jump, instead of a bare "请检查标出的必填项".
  const recovery = form.getByRole('alert');
  await expect(recovery).toContainText('需要处理');
  await expect(form.getByText('金额必须大于 0', { exact: true })).toBeVisible();
  await expect(amount).toBeFocused();

  // Moving away and clicking the chip comes back to the same field.
  await form.getByLabel('描述').click();
  await expect(amount).not.toBeFocused();
  await recovery.getByRole('button', { name: '金额', exact: true }).click();
  await expect(amount).toBeFocused();

  // 描述 is no longer mandatory, so the amount alone is enough to save.
  await amount.fill('42');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText('暂无流水')).toHaveCount(0);
});

test('saves an item asset that only registers the purchase', async ({ page }) => {
  await openLedger(page);
  const sidebar = page.locator('.zc-sidebar');
  await sidebar.getByRole('button', { name: /物品资产$/ }).click();
  await page.getByRole('button', { name: '+ 新增物品' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 物品资产' });
  await expect(form).toBeVisible();

  await form.getByLabel('名称').fill('Playwright 记录用相机');
  await page.getByRole('button', { name: '保存', exact: true }).click();

  /*
   * The three cashflow fields are required only while 同时创建支出 is selected.
   * 仅登记物品 must save without them, and without a jump prompt.
   */
  await expect(form).toBeHidden();
  await expect(page.getByText('Playwright 记录用相机', { exact: true })).toBeVisible();
});

async function rejectDraftWrites(page) {
  await page.evaluate(() => {
    window.__draftPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (typeof key === 'string' && key.startsWith('form-draft.v1.')) {
        throw new DOMException('模拟存储空间不足', 'QuotaExceededError');
      }
      return window.__draftPut.call(this, value, key);
    };
  });
}

async function allowDraftWrites(page) {
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = window.__draftPut;
    delete window.__draftPut;
  });
}

test('reports an IndexedDB draft failure and clears the warning after a successful retry', async ({ page }) => {
  await openTransactions(page);
  await rejectDraftWrites(page);
  await page.getByRole('button', { name: '+ 记账' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await form.getByRole('textbox', { name: /^金额/ }).fill('42');
  await expect(form.getByRole('alert')).toContainText('草稿自动保存失败：模拟存储空间不足');
  await allowDraftWrites(page);
  await form.getByLabel('描述').fill('恢复草稿保存');
  await expect(form.getByRole('status').filter({ hasText: '草稿已自动保存' })).toBeVisible();
  await form.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog', { name: '关闭未保存表单' }).getByRole('button', { name: '保留草稿并关闭' }).click();
  await expect(form).toBeHidden();
});
