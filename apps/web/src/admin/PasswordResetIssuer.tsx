import { useState } from 'react';
import type { AdminClient } from './client.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';

export function PasswordResetIssuer({ client, accountId, username }: { client: AdminClient; accountId: string; username: string }) {
  const [confirm, setConfirm] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [issued, setIssued] = useState<{ code: string; expiresAt: string }>();
  return <section aria-label="账号密码恢复" style={{ marginTop: 16 }}><h4>账号密码恢复</h4>
    <label><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />我已通过可信渠道核实 {username} 的身份和恢复请求</label>
    <button disabled={!reviewed} onClick={() => setConfirm(true)}>发放一次性重置码</button>
    {confirm && <ConfirmDialog title={`为 ${username} 发放重置码`} confirmLabel="确认发放" onCancel={() => setConfirm(false)} onConfirm={async () => {
      const result = await client.request<{ code: string; expiresAt: string }>(`/accounts/${accountId}/password-reset`, {});
      setIssued(result); setConfirm(false); setReviewed(false);
    }}><p>有效期 15 分钟，仅可使用一次。重新发放会使旧码失效。请私下交给已核实的用户；密码重置成功后将撤销该账号所有旧会话，账本密码不变。</p></ConfirmDialog>}
    {issued && <div><label>本次重置码<textarea aria-label="本次重置码" readOnly value={issued.code} onFocus={(event) => event.target.select()} /></label><p>到期：{new Date(issued.expiresAt).toLocaleString()}。离开此详情后不再显示。</p><button onClick={() => setIssued(undefined)}>隐藏重置码</button></div>}
  </section>;
}
