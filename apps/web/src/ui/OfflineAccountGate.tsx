import { useEffect, useState, type ReactNode } from 'react';
import { hasOfflinePassword, unlockOffline, unlockRememberedDevice } from '../offline-access.js';
import type { SyncConnection } from '../sync-config.js';

export function OfflineAccountGate({ connection, children }: { connection: SyncConnection; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    void unlockRememberedDevice(connection).then(setReady).catch(() => setError('离线免密不可用，请输入账号密码，或联网后重新登录。')).finally(() => setBusy(false));
  }, [connection]);
  if (ready) return <>{children}</>;
  return <main className="zc-protection" style={{ maxWidth: 500, margin: '10vh auto', padding: 24 }}><h1>离线解锁</h1>
    <p>服务器暂时不可用。输入账号密码即可打开此账号在本设备保存的账本缓存；恢复连接后继续同步。</p>
    {hasOfflinePassword() ? <form onSubmit={(e) => {
      e.preventDefault(); if (busy) return; setBusy(true); setError('');
      void unlockOffline(connection, password).then(() => setReady(true)).catch(() => setError('账号密码错误或本机缓存已失效')).finally(() => setBusy(false));
    }}><label>账号密码<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><button disabled={busy || password.length < 8}>解锁缓存</button></form>
      : <p>此设备尚无可离线打开的账本。联网后用账号密码登录一次，即可自动准备离线访问。</p>}
    {error && <p role="alert">{error}</p>}<button onClick={() => location.reload()}>重试在线登录</button>
  </main>;
}
