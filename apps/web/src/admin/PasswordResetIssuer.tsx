import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { message } from './ui.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';

export function PasswordResetIssuer({ client, accountId, username, onDone }: { client: AdminClient; accountId: string; username: string; onDone?: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [issued, setIssued] = useState<{ code: string; expiresAt: string }>();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!issued) return;
    const expire = () => {
      if (Date.parse(issued.expiresAt) <= Date.now()) { setIssued(undefined); setExpired(true); }
    };
    const timer = window.setTimeout(expire, Math.max(0, Date.parse(issued.expiresAt) - Date.now()));
    // Background tabs may throttle timers; recheck when they become visible.
    document.addEventListener('visibilitychange', expire);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', expire); };
  }, [issued]);
  return <section aria-label="账号密码恢复" style={{ marginTop: 16 }}><h4>账号密码恢复</h4>
    <label><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />我已通过可信渠道核实 {username} 的身份和恢复请求</label>
    <button disabled={!reviewed || busy} onClick={() => setConfirm(true)}>发放一次性重置码</button>
    {confirm && <ConfirmDialog title={`为 ${username} 发放重置码`} confirmLabel="确认发放" onCancel={() => setConfirm(false)} onConfirm={async () => {
      const result = await client.request<{ code: string; expiresAt: string }>(`/accounts/${accountId}/password-reset`, {}, { idempotencyKey: adminIdempotencyKey(`password-reset-issue-${accountId}`) });
      setIssued(result); setExpired(false); setConfirm(false); setReviewed(false);
    }}><p>有效期 15 分钟，仅可使用一次。重新发放会使旧码失效。请私下交给已核实的用户；密码重置成功后将撤销该账号所有旧会话，账本密码不变。</p></ConfirmDialog>}
    {issued && <div><label>本次重置码<textarea aria-label="本次重置码" readOnly value={issued.code} onFocus={(event) => event.target.select()} /></label><p>到期：{new Date(issued.expiresAt).toLocaleString()}。离开此详情后不再显示。</p><button onClick={() => setIssued(undefined)}>隐藏重置码</button></div>}
    {expired && <p role="status">重置码已到期并自动隐藏。如仍需恢复，请重新核实身份后发放。</p>}
    <p><button disabled={busy} onClick={() => { void revokeUnusedCode(); }}>撤销未使用的重置码</button></p>
    {revokeError ? <p role="alert" style={{ color: 'var(--negative)' }}>撤销失败：{revokeError}</p> : null}
  </section>;

  async function revokeUnusedCode(): Promise<void> {
    setBusy(true); setRevokeError('');
    try {
      await client.request(`/accounts/${accountId}/password-reset/revoke`, {}, { idempotencyKey: adminIdempotencyKey(`password-reset-revoke-${accountId}`) });
      setIssued(undefined); setExpired(false); onDone?.();
    } catch (error) {
      // The code stays valid on the server, so the page must not claim it is gone.
      setRevokeError(message(error));
    } finally { setBusy(false); }
  }
}
