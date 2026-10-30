import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

/*
 * Dark mode, in a real browser.
 *
 * The unit tests cover the preference and the token maps; what they cannot show
 * is whether the palette actually reaches the pixels. These tests read computed
 * styles, which is the only way to catch the two failures that matter: a token
 * that is applied but never used (the page stays cream), and a surface that kept
 * a hardcoded light literal (one panel stays cream inside a dark page).
 *
 * `colorScheme` is set at the browser level so `prefers-color-scheme` is real
 * rather than stubbed, and the whole flow is exercised through the ledger app,
 * where the appearance picker lives.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'appearance-password-0001';

async function fixture() {
  const setup = 'test-appearance-owner-secret-0000000000';
  const server = createSyncServer({
    webDir: resolve(root, 'apps/web/dist'),
    enableWeb: true,
    registrationMode: 'open',
    ownerSetupToken: setup,
  });
  await server.ready;
  await server.started;
  await new Promise((done) => server.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
    await registerAccount(url, 'operator', password);
  } catch (error) {
    server.server.closeAllConnections();
    await server.close();
    throw error;
  }
  return { url, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

/** The channels a palette has to reach for dark mode to be real. */
const readPalette = (page) => page.evaluate(() => {
  const rootStyle = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const luminance = (value) => {
    const [r, g, b] = (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  };
  return {
    bg: rootStyle.getPropertyValue('--bg').trim(),
    onAccent: rootStyle.getPropertyValue('--on-accent').trim(),
    colorScheme: rootStyle.getPropertyValue('color-scheme').trim(),
    bodyBackground: body.backgroundColor,
    bodyColor: body.color,
    bodyBackgroundLuminance: luminance(body.backgroundColor),
    bodyTextLuminance: luminance(body.color),
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
  };
});

/** Signs in, finishes first-run setup, and opens 设置 → 外观. */
async function openAppearance(page, url) {
  await page.goto(`${url}/app/`);
  await page.getByLabel('服务器用户名').fill('operator');
  await page.getByLabel('服务器账号密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '开始记账', exact: true }).click({ timeout: 30_000 });
  // The wizard hands straight into the first entry dialog; Escape dismisses it.
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.locator('.zc-sidebar button[title="设置"]').click({ timeout: 15_000 });
  await page.getByRole('tab', { name: '外观', exact: true }).click();
}

test('a dark system paints the ledger dark, and the choice outranks it', async ({ page }) => {
  const f = await fixture();
  try {
    // The OS asks for dark before the app ever loads: this is the pre-hydration path.
    await page.emulateMedia({ colorScheme: 'dark' });
    await openAppearance(page, f.url);

    const dark = await readPalette(page);
    expect(dark.colorScheme, 'the root must declare a dark colour scheme').toBe('dark');
    expect(dark.bg, 'the dark palette must be the one applied').toBe('#191512');
    // The page itself must be dark, and its text light: a token that is applied
    // but never reaches <body> leaves a cream page behind dark components.
    expect(dark.bodyBackgroundLuminance, `body background is ${dark.bodyBackground}`).toBeLessThan(80);
    expect(dark.bodyTextLuminance, `body text is ${dark.bodyColor}`).toBeGreaterThan(150);
    // The browser-chrome tint follows the palette instead of staying cream.
    expect(dark.themeColor).toBe('#191512');

    // An explicit light choice has to beat a dark system setting.
    await page.getByRole('radio', { name: '浅色', exact: true }).click();
    await expect.poll(async () => (await readPalette(page)).colorScheme).toBe('light');
    const light = await readPalette(page);
    expect(light.bg).toBe('#f0e9dc');
    expect(light.bodyBackgroundLuminance).toBeGreaterThan(150);
    expect(light.themeColor).toBe('#f0e9dc');

    // And an explicit dark choice has to beat a light system setting.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await expect.poll(async () => (await readPalette(page)).colorScheme).toBe('dark');
    const forced = await readPalette(page);
    expect(forced.bodyBackgroundLuminance).toBeLessThan(80);
    expect(forced.onAccent, 'dark mode must re-point the text that sits on an accent').not.toBe('#ffffff');
  } finally { await f.close(); }
});

test('a dark screen survives a reload, and the accent family is a separate axis', async ({ page }) => {
  const f = await fixture();
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await openAppearance(page, f.url);
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await expect.poll(async () => (await readPalette(page)).colorScheme).toBe('dark');

    // The palette is a device preference, so it has to come back without the server.
    await page.reload();
    await expect.poll(async () => (await readPalette(page)).colorScheme).toBe('dark');
    expect((await readPalette(page)).bg).toBe('#191512');

    // Switching the accent family keeps the mode: they are separate axes.
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: '鼠尾草 · 苔绿', exact: true }).click();
    await expect.poll(async () => (await readPalette(page)).bg).toBe('#121814');
    expect((await readPalette(page)).colorScheme).toBe('dark');
  } finally { await f.close(); }
});

