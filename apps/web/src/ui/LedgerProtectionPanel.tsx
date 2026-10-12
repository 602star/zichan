import { useEffect, useState } from 'react';
import { hasNativeSubtle } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import { accountProtection, PROTECTION_CHANGED, randomRecoveryCode } from '../account-protection.js';
import { changeAccountProtection } from '../change-protection.js';
import { enableOfflinePassword, forgetOfflineAccess, rememberDevice } from '../offline-access.js';
import { loadSyncConnections } from '../sync-config.js';
import { ReplacementRecoveryPanel } from './ReplacementRecoveryPanel.js';

export function LedgerProtectionPanel({ store }: { store: SqlLedgerStore }) {
  const [state, setState] = useState(accountProtection);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);
  const [nextMode, setNextMode] = useState<'managed' | 'private'>();
  const [nextSecret, setNextSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    const update = () => { setState(accountProtection()); setShowRecovery(false); };
    window.addEventListener(PROTECTION_CHANGED, update);
    return () => window.removeEventListener(PROTECTION_CHANGED, update);
  }, []);
  if (!state) return null;
  const nativeDeviceKey = hasNativeSubtle();
  async function run(action: () => Promise<void>, message: string) {
    if (busy) return; setBusy(true); setNotice('');
    try { await action(); setNotice(message); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  if (state.info.mode === 'member') return <section className="zc-protection" style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 'var(--r-md)', marginBottom: 16 }} aria-label="账本保护">
    <h2 style={{ fontSize: 'var(--fs-title)' }}>账本保护 · 成员密钥</h2>
    <p>此账号通过自己的加密密钥包解锁账本。账本所有者管理成员及密钥代次；此设备可以另外设置离线访问。</p>
    <details><summary>此设备的离线访问</summary>
      <p>记住设备后，本浏览器可在七天内解锁已有缓存；成员被移除后，重新联网将无法继续同步。</p>
      {!nativeDeviceKey && <p>当前网页无法使用浏览器的不可导出密钥。记住设备会把解锁材料保存在网页可读取的本地存储，保护强度低于 HTTPS；建议使用可信 HTTPS 或设置离线密码。</p>}
      <button disabled={busy} onClick={() => void run(rememberDevice, '已记住此设备七天。')}>记住此设备七天</button>
      <p>也可设置独立的离线密码：</p>
      <input aria-label="设置离线密码" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少八个字符" />
      <input aria-label="确认离线密码" type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="再次输入" />
      <button disabled={busy || password.length < 8 || password !== confirmation} onClick={() => void run(async () => { await enableOfflinePassword(password); setPassword(''); setConfirmation(''); }, '离线密码已设置。')}>设置离线密码</button>
      <p><button disabled={busy} onClick={() => void run(forgetOfflineAccess, '已关闭此设备的离线解锁授权。')}>关闭离线访问</button></p>
    </details>
    {notice && <p role="status">{notice}</p>}
  </section>;
  const managed = state.info.mode === 'managed';
  const primaryProfile = loadSyncConnections().find((row) => row.id === state.profileId);
  return <section className="zc-protection" style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 'var(--r-md)', marginBottom: 16 }} aria-label="账本保护">
    <h2 style={{ fontSize: 'var(--fs-title)' }}>账本保护 · {managed ? '云端托管' : '私密模式'}</h2>
    <p>{managed ? '获授权的同步节点会各自托管此账本密钥，均可解密账本。登录这些节点后可打开账本；找回账号密码后，待新凭据同步到节点即可重新登录。' : '恢复码由你保管，服务器只保存密文。账号密码找回不会恢复解密能力；过去曾被托管的历史数据不具有追溯保密性。'}</p>
    {state.secretKind === 'password' ? <p>当前使用账号密码解锁。恢复码只在创建或用恢复码重新解锁时显示；请保管创建时保存的恢复码。</p>
      : <><button disabled={busy} onClick={() => setShowRecovery(!showRecovery)}>{showRecovery ? '隐藏恢复码' : '查看备份恢复码'}</button>
        {showRecovery && <><p>保存在本设备以外，可在服务器不可用时解锁导出的加密备份。此恢复码能解密账本，请妥善保存。</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{state.secret}</pre></>}</>}
    {state.info.controlled ? <p>此账本已启用成员密钥。请在成员管理中轮换密钥；旧保护接口不能再更改此账本的密钥。</p>
      : <details style={{ marginTop: 16 }}><summary>高级：更改保护方式</summary>
      <p>更改前自动保存保护备份，其他设备需要重新登录。切到私密模式会轮换数据、附件与备份密钥，已有历史副本仍可能被原托管方读取。</p>
      <button disabled={busy || !managed && !state.info.custodyEnabled} onClick={() => { setNextMode(managed ? 'private' : 'managed'); setNextSecret(randomRecoveryCode()); setConfirmed(false); }}>准备切换到{managed ? '私密模式' : '云端托管'}</button>
      {nextMode && <div><p>{nextMode === 'private' ? '请先保存新恢复码：' : '将允许主服务器解密此账本，并提供账号恢复。'}</p>
        {nextMode === 'private' && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{nextSecret}</pre>}
        <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />{nextMode === 'private' ? '我已保存新恢复码，并理解历史数据仍可能被原托管方读取' : '允许此服务器解密账本'}</label>
        <p><button disabled={busy || !confirmed} onClick={() => void run(async () => {
          await changeAccountProtection(store, nextMode, nextSecret); setNextMode(undefined); setNextSecret('');
        }, '保护方式已更新，其他设备需重新登录。请重新设置离线访问。')}>确认更改保护方式</button></p>
      </div>}
    </details>}
    <details style={{ marginTop: 16 }}><summary>此设备的离线访问</summary>
      <p>默认在线登录解锁。记住设备后，本浏览器可在七天内自动解锁已有缓存；仅在自己的设备上开启。主动退出会清除授权，浏览器清理数据也会使授权失效。</p>
      {!nativeDeviceKey && <p>当前网页无法使用浏览器的不可导出密钥。记住设备会把解锁材料保存在网页可读取的本地存储，保护强度低于 HTTPS；建议使用可信 HTTPS 或设置离线密码。</p>}
      <button disabled={busy} onClick={() => void run(rememberDevice, '已记住此设备七天。')}>记住此设备七天</button>
      <p>也可设置独立的离线密码：</p>
      <input aria-label="设置离线密码" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少八个字符" />
      <input aria-label="确认离线密码" type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="再次输入" />
      <button disabled={busy || password.length < 8 || password !== confirmation} onClick={() => void run(async () => { await enableOfflinePassword(password); setPassword(''); setConfirmation(''); }, '离线密码已设置。')}>设置离线密码</button>
      <p><button disabled={busy} onClick={() => void run(forgetOfflineAccess, '已关闭此设备的离线解锁授权。')}>关闭离线访问</button></p>
    </details>
    {!state.info.controlled && primaryProfile?.serverId && <ReplacementRecoveryPanel
      store={store} profile={primaryProfile} />}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
