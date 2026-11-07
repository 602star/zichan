import { test, expect } from './fixtures.mjs';
import { openTransactions } from './helpers.mjs';

test.setTimeout(720_000);

/** 流水列表里的行（不含「最近使用」模板条）。 */
function rows(page) {
  return page.locator('#transaction-records .zc-transaction-row');
}

/** 在轻量记账模式下记一笔支出（只填二级分类、描述、金额）。 */
async function recordExpense(page, { category, description, amount }) {
  await page.getByRole('button', { name: '+ 记账' }).click();
  const form = page.getByRole('dialog', { name: '新增 · 日常收支' });
  await form.getByLabel('分类').click();
  const panel = page.locator('.zc-category-picker-panel');
  await panel.getByLabel('搜索分类', { exact: true }).fill(category);
  await panel.getByRole('option', { name: new RegExp(category) }).first().click();
  await form.getByLabel('描述').fill(description);
  await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(rows(page).getByText(description, { exact: true })).toBeVisible();
}

/**
 * 构成环是两级：左环画一级（板块），点一段**按该板块筛选**并让右环画出它的二级；
 * 点右环的细分再收窄到那一项。
 *
 * 两级都必须能退回去：轻量模式不渲染筛选行（`Filters` 只在资产模式出现），所以
 * 面包屑是这些筛选唯一的出口——否则点一下环就把账本锁进一个看不见的筛选里。
 */
test('the composition rings drill 板块 then 二级, and the breadcrumb steps back', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { category: '堂食餐饮', description: '午餐', amount: '38.50' });
  await recordExpense(page, { category: '公交地铁', description: '通勤', amount: '6' });

  const lunch = rows(page).getByText('午餐', { exact: true });
  const commute = rows(page).getByText('通勤', { exact: true });
  const preset = page.getByLabel('快捷时间范围');
  const crumbs = page.locator('.zc-drill-crumbs');
  const backToAll = page.getByRole('button', { name: '退回到全部支出' });
  // 左环画板块：一笔堂食餐饮落到「食品餐饮」这一段。两个环的行都在同一种 class 下，
  // 所以都要先钉到自己的环上，否则标签里出现父级名就会同时命中两个。
  const parentRing = page.getByTestId('composition-parent');
  const foodSlice = parentRing.locator('.zc-donut-legend-row.is-drillable', { hasText: '食品餐饮' });
  const childRing = page.getByTestId('composition-children');
  const childSlice = childRing.locator('.zc-donut-legend-row.is-drillable', { hasText: '堂食餐饮' });

  await expect(lunch).toBeVisible();
  await expect(commute).toBeVisible();
  await expect(crumbs).toBeHidden();
  await expect(childRing).toBeHidden();

  // 把区间先拨到「全部时间」，这样才看得出下钻顺手改掉的区间有没有还回来。
  await preset.selectOption('all');
  await foodSlice.click();

  // 一级：列表收窄到板块，右环长出来，区间跟着环收窄到本月。
  await expect(lunch).toBeVisible();
  await expect(commute).toBeHidden();
  await expect(foodSlice).toHaveClass(/is-selected/);
  await expect(preset).toHaveValue('this_month');
  await expect(childRing).toBeVisible();
  await expect(childSlice).toBeVisible();
  await expect(crumbs).toContainText('食品餐饮');

  // 二级：同一个板块里再收到一项，面包屑多一层。
  await childSlice.click();
  await expect(lunch).toBeVisible();
  await expect(commute).toBeHidden();
  await expect(childSlice).toHaveClass(/is-selected/);
  await expect(crumbs).toContainText('堂食餐饮');

  // 退一层回到板块：细分高亮消失，列表仍按板块筛，区间不动（用户没改过它）。
  await page.getByRole('button', { name: '退回一级：食品餐饮' }).click();
  await expect(crumbs).not.toContainText('堂食餐饮');
  await expect(childSlice).not.toHaveClass(/is-selected/);
  await expect(commute).toBeHidden();
  await expect(preset).toHaveValue('this_month');

  // 全部清掉：两类流水都回来，右环收起，区间还原成下钻前的「全部时间」。
  await backToAll.click();
  await expect(commute).toBeVisible();
  await expect(crumbs).toBeHidden();
  await expect(childRing).toBeHidden();
  await expect(foodSlice).not.toHaveClass(/is-selected/);
  await expect(preset).toHaveValue('all');

  // 再点同一段就是退回一层：一级 → 全部。
  await foodSlice.click();
  await expect(commute).toBeHidden();
  await foodSlice.click();
  await expect(commute).toBeVisible();
  await expect(crumbs).toBeHidden();
});

/**
 * 报表页的同一道题。它的图有两个形态，这里都走一遍：环形画板块并让右环出二级，
 * 条形在选中板块后只排那一个板块的二级——两种形态必须是同一道题的两个读法。
 */
