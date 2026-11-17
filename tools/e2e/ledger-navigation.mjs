import { expect } from '@playwright/test';

/** Use the application's public navigation event when navigation itself is not under test. */
export async function openLedgerSection(page, screen, tab) {
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail })), { screen, tab });
}

export async function selectValue(page, control, value, label) {
  if (await control.evaluate((node) => node.tagName === 'SELECT')) await control.selectOption(value);
  else {
    await control.click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }
}

export async function clickLedgerNavigation(page, label) {
  const desktop = ({ 总览: '工作台', 日常收支: '流水', 管理: '资料管理', 历史: '操作历史' })[label] ?? label;
  const sidebar = page.locator('.zc-sidebar');
  if (await sidebar.isVisible()) await sidebar.getByRole('button', { name: desktop, exact: true }).click();
  else {
    const bottom = page.getByRole('navigation', { name: '移动端主导航' });
    const mobile = ({ 工作台: '总览', 流水: '收支' })[desktop] ?? desktop;
    const direct = bottom.getByRole('button', { name: mobile, exact: true });
    if (await direct.count()) await direct.click();
    else {
      await bottom.getByRole('button', { name: /更多$/ }).click();
      await page.getByRole('dialog', { name: '更多功能' }).getByRole('button', { name: desktop, exact: true }).click();
    }
  }
  await page.waitForTimeout(200);
}

export async function visitManageSections(page, visit) {
  const directory = page.getByRole('navigation', { name: '资料管理' });
  if (await directory.isVisible()) {
    const labels = await directory.getByRole('button').allTextContents();
    for (const label of labels) {
      await directory.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(200);
      await visit(label);
    }
  } else {
    const labels = await page.locator('main .zc-task-list button').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    for (const label of labels) {
      await page.locator('main .zc-task-list').getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(200);
      await visit(label);
      await page.getByRole('button', { name: '返回资料', exact: true }).click();
    }
  }
}
