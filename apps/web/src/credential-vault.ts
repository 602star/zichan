import { isTauriRuntime, tauriInvoke } from './tauri.js';
import {
  loadSessionCredentials,
  saveSessionCredentials,
  type ServerCredential,
} from './sync-config.js';

const CLIENT_ID = 'zichan-sync-v1';
const RECORD_PREFIX = 'sync-server:';
export const CREDENTIALS_CHANGED_EVENT = 'zichan:credentials-changed';
export const VAULT_STATE_CHANGED_EVENT = 'zichan:vault-state-changed';

export interface NativeSecurityStatus {
  platform: string;
  mobile: boolean;
  strongholdPath: string;
  strongholdExists: boolean;
}

export interface CredentialVaultState {
  kind: 'browser-session' | 'native-stronghold';
  unlocked: boolean;
  initialized: boolean;
  platform: string;
  mobile: boolean;
  message: string;
}

let runtimeCredentials: Record<string, ServerCredential> = isTauriRuntime() ? {} : loadSessionCredentials();
let snapshotPath = '';
let vaultState: CredentialVaultState = isTauriRuntime()
  ? { kind: 'native-stronghold', unlocked: false, initialized: false, platform: 'native', mobile: false, message: '安全密码库尚未解锁' }
  : { kind: 'browser-session', unlocked: true, initialized: true, platform: 'web', mobile: false, message: '密码仅保存在当前浏览器标签页' };

function emit(name: string): void {
  globalThis.dispatchEvent?.(new CustomEvent(name));
}

function requiredInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const request = tauriInvoke<T>(command, args);
  if (!request) return Promise.reject(new Error('当前不是 Tauri 原生运行环境'));
  return request;
}

function recordKey(profileId: string): string {
  return `${RECORD_PREFIX}${profileId}`;
}

function decodeCredential(bytes: number[] | null): ServerCredential | null {
  if (!bytes?.length) return null;
  const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as Partial<ServerCredential>;
  return {
    password: typeof parsed.password === 'string' ? parsed.password : '',
    inviteCode: typeof parsed.inviteCode === 'string' ? parsed.inviteCode : '',
  };
}

async function invalidateNativeVault(message: string): Promise<void> {
  if (snapshotPath) await requiredInvoke('plugin:stronghold|destroy', { snapshotPath }).catch(() => undefined);
  runtimeCredentials = {};
  vaultState = { ...vaultState, unlocked: false, message };
  emit(VAULT_STATE_CHANGED_EVENT);
  emit(CREDENTIALS_CHANGED_EVENT);
}

export function credentialVaultState(): CredentialVaultState {
  return { ...vaultState };
}

export function runtimeCredentialMap(): Record<string, ServerCredential> {
  return Object.fromEntries(Object.entries(runtimeCredentials).map(([id, value]) => [id, { ...value }]));
}

export function runtimeCredential(profileId: string): ServerCredential | undefined {
  const value = runtimeCredentials[profileId];
  return value ? { ...value } : undefined;
}

export function setRuntimeCredential(profileId: string, value: ServerCredential, notify = true): void {
  runtimeCredentials = { ...runtimeCredentials, [profileId]: { ...value } };
  if (!isTauriRuntime()) saveSessionCredentials(runtimeCredentials);
  if (notify) emit(CREDENTIALS_CHANGED_EVENT);
}

export function removeRuntimeCredential(profileId: string): void {
  if (!(profileId in runtimeCredentials)) return;
  const next = { ...runtimeCredentials };
  delete next[profileId];
  runtimeCredentials = next;
  if (!isTauriRuntime()) saveSessionCredentials(runtimeCredentials);
  emit(CREDENTIALS_CHANGED_EVENT);
}

export async function refreshCredentialVaultState(): Promise<CredentialVaultState> {
  if (!isTauriRuntime()) return credentialVaultState();
  const status = await requiredInvoke<NativeSecurityStatus>('native_security_status');
  snapshotPath = status.strongholdPath;
  vaultState = {
    ...vaultState,
    kind: 'native-stronghold',
    initialized: status.strongholdExists,
    platform: status.platform,
    mobile: status.mobile,
    message: vaultState.unlocked
      ? '同步密码由 Stronghold 加密保存'
      : status.strongholdExists ? '请输入本机密码解锁 Stronghold' : '请设置本机密码创建 Stronghold',
  };
  emit(VAULT_STATE_CHANGED_EVENT);
  return credentialVaultState();
}

