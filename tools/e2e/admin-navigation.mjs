import { expect } from '@playwright/test';

/** Follow the same grouped navigation that an operator uses, including on a narrow screen. */
export async function clickAdminLink(page, name) {
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
  if (logMode && logMode !== '系统日志') await page.getByRole('navigation', { name: '日志与审计视图' }).getByRole('link', { name: new RegExp(logMode) }).click();
}
