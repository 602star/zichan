import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';
import { enableEveryNavigationModule } from '../account-tests/mobile-onboarding.mjs';

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }) => { page.setDefaultTimeout(15_000); await page.clock.setFixedTime(new Date('2026-11-16T11:00:00Z')); });
const go = (page, screen, tab) => page.evaluate((detail) => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail })), { screen, tab });
async function setup(page) { await openLedger(page); await go(page, 'settings'); await enableEveryNavigationModule(page); await go(page, 'fixed'); }
async function select(form, name, label) {
  const control = form.getByRole('combobox', { name });
  if (await form.getAttribute('role') === 'dialog') await expect(control).toHaveJSProperty('tagName', form.page().viewportSize().width <= 767 ? 'BUTTON' : 'SELECT');
  if (await control.evaluate((node) => node.tagName) === 'SELECT') await control.selectOption({ label });
  else { await control.click(); await form.page().getByRole('dialog').last().getByRole('option', { name: label, exact: true }).click(); }
}
async function save(form) { await form.locator('.zc-dialog-foot').getByRole('button', { name: '保存', exact: true }).click(); await expect(form).toBeHidden(); }
async function locations(page) { await page.getByRole('button', { name: '管理位置', exact: true }).click(); await page.getByRole('button', { name: '添加常用房间', exact: true }).click(); await expect(page.getByRole('button', { name: '编辑位置 厨房', exact: true })).toBeVisible(); await page.getByRole('button', { name: '返回物品', exact: true }).click(); }
async function addItem(page, name, location, yearOnly = false, image = false) {
  await page.getByRole('button', { name: '+ 新增物品', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增 · 物品资产', exact: true });
  await form.getByLabel(/^名称/).fill(name); await form.getByLabel(/^购买金额/).fill(yearOnly ? '999' : '2400');
  if (yearOnly) { await select(form, /^购买日期精度/, '只记年份'); await form.getByLabel(/^购置年份/).fill('2024'); }
  else await form.getByLabel('购买日期', { exact: true }).fill('2025-06-01');
  await select(form, /^存放位置/, location);
  if (!yearOnly) {
    const more = form.locator('summary').filter({ hasText: '更多信息' }); if (await more.count()) await more.click();
    const dates = await page.evaluate(() => {
      const day = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      return { maintenance: day(-1), warranty: day(2) };
    });
    await form.getByLabel(/^下次保养日期/).fill(dates.maintenance); await form.getByLabel(/^保养间隔/).fill('30'); await form.getByLabel(/^保修截止日/).fill(dates.warranty);
  }
  if (image) {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 120;
      const context = canvas.getContext('2d'); context.fillStyle = '#e9e3d8'; context.fillRect(0, 0, 120, 120);
      context.fillStyle = '#444d50'; context.fillRect(25, 15, 65, 80); context.fillRect(18, 95, 85, 10);
      context.fillStyle = '#c9d4d5'; context.fillRect(35, 25, 45, 25); context.fillRect(42, 65, 30, 25);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await form.locator('input[name="imageFiles"]').setInputFiles({ name: 'test-appliance.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(form).toContainText('test-appliance.png');
  }
  await save(form);
}

test('cards are the default and the chosen view survives a new tab without carrying private searches', async ({ page, context }) => {
  await page.clock.setFixedTime(new Date());
  await setup(page); await locations(page);
  const longName = '厨房里的多功能咖啡机与超长名称配件组合 Long model 2026';
  await addItem(page, longName, '家 / 厨房', false, true);
  await expect(page.locator('.zc-fixed-item-card img')).toHaveCount(1);
  const originalPhoto = await page.locator('.zc-fixed-item-card img').getAttribute('src');
  await addItem(page, '旧无线耳机', '家 / 卧室', true);
  const mode = () => page.getByRole('group', { name: '物品展示方式', exact: true });
  await expect(mode().getByRole('button', { name: '卡片', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.zc-fixed-item-card')).toHaveCount(2);
  await expect(page.locator('.zc-fixed-item-card img')).toHaveCount(1);
  expect(await page.locator('.zc-fixed-item-card img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.locator('.zc-fixed-item-card img')).toHaveAttribute('src', originalPhoto);
  const old = page.getByRole('article', { name: '旧无线耳机', exact: true });
  await expect(old).toContainText('待补日期'); await expect(old.locator('.zc-fixed-card-photo svg')).toHaveCount(1);
  const coffee = page.getByRole('article', { name: longName, exact: true });
  await expect(coffee).toContainText('另有 1 项待处理');
  for (const width of [1280, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.locator('.zc-card .zc-card')).toHaveCount(0);
    const name = coffee.getByRole('button', { name: longName, exact: true });
    expect(await name.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect((await coffee.getByRole('button', { name: '查看详情', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: test.info().outputPath(`cards-${width}.png`), fullPage: true });
    await coffee.evaluate((node) => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -document.querySelector('.zc-app-header').getBoundingClientRect().height - 12); });
    await coffee.screenshot({ path: test.info().outputPath(`card-${width}.png`) });
    await page.screenshot({ path: test.info().outputPath(`cards-viewport-${width}.png`) });
    await page.locator('.zc-fixed-photo-grid').screenshot({ path: test.info().outputPath(`cards-grid-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await coffee.getByRole('button', { name: longName, exact: true }).click();
  await page.getByRole('tab', { name: '使用与成本', exact: true }).click();
  await page.getByRole('button', { name: '添加使用指标', exact: true }).click();
  let usage = page.getByRole('dialog', { name: '新增 · 使用量指标', exact: true });
  await usage.getByLabel(/^指标名称/).fill('制作咖啡'); await usage.getByLabel(/^主指标/).check(); await save(usage);
  await page.getByRole('button', { name: '返回物品', exact: true }).click();
  await expect(coffee).toContainText('尚未记录');
  await coffee.getByRole('button', { name: '记录使用', exact: true }).click();
  usage = page.getByRole('dialog', { name: '新增 · 使用量记录', exact: true });
  await usage.getByLabel(/^本次增加量/).fill('100'); await save(usage);
  await expect(coffee).toContainText('累计 100 次'); await expect(coffee).toContainText('¥24.00');
  await mode().getByRole('button', { name: '清单', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索物品' }).fill('咖啡机');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(mode().getByRole('button', { name: '清单', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.zc-fixed-inventory-row')).toHaveCount(2);
  await page.getByRole('textbox', { name: '搜索物品' }).fill('咖啡机');
  await page.reload(); await expect(page.locator('.zc-app-shell')).toBeVisible(); await go(page, 'fixed');
  await expect(mode().getByRole('button', { name: '清单', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '搜索物品' })).toHaveValue('咖啡机');
  const reopened = await context.newPage();
  await openLedger(reopened); await go(reopened, 'fixed');
  await expect(reopened.getByRole('group', { name: '物品展示方式', exact: true }).getByRole('button', { name: '清单', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(reopened.getByRole('textbox', { name: '搜索物品' })).toHaveValue('');
  await expect(reopened.locator('.zc-fixed-inventory-row')).toHaveCount(2);
  await reopened.getByRole('group', { name: '物品展示方式', exact: true }).getByRole('button', { name: '卡片', exact: true }).click();
  await reopened.reload(); await expect(reopened.locator('.zc-app-shell')).toBeVisible(); await go(reopened, 'fixed');
  await expect(reopened.locator('.zc-fixed-item-card')).toHaveCount(2); await expect(reopened.locator('.zc-fixed-item-card img')).toHaveCount(1); await reopened.close();
});

test('event tasks buy and scrap a tracked battery, change idle status, and archive without disposing', async ({ page }) => {
  await page.clock.setFixedTime(new Date()); await setup(page); await locations(page); await addItem(page, '巡检无人机', '家 / 卧室');
  await page.getByRole('button', { name: '巡检无人机', exact: true }).click();
  const detail = page.locator('.zc-fixed-item-detail');
  const menu = () => page.getByRole('dialog', { name: '记录物品事件', exact: true });
  await page.getByRole('button', { name: '记录生命周期事件', exact: true }).click();
  await menu().getByRole('button', { name: /^购入配件/ }).click();
  let form = page.getByRole('dialog', { name: '新增 · 购入配件', exact: true });
  await form.getByLabel(/^名称/).fill('飞行电池'); await form.getByLabel(/^购买金额/).fill('399');
  await form.getByLabel('购买日期', { exact: true }).fill('2026-11-15'); await save(form);
  await expect(detail).toContainText('2,799.00');
  await page.getByRole('tab', { name: '记录与凭证', exact: true }).click();
  const purchase = detail.locator('.zc-fixed-history-records .zc-fixed-record-row').filter({ hasText: '购入配件 · 飞行电池' });
  await expect(purchase).toBeVisible(); await purchase.click();
  form = page.getByRole('dialog').last(); await expect(form.getByLabel(/^名称/)).toHaveValue('飞行电池');
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '配件耗材', exact: true }).click();
  await detail.getByRole('button', { name: '报废配件', exact: true }).click();
  form = page.getByRole('dialog', { name: '新增 · 物品生命周期事件', exact: true });
  await expect(form.getByRole('combobox', { name: /^事件类型/ })).toHaveValue('scrap');
  await expect(form.getByLabel(/^本次金额/)).toHaveCount(0); await form.getByLabel('备注', { exact: true }).fill('电池鼓包'); await save(form);
  const part = detail.locator('.zc-fixed-location-row').filter({ hasText: '飞行电池' });
  await expect(part).toContainText('已报废'); await expect(part.getByRole('button', { name: '安装与转装', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '概况', exact: true }).click(); await expect(detail).toContainText('2,799.00');
  await page.getByRole('button', { name: '记录生命周期事件', exact: true }).click(); await menu().getByRole('button', { name: /^转为闲置/ }).click();
  await save(page.getByRole('dialog', { name: '新增 · 物品生命周期事件', exact: true })); await expect(detail.locator('.zc-fixed-toolbar').first()).toContainText('闲置');
  await page.clock.setFixedTime(new Date(await page.evaluate(() => Date.now()) + 1000));
  await page.getByRole('button', { name: '记录生命周期事件', exact: true }).click(); await menu().getByRole('button', { name: /^启用/ }).click();
  await save(page.getByRole('dialog', { name: '新增 · 物品生命周期事件', exact: true })); await expect(detail.locator('.zc-fixed-toolbar').first()).toContainText('使用中');
  await page.getByRole('button', { name: '返回物品', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 巡检无人机', exact: true }).check(); await page.getByRole('button', { name: '归档所选档案', exact: true }).click();
  await page.getByRole('dialog', { name: '归档所选档案', exact: true }).getByRole('button', { name: '归档档案', exact: true }).click();
  await expect(page.locator('[data-fixed-item]')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '查看已归档', exact: true }).check();
  await expect(page.locator('[data-fixed-item]')).toHaveCount(1); await expect(page.locator('.zc-fixed-card-status')).toHaveText('已归档 · 使用中');
  await page.getByRole('button', { name: '恢复档案', exact: true }).click(); await expect(page.locator('[data-fixed-item]')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '查看已归档', exact: true }).uncheck();
  await expect(page.locator('[data-fixed-item]')).toHaveCount(1); await expect(page.locator('[data-fixed-item]')).toContainText('2,799.00');
  await go(page, 'transactions', 'records'); await expect(page.locator('.zc-transaction-row')).toHaveCount(0);
});

test('service subscription tasks fit desktop and phones and preserve a paid coverage period with one payment', async ({ page }) => {
  await page.clock.setFixedTime(new Date()); await setup(page); await locations(page); await addItem(page, '门口监控', '家 / 卧室');
  await page.getByRole('button', { name: '门口监控', exact: true }).click();
  const menu = () => page.getByRole('dialog', { name: '记录物品事件', exact: true });
  for (const mode of ['浅色', '深色']) {
    await page.setViewportSize({ width: 1280, height: 900 }); await go(page, 'settings', 'appearance');
    await page.getByRole('tab', { name: '外观', exact: true }).click(); await page.getByRole('radio', { name: mode, exact: true }).click();
    await go(page, 'fixed'); await page.getByRole('button', { name: '门口监控', exact: true }).click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await page.getByRole('button', { name: '记录生命周期事件', exact: true }).click();
      expect(await menu().evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`event-tasks-${mode}-${width}.png`) });
      await menu().getByRole('button', { name: '关闭记录物品事件', exact: true }).click();
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await page.getByRole('button', { name: '记录生命周期事件', exact: true }).click();
  await menu().getByRole('button', { name: /^软件／云服务订阅/ }).click();
  let form = page.getByRole('dialog', { name: '新增 · 使用费用记录', exact: true });
  await expect(form.getByRole('combobox', { name: /^记录方式/ })).toHaveValue('fee');
  await expect(form.getByLabel(/^用量单位/)).toHaveCount(0);
  await form.getByLabel(/^费用项目/).fill('监控云存储年费'); await form.getByLabel('服务商', { exact: true }).fill('测试云服务商');
  await form.getByLabel(/^服务开始日期/).fill('2026-11-16'); await form.getByLabel(/^服务截止日期/).fill('2027-11-15');
  await form.getByLabel(/^实际总费用/).fill('99'); await select(form, /^资金处理/, '同时创建流水');
  await form.getByLabel(/^流水二级分类/).click(); await page.getByRole('dialog', { name: '选择分类', exact: true }).getByRole('option').first().click();
  await save(form);
  await page.getByRole('tab', { name: '概况', exact: true }).click(); await expect(page.locator('.zc-fixed-item-detail')).toContainText('2,499.00');
  await page.getByRole('tab', { name: '记录与凭证', exact: true }).click();
  const record = page.locator('.zc-fixed-history-records .zc-fixed-record-row').filter({ hasText: '监控云存储年费' });
  await expect(record).toContainText('服务期间 2026-11-16 至 2027-11-15'); await record.click();
  form = page.getByRole('dialog', { name: '编辑 · 使用费用记录', exact: true });
  await expect(form.getByLabel(/^服务截止日期/)).toHaveValue('2027-11-15'); await form.getByRole('button', { name: '取消', exact: true }).click();
  await go(page, 'transactions', 'records'); await expect(page.locator('.zc-transaction-row')).toHaveCount(1); await expect(page.locator('.zc-transaction-amount-original')).toHaveText('-99.00 CNY');
});

test('real inventory combines locations and years, saves views, moves items, exports and completes maintenance', async ({ page }) => {
  const errors=[]; page.on('pageerror', (error)=>errors.push(error.message));
  await setup(page); await locations(page);
  await addItem(page, '厨房咖啡机', '家 / 厨房'); await addItem(page, '旧无线耳机', '家 / 卧室', true);
  await page.getByRole('combobox', { name: '购置年份', exact: true }).selectOption('2025');
  const location = page.getByRole('combobox', { name: '存放位置', exact: true }); await location.selectOption({label:'家 / 厨房'});
  await expect(page.locator('[data-fixed-item]')).toHaveCount(1); await expect(page.locator('[data-fixed-item]')).toContainText('厨房咖啡机');
  await page.getByText('视图、排序与导出',{exact:true}).click(); await page.getByRole('button',{name:'保存当前视图',exact:true}).click();
  let form=page.getByRole('dialog',{name:'新增 · 保存物品视图',exact:true}); await form.getByLabel(/^视图名称/).fill('厨房物品'); await save(form);
  await page.getByRole('button',{name:'清除筛选',exact:true}).click(); await expect(page.locator('[data-fixed-item]')).toHaveCount(2);
  await page.getByRole('button',{name:'厨房物品',exact:true}).click(); await expect(page.locator('[data-fixed-item]')).toHaveCount(1);
  await page.getByRole('checkbox',{name:'选择 厨房咖啡机',exact:true}).check(); await page.getByRole('button',{name:'批量移动位置',exact:true}).click();
  form=page.getByRole('dialog',{name:'新增 · 批量移动物品',exact:true}); await select(form,/^目标位置/,'家 / 卧室'); await save(form);
  await expect(page.locator('[data-fixed-item]')).toHaveCount(0); await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await page.getByRole('button',{name:'旧无线耳机',exact:true}).click(); await expect(page.locator('.zc-fixed-item-detail')).toContainText('待补准确日期'); await page.getByRole('button',{name:'返回物品',exact:true}).click();
  await page.getByRole('button',{name:'厨房咖啡机',exact:true}).click(); await page.getByRole('tab',{name:'记录与凭证',exact:true}).click(); await expect(page.locator('.zc-fixed-item-detail')).toContainText('家 / 厨房 → 家 / 卧室');
  await page.getByRole('tab',{name:'概况',exact:true}).click(); await page.getByRole('button',{name:'完成保养',exact:true}).click(); await page.getByRole('dialog',{name:'完成物品保养',exact:true}).getByRole('button',{name:'完成保养',exact:true}).click();
  await expect(page.getByRole('button',{name:'完成保养',exact:true})).toHaveCount(0);
  await page.getByRole('tab',{name:'记录与凭证',exact:true}).click(); await expect(page.locator('.zc-fixed-item-detail')).toContainText('完成定期保养');
  await page.getByRole('button',{name:'返回物品',exact:true}).click();
  if (!(await page.getByRole('button',{name:'导出 CSV',exact:true}).isVisible())) await page.getByText('视图、排序与导出',{exact:true}).click();
  let downloaded=page.waitForEvent('download'); await page.getByRole('button',{name:'导出 CSV',exact:true}).click();
  expect(await readFile(await (await downloaded).path(),'utf8')).toContain('2024 年（日期未补）');
  downloaded=page.waitForEvent('download'); await page.getByRole('button',{name:'导出 PDF',exact:true}).click(); expect((await readFile(await (await downloaded).path())).subarray(0,5).toString()).toBe('%PDF-');
  await page.reload(); await expect(page.getByRole('button',{name:'厨房物品',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('an existing expense becomes an item without a second expense', async ({ page }) => {
  await setup(page); await go(page,'transactions','records'); await page.getByRole('button',{name:'+ 记账',exact:true}).click();
  let form=page.getByRole('dialog',{name:'新增 · 日常收支',exact:true}); await form.getByLabel(/^金额/).fill('125.45'); await form.getByLabel('描述',{exact:true}).fill('购入台灯'); await save(form);
  await go(page,'fixed'); await page.getByRole('button',{name:'从支出登记',exact:true}).click();
  form=page.getByRole('dialog',{name:'新增 · 从已有支出登记物品',exact:true}); const control=form.getByRole('combobox',{name:/^已有支出流水/}); const option=await control.locator('option').filter({hasText:'购入台灯'}).getAttribute('value'); await control.selectOption(option); await save(form);
  form=page.getByRole('dialog',{name:'新增 · 物品资产',exact:true}); await expect(form.getByLabel(/^名称/)).toHaveValue('购入台灯'); await expect(form.getByLabel(/^购买金额/)).toHaveValue('125.45');
  await form.getByLabel(/^分类/).click(); const picker=page.getByRole('dialog',{name:'选择分类',exact:true}); await picker.getByRole('option').first().click(); await save(form);
  await page.getByRole('button',{name:'购入台灯',exact:true}).click(); await page.getByRole('tab',{name:'记录与凭证',exact:true}).click(); await expect(page.locator('.zc-fixed-item-detail')).toContainText('已关联现有流水');
  await go(page,'transactions','records'); await expect(page.locator('.zc-transaction-row')).toHaveCount(1); await expect(page.locator('.zc-transaction-amount-original')).toHaveText('-125.45 CNY');
});

test('usage expenses preserve paused gaps and charging totals across desktop and mobile', async ({ page }) => {
  // Match the real fixture server clock: a future UI clock expires access tokens
  // immediately and turns reload into an unrelated session-refresh rate-limit test.
  await page.clock.setFixedTime(new Date());
  await setup(page); await locations(page); await addItem(page, '净水器与充电费用测试', '家 / 厨房');
  await page.getByRole('button', { name: '净水器与充电费用测试', exact: true }).click();
  await page.getByRole('tab', { name: '使用与成本', exact: true }).click();
  const detail = page.locator('.zc-fixed-item-detail');
  const dialog = () => page.getByRole('dialog', { name: /使用费用记录/ });
  await page.getByRole('button', { name: '添加计量项目', exact: true }).click();
  await dialog().getByLabel(/^当前累计读数/).fill('100'); await save(dialog());
  await page.getByRole('button', { name: '抄表计费', exact: true }).click();
  await dialog().getByLabel(/^当前累计读数/).fill('110.5'); await dialog().getByLabel(/^本段单价/).fill('0.6'); await save(dialog());
  await page.getByRole('button', { name: '暂停计量', exact: true }).click(); await save(dialog());
  await expect(detail).toContainText('已暂停 · 后续未计量'); await page.reload();
  await page.getByRole('button', { name: '净水器与充电费用测试', exact: true }).click();
  await page.getByRole('tab', { name: '使用与成本', exact: true }).click();
  await page.getByRole('button', { name: '设置起点并恢复', exact: true }).click();
  await dialog().getByLabel(/^当前累计读数/).fill('150'); await save(dialog());
  await page.getByRole('button', { name: '抄表计费', exact: true }).click();
  await dialog().getByLabel(/^当前累计读数/).fill('152'); await dialog().getByLabel(/^本段单价/).fill('1'); await save(dialog());
  await detail.getByRole('button', { name: '记录使用费用', exact: true }).last().click();
  await dialog().getByLabel(/^费用项目/).fill('公共充电'); await dialog().getByLabel(/^本次用量/).fill('30');
  await dialog().getByLabel(/^本段单价/).fill('0.7'); await dialog().getByLabel(/^本次服务费/).fill('3'); await dialog().getByLabel(/^实际总费用/).fill('25.50');
  await expect(dialog()).toContainText('25.50 CNY'); await save(dialog());
  await detail.getByRole('button', { name: '记录使用费用', exact: true }).last().click();
  await dialog().getByLabel(/^本次用量/).fill('5'); await save(dialog());
  await expect(detail).toContainText('1 笔用量未定价');
  await expect(detail).toContainText('已测用量 12.5 kWh');
  await expect(detail.locator('.zc-card-fact').filter({ hasText: '已登记使用费用' })).toContainText('33.80');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.locator('.zc-card .zc-card')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`operating-cost-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('tab', { name: '概况', exact: true }).click();
  await expect(detail).toContainText('2,433.80');
  await go(page, 'transactions', 'records'); await expect(page.locator('.zc-transaction-row')).toHaveCount(0);
});

test('actual usage expenses create one payment and estimates stay outside actual costs', async ({ page }) => {
  await page.clock.setFixedTime(new Date());
  await setup(page); await locations(page); await addItem(page, '费用与估算检验', '家 / 厨房');
  await page.getByRole('button', { name: '费用与估算检验', exact: true }).click();
  await page.getByRole('tab', { name: '使用与成本', exact: true }).click();
  const detail = page.locator('.zc-fixed-item-detail');
  const dialog = () => page.getByRole('dialog', { name: /使用费用记录/ });
  await page.setViewportSize({ width: 390, height: 900 });
  await detail.getByRole('button', { name: '记录使用费用', exact: true }).last().click();
  await expect(dialog().locator('.zc-form-task-group').first().getByLabel(/^记录方式/)).toBeVisible();
  await select(dialog(), /^记录方式/, '直接记费用'); await dialog().getByLabel(/^实际总费用/).fill('12.34');
  await page.setViewportSize({ width: 1280, height: 900 });
  await select(dialog(), /^资金处理/, '同时创建流水');
  await dialog().getByLabel(/^流水二级分类/).click(); await page.getByRole('dialog', { name: '选择分类', exact: true }).getByRole('option').first().click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`operating-form-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await save(dialog());
  await expect(detail.locator('.zc-card-fact').filter({ hasText: '已登记使用费用' })).toContainText('12.34');
  await detail.getByRole('button', { name: '记录使用费用', exact: true }).last().click();
  await select(dialog(), /^记录方式/, '估算参考费用'); await dialog().getByLabel(/^本次用量/).fill('10'); await dialog().getByLabel(/^本段单价/).fill('0.6');
  await dialog().getByLabel(/^估算开始日期/).fill('2026-11-01'); await dialog().getByLabel(/^估算结束日期/).fill('2026-11-05');
  await expect(dialog().getByLabel(/^资金处理/)).toBeHidden(); await save(dialog());
  await expect(detail.locator('.zc-card-fact').filter({ hasText: '估算参考费用' })).toContainText('6.00');
  await detail.locator('.zc-fixed-record-row').filter({ hasText: '直接记费用' }).click();
  await dialog().getByLabel(/^实际总费用/).fill('18.76'); await save(dialog());
  await page.getByRole('tab', { name: '概况', exact: true }).click(); await expect(detail).toContainText('2,418.76');
  await go(page, 'transactions', 'records'); await expect(page.locator('.zc-transaction-row')).toHaveCount(1);
  await expect(page.locator('.zc-transaction-amount-original')).toHaveText('-18.76 CNY');
});

test('long meter histories stay bounded and old unpriced readings remain editable', async ({ page }) => {
  await page.clock.setFixedTime(new Date());
  await setup(page); await locations(page); await addItem(page, '长期抄表分页检验', '家 / 厨房');
  await page.getByRole('button', { name: '长期抄表分页检验', exact: true }).click();
  await page.getByRole('tab', { name: '使用与成本', exact: true }).click();
  const detail = page.locator('.zc-fixed-item-detail');
  const dialog = () => page.getByRole('dialog', { name: /使用费用记录/ });
  await page.getByRole('button', { name: '添加计量项目', exact: true }).click();
  await dialog().getByLabel(/^当前累计读数/).fill('100'); await dialog().getByLabel(/^记录日期/).fill('2026-10-01'); await save(dialog());
  for (let index = 1; index <= 24; index++) {
    await page.getByRole('button', { name: '抄表计费', exact: true }).click();
    await dialog().getByLabel(/^当前累计读数/).fill(String(100 + index));
    await dialog().getByLabel(/^记录日期/).fill(`2026-${index <= 11 ? '10' : '11'}-${String(index <= 11 ? index + 1 : index - 11).padStart(2, '0')}`);
    if (index !== 4) await dialog().getByLabel(/^本段单价/).fill('0.6');
    await save(dialog());
    await expect(detail.locator('.zc-fixed-operating-recent .zc-fixed-record-row')).toHaveCount(Math.min(3, index + 1));
  }
  await detail.getByRole('button', { name: '记录使用费用', exact: true }).last().click();
  await select(dialog(), /^记录方式/, '直接记费用'); await dialog().getByLabel(/^费用项目/).fill('公共充电');
  await dialog().getByLabel(/^实际总费用/).fill('1.25'); await save(dialog());
  await expect(detail.locator('.zc-card .zc-card')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '查看全部使用费用（26 条）', exact: true })).toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(detail.locator('.zc-fixed-operating-recent .zc-fixed-record-row')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`bounded-summary-${width}.png`), fullPage: true });
  }
  await detail.getByRole('button', { name: '查看全部使用费用（26 条）', exact: true }).click();
  await expect(page.getByRole('tab', { name: '记录与凭证', exact: true })).toHaveAttribute('aria-selected', 'true');
  const rows = detail.locator('.zc-fixed-history-records .zc-fixed-record-row');
  const pager = detail.getByRole('navigation', { name: '物品记录翻页', exact: true });
  await expect(rows).toHaveCount(10); await expect(pager).toContainText('1 / 3');
  await page.screenshot({ path: test.info().outputPath('bounded-history-page-1-320.png'), fullPage: true });
  await pager.getByRole('button', { name: '下一页', exact: true }).click(); await expect(rows).toHaveCount(10);
  expect(await detail.locator('.zc-fixed-record-history h3').evaluate((node) => node.getBoundingClientRect().top >= document.querySelector('.zc-app-header').getBoundingClientRect().bottom)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('bounded-history-viewport-320.png') });
  await pager.getByRole('button', { name: '下一页', exact: true }).click(); await expect(rows).toHaveCount(6);
  await expect(pager.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await select(detail, '记录月份', '2026-10'); await expect(rows).toHaveCount(10); await expect(pager).toContainText('1 / 2');
  await select(detail, '费用项目', '电费 · kWh');
  await pager.getByRole('button', { name: '下一页', exact: true }).click(); await expect(rows).toHaveCount(2);
  await select(detail, '记录类型', '待补费用'); await expect(rows).toHaveCount(1); await expect(rows).toContainText('2026-10-05');
  await page.screenshot({ path: test.info().outputPath('bounded-history-320.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await rows.first().click(); await dialog().getByLabel(/^本段单价/).fill('1.2'); await save(dialog());
  await expect(rows).toHaveCount(0); await expect(detail).toContainText('此筛选下没有记录');
  await page.getByRole('tab', { name: '使用与成本', exact: true }).click();
  await expect(detail.locator('.zc-card-fact').filter({ hasText: '已登记使用费用' })).toContainText('16.25');
  await expect(detail.locator('.zc-fixed-operating-recent .zc-fixed-record-row')).toHaveCount(3);
});

test('physical inventory and full-width detail fit paper themes on desktop and phones', async ({ page }) => {
  await setup(page); await locations(page); await addItem(page,'厨房里的多功能咖啡机与超长名称配件组合','家 / 厨房');
  for(const paper of ['文献纸 · 墨朱','青灰纸 · 墨朱','紫灰纸 · 墨朱'])for(const mode of ['浅色','深色']){
    await page.setViewportSize({width:1280,height:900}); await go(page,'settings','appearance'); await page.getByRole('tab',{name:'外观',exact:true}).click(); await page.getByRole('radio',{name:paper,exact:true}).click(); await page.getByRole('radio',{name:mode,exact:true}).click(); await go(page,'fixed');
    for(const width of [1280,1024,390,320]){
      await page.setViewportSize({width,height:900}); await expect(page.locator('[data-fixed-item]')).toHaveCount(1);
      if(width===390&&paper==='文献纸 · 墨朱'&&mode==='浅色'){
        const filters=page.locator('.zc-fixed-filter-details'); await expect(filters).not.toHaveAttribute('open',''); await filters.locator('summary').click();
        await page.getByRole('combobox',{name:'购置年份',exact:true}).selectOption('2025'); await page.getByRole('combobox',{name:'存放位置',exact:true}).selectOption({label:'家 / 厨房'});
        await expect(page.locator('[data-fixed-item]')).toHaveCount(1); await page.getByRole('button',{name:'清除筛选',exact:true}).click(); await filters.locator('summary').click();
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${paper}/${mode}/${width}`).toBe(true);
      await expect(page.locator('.zc-card .zc-card')).toHaveCount(0); await page.screenshot({path:test.info().outputPath(`${paper}-${mode}-${width}-inventory.png`),fullPage:true});
      await page.getByRole('button',{name:'厨房里的多功能咖啡机与超长名称配件组合',exact:true}).click();
      await page.screenshot({path:test.info().outputPath(`${paper}-${mode}-${width}-overview.png`),fullPage:true});
      for(const tab of ['概况','使用与成本','配件耗材','记录与凭证']){await page.getByRole('tab',{name:tab,exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width}/${tab}`).toBe(true);}
      await page.screenshot({path:test.info().outputPath(`${paper}-${mode}-${width}-detail.png`),fullPage:true}); await page.getByRole('button',{name:'返回物品',exact:true}).click(); await expect(page.locator('[data-fixed-item]')).toHaveCount(1);
    }
  }
});
