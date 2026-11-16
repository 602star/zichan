import { useEffect, useState } from 'react';
import { hasNativeSubtle } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import { accountProtection, PROTECTION_CHANGED } from '../account-protection.js';
import { hasOfflinePassword, rememberDevice } from '../offline-access.js';
import { loadSyncConnections } from '../sync-config.js';
import { isTauriRuntime } from '../tauri.js';
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
    <p>账本密钥由获授权的同步服务器托管。联网且登录状态有效时，可直接打开账本，无需开启下方的离线免密。</p>
    <p>{hasOfflinePassword()
      ? '本机离线访问已准备好。断网或服务器暂时不可用时，重新打开账本可用账号密码解锁本设备已有的缓存；离线新增的记录会在恢复连接后同步。'
      : '使用账号密码在线登录后，本机会自动准备离线访问。当前会话可能是自动续期登录；如需离线访问，请退出后用账号密码重新登录。'}</p>
    <details><summary>离线打开时免输密码（7 天）</summary>
      <p>开启后，7 天内离线打开本设备已有的账本时，无需输入账号密码；到期后仍可用账号密码打开。本选项不影响联网登录的有效期。</p>
      <p>请只在个人设备上开启。退出账号会清除本机的离线免密授权。</p>
      {isTauriRuntime() && <p>如已开启指纹、人脸或设备密码应用锁，离线免密不会跳过应用锁验证。</p>}
      {!hasNativeSubtle() && <p>当前连接不能使用浏览器不可导出的密钥，设备授权保存在网页可读取的本机存储中；建议使用 HTTPS。</p>}
      <button disabled={busy} onClick={() => {
        setBusy(true); setNotice('');
        void rememberDevice().then(() => setNotice('已开启离线免密，7 天内离线打开本设备账本无需输入账号密码。'))
          .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false));
      }}>{busy ? '正在开启…' : '开启 7 天离线免密'}</button>
    </details>
    {primaryProfile?.serverId && <ReplacementRecoveryPanel store={store} profile={primaryProfile} />}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
