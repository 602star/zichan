import { test, expect } from './fixtures.mjs';
import { openLedger } from './helpers.mjs';

test('opens and reopens a ledger with the IndexedDB lease fallback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'SharedWorker', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  });
  await openLedger(page);
  const hasLeaseStore = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const entry of databases) {
      if (!entry.name) continue;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(entry.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const present = database.objectStoreNames.contains('kv') && database.objectStoreNames.contains('lease');
      database.close();
      if (present) return true;
    }
    return false;
  });
  expect(hasLeaseStore).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.zc-app-shell')).toBeVisible({ timeout: 30_000 });
});
