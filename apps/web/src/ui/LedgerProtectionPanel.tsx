import { useEffect, useState } from 'react';
import { hasNativeSubtle } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import { accountProtection, PROTECTION_CHANGED } from '../account-protection.js';
import { hasOfflinePassword, rememberDevice } from '../offline-access.js';
import { loadSyncConnections } from '../sync-config.js';
import { ReplacementRecoveryPanel } from './ReplacementRecoveryPanel.js';

export function LedgerProtectionPanel({ store }: { store: SqlLedgerStore }) {
  const [state, setState] = useState(accountProtection);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const update = () => setState(accountProtection());
    window.addEventListener(PROTECTION_CHANGED, update);
    return () => window.removeEventListener(PROTECTION_CHANGED, update);
  }, []);
  if (!state) return null;
  const primaryProfile = loadSyncConnections().find((row) => row.id === state.profileId);
  return <section className="zc-protection" style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 'var(--r-md)', marginBottom: 16 }} aria-label="账本保护">
    <h2 style={{ fontSize: 'var(--fs-title)' }}>账本与离线访问</h2>
    <p>{state.info.mode === 'member'
      ? '共享账本通过账号密钥解锁。'
      : '获授权的同步服务器托管账本密钥，可以在登录后打开账本。'}</p>
    <p>{hasOfflinePassword()
      ? '本机离线访问已准备好。服务器暂时不可用时，可用账号密码打开此设备已有的账本缓存；离线新增的记录会在恢复连接后同步。'
      : '使用账号密码在线登录后，本机会自动准备离线访问。当前会话可能是自动续期登录；如需离线访问，请退出后用账号密码重新登录。'}</p>
    <details><summary>记住此设备七天</summary>
      <p>开启后，七天内打开本设备缓存时无需再次输入账号密码。只在个人设备上使用。</p>
      {!hasNativeSubtle() && <p>当前连接不能使用浏览器不可导出的密钥，设备授权保存在网页可读取的本机存储中；建议使用 HTTPS。</p>}
      <button disabled={busy} onClick={() => {
        setBusy(true); setNotice('');
        void rememberDevice().then(() => setNotice('已记住此设备七天。'))
          .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false));
      }}>记住此设备</button>
    </details>
    {state.info.mode !== 'member' && primaryProfile?.serverId && <ReplacementRecoveryPanel store={store} profile={primaryProfile} />}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
