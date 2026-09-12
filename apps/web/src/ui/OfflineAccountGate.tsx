import { useEffect, useState, type ReactNode } from 'react';
import { hasOfflinePassword, unlockOffline, unlockRememberedDevice } from '../offline-access.js';
import type { SyncConnection } from '../sync-config.js';

export function OfflineAccountGate({ connection, children }: { connection: SyncConnection; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    void unlockRememberedDevice(connection).then(setReady).catch(() => setError('此设备授权不可用，请输入离线密码或联网登录。')).finally(() => setBusy(false));
  }, [connection]);
  if (ready) return <>{children}</>;
  return <main className="zc-protection" style={{ maxWidth: 500, margin: '10vh auto', padding: 24 }}><h1>离线解锁</h1>
    <p>仅访问此账号在本设备保存的加密缓存。</p>
    {hasOfflinePassword() ? <form onSubmit={(e) => {
      e.preventDefault(); if (busy) return; setBusy(true); setError('');
      void unlockOffline(connection, password).then(() => setReady(true)).catch(() => setError('离线密码错误或缓存授权已失效')).finally(() => setBusy(false));
    }}><input aria-label="离线密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /><button disabled={busy || password.length < 8}>解锁缓存</button></form>
      : <p>此设备未设置离线密码。联网登录后，可在“账本保护”中开启离线访问。</p>}
    {error && <p role="alert">{error}</p>}<button onClick={() => location.reload()}>重试在线登录</button>
  </main>;
}
