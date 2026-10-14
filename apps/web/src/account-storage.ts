/** Browser account storage is isolated by server, account and ledger replica. */
let webAccounts = false;
let namespace: string | undefined;
export const WEB_ACCOUNT_BINDING_KEY = 'zichan.web-account.v2.binding';
export const WEB_LEDGER_SWITCH_EVENT_KEY = 'zichan.web-account.v1.ledger-switch';

export function enableWebAccounts(): void { webAccounts = true; }
export function webLedgerNamespace(serverId: string, accountId: string,
  replicaId?: string): string {
  return `zichan.account.v3:${encodeURIComponent(serverId)}:${encodeURIComponent(accountId)}:${encodeURIComponent(replicaId ?? 'unbound')}:`;
}

export function activateWebAccount(serverId: string, accountId: string,
  replicaId?: string): void {
  const next = webLedgerNamespace(serverId, accountId, replicaId);
  if (namespace && namespace !== next) throw new Error('切换账号或账本需要重新加载页面');
  namespace = next;
}
export function accountStorageKey(key: string): string {
  return webAccounts ? `${namespace ?? 'zichan.account.v3:guest:'}${key}` : key;
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
