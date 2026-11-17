import { useCallback, useEffect, useState } from 'react';
import { requestJson } from '@zichan/db';
import { accountProtection } from '../account-protection.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';
import { ConfirmDialog } from './ConfirmDialog.js';
interface EmailState {
  federated?: boolean;
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

  if (state?.federated) return <section className="zc-card" aria-label="邮箱与通知">
    <h2 className="zc-section-title">邮箱与通知</h2>
    <p className="zc-caption">统一账号的邮箱由创建账号的身份源节点管理，请在该节点的网站验证或更换邮箱。本站不单独设置找回邮箱。</p>
  </section>;

  return <section className="zc-card" aria-label="邮箱与通知">
    <h2 className="zc-section-title">邮箱与通知</h2>
    <p className="zc-caption">绑定后可使用邮箱和账号密码登录，无需先验证邮箱。验证后才能通过邮件找回密码或接收提醒。</p>
    {state ? state.email ? <p style={{ overflowWrap: 'anywhere' }}>已绑定邮箱：<strong>{state.email}</strong>（{state.verifiedAt ? '已验证' : '未验证'}）</p> : <p>尚未绑定邮箱。</p> : <p>正在读取邮箱设置…</p>}
    {state?.pendingEmail && <p style={{ overflowWrap: 'anywhere' }}>待验证邮箱：<strong>{state.pendingEmail}</strong>。请输入邮件中的 8 位验证码。</p>}
    {state && !state.available && <p className="zc-caption">当前未开启邮件发送，仍可绑定邮箱并登录；邮箱验证、邮件找回和提醒暂不可用。</p>}
    {state?.email && !state.verifiedAt && state.available && <button type="button" className="zc-btn" disabled={busy} onClick={() => void run(async () => {
      await api('/request', 'POST', { email: state.email });
      await refresh(); setNotice('验证码已发送，有效期 10 分钟。');
    })}>{state.pendingEmail ? '重新发送验证码' : '发送验证邮件'}</button>}
    {state?.pendingEmail && <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      await api('/verify', 'POST', { code: code.trim() });
      await refresh(); setCode(''); setDraft(''); setNotice('邮箱验证成功。');
    }); }} style={{ display: 'grid', gap: 10, maxWidth: 420, marginTop: 12 }}>
      <label>邮箱验证码<input className="zc-input" aria-label="邮箱验证码" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} value={code} onChange={(event) => setCode(event.target.value)} required disabled={busy} placeholder="8 位验证码" /></label>
      <button type="submit" className="zc-btn zc-btn--primary" disabled={busy || !/^\d{8}$/.test(code)}>验证邮箱</button>
    </form>}
    {state && <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      await api('', 'PUT', { email: draft.trim() });
      await refresh(); setDraft(''); setCode(''); setNotice('邮箱已绑定，可使用此邮箱和账号密码登录。');
    }); }} style={{ display: 'grid', gap: 10, maxWidth: 420, marginTop: state.email ? 16 : 0 }}>
      <label>{state.email ? '更换邮箱' : '绑定邮箱'}<input className="zc-input" aria-label="邮箱地址" type="email" autoComplete="email" maxLength={254} value={draft} onChange={(event) => setDraft(event.target.value)} required disabled={busy} placeholder="name@example.com" /></label>
      {state.email && <small className="zc-caption">更换后旧邮箱立即停止用于登录，新邮箱需要重新验证；邮件提醒将关闭。</small>}
      <button type="submit" className="zc-btn zc-btn--primary" disabled={busy || !draft.trim()}>{busy ? '处理中…' : state.email ? '更换绑定邮箱' : '绑定邮箱'}</button>
    </form>}
    {state?.verifiedAt && <div style={{ marginTop: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={state.quotaNotifications} disabled={busy} onChange={(event) => void run(async () => {
        await api('/preferences', 'PUT', { quotaNotifications: event.target.checked });
        await refresh(); setNotice('通知偏好已保存。');
      })} />配额接近上限时发送邮件提醒</label>
      <p className="zc-caption">{quotaUnlimited ? '当前账号无限配额，不会触发容量提醒；角色变更后，已保存的偏好会生效。' : '默认关闭。服务器在用量达到告警阈值时提醒一次；恢复后再次达到阈值才会重新提醒。'}</p>
    </div>}
    {(state?.email || state?.pendingEmail) && <button type="button" className="zc-btn" style={{ marginTop: 16 }} disabled={busy} onClick={() => setRemoveOpen(true)}>移除邮箱</button>}
    {removeOpen && <ConfirmDialog title="移除邮箱" confirmLabel="确认移除" onCancel={() => setRemoveOpen(false)} onConfirm={async () => { if (await run(async () => { await api('', 'DELETE'); await refresh(); setCode(''); setNotice('邮箱已移除，请使用原登录账号登录。'); })) setRemoveOpen(false); }}><p>移除后，此邮箱将无法用于登录、邮件找回和提醒。仍可使用原登录账号和密码登录。</p></ConfirmDialog>}
    {notice && <p role="status">{notice}</p>}
    {!state && notice && <button type="button" className="zc-btn" disabled={busy} onClick={() => void run(async () => { await refresh(); })}>重试读取邮箱设置</button>}
  </section>;
}
