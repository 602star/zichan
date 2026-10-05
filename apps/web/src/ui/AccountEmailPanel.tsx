import { useCallback, useEffect, useState } from 'react';
import { requestJson } from '@zichan/db';
import { accountProtection } from '../account-protection.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { btnOutline } from './styles.js';

interface EmailState {
  email?: string;
  verifiedAt?: string;
  pendingEmail?: string;
  quotaNotifications: boolean;
  available: boolean;
}

export function AccountEmailPanel({ quotaUnlimited = false }: { quotaUnlimited?: boolean }) {
  const profileId = accountProtection()?.profileId;
  const profile = loadSyncConnections().find((row) => row.id === profileId);
  const [state, setState] = useState<EmailState>();
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);

  const api = useCallback(async (path = '', method = 'GET', body?: object) => {
    const selected = loadSyncConnections().find((row) => row.id === profileId);
    if (!selected) throw new Error('当前没有服务器账号');
    const token = await authenticateSyncProfile(selected);
    const response = await requestJson(`${buildSyncBaseUrl(selected)}/api/auth/email${path}`, {
      method, cache: 'no-store', redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json() as EmailState & { error?: string };
    if (!response.ok) throw new Error(result.error || `邮箱操作失败（HTTP ${response.status}）`);
    return result;
  }, [profileId]);

  const refresh = useCallback(async () => {
    const next = await api();
    setState(next);
    return next;
  }, [api]);

  useEffect(() => {
    if (!profileId) return;
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [profileId, refresh]);

  if (!profile) return null;
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setNotice('');
    try { await action(); return true; }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  }

  return <section className="zc-card" aria-label="邮箱与通知">
    <h2 className="zc-section-title">邮箱与通知</h2>
    <p className="zc-caption">邮箱可选。验证成功后才能接收提醒；邮件不包含账本明细、金额或附件内容。</p>
    {state?.email ? <p>已验证邮箱：<strong>{state.email}</strong></p> : <p>尚未绑定邮箱。</p>}
    {state?.pendingEmail && <p>待验证邮箱：<strong>{state.pendingEmail}</strong>。请输入邮件中的 8 位验证码。</p>}
    {state && !state.available && <p className="zc-caption">服务器尚未配置邮件发送渠道，请联系服务器管理员。</p>}
    {state?.available && <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      await api('/request', 'POST', { email: draft.trim() });
      await refresh(); setNotice('验证码已发送，有效期 10 分钟。');
    }); }} style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
      <label>{state.email ? '更换邮箱' : '添加邮箱'}<input className="zc-input" aria-label="邮箱地址" type="email" autoComplete="email" value={draft} onChange={(event) => setDraft(event.target.value)} required disabled={busy} placeholder="name@example.com" /></label>
      <button type="submit" disabled={busy || !draft.trim()}>{busy ? '处理中…' : '发送验证码'}</button>
    </form>}
    {state?.pendingEmail && <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      await api('/verify', 'POST', { code: code.trim() });
      await refresh(); setCode(''); setDraft(''); setNotice('邮箱验证成功。');
    }); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
      <input className="zc-input" aria-label="邮箱验证码" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} value={code} onChange={(event) => setCode(event.target.value)} required disabled={busy} placeholder="8 位验证码" />
      <button type="submit" disabled={busy || !/^\d{8}$/.test(code)}>验证邮箱</button>
    </form>}
    {state?.verifiedAt && <div style={{ marginTop: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={state.quotaNotifications} disabled={busy} onChange={(event) => void run(async () => {
        await api('/preferences', 'PUT', { quotaNotifications: event.target.checked });
        await refresh(); setNotice('通知偏好已保存。');
      })} />配额接近上限时发送邮件提醒</label>
      <p className="zc-caption">{quotaUnlimited ? '当前账号无限配额，不会触发容量提醒；角色变更后，已保存的偏好会生效。' : '默认关闭。服务器在用量达到告警阈值时提醒一次；恢复后再次达到阈值才会重新提醒。'}</p>
      <button type="button" style={btnOutline} disabled={busy} onClick={() => setRemoveOpen(true)}>移除邮箱</button>
    </div>}
    {removeOpen && <ConfirmDialog title="移除邮箱" confirmLabel="确认移除" onCancel={() => setRemoveOpen(false)} onConfirm={async () => { if (await run(async () => { await api('', 'DELETE'); await refresh(); setNotice('邮箱已移除，邮件提醒已关闭。'); })) setRemoveOpen(false); }}><p>移除后将停止发送提醒。再次使用需要重新验证邮箱。</p></ConfirmDialog>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
