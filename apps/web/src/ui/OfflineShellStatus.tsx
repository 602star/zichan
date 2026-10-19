import { useEffect, useRef, useState } from 'react';
import { isTauriRuntime } from '../tauri.js';

type Notice = 'none' | 'waiting' | 'activating' | 'activated' | 'error';

export function OfflineShellStatus() {
  const [notice, setNotice] = useState<Notice>('none');
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequested = useRef(false);

  useEffect(() => {
    if (!import.meta.env.PROD || isTauriRuntime() || !('serviceWorker' in navigator)) return;
    let active = true;
    let wasControlled = Boolean(navigator.serviceWorker.controller);
    const version = document.querySelector<HTMLMetaElement>('meta[name="zichan-shell-version"]')?.content;
    const reportVersion = () => navigator.serviceWorker.controller?.postMessage({ type: 'ZICHAN_PRUNE_CACHES' });
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'ZICHAN_SHELL_VERSION_REQUEST') event.ports[0]?.postMessage(version ?? null);
    };
    const onControllerChange = () => {
      if (!active) return;
      reportVersion();
      if (wasControlled || updateRequested.current) {
        setNotice('activated');
        if (updateRequested.current) {
          updateRequested.current = false;
          window.location.reload();
        }
      }
      wasControlled = true;
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    // Relative to the actual document, including deployments under /prefix/app/.
    const base = new URL('./', window.location.href);
    void navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' }).then((registration) => {
      if (!active) return;
      registrationRef.current = registration;
      const update = () => {
        if (!active) return;
        setNotice((previous) => registration.waiting ? 'waiting' : previous === 'waiting' ? 'none' : previous);
      };
      update();
      registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', update));
      reportVersion();
    }).catch(() => { if (active) setNotice('error'); });
    return () => {
      active = false;
      registrationRef.current = null;
      navigator.serviceWorker.removeEventListener('message', onMessage);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  const applyUpdate = () => {
    if (notice === 'activated') {
      window.location.reload();
      return;
    }
    const waiting = registrationRef.current?.waiting;
    if (!waiting) return;
    updateRequested.current = true;
    setNotice('activating');
    waiting.postMessage({ type: 'ZICHAN_SKIP_WAITING' });
  };

  if (notice === 'none') return null;
  const message = notice === 'waiting' ? '应用更新已准备好。保存当前操作后，可更新此页；其他页面可稍后各自刷新。'
    : notice === 'activating' ? '正在切换到新版…'
      : notice === 'activated' ? '新版已启用。保存当前操作后，刷新此页即可使用。'
        : '离线启动资源尚未准备好，请联网后重新打开此页。';
  return (
    <div role="status" style={{ padding: '10px 16px', background: 'var(--surface-2)', color: 'var(--text-primary)', fontSize: 'var(--fs-body)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px' }}>
      <span style={{ flex: '1 1 220px' }}>{message}</span>
      {(notice === 'waiting' || notice === 'activated') && <button type="button" onClick={applyUpdate} style={{ whiteSpace: 'nowrap' }}>{notice === 'waiting' ? '更新此页' : '刷新此页'}</button>}
    </div>
  );
}
