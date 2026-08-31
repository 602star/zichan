import {
  loginAccount,
  refreshAccountSession,
  type SyncAuthSession,
} from '@zichan/db';
import { runtimeCredential, setRuntimeCredential } from './credential-vault.js';
import { getDeviceId } from './db/cloud.js';
import { buildSyncBaseUrl, type ServerCredential, type SyncConnection } from './sync-config.js';
import { fingerprintServerPublicKey } from './connection-link.js';

const EXPIRY_MARGIN_MS = 30_000;
const authenticationInFlight = new Map<string, Promise<string>>();

function deviceName(): string {
  const navigator = globalThis.navigator;
  const platform = navigator?.platform?.trim();
  return (platform ? `Zichan · ${platform}` : 'Zichan client').slice(0, 120);
}

function sessionCredential(current: ServerCredential, session: SyncAuthSession): ServerCredential {
  return {
    ...current,
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
  const response = await fetch(`${buildSyncBaseUrl(profile)}/api/health`, { redirect: 'error' });
  if (!response.ok) throw new Error(`同步服务器身份检查失败：HTTP ${response.status}`);
  const body = await response.json() as { serverId?: string; serverPublicKey?: string };
  if (body.serverId !== profile.serverId || body.serverPublicKey !== profile.serverPublicKey) {
    throw new Error('同步服务器身份已变化，已阻止发送会话或密码');
  }
  if (profile.expectedServerPublicKeyFingerprint
    && await fingerprintServerPublicKey(body.serverPublicKey) !== profile.expectedServerPublicKeyFingerprint) {
    throw new Error('同步服务器公钥指纹与导入连接链接不一致');
  }
}

async function authenticateSyncProfileNow(
  profile: SyncConnection,
  forceLogin = false,
): Promise<string> {
  let credential = runtimeCredential(profile.id);
  if (!profile.username.trim() || !credential?.password) throw new Error('缺少用户名或已解锁的同步密码');
  await assertSyncServerIdentity(profile);
  if (!forceLogin && accessTokenIsFresh(credential)) return credential.accessToken!;

  if (!forceLogin && credential.refreshToken) {
    try {
      const refreshed = await refreshAccountSession(buildSyncBaseUrl(profile), credential.refreshToken);
      credential = sessionCredential(credential, refreshed);
      setRuntimeCredential(profile.id, credential, false);
      return refreshed.accessToken;
    } catch {
      // A revoked, expired, or already-rotated refresh token falls back to a fresh challenge login.
    }
  }

  const session = await loginAccount(
    buildSyncBaseUrl(profile),
    profile.username.trim(),
    credential.password,
    {
      deviceId: getDeviceId(),
      deviceName: deviceName(),
      expectedServerId: profile.serverId,
      expectedServerPublicKey: profile.serverPublicKey,
    },
  );
  credential = sessionCredential(credential, session);
  setRuntimeCredential(profile.id, credential, false);
  return session.accessToken;
}

export async function authenticateSyncProfile(
  profile: SyncConnection,
  forceLogin = false,
): Promise<string> {
  const authenticationKey = `${profile.id}\n${buildSyncBaseUrl(profile)}\n${forceLogin ? 'force' : 'reuse'}`;
  const existing = authenticationInFlight.get(authenticationKey);
  if (existing) return existing;
  const pending = authenticateSyncProfileNow(profile, forceLogin);
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
