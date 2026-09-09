import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { AppErrorBoundary } from './ui/AppErrorBoundary.js';
import { adminBaseUrl } from './admin/client.js';
import { isTauriRuntime } from './tauri.js';
import { enableWebAccounts } from './account-storage.js';

const AdminApp = lazy(() => import('./admin/AdminApp.js').then((module) => ({ default: module.AdminApp })));
const LedgerApp = lazy(() => import('./LedgerApp.js').then((module) => ({ default: module.LedgerApp })));
const WebAccountApp = lazy(() => import('./WebAccountApp.js').then((module) => ({ default: module.WebAccountApp })));
const managementBase = adminBaseUrl(window.location);
if (managementBase === undefined && !isTauriRuntime()) enableWebAccounts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <Suspense fallback={<p role="status">正在加载…</p>}>
        {managementBase !== undefined ? <AdminApp baseUrl={managementBase} /> : isTauriRuntime() ? <LedgerApp /> : <WebAccountApp />}
      </Suspense>
    </AppErrorBoundary>
  </StrictMode>,
);
