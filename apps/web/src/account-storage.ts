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
/** First personal-ledger binding happens before the ledger database is opened. */
export function adoptFirstWebLedgerReplica(serverId: string, accountId: string,
  ledgerId: string, replicaId: string, streamEpoch: string): void {
  if (!webAccounts) return;
  const old = webLedgerNamespace(serverId, accountId);
  const next = webLedgerNamespace(serverId, accountId, replicaId);
  if (namespace === next) return;
  if (namespace !== old) throw new Error('当前账本身份与浏览器账号不一致');
  for (const storage of [localStorage, sessionStorage]) {
    const entries = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(old)));
    for (const key of entries) {
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(`${next}${key.slice(old.length)}`) === null) {
        storage.setItem(`${next}${key.slice(old.length)}`, value);
      }
    }
    try {
      const binding = JSON.parse(storage.getItem(WEB_ACCOUNT_BINDING_KEY) ?? 'null') as Record<string, unknown> | null;
      if (binding?.serverId === serverId && binding.accountId === accountId && !binding.replicaId) {
        storage.setItem(WEB_ACCOUNT_BINDING_KEY, JSON.stringify({ ...binding, ledgerId, replicaId, streamEpoch }));
      }
    } catch { /* Invalid bindings are handled by the account gate. */ }
  }
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
