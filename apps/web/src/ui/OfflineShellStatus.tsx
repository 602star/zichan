import { useEffect, useState } from 'react';
import { isTauriRuntime } from '../tauri.js';

export function OfflineShellStatus() {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!import.meta.env.PROD || isTauriRuntime() || !('serviceWorker' in navigator)) return;
    let active = true;
    // Relative to the actual document, including deployments under /prefix/app/.
    const base = new URL('./', window.location.href);
    void navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' }).then((registration) => {
      const update = () => {
        if (!active) return;
        setNotice(registration.waiting ? '应用更新已准备好。保存当前操作后，关闭此网站的全部页面并重新打开即可更新。' : '');
      };
      update();
      registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', update));
    }).catch(() => { if (active) setNotice('离线启动资源尚未准备好，请联网后重新打开此页。'); });
    return () => { active = false; };
  }, []);
  return notice ? <div role="status" style={{ padding: '10px 16px', background: 'var(--surface-2)', color: 'var(--fg)', fontSize: 13 }}>{notice}</div> : null;
}
