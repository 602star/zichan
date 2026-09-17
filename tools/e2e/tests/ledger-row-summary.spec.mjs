import { test, expect } from './fixtures.mjs';
import { openTransactions } from './helpers.mjs';

test.setTimeout(120_000);

/** 行内的摘要主标题（粗体那一格）。 */
function summaryOf(row) {
  return row.locator('span > span').first();
}

/** 记一笔支出；`description` 可以不填。 */
async function recordExpense(page, { category, amount, description }) {
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expect(form).toBeVisible();
  await form.getByLabel('二级分类').click();
  const panel = form.locator('.zc-category-picker-panel');
  await panel.getByPlaceholder('查找分类，输入可搜索隐藏分类').fill(category);
  /*
   * 选择器把标签按 `/` 拆开再拼回，所以叶子名自带的斜杠在面板里会带上空格
   * （「打车/网约车」显示成「打车 / 网约车」），正则要容忍这个空格。
   */
  const optionName = new RegExp(category.split('/').map((part) => part.trim()).join('\\s*/\\s*'));
  await panel.getByRole('option', { name: optionName }).first().click();
  if (description) await form.getByLabel('描述').fill(description);
  await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  // 记完之后用最稳的那个标识等行出现：有描述就用描述（金额会被去掉末尾的 0）。
  const marker = description ?? amount;
  await expect(page.locator('#transaction-records .zc-transaction-row').filter({ hasText: marker }).first()).toBeVisible();
}

/*
 * 不写描述时，摘要那一格过去显示的是一个真的横杠字符：兜底链是
 * 「描述 → 商户 → 分类」，而没商户时中间那一环返回的就是 `'—'`——它不是空值，
 * `??` 就停在那里，后面的商户与分类永远轮不到。
 */
test('a row saved without a description reads as its subcategory, not as a dash', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { category: '堂食餐饮', amount: '23.45' });

  const row = page.locator('#transaction-records .zc-transaction-row').filter({ hasText: '23.45' });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText('—');
  // 摘要写二级名；完整的「一级 / 二级」留给旁边那一列的分类标签。
  await expect(summaryOf(row)).toHaveText('堂食餐饮');
  await expect(row.getByText('食品餐饮 / 堂食餐饮', { exact: true })).toBeVisible();
});

/*
 * 分类列过去写死 112px，而「一级 / 二级」标签最长的几个（打车/网约车实测 134px）会顶出格子，
 * 两列之间只有 12px 间距——标签就画到旁边的描述文字上了。
 * 桌面（≥1024px）把这一列放到 200px，内置分类一个都不用省略。
 */
test('a long 「一级 / 二级」 chip stays inside its own column and is not ellipsised', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { category: '打车/网约车', amount: '41.20', description: '打车加班' });

  const row = page.locator('#transaction-records .zc-transaction-row').filter({ hasText: '打车加班' });
  await expect(row).toHaveCount(1);
  const chip = row.getByText('交通出行 / 打车/网约车', { exact: true });
  const summary = summaryOf(row);

  /*
   * 分类列不再固定 112px。行首还可能有勾选框轨道，所以按「分类标签是这一行的第几个
   * 子元素」去取对应的轨道，而不是写死下标。
   */
  const chipIndex = await chip.evaluate((el) => [...el.parentElement.children].indexOf(el));
  const tracks = (await row.evaluate((el) => getComputedStyle(el).gridTemplateColumns))
    .trim().split(/\s+/).map(Number.parseFloat);
  expect(tracks[chipIndex]).toBeGreaterThan(112);

  // 桌面宽度够，就一个都不省略。
  expect(await chip.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);

  const chipBox = await chip.boundingBox();
  const summaryBox = await summary.boundingBox();
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(summaryBox.x + 0.5);
});
