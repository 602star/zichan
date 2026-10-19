import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { fetchAuthMe, loginAccount, registerAccount, type SyncAuthSession } from '@zichan/db';
import { getDeviceId } from '../db/cloud.js';
import { rememberLoginPassword } from '../login-password.js';
import { PasswordRecovery } from './PasswordRecovery.js';
import { applySyncAuthSession, preferredSessionTransport } from '../sync-auth.js';
import {
  buildSyncUrlFromParts,
  isDeviceLocalSyncUrl,
  newSyncConnection,
  normalizeSyncBaseUrl,
  parseSyncBaseUrl,
  saveAutoSync,
  saveSyncConnections,
  syncAddressPresetUrl,
  type SyncAddressPreset,
  type SyncUrlParts,
  type SyncConnection,
} from '../sync-config.js';
import {
  clearConnectionLinkHash,
  connectionLinkFromLocation,
  fingerprintServerPublicKey,
  type SyncConnectionLinkPayload,
} from '../connection-link.js';

interface ServerHealth {
  serverId: string;
  serverPublicKey: string;
  claimed: boolean;
  registrationMode: 'open' | 'invite' | 'closed';
  ledgerWebAccess?: boolean;
  protocols?: number[];
  capabilities?: string[];
}

const button = btnOutline;

