import { expect } from '@playwright/test';

/** Keep password fallback coverage after Web began preparing quick authorization automatically. */
export async function expireQuickAuthorization(page) {
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .some(key => key.endsWith('zichan.offline-access.v1')))).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    for (const { name } of await indexedDB.databases()) {
      if (!name?.endsWith(':trusted-device')) continue;
      const expired = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('vault', 'readwrite');
          const vault = tx.objectStore('vault');
          const get = vault.get('access');
          get.onsuccess = () => { if (get.result) vault.put({ ...get.result, expiresAt: 0 }, 'access'); };
          tx.oncomplete = () => { db.close(); resolve(Boolean(get.result)); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
      if (expired) return true;
    }
    return false;
  })).toBe(true);
}
