import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

test.use({ hasTouch: true, isMobile: true });
test.setTimeout(1_200_000);

const routes = [
  'overview', 'users', 'sessions', 'invites', 'storage', 'monitor', 'sync',
  'jobs', 'alerts', 'logs', 'audit', 'security-events', 'settings', 'security',
];
const viewports = [
  { width: 320, height: 568 }, { width: 390, height: 844 },
  { width: 768, height: 1024 }, { width: 820, height: 1180 },
  { width: 844, height: 390 }, { width: 1024, height: 768 },
  { width: 1180, height: 820 },
];

function measureAdminLayout() {
  const root = document.querySelector('.zc-admin-root');
  const viewport = innerWidth;
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || !rect.width || !rect.height) return false;
    const details = el.closest('details');
    return !details || details.open || !!el.closest('summary');
  };
  const describe = (el) => `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)}`;
  const outside = [...root.querySelectorAll('*')].filter(visible).filter((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.left >= -1 && rect.right <= viewport + 1) return false;
    for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(parent).overflowX)) return false;
    }
    return true;
  }).slice(0, 12).map((el) => describe(el));
  const controls = [...root.querySelectorAll('button, a[href], summary, select, input, textarea')]
    .filter(visible).filter((el) => !el.hasAttribute('disabled'));
  const small = controls.filter((el) => {
    const target = el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)
      ? el.closest('label') ?? el : el;
    const rect = target.getBoundingClientRect();
    return rect.width < 44 || rect.height < 44;
  }).slice(0, 25).map((el) => {
    const target = el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)
      ? el.closest('label') ?? el : el;
    const rect = target.getBoundingClientRect();
    return `${describe(el)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
  });
  const zoom = controls.filter((el) => el.matches('input:not([type="checkbox"]):not([type="radio"]),select,textarea'))
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
    .slice(0, 10).map((el) => `${describe(el)} ${getComputedStyle(el).fontSize}`);
  const menu = document.querySelector('.zc-admin-mobile-bar');
  return { overflow: document.documentElement.scrollWidth - viewport, outside, small, zoom,
    mobileBarVisible: !!menu && visible(menu) };
}

test('management pages fit phone and iPad touch viewports', async ({ page }) => {
  test.setTimeout(1_200_000);
  const server = createSyncServer({
    enableWeb: true,
    webDir: resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/web/dist'),
    registrationMode: 'open',
    ownerSetupToken: 'admin-mobile-layout-owner-setup-000000',
  });
  try {
    await server.ready;
    await listenOnSafePort(server.server, '127.0.0.1');
    const base = `http://127.0.0.1:${server.server.address().port}`;
    await registerAccount(base, 'layout-owner', 'layout-owner-password', {
      ownerSetupToken: 'admin-mobile-layout-owner-setup-000000',
    });
    await registerAccount(base, 'layout-member', 'layout-member-password');
    await page.goto(`${base}/e2e-private-entry/admin/`);
    await page.getByLabel('管理账号用户名').fill('layout-owner');
    await page.getByLabel('管理账号密码').fill('layout-owner-password');
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await expect(page.locator('.zc-admin-content')).toBeVisible();

    await page.setViewportSize({ width: 820, height: 1180 });
    await page.evaluate(() => { history.pushState(null, '', '/e2e-private-entry/admin/users'); dispatchEvent(new Event('zichan:admin:navigate')); });
    await page.getByRole('button', { name: 'layout-member', exact: true }).click();
    const confirm = page.locator('.zc-admin-password-reset-confirm');
    await expect(confirm).toBeVisible();
    expect((await confirm.boundingBox()).height).toBeGreaterThanOrEqual(44);

    const failures = [];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(250);
      for (const route of routes) {
        await page.evaluate((path) => {
          history.pushState(null, '', `/e2e-private-entry/admin/${path}`);
          dispatchEvent(new Event('zichan:admin:navigate'));
        }, route);
        await page.waitForTimeout(120);
        const result = await page.evaluate(measureAdminLayout);
        if (result.mobileBarVisible !== (viewport.width <= 1023)) failures.push(`${viewport.width} ${route}: navigation breakpoint`);
        if (result.overflow > 1) failures.push(`${viewport.width} ${route}: document overflow ${result.overflow}px`);
        for (const item of result.outside) failures.push(`${viewport.width} ${route}: outside ${item}`);
        for (const item of result.small) failures.push(`${viewport.width} ${route}: small target ${item}`);
        for (const item of result.zoom) failures.push(`${viewport.width} ${route}: zoom risk ${item}`);
      }
    }

    for (const viewport of [
      { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => { history.pushState(null, '', '/e2e-private-entry/admin/logs'); dispatchEvent(new Event('zichan:admin:navigate')); });
      await page.getByRole('button', { name: '起始日期' }).click();
      const calendar = await page.evaluate(() => {
        const popover = document.querySelector('.zc-calendar-popover');
        const rect = popover.getBoundingClientRect();
        const grid = document.querySelector('.zc-calendar-grid-day');
        const rows = [...grid.querySelectorAll('button')].map((button) => {
          const cell = button.getBoundingClientRect();
          return { top: cell.top, left: cell.left, right: cell.right, width: cell.width, height: cell.height };
        });
        return { overflow: document.documentElement.scrollWidth - innerWidth,
          bounds: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, rows };
      });
      expect(calendar.overflow).toBeLessThanOrEqual(1);
      expect(calendar.bounds.left).toBeGreaterThanOrEqual(-1);
      expect(calendar.bounds.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(calendar.bounds.top).toBeGreaterThanOrEqual(-1);
      expect(calendar.bounds.bottom).toBeLessThanOrEqual(viewport.height + 1);
      for (const cell of calendar.rows) {
        expect(cell.width).toBeGreaterThanOrEqual(44);
        expect(cell.height).toBeGreaterThanOrEqual(44);
      }
      for (let index = 1; index < calendar.rows.length; index += 1) {
        if (Math.abs(calendar.rows[index].top - calendar.rows[index - 1].top) < 1) {
          expect(calendar.rows[index].left).toBeGreaterThanOrEqual(calendar.rows[index - 1].right - 1);
        }
      }
      await page.getByRole('button', { name: '起始日期' }).click();
    }
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }, { width: 3840, height: 2160 }]) {
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await page.evaluate((path) => {
          history.pushState(null, '', `/e2e-private-entry/admin/${path}`);
          dispatchEvent(new Event('zichan:admin:navigate'));
        }, route);
        await page.waitForTimeout(120);
        const wide = await page.evaluate(() => {
          const content = document.querySelector('.zc-admin-content');
          const rect = content.getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth - innerWidth,
            contentWidth: rect.width, bodyFont: parseFloat(getComputedStyle(document.querySelector('.zc-admin-root')).fontSize) };
        });
        expect(wide.overflow, `${viewport.width}px ${route} overflow`).toBeLessThanOrEqual(1);
        if (viewport.width >= 2560) expect(wide.contentWidth, `${viewport.width}px ${route} width`).toBeGreaterThanOrEqual(1900);
        if (viewport.width >= 3840) expect(wide.bodyFont).toBeGreaterThanOrEqual(17);
      }
    }
    expect(failures.join('\n')).toBe('');
  } finally {
    await page.close();
    await closeTestSyncServer(server);
  }
});
