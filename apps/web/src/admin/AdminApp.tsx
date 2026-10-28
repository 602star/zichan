import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, Bell, ExternalLink, HardDrive, LayoutDashboard, ListTodo, LogOut, Menu, Monitor, RefreshCw, ScrollText, Settings, ShieldCheck, Ticket, Users, X, type LucideIcon } from 'lucide-react';
import { MfaRequiredError, type SyncAuthMe } from '@zichan/db';
import {
  appearanceTokens,
  applyBrowserChrome,
  applyThemeTokens,
  readAppearancePreference,
  resolveThemeMode,
  subscribeSystemMode,
  systemPrefersDark,
} from '../appearance.js';
import { AdminClient, type AdminHealth } from './client.js';
import { adminBasePath, adminHref, navigate as navigateRoute, useRoute } from './router.js';
import { AuditPage, LogsPage } from './LogsPage.js';
import { AlertsPage } from './AlertsPage.js';
import { SecurityEventsPage } from './SecurityEventsPage.js';
import { InvitesPage } from './InvitesPage.js';
import { JobsPage } from './JobsPage.js';
import { OverviewPage } from './OverviewPage.js';
import { MonitorPage } from './MonitorPage.js';
import { ResourcesPage } from './ResourcesPage.js';
import { SessionsPage } from './SessionsPage.js';
import { SettingsPage } from './SettingsPage.js';
import { SecurityPage } from './SecurityPage.js';
import { StoragePage } from './StoragePage.js';
import { SyncPage } from './SyncPage.js';
import { UserDetailPage } from './UserDetailPage.js';
import { PreviewPage } from './PreviewPage.js';
import { UsersPage } from './UsersPage.js';
import './admin.css';
import { PasswordRecovery } from '../ui/PasswordRecovery.js';
import { useBodyScrollLock } from '../ui/body-scroll-lock.js';
import { Breadcrumbs, isPlainPrimaryClick, roleLabel } from './ui.js';
import { adminNavigation } from './navigation.js';

const navigationIcons: Record<string, LucideIcon> = {
  '/overview': LayoutDashboard,
  '/users': Users,
  '/sessions': Monitor,
  '/invites': Ticket,
  '/storage': HardDrive,
  '/monitor': Activity,
  '/sync': RefreshCw,
  '/jobs': ListTodo,
  '/alerts': Bell,
  '/logs': ScrollText,
  '/audit': ShieldCheck,
  '/security-events': ShieldCheck,
  '/settings': Settings,
};

