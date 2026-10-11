import {
  refreshAccountSession, requestJson,
  type SyncAuthSession,
} from '@zichan/db';
import { credentialRevision, credentialVaultState, persistCredential, runtimeCredential, setRuntimeCredential } from './credential-vault.js';
import { buildSyncBaseUrl, isUnauthorizedSyncError, patchSavedSyncConnection, type ServerCredential, type SyncConnection } from './sync-config.js';
import { fingerprintServerPublicKey } from './connection-link.js';
import { assertNodeReplicaIdentity } from './node-replica-identity.js';
import { isTauriRuntime } from './tauri.js';

const EXPIRY_MARGIN_MS = 30_000;
const authenticationInFlight = new Map<string, Promise<string>>();
const refreshInFlight = new Map<string, Promise<string>>();

export function preferredSessionTransport(baseUrl: string): 'cookie' | 'token' {
  return !isTauriRuntime() && globalThis.location?.origin === new URL(baseUrl).origin ? 'cookie' : 'token';
}

export function hasAccountSession(credential: ServerCredential | undefined): boolean {
  return Boolean(credential && (credential.accessToken || credential.refreshToken
    || credential.sessionTransport === 'cookie' && credential.sessionId));
}

function sessionCredential(current: ServerCredential, session: SyncAuthSession): ServerCredential {
  return {
    ...current,
    password: '',
    inviteCode: '',
    sessionTransport: session.sessionTransport ?? 'token',
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessExpiresAt: session.accessExpiresAt,
    sessionId: session.session.id,
  };
}

function accessTokenIsFresh(credential: ServerCredential): boolean {
  return !!credential.accessToken
    && !!credential.accessExpiresAt
    && Date.parse(credential.accessExpiresAt) > Date.now() + EXPIRY_MARGIN_MS;
}

export async function assertSyncServerIdentity(profile: SyncConnection): Promise<void> {
  if (!profile.serverId || !profile.serverPublicKey) throw new Error('同步服务器身份尚未固定，请先测试连通性');
  const response = await requestJson(`${buildSyncBaseUrl(profile)}/api/health`, { redirect: 'error' });
  if (!response.ok) throw new Error(`同步服务器身份检查失败：HTTP ${response.status}`);
  const body = await response.json() as { serverId?: string; serverPublicKey?: string; nodePublicKey?: string };
  if (body.serverId !== profile.serverId || body.serverPublicKey !== profile.serverPublicKey) {
    throw new Error('同步服务器身份已变化，已阻止发送会话或密码');
  }
  if (profile.nodePublicKey) assertNodeReplicaIdentity(profile,
    { serverId: body.serverId ?? '', nodePublicKey: body.nodePublicKey ?? '' });
  if (profile.expectedServerPublicKeyFingerprint
    && await fingerprintServerPublicKey(body.serverPublicKey) !== profile.expectedServerPublicKeyFingerprint) {
    throw new Error('同步服务器公钥指纹与导入连接链接不一致');
  }
}

async function authenticateSyncProfileNow(
  profile: SyncConnection,
  forceRefresh = false,
): Promise<string> {
  let credential = runtimeCredential(profile.id);
  if (!profile.username.trim() || !credential || !hasAccountSession(credential)) throw new Error('认证失败：请先登录账号');
  const revision = credentialRevision(profile.id);
  const assertCurrent = () => {
    if (revision !== credentialRevision(profile.id)) throw new Error('登录会话已改变，已忽略旧请求结果');
  };
  if (credential.sessionTransport === 'cookie' && preferredSessionTransport(buildSyncBaseUrl(profile)) !== 'cookie') {
    throw new Error('同站登录会话不能用于其他网站地址，请重新登录');
  }
  await assertSyncServerIdentity(profile);
  assertCurrent();
  const refreshKey = `${profile.id}\n${revision}`;
  const refreshing = refreshInFlight.get(refreshKey);
  if (refreshing) return refreshing;
  if (!forceRefresh && accessTokenIsFresh(credential)) return credential.accessToken!;

  if (!credential.refreshToken && credential.sessionTransport !== 'cookie') throw new Error('认证失败：登录已过期，请重新登录');
  const pending = (async () => {
    try {
      const transport = credential.sessionTransport ?? 'token';
      const refresh = () => refreshAccountSession(buildSyncBaseUrl(profile), credential!.refreshToken ?? '', transport);
      // Cookies are shared by tabs; serialize refresh rotation across the origin.
      const refreshed = transport === 'cookie' && globalThis.navigator?.locks
        ? await navigator.locks.request(`zichan:session-refresh:${buildSyncBaseUrl(profile)}`, refresh)
        : await refresh();
      assertCurrent();
      if (refreshed.session.username !== profile.username.trim().normalize('NFKC').toLowerCase()
        || profile.accountId && refreshed.accountId !== profile.accountId) {
        throw new Error('认证失败：当前网站已切换账号，请重新登录');
      }
      credential = sessionCredential(credential, refreshed);
      if (isTauriRuntime() && credentialVaultState().unlocked) await persistCredential(profile.id, credential);
      else setRuntimeCredential(profile.id, credential);
      return refreshed.accessToken;
    } catch (error) {
      assertCurrent();
      if (isUnauthorizedSyncError(error)) {
        setRuntimeCredential(profile.id, { password: '', inviteCode: '' });
        patchSavedSyncConnection(profile.id, { status: 'login_required', lastError: '登录已失效，请重新登录；本机数据仍保留' });
      }
      // Offline/5xx is retryable. Revoked/expired credentials require explicit
      // user login. Neither case may fall back to a remembered password.
      throw error;
    }
  })();
  refreshInFlight.set(refreshKey, pending);
  try {
    return await pending;
  } finally {
    if (refreshInFlight.get(refreshKey) === pending) refreshInFlight.delete(refreshKey);
  }
}

export async function authenticateSyncProfile(
  profile: SyncConnection,
  forceRefresh = false,
): Promise<string> {
  const authenticationKey = `${profile.id}\n${buildSyncBaseUrl(profile)}\n${profile.serverId}\n${profile.username}\n${credentialRevision(profile.id)}`;
  const existing = authenticationInFlight.get(authenticationKey);
  if (existing) return existing;
  const pending = authenticateSyncProfileNow(profile, forceRefresh);
  authenticationInFlight.set(authenticationKey, pending);
  try {
    return await pending;
  } finally {
    if (authenticationInFlight.get(authenticationKey) === pending) authenticationInFlight.delete(authenticationKey);
  }
}

export function applySyncAuthSession(
  profileId: string,
  current: ServerCredential,
  session: SyncAuthSession,
): ServerCredential {
  const credential = sessionCredential(current, session);
  setRuntimeCredential(profileId, credential, false);
  return credential;
}
