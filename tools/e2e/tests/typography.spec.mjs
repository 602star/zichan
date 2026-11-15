import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test('complete bundled screen font loads common and extended Chinese with readable sizes', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLedger(page);
  const fonts = await page.evaluate(async () => {
    const common = await document.fonts.load('16px "LXGW WenKai Screen"', '账簿收支');
    const extended = await document.fonts.load('16px "LXGW WenKai Screen"', '龘');
    return {
      common: common.map((font) => font.status), extended: extended.map((font) => font.status),
      urls: performance.getEntriesByType('resource').filter((entry) => /\.woff2(?:\?|$)/.test(entry.name)).map((entry) => entry.name),
    };
  });
  expect(fonts.common).toEqual(['loaded']);
  expect(fonts.extended).toEqual(['loaded']);
  expect(fonts.urls.some((url) => url.includes('-full-'))).toBe(true);
  expect(fonts.urls.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  for (const width of [1280, 390, 320, 2560, 3200]) {
    await page.setViewportSize({ width, height: 900 });
    const text = await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      const caption = document.createElement('span');
      caption.style.fontSize = 'var(--fs-caption)';
      document.body.append(caption);
      const captionSize = parseFloat(getComputedStyle(caption).fontSize);
      caption.remove();
      return { family: style.fontFamily, synthesis: style.fontSynthesis, size: parseFloat(style.fontSize), caption: captionSize, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    expect(text.family).toContain('LXGW WenKai Screen');
    expect(text.synthesis).toBe('none');
    expect(text.size).toBeGreaterThanOrEqual(16);
    expect(text.caption).toBeGreaterThanOrEqual(14);
    expect(text.overflow).toBe(false);
    if (width === 1280 || width === 390) await page.screenshot({ path: test.info().outputPath(`wenkai-${width}.png`) });
  }
  // The release's immutable offline shell includes the complete font, even if
  // a rare character was never displayed while the device was online.
  await expect.poll(async () => page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    for (const key of keys.filter((name) => name.startsWith('zichan-shell:'))) {
      const urls = (await (await caches.open(key)).keys()).map((request) => request.url);
      if (urls.some((url) => /wenkai.*full.*\.woff2$/.test(url))) return true;
    }
    return false;
  })).toBe(true);
});
