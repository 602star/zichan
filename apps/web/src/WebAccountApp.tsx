import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { fetchAuthMe, refreshAccountSession, requestJson, HttpRequestError, type SyncAuthSession } from '@zichan/db';
import { canOfferOfflineCache } from './account-restore-error.js';
import { activateWebAccount, accountLocalStorage, accountStorageKey } from './account-storage.js';
import { FirstServerConnectionGate } from './ui/FirstServerConnectionGate.js';
import { applySyncAuthSession } from './sync-auth.js';
import { restoreBrowserCredentialRuntimeState, setRuntimeCredential } from './credential-vault.js';
import { ACCOUNT_EXIT_KEY, ACCOUNT_LOCK_REQUEST_EVENT, hasAccountCloseHandler } from './browser-account-exit.js';
import { clearAccountProtection } from './account-protection.js';
import { syncAddressPresetUrl, type SyncConnection } from './sync-config.js';
import { restoreWebSyncConnections } from './web-sync-connections.js';
import { AccountProtectionGate } from './ui/AccountProtectionGate.js';
import { OfflineAccountGate } from './ui/OfflineAccountGate.js';

const LedgerApp = lazy(() => import('./LedgerApp.js').then((module) => ({ default: module.LedgerApp })));
const BINDING_KEY = 'zichan.web-account.v2.binding';
const LOGIN_EVENT_KEY = 'zichan.web-account.v2.login';
const REQUIRE_LOGIN_KEY = 'zichan.web-account.v2.require-login';

type WebBinding = SyncConnection & { browserSessionId?: string };
function savedBinding(): WebBinding | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(BINDING_KEY) ?? localStorage.getItem(BINDING_KEY) ?? 'null') as WebBinding | null;
    return value?.accountId && value.serverId && value.serverPublicKey && value.baseUrl === syncAddressPresetUrl('current') ? value : undefined;
  } catch { return undefined; }
}

