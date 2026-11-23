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
    <p>账本密钥由获授权的同步服务器托管。{isTauriRuntime() ? '联网且登录有效时可直接打开；离线免密可在下方开启。'
      : '成功打开后，本机会在后台准备 7 天快速打开授权；下次优先打开本机加密账本，同时在后台验证登录和同步。'}</p>
    <p>{hasOfflinePassword()
      ? '本机离线访问已准备好。断网或服务器暂时不可用时，重新打开账本可用账号密码解锁本设备已有的缓存；离线新增的记录会在恢复连接后同步。'
      : '使用账号密码在线登录后，本机会自动准备离线访问。当前会话可能是自动续期登录；如需离线访问，请退出后用账号密码重新登录。'}</p>
    <details><summary>本机快速打开授权（7 天）</summary>
      <p>{isTauriRuntime() ? '开启后，7 天内离线打开本机账本免输密码。' : '网页版在线成功打开后自动准备，也可以在这里续期。7 天内打开本设备已有账本无需等待网络验证。'}到期后需要在线解锁或使用已准备的离线密码。服务器登录失效时暂停同步，本机记录继续保留。</p>
      <p>共用设备使用结束后请退出账号，退出会清除本机的快速打开授权。</p>
      {isTauriRuntime() && <p>如已开启指纹、人脸或设备密码应用锁，离线免密不会跳过应用锁验证。</p>}
      {!hasNativeSubtle() && <p>当前连接不能使用浏览器不可导出的密钥，设备授权保存在网页可读取的本机存储中；建议使用 HTTPS。</p>}
      <button disabled={busy} onClick={() => {
        setBusy(true); setNotice('');
        void rememberDevice().then(() => setNotice('本机快速打开授权已续期，7 天内无需等待网络验证即可打开缓存。'))
          .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false));
      }}>{busy ? '正在续期…' : '续期 7 天快速打开授权'}</button>
    </details>
    {primaryProfile?.serverId && <ReplacementRecoveryPanel store={store} profile={primaryProfile} />}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