test('the reports rings drill 板块 then 二级, in both chart shapes', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { category: '堂食餐饮', description: '午餐', amount: '38.50' });
  await recordExpense(page, { category: '公交地铁', description: '通勤', amount: '6' });

  await page.locator('.zc-sidebar').getByRole('button', { name: /设置$/ }).click();
  // 报表默认不在侧边栏；滑块包裹在 <label> 里，点输入框会被标签再激活一次（状态回到原样），
  // 所以用键盘激活这一次——与用户按空格同一条路。
  const reportsNav = page.getByRole('checkbox', { name: /在侧边栏显示.*报表/ });
  await reportsNav.focus();
  await reportsNav.press('Space');
  await expect(reportsNav).toBeChecked();
  await page.locator('.zc-sidebar').getByRole('button', { name: /报表$/ }).click();

  const details = page.locator('#transaction-report-details');
  const lunch = details.getByText('午餐', { exact: true });
  const commute = details.getByText('通勤', { exact: true });
  const crumbs = page.locator('.zc-drill-crumbs');
  const backToAll = page.getByRole('button', { name: '退回到全部支出' });
  const parentRing = page.getByTestId('composition-parent');
  const foodSlice = parentRing.locator('.zc-donut-legend-row.is-drillable', { hasText: '食品餐饮' });
  const childRing = page.getByTestId('composition-children');

  await expect(details).toContainText('流水明细');
  await expect(crumbs).toBeHidden();

  await foodSlice.click();
  await expect(details).toContainText('已按分类下钻');
  await expect(lunch).toBeVisible();
  await expect(commute).toBeHidden();
  await expect(childRing).toBeVisible();
  await expect(crumbs).toContainText('食品餐饮');

  await childRing.locator('.zc-donut-legend-row.is-drillable', { hasText: '堂食餐饮' }).click();
  await expect(details).toContainText('堂食餐饮');
  await expect(lunch).toBeVisible();
  await expect(commute).toBeHidden();

  await expect(backToAll).toBeVisible();
  await backToAll.click();
  await expect(details).not.toContainText('已按分类下钻');
  await expect(commute).toBeVisible();
  await expect(crumbs).toBeHidden();

  // 条形：同样列二级（整段区间），点一条按那条二级下钻，板块跟着它的归属走；
  // 选中后条形只剩这个板块的二级，不再列别的板块。
  await page.getByRole('button', { name: '条形', exact: true }).click();
  await expect(page.getByRole('group', { name: '分类图形态' })).toBeVisible();
  const bars = page.getByRole('group', { name: /排名/ });
  await bars.getByRole('button', { name: /^堂食餐饮 · / }).click();
  await expect(commute).toBeHidden();
  await expect(lunch).toBeVisible();
  await expect(crumbs).toContainText('食品餐饮');
  await expect(crumbs).toContainText('堂食餐饮');
  await expect(bars.getByRole('button', { name: /^公交地铁 · / })).toBeHidden();
});

/**
 * 图区是上下两张整幅卡：构成在上、趋势在下，而且环的图例不许出现省略号。
 *
 * 以前两张图在宽屏并排，构成卡只拿到半幅，卡里的两个环再分那半幅：实测分类名的
 * 可用宽度是 0px——名字整段被省略号吃掉，而图例是环唯一的读法。所以这里量几何
 * （上下关系、等宽、没有被截断的标签），不量审美。
 */