const input: CSSProperties = { boxSizing: 'border-box', width: '100%', minHeight: 42, padding: '0 11px', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', color: 'var(--text-primary)' };

const PRESETS: { id: SyncAddressPreset; label: string }[] = [
  { id: 'current', label: '当前网站' },
  { id: 'local', label: '本机' },
  { id: 'lan', label: '局域网' },
  { id: 'public', label: '公网' },
];

async function readHealth(baseUrl: string): Promise<ServerHealth> {
  const response = await fetch(`${baseUrl}/api/health`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`服务器检查失败：HTTP ${response.status}`);
  const body = await response.json() as Partial<ServerHealth>;
  if (!body.serverId || !body.serverPublicKey || !body.registrationMode) throw new Error('服务器身份或注册策略响应不完整');
  if (!body.protocols?.includes(3)
    || !body.capabilities?.includes('opaque-pake-v1')
    || !body.capabilities.includes('ledger-key-envelope-v1')
    || !body.capabilities.includes('encrypted-blobs-v1')) {
    throw new Error('服务器不支持当前端到端加密同步协议');
  }
  return {
    serverId: body.serverId,
    serverPublicKey: body.serverPublicKey,
    claimed: body.claimed === true,
    registrationMode: body.registrationMode,
    ledgerWebAccess: body.ledgerWebAccess !== false,
  };
}

export function FirstServerConnectionGate({ onReady, onCancel, accountOnly = false, onAuthenticated, initialProfile }: { onReady: () => Promise<void>; onCancel: () => void; accountOnly?: boolean; initialProfile?: SyncConnection; onAuthenticated?: (connection: SyncConnection, session: SyncAuthSession) => Promise<void> }) {
  const initialConnectionLink = useMemo(() => accountOnly ? null : connectionLinkFromLocation(), [accountOnly]);
  const initialUrl = useMemo(() => initialConnectionLink?.url ?? initialProfile?.baseUrl ?? syncAddressPresetUrl('current'), [initialConnectionLink, initialProfile?.baseUrl]);
  const [expectedLink, setExpectedLink] = useState<SyncConnectionLinkPayload | null>(initialConnectionLink ?? null);
  const [preset, setPreset] = useState<SyncAddressPreset>('current');
  const [address, setAddress] = useState(initialUrl);
  const [parts, setParts] = useState<SyncUrlParts>(() => parseSyncBaseUrl(initialUrl));
  const [advanced, setAdvanced] = useState(false);
  const [username, setUsername] = useState(initialProfile?.username ?? '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [registering, setRegistering] = useState(false);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [identityProviders, setIdentityProviders] = useState<{
    issuerNodeId: string; issuerUrl: string; linkId: string; ledgerId: string;
  }[]>([]);
  useEffect(() => {
    if (!accountOnly) return;
    let active = true;
    setBusy(true);
    void readHealth(initialUrl).then((checked) => {
      if (!active) return;
      setHealth(checked);
      setMessage(checked.claimed ? '服务器在线，请登录账号。' : '服务器尚未初始化，请先进入管理后台设置管理员用户名和密码。');
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setBusy(false); });
    void fetch(`${initialUrl}/api/auth/federation/providers`, { redirect: 'error' })
      .then(async (response) => response.ok ? response.json() as Promise<{
        providers: { issuerNodeId: string; issuerUrl: string; linkId: string; ledgerId: string }[];
      }> : { providers: [] })
      .then((value) => { if (active) setIdentityProviders(value.providers); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [accountOnly, initialUrl]);

  function setAddressDraft(value: string) {
    setAddress(value);
    setHealth(null);
    if (value !== expectedLink?.url) setExpectedLink(null);
    try {
      setParts(parseSyncBaseUrl(value));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function setAddressPart(patch: Partial<SyncUrlParts>) {
    const next = { ...parts, ...patch };
    setParts(next);
    setHealth(null);
    setExpectedLink(null);
    try {
      setAddress(buildSyncUrlFromParts(next));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function selectPreset(next: SyncAddressPreset) {
    setPreset(next);
    const nextUrl = syncAddressPresetUrl(next, {
      host: next === 'lan' ? '192.168.1.100' : next === 'public' ? 'ledger.example.com' : undefined,
      path: next === 'public' ? '/zichan' : undefined,
    });
    setAddress(nextUrl);
    setParts(parseSyncBaseUrl(nextUrl));
    setHealth(null);
    setExpectedLink(null);
    setError('');
  }

  async function checkServer(): Promise<{ baseUrl: string; health: ServerHealth }> {
    const baseUrl = normalizeSyncBaseUrl(address);
    const checked = await readHealth(baseUrl);
    if (expectedLink) {
      if (checked.serverId !== expectedLink.serverId) throw new Error('服务器 ID 与连接链接不一致');
      const fingerprint = await fingerprintServerPublicKey(checked.serverPublicKey);
      if (fingerprint !== expectedLink.serverPublicKeyFingerprint) throw new Error('服务器 OPAQUE 公钥指纹与连接链接不一致');
    }
    setAddress(baseUrl);
    setParts(parseSyncBaseUrl(baseUrl));
    setHealth(checked);
    setMessage(checked.claimed
      ? `服务器在线 · 注册策略：${checked.registrationMode === 'open' ? '开放' : checked.registrationMode === 'invite' ? '邀请码' : '关闭'}`
      : '服务器尚未初始化，请先进入管理后台设置管理员用户名和密码。');
    return { baseUrl, health: checked };
  }

  async function inspectServer() {
    setBusy(true);
    setError('');
    setMessage('正在检查服务器…');
    try {
      await checkServer();
    } catch (reason) {
      setMessage('');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function authenticate(action: 'login' | 'register') {
    if (busy) return;
    if (action === 'register' && password !== confirmation) { setError('两次输入的账号密码不一致'); return; }
    if (action === 'register' && (!displayName.trim() || Array.from(displayName.trim()).length > 24)) { setError('请输入 1 至 24 个字符的昵称'); return; }
    if (!/^[\p{L}\p{N}_.-]{2,64}$/u.test(username.trim().normalize('NFKC').toLowerCase())) { setError('登录账号须为 2 至 64 个中文、字母、数字或 _ . -'); return; }
    if (!username.trim() || password.length < 8) {
      setError('请输入登录账号和至少 8 个字符的密码');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('正在校验服务器身份…');
    try {
      const checked = await checkServer();
      if (checked.health.ledgerWebAccess === false) throw new Error('管理员已关闭通过这台服务器网页记账，请使用其他获准节点。');
      if (action === 'register') {
        if (checked.health.claimed && checked.health.registrationMode === 'closed') throw new Error('该服务器已关闭注册，请使用已有账号登录');
        if (!checked.health.claimed) throw new Error('请先进入管理后台初始化服务器，再注册个人账号');
        if (checked.health.claimed && checked.health.registrationMode === 'invite' && !inviteCode.trim()) throw new Error('该服务器要求邀请码');
        await registerAccount(checked.baseUrl, username.trim(), password, {
          displayName: displayName.trim(),
          inviteCode: inviteCode.trim() || undefined,
          expectedServerId: checked.health.serverId,
          expectedServerPublicKey: checked.health.serverPublicKey,
        });
        setRegistering(false);
        setMessage('注册成功，正在登录；若登录失败，请直接使用新账号登录。');
      }
      const session = await loginAccount(checked.baseUrl, username.trim(), password, {
        sessionTransport: preferredSessionTransport(checked.baseUrl),
        sessionContext: 'ledger',
        deviceId: getDeviceId(),
        deviceName: 'Zichan · 首次连接',
        expectedServerPublicKey: checked.health.serverPublicKey,
        expectedServerId: checked.health.serverId,
      });
      const account = await fetchAuthMe(checked.baseUrl, session.accessToken);
      if (!account.accountId) throw new Error('服务器未返回账号身份');
      const connection = {
        ...newSyncConnection(checked.baseUrl),
        alias: expectedLink?.alias ?? (preset === 'current' ? '当前网站' : preset === 'local' ? '本机服务器' : preset === 'lan' ? '局域网服务器' : '公网服务器'),
        serverId: checked.health.serverId,
        serverPublicKey: checked.health.serverPublicKey,
        username: account.username,
        accountId: account.accountId,
        role: account.role,
        ledgerId: account.ledgerId,
        replicaId: account.replicaId,
        streamEpoch: account.streamEpoch,
        enabled: true,
        status: 'online' as const,
        sharedUrls: isDeviceLocalSyncUrl(checked.baseUrl) ? [] : [checked.baseUrl],
        deviceUrls: isDeviceLocalSyncUrl(checked.baseUrl) ? [checked.baseUrl] : [],
        lastError: account.role !== 'member' ? '管理员登录成功' : '登录成功',
        expectedServerPublicKeyFingerprint: expectedLink?.serverPublicKeyFingerprint,
      };
      rememberLoginPassword(checked.health.serverId, account.accountId, password);
      if (onAuthenticated) {
        setPassword(''); setConfirmation(''); setInviteCode('');
        await onAuthenticated(connection, session);
        return;
      }
      saveSyncConnections([connection]);
      saveAutoSync({ enabled: true, minutes: 5 });
      applySyncAuthSession(connection.id, { password: '', inviteCode: '' }, session);
      setPassword('');
      setInviteCode('');
      setMessage(action === 'register' ? '注册并登录成功，正在创建本机加密存储…' : '登录成功，正在创建本机加密存储…');
      clearConnectionLinkHash();
      await onReady();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100dvh', overflowY: 'auto', padding: 'clamp(20px, 5vw, 64px)', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: accountOnly ? 'min(440px, 100%)' : 'min(780px, 100%)', margin: '0 auto' }}>
        {!accountOnly && <button type="button" onClick={onCancel} disabled={busy} style={{ ...button, minHeight: 34, padding: '0 11px' }}>返回模式选择</button>}
        <h1 style={{ margin: '18px 0 6px', color: 'var(--text-primary)', fontSize: 'var(--fs-hero)' }}>{accountOnly ? registering ? '注册账号' : '账号登录' : '连接同步服务器'}</h1>
        <p style={{ margin: '0 0 22px', color: 'var(--text-secondary)', lineHeight: 1.7 }}>{accountOnly ? '使用账号密码登录并打开账本。本机自动准备离线访问，联网后继续同步。' : '先验证服务器身份并登录。服务器地址可以来自当前网站、本机、局域网或公网。'}</p>

        <div style={{ padding: 'clamp(20px, 4vw, 28px)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--surface)' }}>
          {!accountOnly && <><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {PRESETS.map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => selectPreset(item.id)} style={{ ...button, background: preset === item.id ? 'var(--accent-soft)' : 'var(--surface)' }}>{item.label}</button>)}
          </div>
          <label style={{ display: 'block', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>完整服务器地址</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <input aria-label="完整服务器地址" value={address} onChange={(event) => setAddressDraft(event.target.value)} disabled={busy} spellCheck={false} style={{ ...input, flex: '1 1 420px' }} />
            <button type="button" onClick={() => setAdvanced((value) => !value)} disabled={busy} style={button}>{advanced ? '收起高级设置' : '高级设置'}</button>
          </div>
          <div style={{ marginTop: 6, color: 'var(--text-secondary)', fontSize: 'var(--fs-meta)', lineHeight: 1.55 }}>
            HTTPS 网站中的浏览器可能阻止普通 HTTP 局域网地址（混合内容或私有网络限制）；遇到此情况请使用可信 HTTPS、服务器自带 Web，或 Windows 便携版。
          </div>
          {advanced && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 10 }}>
              <select aria-label="协议" value={parts.protocol} onChange={(event) => setAddressPart({ protocol: event.target.value as 'http' | 'https' })} style={input}><option value="http">http</option><option value="https">https</option></select>
              <input aria-label="主机或域名" value={parts.host} onChange={(event) => setAddressPart({ host: event.target.value })} style={input} placeholder="ledger.example.com" />
              <input aria-label="端口" value={parts.port} onChange={(event) => setAddressPart({ port: event.target.value })} style={input} placeholder="443" />
              <input aria-label="服务路径" value={parts.path} onChange={(event) => setAddressPart({ path: event.target.value })} style={input} placeholder="/zichan" />
            </div>
          )}

          </>}
          <form className="zc-login-form" onSubmit={(event) => { event.preventDefault(); void authenticate(registering ? 'register' : 'login'); }}>
          <div className="zc-login-fields">
            {registering && <label className="zc-field">昵称<input className="zc-input" aria-label="昵称" value={displayName} onChange={(event) => { setDisplayName(event.target.value); setError(''); }} disabled={busy} autoComplete="nickname" required maxLength={48} placeholder="例如：小明" style={input} /><small className="zc-caption">显示给自己看的名称，之后可以修改，支持中文。</small></label>}
            <label className="zc-field">登录账号<input className="zc-input" aria-label="服务器用户名" value={username} onChange={(event) => { setUsername(event.target.value); setError(''); }} disabled={busy} autoComplete="username" required autoFocus={accountOnly} placeholder={registering ? '例如：xiaoming 或 小明' : '输入注册时的登录账号'} style={input} />{registering && <small className="zc-caption">用于登录，注册后暂不能修改；支持 2 至 64 个中文、字母、数字或 _ . -。</small>}</label>
            <label className="zc-field">账号密码<input className="zc-input" aria-label="服务器账号密码" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setError(''); }} disabled={busy} autoComplete={registering ? 'new-password' : 'current-password'} required minLength={8} style={input} /></label>
            {registering && <label className="zc-field">确认账号密码<input className="zc-input" aria-label="确认账号密码" type="password" required minLength={8} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} autoComplete="new-password" style={input} /></label>}
            {health?.registrationMode === 'invite' && (!accountOnly || registering) && <label className="zc-field">邀请码<input className="zc-input" aria-label="邀请码" value={inviteCode} onChange={(event) => { setInviteCode(event.target.value); setError(''); }} disabled={busy} style={input} /></label>}
          </div>

          {health && !health.claimed && <p>本站尚未开放，请联系部署者完成服务器初始化。</p>}
          {health?.ledgerWebAccess === false && <p role="status">管理员已关闭通过本站网页记账。节点间复制仍可继续，请使用其他获准节点。</p>}
          <div className="zc-login-actions">
            <button className="zc-btn zc-btn--primary" type="submit" disabled={busy || health?.claimed === false || health?.ledgerWebAccess === false}>{busy ? '处理中…' : registering ? '注册并登录' : '登录'}</button>
            <div className="zc-login-secondary-actions">
              <button className="zc-btn" type="button" onClick={() => setRegistering((value) => !value)} disabled={busy || !registering && (health?.claimed === false || health?.registrationMode === 'closed')}>{registering ? '返回登录' : '注册新账号'}</button>
              <button className="zc-btn zc-btn--ghost" type="button" onClick={() => void inspectServer()} disabled={busy}>{accountOnly ? '重试连接' : '检查服务器'}</button>
            </div>
          </div>
          </form>
          {error && <div role="alert" style={{ marginTop: 12, color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>{error}</div>}
          {message && <div role="status" style={{ marginTop: 12, color: 'var(--positive)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>{message}</div>}
          {health?.claimed && !registering && <div style={{ maxWidth: 440 }}><PasswordRecovery baseUrl={address} onComplete={(value) => { setUsername(value); setRegistering(false); }} /></div>}
          {accountOnly && <section aria-label="账号登录权限说明" style={{ marginTop: 18, fontSize: 'var(--fs-caption)', lineHeight: 1.7 }}><strong>登录会使用什么权限？</strong><p>验证本站账号并建立 HttpOnly 会话 Cookie。登录后用账号密码加密本浏览器的离线解锁资料，不保存明文密码。</p></section>}
          {accountOnly && identityProviders.length > 0 && <section style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <strong>使用统一账号登录</strong>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>账号资料已同步时，可直接在上方输入账号密码登录；首次开通尚未完成时，也可通过身份节点登录。</p>
            {identityProviders.map((provider) => <button key={provider.linkId} type="button" style={{ ...button, marginRight: 8 }}
              onClick={() => window.location.assign(`${initialUrl}/api/auth/federation/start?issuer=${encodeURIComponent(provider.issuerNodeId)}&link=${encodeURIComponent(provider.linkId)}`)}>
              通过 {new URL(provider.issuerUrl).host} 登录账本 {provider.ledgerId}
            </button>)}
          </section>}
        </div>
      </section>
    </main>
  );
}

import { btnOutline } from './styles.js';
