import { requestJson } from '@zichan/db';
import { buildSyncBaseUrl, type ServerCredential, type SyncConnection } from './sync-config.js';

/** Never send credentials to an edited endpoint until its pinned identity is verified. */
export async function revokeConnectionSession(profile: SyncConnection, credential?: ServerCredential, signal?: AbortSignal): Promise<boolean> {
  if (!credential?.sessionId && !credential?.accessToken && !credential?.refreshToken) return true;
  const url = buildSyncBaseUrl(profile);
  try {
    if (!profile.serverId || !profile.serverPublicKey) return false;
    const health = await requestJson(`${url}/api/health`, { redirect: 'error', cache: 'no-store' }, { signal, timeoutMs: 5000 });
    if (!health.ok) return false;
    const identity = await health.json() as { serverId?: string; serverPublicKey?: string };
    if (identity.serverId !== profile.serverId || identity.serverPublicKey !== profile.serverPublicKey) return false;
    const cookie = credential.sessionTransport === 'cookie';
    if (cookie ? new URL(url).origin !== globalThis.location?.origin : !credential.accessToken) return false;
    const response = await requestJson(`${url}/api/auth/logout`, {
      method: 'POST', redirect: 'error', credentials: cookie ? 'same-origin' : 'omit',
      headers: cookie ? { 'X-Zichan-Session': 'cookie' } : { Authorization: `Bearer ${credential.accessToken}` },
    }, { signal, timeoutMs: 5000 });
    // Token 401 may only mean access-token expiry, not refresh-session revocation.
    return response.ok || cookie && response.status === 401;
  } catch { return false; }
}