test('the account id is readable in the list, not just copyable', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(`${f.url}/e2e-private-entry/admin/`);
    await page.getByLabel('管理账号用户名').fill('owner');
    await page.getByLabel('管理账号密码').fill('owner-test-password');
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click({ timeout: 30_000 });
    await page.getByRole('link', { name: '用户管理' }).click();

    // The card shows the ID as selectable text alongside its copy action.
    const id = await page.locator('.zc-admin-user-card code').first().textContent();
    expect(id ?? '').toMatch(/^account-[a-f0-9]{32}$/);
    await expect(page.getByRole('button', { name: `复制 ${id}` })).toBeVisible();
  } finally { await f.close(); }
});

test('the console can jump between the sections of a long page', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(`${f.url}/e2e-private-entry/admin/`);
    await page.getByLabel('管理账号用户名').fill('owner');
    await page.getByLabel('管理账号密码').fill('owner-test-password');
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click({ timeout: 30_000 });

    // The overview is one of the pages long enough to carry a jump list.
    const index = page.getByRole('navigation', { name: '总览分区' });
    await expect(index).toBeVisible({ timeout: 30_000 });
    const links = await index.getByRole('link').allTextContents();
    expect(links.length).toBeGreaterThanOrEqual(3);

    // Every entry has to resolve to a real element; a link to a missing id looks
    // correct and does nothing, which is the failure a unit test cannot see.
    const targets = await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="总览分区"] a')]
      .map((a) => ({ text: (a.textContent ?? '').trim(), id: (a.getAttribute('href') ?? '').slice(1) })));
    const missing = await page.evaluate((entries) => entries
      .filter((entry) => !document.getElementById(entry.id))
      .map((entry) => `${entry.text} -> ${entry.id}`), targets);
    expect(missing, `jump targets with no element: ${missing.join(', ')}`).toHaveLength(0);

    // Clicking scrolls rather than changing the route: the console's URLs are its own.
    const before = page.url();
    await index.getByRole('link').last().click();
    await page.waitForTimeout(400);
    expect(page.url()).toBe(before);
    const scrolled = await page.evaluate(() => {
      const target = [...document.querySelectorAll('nav[aria-label="总览分区"] a')].at(-1);
      const section = document.getElementById((target?.getAttribute('href') ?? '').slice(1));
      if (!section) return false;
      const box = section.getBoundingClientRect();
      // The section must have been brought near the top of the viewport.
      return box.top < window.innerHeight && box.bottom > 0;
    });
    expect(scrolled, 'clicking a jump link did not bring its section into view').toBe(true);
  } finally { await f.close(); }
});

test('the management console follows the same device preference', async ({ page }) => {
  const f = await fixture();
  try {
    // Set the preference through the ledger app, then open the console.
    await page.emulateMedia({ colorScheme: 'dark' });
    await openAppearance(page, f.url);
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await expect.poll(async () => (await readPalette(page)).colorScheme).toBe('dark');

    // A fresh page at the management path is a different entry point but the same origin,
    // so it must read the same stored preference rather than a hardcoded theme.
    await page.goto(`${f.url}/e2e-private-entry/admin/`);
    await expect.poll(async () => (await readPalette(page)).colorScheme).toBe('dark');
    expect((await readPalette(page)).bodyBackgroundLuminance).toBeLessThan(80);

    // The console shell paints the page itself; a light literal left anywhere in
    // it shows up as a bright surface inside the dark page.
    const bright = await page.evaluate(() => [...document.querySelectorAll('.zc-admin-root *')]
      .slice(0, 400)
      .map((node) => getComputedStyle(node).backgroundColor)
      .filter((value) => value !== 'rgba(0, 0, 0, 0)')
      .filter((value) => {
        const [r, g, b] = (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) > 200;
      }));
    expect(bright, `light surfaces inside a dark console: ${bright.join(', ')}`).toHaveLength(0);
  } finally { await f.close(); }
});
