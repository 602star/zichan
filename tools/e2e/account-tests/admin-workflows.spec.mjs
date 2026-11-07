import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';
import { registerAccount } from '../../../packages/db/dist/index.js';
import { clickAdminLink } from '../admin-navigation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'workflow-fixture-password-0001';
const setup = 'workflow-fixture-owner-token-000000';

async function fixture(page) {
  const directory = mkdtempSync(join(tmpdir(), 'zichan-admin-workflows-'));
  const server = createSyncServer({ dataDir: directory, webDir: resolve(root, 'apps/web/dist'), enableWeb: true, registrationMode: 'open', ownerSetupToken: setup });
  await server.ready; await server.started;
  await listenOnSafePort(server.server, '127.0.0.1');
  const url = `http://127.0.0.1:${server.server.address().port}`;
  const close = async () => {
    await page.close();
    await closeTestSyncServer(server);
    if (resolve(directory).startsWith(resolve(tmpdir()) + '\\zichan-admin-workflows-') || resolve(directory).startsWith(resolve(tmpdir()) + '/zichan-admin-workflows-')) rmSync(directory, { recursive: true, force: true });
  };
  try {
    await registerAccount(url, 'operator', password, { ownerSetupToken: setup });
    await registerAccount(url, 'sample-user', password);
    const store = new SyncServerStore(join(directory, 'server.sqlite'), 'open', server.serverId);
    try {
      for (let index = 0; index < 4; index++) await store.upsertAlert({ key: 'fixture-alert', rule: 'fixture-rule', scope: 'fixture-scope', severity: 'warning', active: true });
    } finally { await store.close(); }
    await page.goto(url + '/e2e-private-entry/admin/');
    await page.getByLabel('管理账号用户名').fill('operator');
    await page.getByLabel('管理账号密码').fill(password);
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
    return { url, close };
  } catch (error) { await close(); throw error; }
}

for (const width of [1280, 390]) {
  test(`direct management workflows and every remaining page at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(480_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    const capture = async (name) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
    };
    try {
      await clickAdminLink(page, '用户管理');
      const user = page.locator('.zc-admin-user-card').filter({ hasText: 'sample-user' }).first();
      const userAction = async (label) => {
        const button = user.getByRole('button', { name: label, exact: true, includeHidden: true });
        if (!(await button.isVisible())) await user.locator('summary').click();
        await button.click();
      };
      await expect(user.locator('summary')).toHaveText('更多操作');
      await expect(page.getByRole('button', { name: '快捷处理', exact: true })).toHaveCount(0);
      await userAction('禁用账号');
      await expect(page.getByRole('button', { name: '确认禁用', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '确认禁用', exact: true }).click();
      await userAction('启用账号');
      await page.getByRole('button', { name: '确认启用', exact: true }).click();
      await userAction('调整提交配额');
      await page.getByLabel('新的上限（GiB）').fill('1');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('操作已完成。')).toBeVisible();
      await expect(page.getByRole('button', { name: '关闭处理面板' })).toHaveCount(0);
      if (width === 390) await expect(user.locator('.zc-admin-user-facts dt', { hasText: '创建时间' })).toBeVisible();
      await capture('users');

      await clickAdminLink(page, '告警历史');
      await page.getByRole('button', { name: '活动', exact: true }).click();
      const alert = page.getByRole('row').filter({ hasText: 'fixture-rule' });
      await alert.getByRole('button', { name: '标记已知晓' }).click();
      await expect(alert.getByRole('button', { name: '已知晓', exact: true })).toBeDisabled();
      await alert.getByRole('button', { name: '暂停通知…' }).click();
      await alert.getByLabel('暂停通知原因').fill('检查 fixture 告警');
      await alert.getByRole('button', { name: '确认暂停通知' }).click();
      await expect(alert.getByRole('button', { name: '恢复通知' })).toBeVisible();
      await alert.getByRole('button', { name: '恢复通知' }).click();
      await expect(alert.getByRole('button', { name: '暂停通知…' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('button', { name: '活动', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await capture('alerts');

      await clickAdminLink(page, '任务中心');
      await page.getByLabel('任务类型').selectOption('database.integrity-check');
      await page.getByRole('button', { name: '创建任务', exact: true }).click();
      await expect(page).toHaveURL(/job=/);
      const detail = page.locator('.zc-admin-panel').filter({ hasText: /^任务详情/ });
      await expect(detail).toBeVisible();
      expect(await detail.evaluate((element) => element.offsetTop)).toBeLessThan(await page.locator('#section-任务列表').evaluate((element) => element.offsetTop));
      await capture('jobs');

      await clickAdminLink(page, '注册与邀请');
      await page.getByRole('button', { name: '生成一次性邀请码' }).click();
      await expect(page.getByText(/新邀请码/)).toBeVisible();
      expect(await page.locator('#section-邀请列表').evaluate((element) => element.offsetTop)).toBeLessThan(await page.locator('#section-注册与邀请增长').evaluate((element) => element.offsetTop));
      await capture('invites');

      await clickAdminLink(page, '管理审计');
      const entry = page.locator('#section-审计记录 tbody tr').first();
      await entry.getByRole('button', { name: '展开', exact: true }).click();
      const auditDetails = entry.locator('xpath=following-sibling::tr[1]');
      await auditDetails.locator('summary', { hasText: '查看变更前后值' }).click();
      await expect(auditDetails.locator('pre').last()).toBeVisible();
      const timeRange = page.getByRole('group', { name: '时间范围' });
      await timeRange.getByRole('button', { name: '起始日期' }).click();
      const calendar = page.getByRole('dialog', { name: '起始日期' });
      await capture('audit-calendar');
      await calendar.getByRole('tab', { name: '年', exact: true }).click();
      await calendar.locator('.zc-calendar-grid-period button.selected').click();
      await calendar.locator('.zc-calendar-grid-period button.selected').click();
      await calendar.getByRole('button', { name: /^\d{4}-\d{2}-01$/ }).click();
      await expect(timeRange.getByLabel('起始时分')).toBeEnabled();
      await timeRange.getByLabel('起始时分').fill('00:00');
      await timeRange.getByRole('button', { name: '应用' }).click();
      await expect(page).toHaveURL(/from=/);
      await timeRange.getByRole('button', { name: '结束日期' }).click();
      await page.getByRole('dialog', { name: '结束日期' }).getByRole('button', { name: '今天' }).click();
      await timeRange.getByRole('button', { name: '应用' }).click();
      expect(new URL(page.url()).searchParams.get('until')).toMatch(/\.999Z$/);
      await capture('audit');

      for (const [label, name] of [['设备与会话', 'sessions'], ['同步诊断', 'sync'], ['运行日志', 'logs'], ['登录安全', 'security-events'], ['监控中心', 'monitor']]) {
        await clickAdminLink(page, label);
        await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
        if (name === 'sync') expect(await page.locator('#section-诊断记录').evaluate((element) => element.offsetTop)).toBeLessThan(await page.locator('#section-错误分类').evaluate((element) => element.offsetTop));
        await capture(name);
      }
      if (width === 390) await clickAdminLink(page, '账号安全');
      else await page.getByRole('link', { name: '账号安全', exact: true }).click();
      await expect(page.getByRole('button', { name: '确认修改账号密码', exact: true })).toBeVisible();
      await capture('security');
    } finally { await f.close(); }
  });
}
