import { requestJson } from '@zichan/db';
import { unlockLedgerKeyEnvelope, type LedgerKeyEnvelope } from '@zichan/core';
import { authenticateSyncProfile } from './sync-auth.js';
import { buildSyncBaseUrl, patchSavedSyncConnection, type SyncConnection } from './sync-config.js';
import { adoptUnlockedLedgerKeyEnvelope } from './ledger-key-vault.js';

export interface ProtectionInfo {
  mode: 'managed' | 'relay' | null;
  version: number;
  defaultMode: 'managed';
  custodyEnabled: boolean;
  secret: string | null;
  envelope: LedgerKeyEnvelope | null;
  replica: { serverId: string; ledgerId: string; replicaId: string; streamEpoch: string; headSeq: number } | null;
}
export interface UnlockedProtection {
  profileId: string; secret: string; info: ProtectionInfo;
}
let unlocked: UnlockedProtection | undefined;
let revision = 0;
export const PROTECTION_CHANGED = 'zichan:protection-changed';
export function accountProtection(): UnlockedProtection | undefined { return unlocked; }
export function clearAccountProtection(): void { revision += 1; unlocked = undefined; }

export async function protectionRequest(profile: SyncConnection, method = 'GET', body?: unknown, suffix = ''): Promise<ProtectionInfo> {
  const token = await authenticateSyncProfile(profile);
  const response = await requestJson(`${buildSyncBaseUrl(profile)}/api/v3/protection${suffix}`, {
    method, redirect: 'error', cache: 'no-store', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json() as ProtectionInfo & { error?: string };
  if (!response.ok) throw new Error(result.error || `保护设置请求失败：HTTP ${response.status}`);
  if (!['managed', 'relay', null].includes(result.mode) || !Number.isSafeInteger(result.version)) throw new Error('保护设置响应无效');
  return result;
}

export async function unlockAccountProtection(profile: SyncConnection, info: ProtectionInfo): Promise<void> {
  const atRevision = revision;
  const secret = info.mode === 'managed' ? info.secret : null;
  if (!secret || !info.envelope || !info.replica || info.envelope.ledgerId !== info.replica.ledgerId || info.replica.serverId !== profile.serverId) throw new Error('账本保护信息不完整');
  const session = await unlockLedgerKeyEnvelope(secret, info.envelope);
  if (atRevision !== revision) throw new Error('账号会话已退出');
  adoptUnlockedLedgerKeyEnvelope(info.envelope, session, true);
  // Secrets stay in memory. Only public replica identity is persisted.
  unlocked = { profileId: profile.id, secret, info: { ...info, secret: null } };
  patchSavedSyncConnection(profile.id, { ledgerId: info.replica.ledgerId, replicaId: info.replica.replicaId, streamEpoch: info.replica.streamEpoch });
  window.dispatchEvent(new Event(PROTECTION_CHANGED));
}

export function replaceProtectionRuntime(secret: string, info: ProtectionInfo): void {
  if (!unlocked) throw new Error('账号账本尚未解锁');
  unlocked = { ...unlocked, secret, info: { ...info, secret: null } };
  window.dispatchEvent(new Event(PROTECTION_CHANGED));
}
