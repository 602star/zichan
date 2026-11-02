import { test, expect } from './fixtures.mjs';

async function start(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '注册新账号', exact: true }).click();
  await page.getByLabel('昵称', { exact: true }).fill('端到端测试用户');
  await page.getByLabel('服务器用户名').fill(`category-${crypto.randomUUID()}`);
  await page.getByLabel('服务器账号密码', { exact: true }).fill('Category-layout-password');
  await page.getByLabel('确认账号密码', { exact: true }).fill('Category-layout-password');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await page.getByRole('button', { name: '开始记账', exact: true }).click();
  await page.getByRole('button', { name: '记第一笔', exact: true }).click();
}

async function fits(panel) {
  await expect(panel).toBeVisible();
  const bounds = await panel.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      width: innerWidth, height: innerHeight, overflow: node.scrollWidth > node.clientWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
  expect(bounds.overflow).toBe(false);
}

test.describe('touch category selection', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('opens the category list without focusing search and shows the amount currency', async ({ page }) => {
    await start(page);
    const entry = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
    await expect(entry.getByLabel('当前币种')).toHaveText('人民币');
    await expect(entry.getByLabel(/^币种/)).toBeHidden();
    await entry.getByText('更多信息', { exact: true }).click();
    await expect(entry.getByLabel(/^币种/)).toBeVisible();
    await entry.getByLabel(/^分类/).click();
    const picker = page.getByRole('dialog', { name: '选择分类', exact: true });
    await expect(picker.getByRole('button', { name: '关闭分类选择' })).toBeFocused();
    await expect(picker.getByLabel('搜索分类')).not.toBeFocused();
    await picker.getByLabel('搜索分类').fill('交通');
    await expect(picker.getByRole('option').first()).toBeVisible();
  });
});

test('actual half-width forms, filters and advanced queries share the overlay', async ({ page }) => {
  await start(page);
  await page.getByRole('dialog', { name: '新增 · 日常收支' }).getByRole('button', { name: '取消', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '选择分类', exact: true });
  await page.getByRole('button', { name: '+ 交易对象', exact: true }).click();
  const payee = page.getByRole('dialog', { name: '新增 · 交易对象', exact: true });
  const narrow = payee.getByLabel('默认分类', { exact: true });
  expect((await narrow.boundingBox()).width).toBeLessThan(300);
  await narrow.click();
  await fits(panel);
  expect((await panel.boundingBox()).width).toBeGreaterThan(500);
  await panel.getByRole('button', { name: '交通出行', exact: true }).click();
  await panel.getByRole('option', { name: '打车/网约车', exact: true }).click();
  await expect(narrow).toContainText('打车/网约车');
  await payee.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
  await page.getByLabel('流水分类', { exact: true }).click();
  await fits(panel);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^高级查询/ }).click();
  await page.getByRole('button', { name: '+ 条件组 OR', exact: true }).click();
  await page.getByLabel('高级查询字段').first().selectOption('category');
  await page.getByLabel('高级查询值').first().click();
  await fits(panel);
  await page.keyboard.press('Escape');
});

for (const width of [320, 390, 768, 1280]) {
  test(`category picker fits ${width}px with a narrow trigger and preserves the parent form`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await start(page);
    const entry = page.getByRole('dialog', { name: '新增 · 日常收支', exact: true });
    await entry.getByLabel(/^金额/).fill('19');
    const trigger = entry.getByLabel(/^分类/);
    // Exercise the shared field at the width of a half-form or filter cell, near an edge.
    await trigger.evaluate((node) => { Object.assign(node.style, { width: '130px' }); });
    await trigger.click();
    const panel = page.getByRole('dialog', { name: '选择分类', exact: true });
    await fits(panel);
    await panel.getByRole('button', { name: '返回一级分类', exact: true }).isVisible().then(async (visible) => {
      if (visible) await panel.getByRole('button', { name: '返回一级分类', exact: true }).click();
    });
    await panel.getByRole('button', { name: '交通出行', exact: true }).click();
    await panel.getByRole('button', { name: '关闭分类选择', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    expect(await panel.evaluate((node) => node.contains(document.activeElement) && document.activeElement.getClientRects().length > 0)).toBe(true);
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: '关闭分类选择', exact: true })).toBeFocused();
    const option = panel.getByRole('option', { name: '打车/网约车', exact: true });
    await expect(option).toBeVisible();
    await option.scrollIntoViewIfNeeded();
    expect(await option.evaluate((node) => {
      const text = node.querySelector('.zc-category-option-text');
      const box = text.getBoundingClientRect();
      return text.scrollWidth <= text.clientWidth && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('[role="option"]') === node;
    })).toBe(true);
    await page.screenshot({ path: `test-results/category-${width}.png` });
    await option.click();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('打车/网约车');
    await trigger.click();
    await panel.getByLabel('搜索分类').fill('加油');
    await expect(panel.getByRole('option').first()).toContainText('交通出行');
    await expect.poll(async () => (await panel.boundingBox()).height).toBeLessThan(200);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(entry).toBeVisible();
    await expect(entry.getByLabel(/^金额/)).toHaveValue('19');
  });
}

test('long custom category names and badges wrap; the panel avoids the right and bottom edges', async ({ page }) => {
  await start(page);
  await page.getByRole('dialog', { name: '新增 · 日常收支' }).getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '+ 分类', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 收支分类', exact: true });
  const longName = '跨城市演出交通与住宿费用及超长自定义分类名称完整显示测试';
  await form.getByLabel(/^名称/).fill(longName);
  await form.getByLabel('父级分类', { exact: true }).selectOption({ label: '交通出行' });
  await form.getByLabel('在快速选择中隐藏', { exact: true }).check();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: '+ 记账', exact: true }).click();
  const trigger = page.getByRole('dialog', { name: '新增 · 日常收支' }).getByLabel(/^分类/);
  await trigger.evaluate((node) => Object.assign(node.style, { position: 'fixed', right: '12px', bottom: '12px', width: '160px' }));
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '选择分类', exact: true });
  await fits(panel);
  await panel.getByLabel('搜索分类').fill(longName);
  const option = panel.getByRole('option', { name: new RegExp(longName) });
  await expect(option).toContainText('隐藏');
  expect(await option.locator('.zc-category-option-text').evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight)).toBe(true);
  // 200% browser zoom has approximately the same CSS viewport as half the screen size.
  await page.setViewportSize({ width: 640, height: 400 });
  await fits(panel);
  await option.click();
  await expect(trigger).toContainText(longName);
});
