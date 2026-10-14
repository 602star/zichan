import { useState } from 'react';
import { registerAccount } from '@zichan/db';

export function PasswordRecovery({ baseUrl, onComplete }: { baseUrl: string; onComplete: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [notice, setNotice] = useState('');
  return <details style={{ marginTop: 20 }}><summary>忘记账号密码</summary>
    <p>可向已验证邮箱发送重置码，或联系管理员核实身份后取得一次性重置码。两种方式修改同一个账号密码；在附属节点登录的统一账号，请到创建账号的身份源网站申请找回。</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      if (password.length < 8 || password !== confirmation) { setNotice('新密码至少 8 位，且两次输入必须一致。'); return; }
      setBusy(true); setNotice('正在重置账号密码…');
      void (async () => {
        try {
          const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store', redirect: 'error' });
          if (!response.ok) throw new Error('服务器检查失败，请稍后重试。');
          const health = await response.json();
          if (!health.serverId || !health.serverPublicKey || !health.capabilities?.includes('password-reset-v1')) throw new Error('服务器尚未支持账号密码重置，请联系部署者更新。');
          await registerAccount(baseUrl, username.trim(), password, { passwordResetCode: code.trim(), expectedServerId: health.serverId, expectedServerPublicKey: health.serverPublicKey });
          setCode(''); setNotice('账号密码已重置，旧登录会话已撤销。请使用新密码登录。');
          onComplete(username.trim());
        } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
        finally { setPassword(''); setConfirmation(''); setBusy(false); }
      })();
    }} style={{ display: 'grid', gap: 10 }}>
      <label>账号用户名<input aria-label="找回账号用户名" required autoComplete="username" value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} /></label>
      <button type="button" disabled={busy || emailBusy || username.trim().length < 2} onClick={() => {
        setEmailBusy(true); setNotice('正在申请邮件重置码…');
        void fetch(`${baseUrl}/api/auth/password-reset/email/request`, {
          method: 'POST', cache: 'no-store', redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.trim() }),
        }).then(async (response) => {
          const body = await response.json() as { message?: string; error?: string };
          if (!response.ok) throw new Error(body.error ?? `请求失败（HTTP ${response.status}）`);
          setNotice(body.message ?? '如果该账号已验证邮箱，重置码会发送到邮箱。');
        }).catch((reason) => setNotice(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setEmailBusy(false));
      }}>{emailBusy ? '发送中…' : '发送到已验证邮箱'}</button>
      <label>一次性重置码<input aria-label="一次性重置码" type="password" required autoComplete="off" value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} /></label>
      <label>新账号密码<input aria-label="新账号密码" type="password" required minLength={8} autoComplete="new-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
      <label>确认新账号密码<input aria-label="确认新账号密码" type="password" required minLength={8} autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <button disabled={busy} type="submit">{busy ? '重置中…' : '重置账号密码'}</button>
    </form>{notice && <p role="status">{notice}</p>}
  </details>;
}
