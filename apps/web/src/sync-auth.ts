import {
  loginAccount,
  refreshAccountSession,
  type SyncAuthSession,
} from '@zichan/db';
import { runtimeCredential, setRuntimeCredential } from './credential-vault.js';
import { getDeviceId } from './db/cloud.js';
import { buildSyncBaseUrl, type ServerCredential, type SyncServerProfile } from './sync-config.js';

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

async function authenticateSyncProfileNow(
  profile: SyncServerProfile,
  forceLogin = false,
): Promise<string> {
  let credential = runtimeCredential(profile.id);
  if (!profile.username.trim() || !credential?.password) throw new Error('缺少用户名或已解锁的同步密码');
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
    { deviceId: getDeviceId(), deviceName: deviceName() },
  );
  credential = sessionCredential(credential, session);
  setRuntimeCredential(profile.id, credential, false);
  return session.accessToken;
}

export async function authenticateSyncProfile(
  profile: SyncServerProfile,
  forceLogin = false,
): Promise<string> {
  const existing = authenticationInFlight.get(profile.id);
  if (existing) return existing;
  const pending = authenticateSyncProfileNow(profile, forceLogin);
  authenticationInFlight.set(profile.id, pending);
  try {
    return await pending;
  } finally {
    if (authenticationInFlight.get(profile.id) === pending) authenticationInFlight.delete(profile.id);
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