export function WebAccountApp() {
  const [binding] = useState(savedBinding);
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(false);
  const [activeConnection, setActiveConnection] = useState<SyncConnection>();
  const [offlineEntry, setOfflineEntry] = useState(false);
  const activeAccount = useRef<string>();
  const restoreFlight = useRef<Promise<SyncAuthSession>>();

  async function enter(connection: WebBinding, session?: SyncAuthSession) {
    activateWebAccount(connection.serverId!, connection.accountId!);
    // These settings, key envelopes and the entire IndexedDB now belong to this account.
    connection = { ...connection, ...restoreWebSyncConnections(connection) };
    restoreBrowserCredentialRuntimeState();
    accountLocalStorage.setItem('zichan.firstUse.mode.v1', 'server');
    if (session) {
      accountLocalStorage.removeItem(ACCOUNT_EXIT_KEY);
      applySyncAuthSession(connection.id, { password: '', inviteCode: '' }, session);
      sessionStorage.removeItem(REQUIRE_LOGIN_KEY);
      localStorage.setItem(LOGIN_EVENT_KEY, JSON.stringify({ accountId: connection.accountId, serverId: connection.serverId, at: Date.now() }));
    } else if (connection.browserSessionId) {
      // Session ID is not a credential: a live HttpOnly Cookie must still pass refresh on reconnect.
      setRuntimeCredential(connection.id, { password: '', inviteCode: '', sessionTransport: 'cookie', sessionId: connection.browserSessionId }, false);
    }
    const remembered = { ...connection, browserSessionId: session?.session.id ?? connection.browserSessionId };
    sessionStorage.setItem(BINDING_KEY, JSON.stringify(remembered));
    localStorage.setItem(BINDING_KEY, JSON.stringify(remembered));
    activeAccount.current = connection.accountId;
    setActiveConnection(connection);
    setOfflineEntry(!session);
    setReady(true);
  }

  useEffect(() => {
    let active = true;
    async function restore() {
      if (!binding || sessionStorage.getItem(REQUIRE_LOGIN_KEY)) { if (active) setChecking(false); return; }
      const prefix = `zichan.account.v2:${encodeURIComponent(binding.serverId!)}:${encodeURIComponent(binding.accountId!)}:`;
      const exit = localStorage.getItem(`${prefix}${ACCOUNT_EXIT_KEY}`);
      if (exit) { if (active) { setNotice(exit === 'confirmed' ? '已退出账号，服务器会话已撤销。可以登录其他账号，本机缓存分别保存。' : '已退出账号，服务器会话撤销尚未确认，请联网后登录。'); setChecking(false); } return; }
      if (!restoreFlight.current) restoreFlight.current = (async () => {
        const health = await requestJson(`${binding.baseUrl}/api/health`, { cache: 'no-store', redirect: 'error' }, { timeoutMs: 8000 });
        if (!health.ok) throw new HttpRequestError('http', `服务器暂不可用（HTTP ${health.status}），请稍后重试。`, health.status);
        const identity = await health.json() as { serverId?: string; serverPublicKey?: string };
        if (identity.serverId !== binding.serverId || identity.serverPublicKey !== binding.serverPublicKey) throw new Error('服务器身份已变化，请联系部署者。');
        const refresh = () => refreshAccountSession(binding.baseUrl, '', 'cookie');
        const session = navigator.locks ? await navigator.locks.request(`zichan:session-refresh:${binding.baseUrl}`, refresh) : await refresh();
        if (session.accountId !== binding.accountId) throw new Error('本站账号会话已切换，请重新登录。');
        return session;
      })();
      try {
        const session = await restoreFlight.current;
        const account = await fetchAuthMe(binding.baseUrl, session.accessToken);
        if (account.accountId !== binding.accountId) throw new Error('账号身份不匹配，请重新登录。');
        if (active) await enter({ ...binding, role: account.role, ledgerId: account.ledgerId, replicaId: account.replicaId, streamEpoch: account.streamEpoch }, session);
      } catch (error) {
        if (active) {
          const available = canOfferOfflineCache(error);
          setNotice(available ? '暂时无法连接账号服务器。可用此设备已设置的离线密码或记住设备授权解锁已有缓存；联网后继续验证账号并同步。'
            : `${error instanceof Error ? error.message : '账号验证失败'} 请重新登录或联系部署者。`);
          setOffline(available);
        }
      } finally { if (active) setChecking(false); }
    }
    void restore();
    return () => { active = false; };
    // Binding is fixed for this document. Switching accounts loads a fresh document.
  }, [binding]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (!activeAccount.current) return;
      if (event.key === accountStorageKey(ACCOUNT_EXIT_KEY) && event.newValue === 'pending') {
        clearAccountProtection();
        // During key bootstrap no StoreProvider exists yet to process logout.
        // Mounted providers close their database through their existing listener.
        if (!hasAccountCloseHandler()) window.location.reload();
        return;
      }
      if (event.key !== LOGIN_EVENT_KEY || !event.newValue) return;
      try {
        if (JSON.parse(event.newValue).accountId !== activeAccount.current) {
          sessionStorage.setItem(REQUIRE_LOGIN_KEY, '1');
          clearAccountProtection();
          if (hasAccountCloseHandler()) window.dispatchEvent(new Event(ACCOUNT_LOCK_REQUEST_EVENT));
          else window.location.reload();
        }
      } catch { /* Ignore malformed cross-tab notifications. */ }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);

  if (checking) return <p role="status">正在验证账号会话…</p>;
  if (ready && activeConnection) {
    const app = <Suspense fallback={<p role="status">正在加载账号账本…</p>}><LedgerApp /></Suspense>;
    return offlineEntry ? <OfflineAccountGate connection={activeConnection}>{app}</OfflineAccountGate> : <AccountProtectionGate connection={activeConnection}>{app}</AccountProtectionGate>;
  }
  return <>
    {notice && <p role="status">{notice}</p>}
    {offline && binding && <button onClick={() => void enter(binding).catch((error) => setNotice(String(error)))}>离线解锁 {binding.username} 的缓存</button>}
    <FirstServerConnectionGate accountOnly onReady={async () => {}} onCancel={() => {}} onAuthenticated={enter} />
  </>;
}
