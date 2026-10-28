import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { AppErrorBoundary } from './ui/AppErrorBoundary.js';
import { adminBaseUrls, resolveAdminBaseUrl } from './admin/client.js';
import { isTauriRuntime } from './tauri.js';
import { enableWebAccounts } from './account-storage.js';
import { OfflineShellStatus } from './ui/OfflineShellStatus.js';
import { loadDesktopLedgerProfile } from './desktop-ledger-profile.js';
import { saveFirstUseMode } from './browser-storage-policy.js';
import { reportPageView } from './traffic-view.js';

const AdminApp = lazy(() => import('./admin/AdminApp.js').then((module) => ({ default: module.AdminApp })));
const LedgerApp = lazy(() => import('./LedgerApp.js').then((module) => ({ default: module.LedgerApp })));
const WebAccountApp = lazy(() => import('./WebAccountApp.js').then((module) => ({ default: module.WebAccountApp })));
function ManagementEntry() {
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void resolveAdminBaseUrl(window.location).then((value) => { if (active) setBaseUrl(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (!baseUrl) return;
    let previous = '';
    const track = () => {
      const page = `/admin/${window.location.pathname.split('/admin/')[1]?.split('/')[0] || 'overview'}`;
      if (page === previous) return;
      previous = page;
      reportPageView(baseUrl, page);
    };
    track();
    window.addEventListener('zichan:admin:navigate', track);
    window.addEventListener('popstate', track);
    return () => {
      window.removeEventListener('zichan:admin:navigate', track);
      window.removeEventListener('popstate', track);
    };
  }, [baseUrl]);
  if (baseUrl) return <AdminApp baseUrl={baseUrl} />;
  return <main><p role={error ? 'alert' : 'status'}>{error || '正在连接管理服务器…'}</p>
    {error && <button onClick={() => setAttempt((value) => value + 1)}>重新连接</button>}</main>;
}
function TrackedWebAccountApp() {
  useEffect(() => {
    const path = window.location.pathname;
    const prefix = /^(.*)\/app(?:\/|$)/.exec(path)?.[1] ?? (path === '/' ? '' : path.replace(/\/$/, ''));
    reportPageView(`${window.location.origin}${prefix}`, '/app');
  }, []);
  return <WebAccountApp />;
}
function DesktopLedgerApp() {
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');
  useEffect(() => {
    let active = true;
    void loadDesktopLedgerProfile().then((profile) => {
      if (profile.ledgerProfileId !== 'legacy') saveFirstUseMode('server');
      if (active) setState('ready');
    }).catch((reason) => { if (active) setState(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  if (state === 'loading') return <p role="status">正在核对桌面账本 profile…</p>;
  if (state !== 'ready') return <p role="alert">{state}</p>;
  return <LedgerApp />;
}
const managementPage = adminBaseUrls(window.location).length > 0;
if (!managementPage && !isTauriRuntime()) enableWebAccounts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      {!managementPage && <OfflineShellStatus />}
      <Suspense fallback={<p role="status">正在加载…</p>}>
        {managementPage ? <ManagementEntry /> : isTauriRuntime() ? <DesktopLedgerApp /> : <TrackedWebAccountApp />}
      </Suspense>
    </AppErrorBoundary>
  </StrictMode>,
);
