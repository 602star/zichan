import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { openLedger, openTransactions } from './helpers.mjs';

test.setTimeout(90_000);

test('records a lightweight expense and keeps it visible after reload', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '+ 记账' }).click();
  await expect(page.getByText('新增 · 日常收支')).toBeVisible();
  await page.getByRole('textbox', { name: /^金额/ }).fill('68');
  await page.getByLabel('描述').fill('Playwright 午餐');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('Playwright 午餐', { exact: true })).toBeVisible();
  await page.reload();
  await openLedger(page);
  await page.getByText('日常收支', { exact: true }).first().click();
  await expect(page.getByText('Playwright 午餐', { exact: true })).toBeVisible();
});

test('auto-saves a form draft and restores it on the next open', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '+ 记账' }).click();
  await page.getByRole('textbox', { name: /^金额/ }).fill('23.50');
  await page.getByLabel('描述').fill('未提交草稿');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并关闭' }).click();
  await page.getByRole('button', { name: '+ 记账' }).click();
  await expect(page.getByRole('status')).toContainText('已恢复');
  await expect(page.getByRole('textbox', { name: /^金额/ })).toHaveValue('23.50');
  await expect(page.getByLabel('描述')).toHaveValue('未提交草稿');
});

test('exports a real PDF report with a valid PDF header', async ({ page }) => {
  await openLedger(page);
  await page.getByText('报表', { exact: true }).first().click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PDF' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
});
