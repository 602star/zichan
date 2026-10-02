import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test.setTimeout(120_000);

/**
 * 管理 →「物品分类」结构列表按一级分类折叠（<details>）。
 *
 * 回归来源：展开/收起的 onToggle 把 `event.currentTarget.open` 读在 setState 的
 * updater 回调里。React 在事件监听器返回后会把 currentTarget 置为 null，而 updater
 * 是在后续渲染阶段才执行的，于是读到 null.open 抛 TypeError，被 AppErrorBoundary
 * 接住，整页变成「这个页面暂时无法显示」。
 *
 * 这条用例（以及整个 e2e 套件）此前从未点过「物品分类」的一级分类标题，所以问题
 * 一直没被覆盖到。
 */
test('expands and collapses a fixed-asset primary category without tripping the error boundary', async ({ page }) => {
  await openLedger(page);
  const sidebar = page.locator('.zc-sidebar');

  await sidebar.getByRole('button', { name: /设置$/ }).click();
  await page.getByLabel('在侧边栏显示管理').click();
  await sidebar.getByRole('button', { name: /管理$/ }).click();
  await expect(page.getByText('资产与资料中心', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: '物品分类', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ 新增物品分类' })).toBeVisible();

  // 默认收起：一级分类下的二级分类行不可见（<details> 收起时子节点仍在 DOM 里）。
  await expect(page.getByText('手机', { exact: true })).toBeHidden();

  const group = (name) => page.locator('details').filter({ has: page.getByText(name, { exact: true }) });
  const electronics = group('数码电子');
  await electronics.getByText('数码电子', { exact: true }).click();

  // 展开后能看到二级分类，且页面没有掉进错误边界。
  await expect(page.getByText('手机', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '这个页面暂时无法显示' })).toHaveCount(0);

  // 再点一次收起，验证 toggle 的两个方向都走通。
  await electronics.getByText('数码电子', { exact: true }).click();
  await expect(page.getByText('手机', { exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: '这个页面暂时无法显示' })).toHaveCount(0);

  // 相邻分组互不影响。
  await group('家用电器').getByText('家用电器', { exact: true }).click();
  await expect(page.getByText('洗衣机', { exact: true })).toBeVisible();
  await expect(page.getByText('手机', { exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: '这个页面暂时无法显示' })).toHaveCount(0);

  // 「全部展开 / 全部收起」走的是另一条路径（state 直接设置），要一起锁住。
  await page.getByRole('button', { name: '全部展开' }).click();
  await expect(page.getByText('手机', { exact: true })).toBeVisible();
  await expect(page.getByText('待分类', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全部收起' }).click();
  await expect(page.getByText('手机', { exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: '这个页面暂时无法显示' })).toHaveCount(0);
});
