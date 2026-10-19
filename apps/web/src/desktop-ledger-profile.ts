import { tauriInvoke } from './tauri.js';
import { fetchAuthMe, type SyncAuthMe, type SyncAuthSession } from '@zichan/db';
import { buildSyncBaseUrl, newSyncConnection, type SyncConnection } from './sync-config.js';

export interface DesktopLedgerProfileBinding {
  serverId: string;
  serverPublicKey: string;
  accountId: string;
  replicaId: string;
  ledgerId: string;
  streamEpoch: string;
  serverUrl: string;
  username: string;
}

export interface DesktopLedgerProfileStatus {
  ledgerProfileId: string;
  ledgerProfileBinding: DesktopLedgerProfileBinding | null;
  ledgerProfileSwitchSupported: boolean;
}

let startupProfile: DesktopLedgerProfileStatus | undefined;

export async function loadDesktopLedgerProfile(): Promise<DesktopLedgerProfileStatus> {
  const request = tauriInvoke<DesktopLedgerProfileStatus>('desktop_storage_status');
  if (!request) throw new Error('桌面账本 profile 状态命令不可用');
  const result = await request;
  if (!result.ledgerProfileId || result.ledgerProfileId !== 'legacy' && !result.ledgerProfileBinding) {
    throw new Error('桌面账本 profile 状态不完整');
  }
  startupProfile = result;
  return result;
}

export function activeDesktopLedgerProfile(): DesktopLedgerProfileStatus | undefined {
  return startupProfile;
}

export function hasNativeLedgerBootstrap(): boolean {
  return Boolean(startupProfile?.ledgerProfileBinding && startupProfile.ledgerProfileId !== 'legacy');
}

export function nativeBootstrapConnection(): SyncConnection | undefined {
  const binding = startupProfile?.ledgerProfileBinding;
  if (!binding) return undefined;
  return { ...newSyncConnection(binding.serverUrl), alias: '当前账本节点',
    serverId: binding.serverId, serverPublicKey: binding.serverPublicKey,
    accountId: binding.accountId, username: binding.username, ledgerId: binding.ledgerId,
    replicaId: binding.replicaId, streamEpoch: binding.streamEpoch,
    enabled: true, status: 'online' };
}

/** Verify the bound replica before any native database or key is opened. */
export async function verifyNativeProfileSession(connection: SyncConnection, session: SyncAuthSession,
  binding: DesktopLedgerProfileBinding,
  readAccount = fetchAuthMe): Promise<{ connection: SyncConnection; session: SyncAuthSession }> {
  if (connection.serverId !== binding.serverId || connection.serverPublicKey !== binding.serverPublicKey
    || connection.accountId !== binding.accountId) {
    throw new Error('登录账号或节点与当前桌面账本 profile 不匹配');
  }
  if (connection.replicaId !== binding.replicaId || connection.ledgerId !== binding.ledgerId
    || connection.streamEpoch !== binding.streamEpoch) {
    throw new Error('当前桌面账本 profile 与服务器副本身份不一致');
  }
  const account: SyncAuthMe = await readAccount(buildSyncBaseUrl(connection), session.accessToken);
  if (account.accountId !== binding.accountId || account.ledgerId !== binding.ledgerId
    || account.replicaId !== binding.replicaId || account.streamEpoch !== binding.streamEpoch) {
    throw new Error('当前桌面账本 profile 与服务器会话不一致');
  }
  connection = { ...connection, role: account.role };
  if (connection.ledgerId !== binding.ledgerId || connection.streamEpoch !== binding.streamEpoch) {
    throw new Error('当前桌面账本 profile 与服务器副本身份不一致');
  }
  return { connection, session };
}
