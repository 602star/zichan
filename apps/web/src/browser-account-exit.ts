import { accountLocalStorage } from './account-storage.js';
import { clearCredentialVaultRuntimeState, runtimeCredentialMap } from './credential-vault.js';
import { buildSyncBaseUrl, loadSyncConnections } from './sync-config.js';
import { isPrimaryWebConnection } from './web-sync-connections.js';

export const ACCOUNT_EXIT_KEY = 'zichan.account.explicit-exit.v1';
export const ACCOUNT_LOCK_REQUEST_EVENT = 'zichan:lock-account';

/** Keep profile identity and encrypted data; never treat sign-out as a cache reset. */
export async function exitBrowserAccount(): Promise<void> {
  accountLocalStorage.setItem(ACCOUNT_EXIT_KEY, 'pending');
  const credentials = runtimeCredentialMap();
  const profiles = loadSyncConnections();
  clearCredentialVaultRuntimeState();
  const targets = profiles.filter((profile) => isPrimaryWebConnection(profile) || credentials[profile.id]?.sessionId);
  const results = await Promise.all(targets.map(async (profile) => {
    const url = buildSyncBaseUrl(profile);
    const credential = credentials[profile.id];
    const cookie = isPrimaryWebConnection(profile) || credential?.sessionTransport === 'cookie';
    try {
      if (cookie && new URL(url).origin !== location.origin) return false;
      if (!cookie) {
        if (!credential?.accessToken) return false;
        // An edited address must prove its pinned identity before receiving a token.
        const response = await fetch(`${url}/api/health`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!response.ok) return false;
        const identity = await response.json();
        if (!profile.serverId || !profile.serverPublicKey || identity.serverId !== profile.serverId || identity.serverPublicKey !== profile.serverPublicKey) return false;
      }
      const response = await fetch(`${url}/api/auth/logout`, {
        method: 'POST', credentials: cookie ? 'same-origin' : 'omit', redirect: 'error', cache: 'no-store',
        headers: cookie ? { 'X-Zichan-Session': 'cookie' } : { Authorization: `Bearer ${credential!.accessToken}` }, signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      // A token 401 can mean only access expiry: the refresh session may still exist.
      return response.ok || cookie && response.status === 401;
    } catch { return false; }
  }));
  accountLocalStorage.setItem(ACCOUNT_EXIT_KEY, results.length && results.every(Boolean) ? 'confirmed' : 'unconfirmed');
}
