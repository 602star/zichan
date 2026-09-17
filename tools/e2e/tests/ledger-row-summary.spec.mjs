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
  // 面板右栏写的是叶子名本身，自带的斜杠原样保留，所以按名字直接找得到。
  await panel.getByRole('option', { name: category }).first().click();
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

/*
 * 面板右栏和触发按钮上写的是二级名本身。过去这里拿「一级 / 二级」拼出来的标签按 `/`
 * 反解再拼回，叶子名自带的斜杠被当成了层级边界，于是显示成「打车 / 网约车」——
 * 一个字符都没多、一个都没少，只是凭空多了两个空格，不盯真实 DOM 就看不见。
 *
 * 断言只能用锚定正则：`toContainText` 会先把期望串 `trim()` 再当子串找（见
 * `ExpectedTextMatcher.normalize`），`' / '` 会被裁成 `'/'`，于是只要文本里有斜杠就命中，
 * 写不出「没有空格」这件事。正则不参与归一化，锚定的 `^…$` 连同空格一起管住。
 */
test('the picker spells a subcategory name with a slash verbatim', async ({ page }) => {
  await openTransactions(page);
  await page.getByRole('button', { name: '+ 记支出' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常支出' });
  await expect(form).toBeVisible();
  await form.getByLabel('二级分类').click();
  const panel = form.locator('.zc-category-picker-panel');
  await panel.getByPlaceholder('查找分类，输入可搜索隐藏分类').fill('打车/网约车');

  // 右栏：首字色块 + 叶子名，中间只允许空白，不允许「 / 」。
  const option = panel.getByRole('option').filter({ hasText: '打车' });
  await expect(option).toHaveCount(1);
  await expect(option).toHaveText(/^打\s*打车\/网约车$/);

  // 选完后，触发按钮上的两栏读法也不许被改写。
  await option.click();
  await expect(form.getByLabel('二级分类')).toHaveText(/^交通出行\s*›\s*打车\/网约车\s*[▲▼]$/);
});