export function AdminApp({ baseUrl }: { baseUrl: string }) {
  const route = useRoute();
  const clientRef = useRef<AdminClient>();
  const [account, setAccount] = useState<SyncAuthMe>();
  const [health, setHealth] = useState<AdminHealth>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // Present only between a password that needs a code and the code that finishes the login.
  const [mfaChallenge, setMfaChallenge] = useState<{ expiresAt: string }>();
  const [mfaCode, setMfaCode] = useState('');
  const [message, setMessage] = useState('正在检查服务器与管理会话…');
  // The same device preference the ledger app uses, so the two surfaces agree and
  // an operator who picked a dark screen does not get a cream console.
  const [appearance] = useState(readAppearancePreference);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const themeMode = resolveThemeMode(appearance.mode, prefersDark);
  useEffect(() => subscribeSystemMode(() => setPrefersDark(systemPrefersDark())), []);
  useEffect(() => {
    // The management console uses the same sage palette as the green ledger theme.
    // Keep the device's light/dark preference while giving the console a stable identity.
    const tokens = appearanceTokens('sage', themeMode);
    const restore = applyThemeTokens(document.documentElement, tokens, themeMode);
    applyBrowserChrome(tokens);
    return restore;
  }, [themeMode]);
  useEffect(() => {
    let active = true;
    const client = new AdminClient(baseUrl, (note) => { if (active) { setAccount(undefined); setPassword(''); setMfaChallenge(undefined); setMfaCode(''); setMessage(note); } });
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
      // The password was right but the account owes a code: switch the same card to its second
      // state instead of reporting a login failure.
      const challenge = client.pendingChallenge();
      if (error instanceof MfaRequiredError && challenge) {
        setMfaChallenge(challenge); setMfaCode('');
        setMessage('账号密码已验证，请输入验证书中的 6 位验证码或一枚一次性恢复码。');
      } else {
        setMessage(error instanceof Error ? error.message : String(error));
        // Registration may have committed even if its response was lost.
        try { setHealth(await client.health()); } catch { /* Keep the last verified state. */ }
      }
    }
    finally { setPassword(''); setBusy(false); }
  }

  /** Answers the pending challenge. A wrong code keeps the challenge: only expiry forces a retry. */
  async function submitMfa(event: FormEvent) {
    event.preventDefault();
    const client = clientRef.current;
    if (!client || busy || !mfaCode.trim()) return;
    setBusy(true); setMessage('');
    try {
      const user = await client.completeMfa(mfaCode.trim());
      setAccount(user); setMfaChallenge(undefined); setMfaCode(''); setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      if (!client.pendingChallenge()) { setMfaChallenge(undefined); setMfaCode(''); }
    }
    finally { setBusy(false); }
  }

  /**
   * The session is already dead server-side (the password change revoked it), so this only
   * clears the console and explains what happened. Calling `logout` would revoke nothing and
   * could fail on the dead token, replacing a clear message with a confusing one; rebuilding the
   * client instead would wipe the explanation, because the effect resets the message while it
   * reconnects. The client is left in place and is already usable for the next login: the
   * password change cleared its session, and its own state is what the login form needs.
   */
  function signOutWithNote(note: string): void {
    setAccount(undefined); setPassword(''); setMfaChallenge(undefined); setMfaCode('');
    setMessage(note);
  }

  async function logout() {
    setAccount(undefined); setBusy(true); setMessage('');
    try { await clientRef.current?.logout(); }
    catch { setMessage('本页已退出，但服务器撤销未确认。请联网后重新登录并退出，以确认撤销。'); }
    finally { setBusy(false); }
  }

  /**
   * A preview is not a console tab: it shows one account's ledger through the ordinary ledger
   * UI, so it replaces the console chrome entirely rather than sitting inside it. Nesting it
   * would put two headers and two navigation systems on one screen and leave the operator
   * unsure which layer they are looking at — the exact confusion the preview banner exists to
   * prevent. It is dispatched here, above the console's own header, for that reason.
   *
   * The target travels in the query rather than as a second path segment. The bundle is built
   * with relative asset paths, so a URL one level deeper (`…/preview/<user>`) resolves
   * `./assets/...` against that extra segment and 404s on any hard reload or shared link. Every
   * other console page that carries state (the user list's filters, the sync page's account)
   * uses a query for the same reason.
   */
  if (account && clientRef.current) {
    const previewTarget = route.segments[0] === 'preview' ? route.query.get('username') ?? '' : '';
    if (previewTarget) {
      return (
        <PreviewPage
          client={clientRef.current}
          username={previewTarget}
          operator={account.username}
          navigate={(to) => navigateRoute(adminHref(adminBasePath(window.location), to))}
        />
      );
    }
  }

  return <main className="zc-admin-root" data-mode={themeMode}>
    <div className="zc-admin-frame">
      <header className="zc-admin-topbar" data-authenticated={Boolean(account)}>
        <div className="zc-admin-brand">
          <span className="zc-admin-brand-mark" aria-hidden="true">资</span>
          <div className="zc-admin-brand-copy">
            <h1>资产生命周期</h1>
            <span>服务器管理</span>
          </div>
        </div>
        <div className="zc-admin-topbar-actions">
          {health ? <span className="zc-admin-connection" title={`服务器 ${health.serverId}`}><span aria-hidden="true" />{health.claimed ? '管理服务已连接' : '等待初始化'}</span> : null}
          <a className="zc-admin-app-link" href={`${baseUrl}/app/`}>打开记账应用</a>
          {account ? (
            <>
              <span className="zc-admin-operator"><strong>{account.username}</strong><small>{roleLabel(account.role)}</small></span>
              <a className="zc-admin-security-link" href={adminHref(adminBasePath(window.location), '/security')} onClick={(event) => { if (!isPlainPrimaryClick(event)) return; event.preventDefault(); navigateRoute(adminHref(adminBasePath(window.location), '/security')); }}>账号安全</a>
              <button className="zc-admin-logout" onClick={() => void logout()}><LogOut size={16} aria-hidden="true" />退出</button>
            </>
          ) : null}
        </div>
      </header>
      {message && <p role="alert" style={{ padding: 14, background: 'var(--surface)', border: '1px solid var(--negative)', borderRadius: 'var(--r-sm)' }}>{message}</p>}
      {account && clientRef.current
        ? <AdminShell client={clientRef.current} account={account} baseUrl={baseUrl} onSignedOut={signOutWithNote} />
        : <section style={{ maxWidth: 580, margin: '24px auto', padding: 24, borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h2>{!health ? '尚未连接管理服务器' : !health.claimed ? '初始化服务器所有者' : '管理员登录'}</h2>
          {!health && !busy && <p>请确认后端服务已启动。仅启动 5173 前端页面不能创建服务器账号。</p>}
          {!busy && message && <button onClick={() => { setPassword(''); setAttempt((value) => value + 1); }}>重新连接服务器</button>}
          {mfaChallenge
            ? <form onSubmit={(event) => void submitMfa(event)} style={{ display: 'grid', gap: 16 }}>
              <p style={{ margin: 0 }}>两步验证已开启。挑战将在 {new Date(mfaChallenge.expiresAt).toLocaleTimeString()} 失效，超时后请重新输入账号密码。</p>
              <label>验证码或恢复码<input className="zc-input" aria-label="两步验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={9} required value={mfaCode} disabled={busy} onChange={(event) => setMfaCode(event.target.value)} /></label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <button disabled={busy || !mfaCode.trim()} type="submit">{busy ? '校验中…' : '验证并进入后台'}</button>
                <button type="button" disabled={busy} onClick={() => { setMfaChallenge(undefined); setMfaCode(''); setMessage(''); }}>返回账号密码</button>
              </div>
              <p style={{ margin: 0 }}>恢复码每个只能使用一次；用它登录成功后，请在“账号安全”页重新生成。</p>
            </form>
            : <form onSubmit={(event) => void submit(event)} style={{ display: 'grid', gap: 16 }}>
              <label>用户名<input className="zc-input" aria-label="管理账号用户名" autoComplete="username" required minLength={3} value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} /></label>
              <label>账号密码<input className="zc-input" aria-label="管理账号密码" type="password" autoComplete={health?.claimed ? 'current-password' : 'new-password'} required minLength={8} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
              {health && !health.claimed && <p>首次使用：设置管理员用户名和密码即可。创建成功后，此页面将只提供登录，不会创建个人账本。</p>}
              <button disabled={busy || !health} type="submit">{busy ? '处理中…' : !health ? '等待服务器连接' : health.claimed ? '登录管理后台' : '创建所有者并进入后台'}</button>
            </form>}
          {health?.claimed && <PasswordRecovery baseUrl={baseUrl} onComplete={setUsername} />}
          <section aria-label="管理后台权限与存储说明" style={{ marginTop: 24, lineHeight: 1.8 }}>
            <strong>登录会使用什么权限？</strong>
            <p>仅验证服务器管理身份，不创建或解锁个人账本，不申请账本持久存储或磁盘文件访问权限。</p>
            <p>使用独立的 HttpOnly 管理会话 Cookie，不与记账登录互相覆盖。账号密码不写入应用存储，访问令牌仅在内存中；此后台不提供“记住设备”。</p>
            <p>两步验证启用后，密码通过仍需输入验证码；忘记验证书时可用一次性恢复码登录。</p>
            <p>管理角色可管理账号、设备和容量。获授权服务器托管账本解密凭据；管理后台不提供查看密钥的入口。</p>
          </section>
        </section>}
    </div>
  </main>;
}

/** Re-exported so existing importers keep working; the mapping itself lives in `ui.tsx`. */
export { roleLabel };

/** Sidebar navigation plus the routed page. Every page has its own URL. */
function AdminShell({ client, account, baseUrl, onSignedOut }: {
  client: AdminClient; account: SyncAuthMe; baseUrl: string;
  /** Ends the console session locally and states why, without calling logout again. */
  onSignedOut: (note: string) => void;
}) {
  const route = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  useBodyScrollLock(navOpen);
  const basePath = adminBasePath(window.location);
  const go = (to: string) => { navigateRoute(adminHref(basePath, to)); };
  const role = account.role;
  const groups = adminNavigation(role);
  const items = [...groups.flatMap((group) => group.pages), { path: '/security', label: '账号安全' }];
  const current = items.find((item) => route.path === item.path || route.path.startsWith(`${item.path}/`)) ?? items[0]!;
  // A detail page is one level below its list, and the trailing segment is an opaque id rather
  // than a label. Only the user detail route has a readable parent, so only it gets an extra crumb;
  // anything else would be a link whose text an operator cannot read.
  const detailCrumb = current.path === '/users' && route.segments[1] ? '用户详情' : undefined;

  // Several console tabs are open at once during an incident; without a title they are
  // indistinguishable in the tab bar. The user detail page names the account it shows, and a
  // preview names it too — a tab reading "运行概览" while showing a user's ledger is the one
  // label that would be actively wrong.
  useEffect(() => {
    const preview = route.segments[0] === 'preview' ? route.query.get('username') : undefined;
    const detail = route.segments[0] === 'users' && route.segments[1] ? ` · ${route.segments[1]}` : '';
    document.title = preview
      ? `预览 · ${preview} · 服务器管理后台`
      : `${current.label}${detail} · 服务器管理后台`;
    // `route.path` is the string identity of the view; `segments` is rebuilt per route object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.label, route.path]);
  // `/admin/` itself is not a page: canonicalise it to the overview URL so refresh and
  // sharing always land on a real location.
  useEffect(() => {
    if (/\/admin\/?$/.test(window.location.pathname)) navigateRoute(adminHref(basePath, '/overview'), { replace: true });
  }, [basePath]);
  useEffect(() => { setNavOpen(false); }, [route.path]);
  useEffect(() => {
    if (!navOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [navOpen]);
  useEffect(() => {
    const mobileViewport = window.matchMedia('(max-width: 1023px)');
    const closeOnDesktop = () => { if (!mobileViewport.matches) setNavOpen(false); };
    mobileViewport.addEventListener('change', closeOnDesktop);
    return () => mobileViewport.removeEventListener('change', closeOnDesktop);
  }, []);

  const page = (() => {
    const [first, second] = route.segments;
    switch (first) {
      case 'users':
        return second
          ? <UserDetailPage client={client} accountId={second} role={role} navigate={go} onChanged={() => undefined} selfAccountId={account.accountId ?? ''} />
          : <UsersPage client={client} query={route.query} navigate={go} role={role} />;
      case 'sessions': return <SessionsPage client={client} query={route.query} navigate={go} role={role} selfAccountId={account.accountId ?? ''} />;
      case 'sync': return <SyncPage client={client} query={route.query} navigate={go} />;
      case 'security-events': return <SecurityEventsPage client={client} query={route.query} navigate={go} />;
      case 'alerts': return <AlertsPage client={client} role={role} navigate={go} query={route.query} />;
      case 'invites': return <InvitesPage client={client} role={role} query={route.query} navigate={go} />;
      case 'storage': return <StoragePage client={client} role={role} query={route.query} navigate={go} onJob={(jobId) => go(`/jobs?job=${jobId}`)} />;
      case 'monitor': return <MonitorPage client={client} role={role} query={route.query} navigate={go} />;
      case 'resources': return <ResourcesPage client={client} role={role} onJob={(jobId) => go(`/jobs?job=${jobId}`)} />;
      case 'jobs': return <JobsPage client={client} query={route.query} navigate={go} role={role} />;
      case 'logs': return <LogsPage client={client} query={route.query} navigate={go} />;
      case 'audit': return <AuditPage client={client} query={route.query} navigate={go} />;
      // Changing the account password revokes every session, so the console signs itself out
      // instead of leaving a dead session on screen that fails on the next click.
      case 'security': return <SecurityPage client={client} username={account.username} role={role} onPasswordChanged={() => { onSignedOut('账号密码已修改，请用新密码重新登录。'); }} />;
      case 'settings': return <SettingsPage client={client} role={role} query={route.query} navigate={go} />;
      default: return <OverviewPage client={client} navigate={go} role={role} />;
    }
  })();

  // A preview replaces the whole console chrome, so it is dispatched in `AdminApp` before the
  // shell renders at all. Nothing to do here.

  return (
    <div className="zc-admin-shell">
      <div className="zc-admin-mobile-bar">
        <button type="button" aria-expanded={navOpen} aria-controls="zc-admin-navigation" onClick={() => setNavOpen((open) => !open)}>
          {navOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}<span>菜单</span>
        </button>
        <strong>{current.label}</strong>
      </div>
      {navOpen ? <button type="button" className="zc-admin-nav-scrim" aria-label="关闭管理导航" onClick={() => setNavOpen(false)} /> : null}
      <nav id="zc-admin-navigation" className="zc-admin-nav" data-open={navOpen} aria-label="管理后台导航">
        <div className="zc-admin-nav-intro"><span>工作台</span><small>{baseUrl}</small></div>
        {groups.map((group) => {
          const link = (item: { path: string; label: string }) => {
          const Icon = navigationIcons[item.path];
          return (
          <a
            key={item.path}
            href={adminHref(basePath, item.path)}
            aria-current={item === current ? 'page' : undefined}
            data-active={item === current ? 'true' : undefined}
            onClick={(event) => { if (!isPlainPrimaryClick(event)) return; event.preventDefault(); setNavOpen(false); go(item.path); }}
          >{Icon ? <Icon size={17} strokeWidth={1.8} aria-hidden="true" /> : null}<span>{item.label}</span></a>
          );
          };
          return <div className="zc-admin-nav-group" key={group.label}>
            <span className="zc-admin-nav-heading">{group.label}</span>
            {group.pages.map(link)}
          </div>;
        })}
        <div className="zc-admin-nav-footer">
          <a href={adminHref(basePath, '/security')} onClick={(event) => { if (!isPlainPrimaryClick(event)) return; event.preventDefault(); setNavOpen(false); go('/security'); }}><ShieldCheck size={17} strokeWidth={1.8} aria-hidden="true" /><span>账号安全</span></a>
          <a href={`${baseUrl}/app/`}><ExternalLink size={17} strokeWidth={1.8} aria-hidden="true" /><span>打开记账应用</span></a>
        </div>
      </nav>
      <section className="zc-admin-content">
        <Breadcrumbs
          crumbs={[
            { label: '管理后台', href: adminHref(basePath, '/overview') },
            ...(route.path === current.path
              ? [{ label: current.label }]
              : [{ label: current.label, href: adminHref(basePath, current.path) }, { label: detailCrumb ?? current.label }]),
          ]}
          onNavigate={go}
        />
        {/* The role is stated up front, because a read-only operator sees every page and would
            otherwise only find out by being refused. */}
        {role === 'viewer'
          ? <p role="status" style={{ padding: 12, marginBottom: 12, borderRadius: 'var(--r-sm)', background: 'var(--warn-surface)', border: '1px solid var(--border)' }}>
            只读运维角色：可以查看全部页面并导出日志与审计，不能执行任何管理变更（修改账号、会话、注册策略、任务、设置或备份操作都会被服务端拒绝）。
          </p>
          : null}
        {page}
      </section>
    </div>
  );
}
