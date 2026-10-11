import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { AppErrorBoundary } from './ui/AppErrorBoundary.js';
import { adminBaseUrl } from './admin/client.js';
import { isTauriRuntime } from './tauri.js';
import { enableWebAccounts } from './account-storage.js';
import { OfflineShellStatus } from './ui/OfflineShellStatus.js';
import { loadDesktopLedgerProfile } from './desktop-ledger-profile.js';
import { saveFirstUseMode } from './browser-storage-policy.js';

const AdminApp = lazy(() => import('./admin/AdminApp.js').then((module) => ({ default: module.AdminApp })));
const LedgerApp = lazy(() => import('./LedgerApp.js').then((module) => ({ default: module.LedgerApp })));
const WebAccountApp = lazy(() => import('./WebAccountApp.js').then((module) => ({ default: module.WebAccountApp })));
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
const managementBase = adminBaseUrl(window.location);
if (managementBase === undefined && !isTauriRuntime()) enableWebAccounts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      {managementBase === undefined && <OfflineShellStatus />}
      <Suspense fallback={<p role="status">正在加载…</p>}>
        {managementBase !== undefined ? <AdminApp baseUrl={managementBase} /> : isTauriRuntime() ? <DesktopLedgerApp /> : <WebAccountApp />}
      </Suspense>
    </AppErrorBoundary>
  </StrictMode>,
);
