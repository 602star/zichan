import { expect } from '@playwright/test';

/** Follow the same grouped navigation that an operator uses, including on a narrow screen. */
export async function clickAdminLink(page, name) {
  const workspaceViews = { '请求分析': ['访问与请求', '访问与请求视图'], '访问分析': ['访问与请求', '访问与请求视图'], '主机与容器': ['运行监控', '运行监控视图'], '采集任务': ['运行监控', '运行监控视图'] };
  const workspaceView = workspaceViews[name];
  const requestedName = name;
  if (workspaceView) name = workspaceView[0];
  const logModes = { '运行日志': '系统日志', '系统日志': '系统日志', '管理审计': '操作日志', '操作日志': '操作日志', '登录安全': '登录日志', '登录日志': '登录日志', '访问日志': '访问日志', '任务日志': '任务日志', '容器日志': '容器日志' };
  const logMode = logModes[name];
  const names = { '运行日志': '日志管理', '系统日志': '日志管理', '管理审计': '日志管理', '操作日志': '日志管理', '登录安全': '日志管理', '登录日志': '日志管理', '访问日志': '日志管理', '任务日志': '日志管理', '容器日志': '日志管理', '告警历史': '告警中心', '监控中心': '运行监控' };
  name = names[name] ?? name;
  const nav = page.locator('nav[aria-label="管理后台导航"]');
  const link = nav.getByRole('link', { name, exact: true, includeHidden: true });
  const menu = page.getByRole('button', { name: '菜单' });
  await expect(nav).toHaveCount(1, { timeout: 30_000 });
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') {
    await menu.click();
    await expect(nav).toHaveAttribute('data-open', 'true');
  }
  await expect(link).toBeVisible();
  await link.click();
  if (workspaceView) await page.getByRole('navigation', { name: workspaceView[1] }).getByRole('button', { name: new RegExp(`^${requestedName}`) }).click();
  if (logMode && logMode !== '系统日志') await page.getByRole('navigation', { name: '日志与审计视图' }).getByRole('link', { name: new RegExp(logMode) }).click();
}
