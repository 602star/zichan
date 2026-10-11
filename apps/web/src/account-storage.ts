/** Web accounts use a new namespace. Legacy/native storage is never migrated. */
let webAccounts = false;
let namespace: string | undefined;
export const WEB_ACCOUNT_BINDING_KEY = 'zichan.web-account.v2.binding';
export const WEB_LEDGER_SWITCH_EVENT_KEY = 'zichan.web-account.v1.ledger-switch';

export function enableWebAccounts(): void { webAccounts = true; }
export function legacyWebAccountNamespace(serverId: string, accountId: string): string {
  return `zichan.account.v2:${encodeURIComponent(serverId)}:${encodeURIComponent(accountId)}:`;
}

/** Keep the existing encrypted cache for its original replica; isolate later replicas. */
export function webLedgerNamespace(serverId: string, accountId: string,
  replicaId?: string, primaryReplicaId?: string, legacyOccupied = false): string {
  const legacy = legacyWebAccountNamespace(serverId, accountId);
  if (!replicaId || replicaId === primaryReplicaId || !primaryReplicaId && !legacyOccupied) return legacy;
  return `zichan.account.v3:${encodeURIComponent(serverId)}:${encodeURIComponent(accountId)}:${encodeURIComponent(replicaId)}:`;
}

export function activateWebAccount(serverId: string, accountId: string,
  replicaId?: string, primaryReplicaId?: string, legacyOccupied = false): void {
  const next = webLedgerNamespace(serverId, accountId, replicaId, primaryReplicaId, legacyOccupied);
  if (namespace && namespace !== next) throw new Error('切换账号或账本需要重新加载页面');
  namespace = next;
}
export function accountStorageKey(key: string): string {
  return webAccounts ? `${namespace ?? 'zichan.account.v2:guest:'}${key}` : key;
}
export function accountDatabaseName(): string {
  if (!webAccounts) return 'zichan-web';
  if (!namespace) throw new Error('请先登录账号，再打开账本缓存');
  return `${namespace}database`;
}
function scopedStorage(kind: 'localStorage' | 'sessionStorage'): Storage {
  return {
    getItem: (key) => globalThis[kind]?.getItem(accountStorageKey(key)) ?? null,
    setItem: (key, value) => globalThis[kind].setItem(accountStorageKey(key), value),
    removeItem: (key) => globalThis[kind]?.removeItem(accountStorageKey(key)),
    get length() { return keys().length; },
    key: (index) => keys()[index] ?? null,
    clear: () => { for (const key of keys()) globalThis[kind].removeItem(accountStorageKey(key)); },
  };
  function keys(): string[] {
    const storage = globalThis[kind];
    const prefix = accountStorageKey('');
    return Array.from({ length: storage?.length ?? 0 }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }
}
export const accountLocalStorage = scopedStorage('localStorage');
export const accountSessionStorage = scopedStorage('sessionStorage');