export async function unlockCredentialVault(password: string, profileIds: string[]): Promise<Record<string, ServerCredential>> {
  if (!isTauriRuntime()) return runtimeCredentialMap();
  if (password.length < 8) throw new Error('本机密码至少需要 8 个字符');
  const status = await requiredInvoke<NativeSecurityStatus>('native_security_status');
  snapshotPath = status.strongholdPath;
  let strongholdLoaded = false;
  try {
    await requiredInvoke('plugin:stronghold|initialize', { snapshotPath, password });
    strongholdLoaded = true;
    try {
      await requiredInvoke('plugin:stronghold|load_client', { snapshotPath, client: CLIENT_ID });
    } catch {
      await requiredInvoke('plugin:stronghold|create_client', { snapshotPath, client: CLIENT_ID });
      await requiredInvoke('plugin:stronghold|save', { snapshotPath });
    }

    const loaded: Record<string, ServerCredential> = {};
    for (const profileId of profileIds) {
      const bytes = await requiredInvoke<number[] | null>('plugin:stronghold|get_store_record', {
        snapshotPath,
        client: CLIENT_ID,
        key: recordKey(profileId),
      });
      const value = decodeCredential(bytes);
      if (value) {
        const runtime = runtimeCredentials[profileId];
        loaded[profileId] = {
          ...value,
          accessToken: runtime?.accessToken,
          refreshToken: runtime?.refreshToken,
          accessExpiresAt: runtime?.accessExpiresAt,
          sessionId: runtime?.sessionId,
        };
      }
    }
    runtimeCredentials = loaded;
    vaultState = {
      kind: 'native-stronghold',
      unlocked: true,
      initialized: true,
      platform: status.platform,
      mobile: status.mobile,
      message: '同步密码由 Stronghold 加密保存',
    };
    emit(VAULT_STATE_CHANGED_EVENT);
    emit(CREDENTIALS_CHANGED_EVENT);
    return runtimeCredentialMap();
  } catch (error) {
    if (strongholdLoaded) {
      await requiredInvoke('plugin:stronghold|destroy', { snapshotPath }).catch(() => undefined);
      runtimeCredentials = {};
      vaultState = {
        kind: 'native-stronghold',
        unlocked: false,
        initialized: status.strongholdExists,
        platform: status.platform,
        mobile: status.mobile,
        message: status.strongholdExists ? 'Stronghold 解锁失败，请重试' : 'Stronghold 创建失败，请重试',
      };
      emit(VAULT_STATE_CHANGED_EVENT);
      emit(CREDENTIALS_CHANGED_EVENT);
    }
    throw error;
  }
}

export async function persistCredential(profileId: string, credential: ServerCredential): Promise<void> {
  if (!isTauriRuntime()) {
    setRuntimeCredential(profileId, credential);
    return;
  }
  if (!vaultState.unlocked || !snapshotPath) throw new Error('请先解锁 Stronghold 安全密码库');
  const contents = JSON.stringify({ password: credential.password, inviteCode: credential.inviteCode });
  try {
    await requiredInvoke('plugin:stronghold|save_store_record', {
      snapshotPath,
      client: CLIENT_ID,
      key: recordKey(profileId),
      value: [...new TextEncoder().encode(contents)],
    });
    await requiredInvoke('plugin:stronghold|save', { snapshotPath });
  } catch (error) {
    await invalidateNativeVault('Stronghold 保存失败，已锁定，请重新解锁后重试');
    throw error;
  }
  setRuntimeCredential(profileId, credential);
}

export async function readCredentialVaultRecord(key: string): Promise<number[] | null> {
  if (!isTauriRuntime()) throw new Error('浏览器不使用 Stronghold 安全密码库');
  if (!vaultState.unlocked || !snapshotPath) throw new Error('请先解锁 Stronghold 安全密码库');
  return requiredInvoke<number[] | null>('plugin:stronghold|get_store_record', {
    snapshotPath,
    client: CLIENT_ID,
    key,
  });
}

export async function writeCredentialVaultRecord(key: string, value: Uint8Array): Promise<void> {
  if (!isTauriRuntime()) throw new Error('浏览器不使用 Stronghold 安全密码库');
  if (!vaultState.unlocked || !snapshotPath) throw new Error('请先解锁 Stronghold 安全密码库');
  try {
    await requiredInvoke('plugin:stronghold|save_store_record', {
      snapshotPath,
      client: CLIENT_ID,
      key,
      value: [...value],
    });
    await requiredInvoke('plugin:stronghold|save', { snapshotPath });
  } catch (error) {
    await invalidateNativeVault('Stronghold 保存失败，已锁定，请重新解锁后重试');
    throw error;
  }
}

export async function deleteCredential(profileId: string): Promise<void> {
  if (!isTauriRuntime() || !vaultState.initialized) {
    removeRuntimeCredential(profileId);
    return;
  }
  if (!vaultState.unlocked || !snapshotPath) throw new Error('请先解锁 Stronghold，再删除服务器或同步凭据');
  try {
    await requiredInvoke('plugin:stronghold|remove_store_record', {
      snapshotPath,
      client: CLIENT_ID,
      key: recordKey(profileId),
    });
    await requiredInvoke('plugin:stronghold|save', { snapshotPath });
  } catch (error) {
    await invalidateNativeVault('Stronghold 删除失败，已锁定，请重新解锁后重试');
    throw error;
  }
  removeRuntimeCredential(profileId);
}

export async function lockCredentialVault(): Promise<void> {
  if (isTauriRuntime() && snapshotPath && vaultState.unlocked) {
    await requiredInvoke('plugin:stronghold|destroy', { snapshotPath });
    runtimeCredentials = {};
    vaultState = { ...vaultState, unlocked: false, message: 'Stronghold 已锁定' };
    emit(CREDENTIALS_CHANGED_EVENT);
    emit(VAULT_STATE_CHANGED_EVENT);
  }
}

export async function resetCredentialVault(): Promise<void> {
  if (!isTauriRuntime()) throw new Error('浏览器没有 Stronghold 安全密码库');
  if (snapshotPath && vaultState.unlocked) {
    await requiredInvoke('plugin:stronghold|destroy', { snapshotPath }).catch(() => undefined);
  }
  await requiredInvoke('native_reset_security_vault');
  runtimeCredentials = {};
  snapshotPath = '';
  vaultState = {
    ...vaultState,
    unlocked: false,
    initialized: false,
    message: '请设置本机密码创建 Stronghold',
  };
  emit(CREDENTIALS_CHANGED_EVENT);
  emit(VAULT_STATE_CHANGED_EVENT);
}
