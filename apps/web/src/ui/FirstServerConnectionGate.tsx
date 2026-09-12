import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { fetchAuthMe, loginAccount, registerAccount, type SyncAuthSession } from '@zichan/db';
import { getDeviceId } from '../db/cloud.js';
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
  protocols?: number[];
  capabilities?: string[];
}

const button = btnOutline;

const primary = btnPrimary;
const input: CSSProperties = { boxSizing: 'border-box', width: '100%', minHeight: 42, padding: '0 11px', border: '1px solid #cfc1af', borderRadius: 'var(--r-sm)', background: '#fffdf9', color: '#4e473f' };

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
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [registering, setRegistering] = useState(false);
  const [privateMode, setPrivateMode] = useState(false);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
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
    if (!username.trim() || password.length < 8) {
      setError('请输入用户名和至少 8 个字符的服务器账号密码');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('正在校验服务器身份…');
    try {
      const checked = await checkServer();
      if (action === 'register') {
        if (checked.health.claimed && checked.health.registrationMode === 'closed') throw new Error('该服务器已关闭注册，请使用已有账号登录');
        if (!checked.health.claimed) throw new Error('请先进入管理后台初始化服务器，再注册个人账号');
        if (checked.health.claimed && checked.health.registrationMode === 'invite' && !inviteCode.trim()) throw new Error('该服务器要求邀请码');
        await registerAccount(checked.baseUrl, username.trim(), password, {
          inviteCode: inviteCode.trim() || undefined,
          expectedServerId: checked.health.serverId,
          expectedServerPublicKey: checked.health.serverPublicKey,
        });
        setRegistering(false);
        setMessage('注册成功，正在登录；若登录失败，请直接使用新账号登录。');
      }
      const session = await loginAccount(checked.baseUrl, username.trim(), password, {
        sessionTransport: preferredSessionTransport(checked.baseUrl),
        deviceId: getDeviceId(),
        deviceName: 'Zichan · 首次连接',
        expectedServerPublicKey: checked.health.serverPublicKey,
        expectedServerId: checked.health.serverId,
      });
      const account = await fetchAuthMe(checked.baseUrl, session.accessToken);
      const connection = {
        initialProtectionMode: privateMode ? 'private' as const : undefined,
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
    <main style={{ minHeight: '100dvh', overflowY: 'auto', padding: 'clamp(20px, 5vw, 64px)', boxSizing: 'border-box', background: '#f0e9dc', color: '#4e473f', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(780px, 100%)', margin: '0 auto' }}>
        {!accountOnly && <button type="button" onClick={onCancel} disabled={busy} style={{ ...button, minHeight: 34, padding: '0 11px' }}>返回模式选择</button>}
        <h1 style={{ margin: '18px 0 6px', color: '#672f20', fontSize: 'var(--fs-hero)' }}>{accountOnly ? registering ? '注册账号' : '账号登录' : '连接同步服务器'}</h1>
        <p style={{ margin: '0 0 22px', color: '#756b60', lineHeight: 1.7 }}>{accountOnly ? '使用账号登录并自动同步。支持托管的服务器默认代管账本密钥，登录即可记账；也可创建由恢复码保护的私密账本。' : '先验证服务器身份并登录。服务器地址可以来自当前网站、本机、局域网或公网。'}</p>

        <div style={{ padding: 20, border: '1px solid #d6ccbd', borderRadius: 'var(--r-md)', background: '#fffaf2' }}>
          {!accountOnly && <><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {PRESETS.map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => selectPreset(item.id)} style={{ ...button, background: preset === item.id ? '#ead8c4' : '#fffdf9' }}>{item.label}</button>)}
          </div>
          <label style={{ display: 'block', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>完整服务器地址</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <input aria-label="完整服务器地址" value={address} onChange={(event) => setAddressDraft(event.target.value)} disabled={busy} spellCheck={false} style={{ ...input, flex: '1 1 420px' }} />
            <button type="button" onClick={() => setAdvanced((value) => !value)} disabled={busy} style={button}>{advanced ? '收起高级设置' : '高级设置'}</button>
          </div>
          <div style={{ marginTop: 6, color: '#756b60', fontSize: 'var(--fs-meta)', lineHeight: 1.55 }}>
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
          <form onSubmit={(event) => { event.preventDefault(); void authenticate(registering ? 'register' : 'login'); }}>
          {registering && <details style={{ marginTop: 12 }}><summary>高级：账本保护方式</summary><label><input type="checkbox" checked={privateMode} disabled={busy} onChange={(e) => setPrivateMode(e.target.checked)} />创建私密账本，自己保存恢复码</label><p>默认云端托管允许此服务器解密和恢复账本。私密模式不托管密钥，遗失恢复码后账号密码找回无法恢复账本。</p></details>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 18 }}>
            <div><label style={{ display: 'block', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>用户名</label><input aria-label="服务器用户名" value={username} onChange={(event) => { setUsername(event.target.value); setError(''); }} disabled={busy} autoComplete="username" style={{ ...input, marginTop: 6 }} /></div>
            <div><label style={{ display: 'block', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>账号密码</label><input aria-label="服务器账号密码" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setError(''); }} disabled={busy} autoComplete={registering ? 'new-password' : 'current-password'} required minLength={8} style={{ ...input, marginTop: 6 }} /></div>
            {registering && <div><label style={{ display: 'block', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>确认账号密码</label><input aria-label="确认账号密码" type="password" required minLength={8} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} autoComplete="new-password" style={{ ...input, marginTop: 6 }} /></div>}
            {health?.registrationMode === 'invite' && (!accountOnly || registering) && <div><label style={{ display: 'block', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>邀请码</label><input aria-label="邀请码" value={inviteCode} onChange={(event) => { setInviteCode(event.target.value); setError(''); }} disabled={busy} style={{ ...input, marginTop: 6 }} /></div>}
          </div>

          {health && !health.claimed && <p>本站尚未开放，请联系部署者完成服务器初始化。</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 }}>
            <button type="button" onClick={() => void inspectServer()} disabled={busy} style={button}>{accountOnly ? '重试连接' : '检查服务器'}</button>
            <button type="submit" disabled={busy || health?.claimed === false} style={primary}>{busy ? '处理中…' : registering ? '注册并登录' : '登录已有账号'}</button>
            <button type="button" onClick={() => setRegistering((value) => !value)} disabled={busy || !registering && (health?.claimed === false || health?.registrationMode === 'closed')} style={button}>{registering ? '返回登录' : '注册新账号'}</button>
          </div>
          </form>
          {accountOnly && <section aria-label="账号登录权限说明" style={{ marginTop: 18, fontSize: 'var(--fs-caption)', lineHeight: 1.7 }}><strong>登录会使用什么权限？</strong><p>仅验证本站账号并建立 HttpOnly 会话 Cookie，不保存账号密码。登录后在本浏览器保存该账号的加密离线缓存，不申请任意磁盘访问权限；不要求授予浏览器持久存储保护。托管账本登录后自动解锁；私密账本需要恢复码或此设备已有授权。</p></section>}
          {health?.claimed && <PasswordRecovery baseUrl={address} onComplete={(value) => { setUsername(value); setRegistering(false); }} />}
          {message && <div role="status" style={{ marginTop: 12, color: '#397044', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>{message}</div>}
          {error && <div role="alert" style={{ marginTop: 12, color: '#9a3a31', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>{error}</div>}
        </div>
      </section>
    </main>
  );
}

import { btnOutline, btnPrimary } from './styles.js';