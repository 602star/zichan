import { useState } from 'react';
import { loginAccount, registerAccount, requestJson } from '@zichan/db';
import { accountProtection } from '../account-protection.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';

interface Device { id: string; deviceName: string; lastSeenAt: string; active: boolean }
export function AccountSecurityPanel({ onExit }: { onExit?: () => Promise<void> }) {
  const profile = loadSyncConnections().find((row) => row.id === accountProtection()?.profileId);
  const [devices, setDevices] = useState<Device[]>();
  const [current, setCurrent] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  if (!profile) return null;
  const selected = profile;
  async function api(path: string, token?: string) {
    const response = await requestJson(`${buildSyncBaseUrl(selected)}/api/auth/${path}`, {
      method: path === 'devices' ? 'GET' : 'POST', cache: 'no-store', redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${token ?? await authenticateSyncProfile(selected)}` },
    });
    const result = await response.json() as { error?: string; devices: Device[]; currentSessionId: string; code: string };
    if (!response.ok) throw new Error(result.error || '账号操作失败');
    return result;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function refresh() {
    const result = await api('devices');
    setDevices(result.devices); setCurrent(result.currentSessionId);
  }
  return <section className="zc-protection" aria-label="账号安全" style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 'var(--r-md)', marginBottom: 16 }}>
    <h2 style={{ fontSize: 'var(--fs-title)' }}>账号安全 · {profile.username}</h2>
    <details><summary>修改账号密码</summary>
      <p>修改后所有设备都需要重新登录。账本、恢复码和保护方式保持不变；未同步数据保留在本机。</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (password.length < 8 || password !== confirmation) throw new Error('新密码至少八位，且两次输入须一致');
          const baseUrl = buildSyncBaseUrl(selected);
          const identity = { expectedServerId: selected.serverId, expectedServerPublicKey: selected.serverPublicKey };
          const verified = await loginAccount(baseUrl, selected.username, oldPassword, { ...identity, deviceName: '修改密码验证', sessionTransport: 'token' });
          try {
            const { code } = await api('password-change/authorize', verified.accessToken);
            await registerAccount(baseUrl, selected.username, password, { ...identity, passwordResetCode: code });
          } finally {
            setOldPassword(''); setPassword(''); setConfirmation('');
            await api('logout', verified.accessToken).catch(() => undefined);
          }
          setNotice('账号密码已修改，请重新登录。');
          if (onExit) await onExit();
          else window.location.reload();
        });
      }}>
        <label>当前账号密码<input aria-label="当前账号密码" type="password" autoComplete="current-password" required value={oldPassword} disabled={busy} onChange={(e) => setOldPassword(e.target.value)} /></label>
        <label>新账号密码<input aria-label="修改后的账号密码" type="password" autoComplete="new-password" required minLength={8} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} /></label>
        <label>再次输入新密码<input aria-label="再次输入新密码" type="password" autoComplete="new-password" required value={confirmation} disabled={busy} onChange={(e) => setConfirmation(e.target.value)} /></label>
        <button disabled={busy || !oldPassword || password.length < 8 || password !== confirmation}>确认修改账号密码</button>
      </form>
    </details>
    <details style={{ marginTop: 16 }}><summary>登录设备</summary>
      <p>这里列出此账号的登录会话。撤销后，该会话不能继续访问服务器；其他设备上已有的离线副本不会远程删除。</p>
      <button disabled={busy} onClick={() => void run(refresh)}>刷新登录设备</button>
      {devices?.map((device) => <div key={device.id} style={{ padding: '10px 0', overflowWrap: 'anywhere' }}>
        <strong>{device.deviceName || '未命名设备'}{device.id === current ? ' · 当前设备' : ''}</strong>
        <div>最近访问：{new Date(device.lastSeenAt).toLocaleString()} · {device.active ? '有效' : '已失效'}</div>
        {device.active && device.id !== current && <button disabled={busy} onClick={() => void run(async () => { await api(`devices/${encodeURIComponent(device.id)}/revoke`); await refresh(); setNotice('已撤销该设备的登录会话。'); })}>退出此设备</button>}
      </div>)}
      <p>退出当前设备请使用“退出记账账号”。</p>
    </details>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
