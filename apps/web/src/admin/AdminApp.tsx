import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { SyncAuthMe } from '@zichan/db';
import { THEMES } from '../theme.js';
import { AdminClient, type AdminHealth } from './client.js';
import { AdminConsole } from './AdminConsole.js';
import './admin.css';
import { PasswordRecovery } from '../ui/PasswordRecovery.js';

export function AdminApp({ baseUrl }: { baseUrl: string }) {
  const clientRef = useRef<AdminClient>();
  const [account, setAccount] = useState<SyncAuthMe>();
  const [health, setHealth] = useState<AdminHealth>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState('正在检查服务器与管理会话…');
  useEffect(() => {
    let active = true;
    const previous = Object.fromEntries(Object.keys(THEMES.terracotta!).map((name) => [name, document.documentElement.style.getPropertyValue(name)]));
    for (const [name, value] of Object.entries(THEMES.terracotta!)) document.documentElement.style.setProperty(name, value);
    const client = new AdminClient(baseUrl, (note) => { if (active) { setAccount(undefined); setPassword(''); setMessage(note); } });
    clientRef.current = client;
    setBusy(true); setHealth(undefined); setMessage('正在检查服务器与管理会话…');
    void (async () => {
      try {
        const server = await client.health();
        if (!active) return;
        setHealth(server);
        const restored = server.claimed ? await client.restore() : undefined;
        if (active) { setAccount(restored); setMessage(''); }
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : String(error)); }
      finally { if (active) setBusy(false); }
    })();
    return () => {
      active = false; client.dispose();
      for (const [name, value] of Object.entries(previous)) {
        if (value) document.documentElement.style.setProperty(name, value);
        else document.documentElement.style.removeProperty(name);
      }
    };
  }, [baseUrl, attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const client = clientRef.current;
    if (!client || !health || busy) return;
    setBusy(true); setMessage('');
    try {
      const user = await client.login(username.trim(), password, !health.claimed, () => {
        setHealth((value) => value ? { ...value, claimed: true } : value);
        setMessage('管理员已创建，正在登录；若登录失败，可使用刚设置的账号重试。');
      });
      setAccount(user); setHealth((value) => value ? { ...value, claimed: true } : value); setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      // Registration may have committed even if its response was lost.
      try { setHealth(await client.health()); } catch { /* Keep the last verified state. */ }
    }
    finally { setPassword(''); setBusy(false); }
  }

  async function logout() {
    setAccount(undefined); setBusy(true); setMessage('');
    try { await clientRef.current?.logout(); }
    catch { setMessage('本页已退出，但服务器撤销未确认。请联网后重新登录并退出，以确认撤销。'); }
    finally { setBusy(false); }
  }

  return <main className="zc-admin-root" style={{ ...THEMES.terracotta, height: '100dvh', overflowY: 'auto', background: 'var(--bg)', color: 'var(--text-primary)', padding: 'clamp(16px, 4vw, 48px)', boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif' } as CSSProperties}>
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <div><div style={{ color: 'var(--accent)', fontWeight: 'var(--fw-bold)' }}>ZICHAN · SERVER ADMIN</div><h1>服务器管理后台</h1><p style={{ overflowWrap: 'anywhere' }}>{baseUrl}</p></div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><a href={`${baseUrl}/app/`}>打开记账应用</a>{account && <><span>{account.username} · {account.role === 'owner' ? '所有者' : '管理员'}</span><button onClick={() => void logout()}>退出管理后台</button></>}</div>
      </header>
      {message && <p role="alert" style={{ padding: 14, background: 'var(--surface)', border: '1px solid var(--negative)', borderRadius: 'var(--r-sm)' }}>{message}</p>}
      {account && clientRef.current ? <AdminConsole key={`${account.accountId}:${account.session.id}`} client={clientRef.current} account={account} /> : <section style={{ maxWidth: 580, margin: '24px auto', padding: 24, borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <h2>{!health ? '尚未连接管理服务器' : !health.claimed ? '初始化服务器所有者' : '管理员登录'}</h2>
        {!health && !busy && <p>请确认后端服务已启动。仅启动 5173 前端页面不能创建服务器账号。</p>}
        {!busy && message && <button onClick={() => { setPassword(''); setAttempt((value) => value + 1); }}>重新连接服务器</button>}
        <form onSubmit={(event) => void submit(event)} style={{ display: 'grid', gap: 16 }}>
          <label>用户名<input className="zc-input" aria-label="管理账号用户名" autoComplete="username" required minLength={3} value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>账号密码<input className="zc-input" aria-label="管理账号密码" type="password" autoComplete={health?.claimed ? 'current-password' : 'new-password'} required minLength={8} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
          {health && !health.claimed && <p>首次使用：设置管理员用户名和密码即可。创建成功后，此页面将只提供登录，不会创建个人账本。</p>}
          <button disabled={busy || !health} type="submit">{busy ? '处理中…' : !health ? '等待服务器连接' : health.claimed ? '登录管理后台' : '创建所有者并进入后台'}</button>
        </form>
        {health?.claimed && <PasswordRecovery baseUrl={baseUrl} onComplete={setUsername} />}
        <section aria-label="管理后台权限与存储说明" style={{ marginTop: 24, lineHeight: 1.8 }}>
          <strong>登录会使用什么权限？</strong>
          <p>仅验证服务器管理身份，不创建或解锁个人账本，不申请账本持久存储或磁盘文件访问权限。</p>
          <p>使用独立的 HttpOnly 管理会话 Cookie，不与记账登录互相覆盖。账号密码不写入应用存储，访问令牌仅在内存中；此后台不提供“记住设备”。</p>
          <p>管理角色可管理账号、设备和容量。托管账本由服务器保管解密凭据；私密账本的恢复码由用户保管，管理后台不提供查看密钥的入口。</p>
        </section>
      </section>}
    </div>
  </main>;
}
