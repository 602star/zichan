import { test, expect } from './fixtures.mjs';
import { openTransactions } from './helpers.mjs';
import { SYSTEM_CATEGORY_CATALOG, categoryLabel } from '../../../packages/core/dist/index.js';

test.use({ viewport: { width: 1280, height: 900 } });

test('every built-in category path fits its ledger column at readable font sizes', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
  await entry.getByLabel(/^金额/).fill('1234.56');
  await entry.getByLabel('描述', { exact: true }).fill('完整分类列宽验收');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toBeHidden();
  const labels = SYSTEM_CATEGORY_CATALOG.map((category) => categoryLabel(category.id));
  const measurements = [];
  for (const width of [1280, 1024, 820, 768, 1920, 2560, 3200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    const result = await page.locator('.zc-transaction-category-label').first().evaluate((node, labels) => {
      const style = getComputedStyle(node);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const widest = labels.map((label) => ({ label, width: context.measureText(label).width })).sort((a, b) => b.width - a.width)[0];
      const original = node.textContent;
      const failures = [];
      for (const label of labels) {
        node.textContent = label;
        if (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > parseFloat(style.lineHeight) + 1) failures.push(label);
      }
      node.textContent = widest.label;
      const column = node.closest('td').getBoundingClientRect().width;
      const summary = node.closest('tr').querySelector('.zc-transaction-summary-title').getBoundingClientRect().width;
      return { fontSize: style.fontSize, fontFamily: style.fontFamily, widest, column, available: node.clientWidth, summary, failures, original };
    }, labels);
    measurements.push({ viewport: width, ...result, failures: result.failures.length });
    // Exercise the production row with all catalog paths, including optional and hidden categories.
    await page.screenshot({ path: test.info().outputPath(`built-in-categories-${width}.png`) });
    await page.locator('.zc-transaction-category-label').first().evaluate((node, text) => { node.textContent = text; }, result.original);
  }
  console.log(JSON.stringify(measurements));
  expect(measurements.filter((result) => result.failures > 0)).toEqual([]);
  expect(measurements.every((result) => result.summary >= 100)).toBe(true);
});