test('the 日常收支 charts stack full width, and no legend name is cut off', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { category: '堂食餐饮', description: '午餐', amount: '38.50' });
  await recordExpense(page, { category: '水电燃气', description: '水电', amount: '126.40' });

  /* 布局在卡片外量：卡片的矩形与图例的可用宽度都不受滚动位置影响。 */
  const chartGeometry = () => page.evaluate(() => {
    const cards = [...document.querySelector('#transaction-charts').children];
    return {
      cards: cards.map((card) => {
        const rect = card.getBoundingClientRect();
        return {
          title: (card.querySelector('div')?.textContent ?? '').slice(0, 12),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          bottom: Math.round(rect.bottom),
        };
      }),
      cutOff: [...document.querySelectorAll('.zc-donut-legend-label')]
        .filter((label) => label.scrollWidth > label.clientWidth + 1)
        .map((label) => label.textContent),
      /*
       * 每个图例行里「名字的右边缘」到「金额的左边缘」的距离。名字列曾经是
       * `1fr`：在宽卡片上名字盒 444px 而名字本身只有 52px，金额被推到右手
       * 边——一行读起来像两列。这里把它量成数字，免得以后再漂回去。
       */
      nameToAmountGaps: [...document.querySelectorAll('.zc-donut-legend-row')].map((row) => {
        const label = row.querySelector('.zc-donut-legend-label');
        const amount = row.querySelector('.zc-donut-legend-amount');
        const range = document.createRange();
        range.selectNodeContents(label);
        const nameWidth = Math.min(range.getBoundingClientRect().width, label.clientWidth);
        return Math.round(amount.getBoundingClientRect().left - label.getBoundingClientRect().left - nameWidth);
      }),
    };
  });

  // 未下钻：一个环也要占满整行，名字不能只剩省略号。
  const plain = await chartGeometry();
  expect(plain.cards).toHaveLength(2);
  expect(plain.cards[0].title).toContain('构成');
  expect(plain.cards[1].title).toContain('趋势');
  expect(plain.cards[1].top).toBeGreaterThanOrEqual(plain.cards[0].bottom - 1);
  expect(plain.cards[1].left).toBe(plain.cards[0].left);
  expect(plain.cards[1].width).toBe(plain.cards[0].width);
  expect(plain.cutOff).toEqual([]);
  // 一行一个读法：名字与它自己的金额相邻（行内对齐间距是 8px）。
  expect(plain.nameToAmountGaps.length).toBeGreaterThan(0);
  for (const gap of plain.nameToAmountGaps) expect(gap).toBeLessThanOrEqual(24);

  // 下钻后两个环并排，图例变窄——这正是以前文字被吃掉的场景。
  await page.getByTestId('composition-parent').locator('.zc-donut-legend-row.is-drillable', { hasText: '食品餐饮' }).click();
  await expect(page.getByTestId('composition-children')).toBeVisible();
  const drilled = await chartGeometry();
  expect(drilled.cards[1].top).toBeGreaterThanOrEqual(drilled.cards[0].bottom - 1);
  expect(drilled.cutOff).toEqual([]);
  for (const gap of drilled.nameToAmountGaps) expect(gap).toBeLessThanOrEqual(24);
});

/** Open the daily ledger's filter controls. */
async function switchToAssetsMode(page) {
  const sidebar = page.locator('.zc-sidebar');
  await sidebar.getByRole('button', { name: /日常收支$/ }).click();
  await expect(page.getByText('日常流水', { exact: true }).first()).toBeVisible();
}

/**
 * 筛选行里的分类控件与环下钻是同一套筛选的两个入口，所以它们不能各说一套：
 *
 * - 控件说「X · 全部」只在筛选确实停在一级上时。选了二级后一级只是它的归属，控件必须
 *   回到「全部分类」——否则空选项被一级的名字占着，用户再也选不到「全部分类」，
 *   而那个选项以前还只清二级、留下一级继续筛（写着全部分类、列表却还是少的）。
 * - 用户自己改了分类，环的下钻就不再成立，面包屑不能继续指着一个没在生效的筛选；
 *   但新值仍落在下钻那一层里时（下钻到板块后又选了它的二级）下钻要继续有效。
 */
test('the filter row and the ring drill agree on what is filtering', async ({ page }) => {
  await openTransactions(page);
  await recordExpense(page, { category: '堂食餐饮', description: '午餐', amount: '38.50' });
  await recordExpense(page, { category: '公交地铁', description: '通勤', amount: '6' });
  await switchToAssetsMode(page);

  const filter = page.getByLabel('流水分类');
  const panel = page.locator('.zc-category-picker-panel');
  const crumbs = page.locator('.zc-drill-crumbs');
  const search = () => panel.getByLabel('搜索分类', { exact: true });
  await expect(filter).toContainText('全部分类');

  // 环下钻到一级：筛选真的停在一级上，控件就这么说。
  await page.getByTestId('composition-parent').locator('.zc-donut-legend-row.is-drillable', { hasText: '食品餐饮' }).click();
  await expect(crumbs).toBeVisible();
  await expect(filter).toContainText('食品餐饮 · 全部');

  // 在同一个板块里挑二级：下钻继续有效，但控件回到「全部分类」。
  await filter.click();
  await search().fill('堂食餐饮');
  await panel.getByRole('option', { name: /堂食餐饮/ }).first().click();
  await expect(crumbs).toContainText('食品餐饮');
  await expect(filter).toContainText('堂食餐饮');
  await filter.click();
  await expect(panel.getByRole('button', { name: '全部分类' })).toBeVisible();

  // 挑另一个板块的二级：旧的下钻不再成立，面包屑得撤掉。
  await search().fill('公交地铁');
  await panel.getByRole('option', { name: /公交地铁/ }).first().click();
  await expect(crumbs).toBeHidden();
  await expect(rows(page).getByText('通勤', { exact: true })).toBeVisible();
  await expect(rows(page).getByText('午餐', { exact: true })).toHaveCount(0);

  // 「全部分类」连一级一起清：以前只清二级，控件写着全部分类而列表还是少的。
  await filter.click();
  await panel.getByRole('button', { name: '全部分类' }).click();
  await expect(filter).toContainText('全部分类');
  await expect(rows(page).getByText('午餐', { exact: true })).toBeVisible();
});
