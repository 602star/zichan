import { accountLocalStorage } from './account-storage.js';
import { clearCredentialVaultRuntimeState } from './credential-vault.js';
import { buildSyncBaseUrl, loadSyncConnections } from './sync-config.js';

export const ACCOUNT_EXIT_KEY = 'zichan.account.explicit-exit.v1';
export const ACCOUNT_LOCK_REQUEST_EVENT = 'zichan:lock-account';

/** Keep profile identity and encrypted data; never treat sign-out as a cache reset. */
export async function exitBrowserAccount(): Promise<void> {
  accountLocalStorage.setItem(ACCOUNT_EXIT_KEY, 'pending');
  clearCredentialVaultRuntimeState();
  const urls = [...new Set(loadSyncConnections().map(buildSyncBaseUrl))]
    .filter((url) => new URL(url).origin === location.origin);
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(`${url}/api/auth/logout`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'X-Zichan-Session': 'cookie' }, signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      return response.ok || response.status === 401;
    } catch { return false; }
  }));
  accountLocalStorage.setItem(ACCOUNT_EXIT_KEY, results.length && results.every(Boolean) ? 'confirmed' : 'unconfirmed');
}
