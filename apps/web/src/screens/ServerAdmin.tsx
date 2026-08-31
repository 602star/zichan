import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { card, th as thStyle, td as tdStyle } from '../ui/styles.js';
import { tauriInvoke } from '../tauri.js';
import { DateRangeBar, dateRangeValue, localDateRangeToUtc, type DateRangeValue } from '../ui/DateRangeBar.js';
import { normalizeSyncBaseUrl, type SyncConnection } from '../sync-config.js';
import { assertSyncServerIdentity } from '../sync-auth.js';

type RegistrationMode = 'open' | 'invite' | 'closed';

interface AdminStatus {
  ok: boolean;
  serverId: string;
  claimed: boolean;
  ownerUsername?: string;
  basePath?: string;
  syncEnabled: boolean;
  webEnabled: boolean;
  registrationMode: RegistrationMode;
  userCount: number;
  disabledUserCount: number;
  inviteCount: number;
  commitCount: number;
  commitBytes: number;
  activeSessionCount: number;
  journalMode: string;
  schemaVersion: number;
  dataDir: string;
  databaseFile: string;
}

interface AdminBlobUser {
  username: string;
  quotaBytes: number;
  usedBytes: number;
  objectCount: number;
  trashBytes: number;
  trashCount: number;
  stagingBytes: number;
  stagingCount: number;
}

interface AdminUser {
  username: string;
  role: 'admin' | 'member';
  disabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastLoginAt: string | null;
  commitCount: number;
  commitBytes: number;
  commitQuotaBytes: number;
  activeDeviceCount: number;
}

interface AdminDevice {
  id: string;
  username: string;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  lastIp: string | null;
  revokedAt: string | null;
  active: boolean;
}

interface AdminInvite {
  code: string;
  createdAt: string;
  usedBy: string | null;
  usedAt: string | null;
  disabled: boolean;
}

interface ServerLog {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  action: string;
  message: string;
  ip?: string;
  username?: string;
  status?: number;
  detail?: Record<string, unknown>;
}

interface DesktopServerStatus {
  available: boolean;
  running: boolean;
  managed: boolean;
  endpoint: string;
  dataFile: string | null;
  message: string;
}

const LAN_EXPOSURE_ACK_KEY = 'zichan.desktop.lan-exposure-ack.v1';

const fmt = (v: string | null) => v ? new Date(v).toLocaleString() : '—';
const compact = (v: string) => v.length > 18 ? `${v.slice(0, 18)}…` : v;

const adminIdentityChecks = new Map<string, Promise<void>>();

async function verifyAdminConnection(connection: SyncConnection): Promise<void> {
  const key = `${connection.id}\u0000${connection.baseUrl}\u0000${connection.serverId ?? ''}\u0000${connection.serverPublicKey ?? ''}`;
  const current = adminIdentityChecks.get(key);
  if (current) return current;
  const pending = assertSyncServerIdentity(connection);
  adminIdentityChecks.set(key, pending);
  try {
    await pending;
  } finally {
    if (adminIdentityChecks.get(key) === pending) adminIdentityChecks.delete(key);
  }
}

async function adminFetch<T>(connection: SyncConnection, token: string, path: string, init: RequestInit = {}): Promise<T> {
  await verifyAdminConnection(connection);
  const normalized = normalizeSyncBaseUrl(connection.baseUrl);
  const res = await fetch(`${normalized}${path}`, {
    ...init,
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function ServerAdmin({ connection, accessToken }: { connection?: SyncConnection; accessToken?: string }) {
  const endpoint = connection?.baseUrl ?? '';
  const token = accessToken?.trim() ?? '';
  const [desktopStatus, setDesktopStatus] = useState<DesktopServerStatus | null>(null);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [deviceOwner, setDeviceOwner] = useState('');
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [logs, setLogs] = useState<ServerLog[]>([]);
  const [blobUsers, setBlobUsers] = useState<AdminBlobUser[]>([]);
  const [quotaGb, setQuotaGb] = useState<Record<string, string>>({});
  const [commitQuotaGb, setCommitQuotaGb] = useState<Record<string, string>>({});
  const [logLevel, setLogLevel] = useState<'all' | ServerLog['level']>('all');
  const [logRange, setLogRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const [mode, setMode] = useState<RegistrationMode>('open');
  const [newInvite, setNewInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [lanExposureAccepted, setLanExposureAccepted] = useState(() => {
    try {
      return localStorage.getItem(LAN_EXPOSURE_ACK_KEY) === 'accepted';
    } catch {
      return false;
    }
  });

  const refreshDesktopStatus = useCallback(async () => {
    const call = tauriInvoke<DesktopServerStatus>('desktop_server_status');
    if (!call) {
      setDesktopStatus({
        available: false,
        running: false,
        managed: false,
        endpoint: 'http://localhost:8787',
        dataFile: null,
        message: '当前是浏览器 Web 模式，不能在线启动本机服务。',
      });
      return;
    }
    try {
      const s = await call;
      setDesktopStatus(s);
    } catch (e) {
      setDesktopStatus({
        available: false,
        running: false,
        managed: false,
        endpoint: 'http://localhost:8787',
        dataFile: null,
        message: `桌面服务状态读取失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, []);

  useEffect(() => {
    void refreshDesktopStatus();
  }, [refreshDesktopStatus]);

  async function controlDesktopServer(command: 'desktop_start_server' | 'desktop_stop_server') {
    if (command === 'desktop_start_server' && !lanExposureAccepted) {
      setMessage('请先确认局域网暴露与防火墙提示。');
      return;
    }
    const call = tauriInvoke<DesktopServerStatus>(command);
    if (!call) return;
    setDesktopBusy(true);
    try {
      const s = await call;
      setDesktopStatus(s);
      setMessage(s.message);
    } catch (e) {
      setMessage(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDesktopBusy(false);
    }
  }

  async function checkHealth() {
    setBusy(true);
    setMessage('');
    try {
      if (!endpoint) throw new Error('请先在“账号与同步”中选择服务器');
      const res = await fetch(`${normalizeSyncBaseUrl(endpoint)}/api/health`, { redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { serverId?: string; syncEnabled?: boolean; webEnabled?: boolean; registrationMode?: string; basePath?: string };
      setMessage(`服务器在线：${body.serverId ?? 'unknown'} · 路径 ${body.basePath || '/'} · 同步 ${body.syncEnabled ? '开启' : '关闭'} · Web ${body.webEnabled ? '开启' : '关闭'} · 管理操作使用当前管理员账号会话`);
    } catch (e) {
      setStatus(null);
      setMessage(`连接失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setMessage('');
    try {
      if (!token.trim()) {
        await checkHealth();
        setMessage('服务器在线；请先在“账号与同步”中登录管理员账号。');
        return;
      }
      const utcRange = localDateRangeToUtc(logRange);
      const logParams = new URLSearchParams({ limit: '5000' });
      if (logLevel !== 'all') logParams.set('level', logLevel);
      if (utcRange.since) logParams.set('from', utcRange.since);
      if (utcRange.until) logParams.set('until', utcRange.until);
      const logQuery = `/api/admin/logs?${logParams.toString()}`;
      const [s, u, i, l, b] = await Promise.all([
        adminFetch<AdminStatus>(connection!, token, '/api/admin/status'),
        adminFetch<{ users: AdminUser[] }>(connection!, token, '/api/admin/users?limit=500'),
        adminFetch<{ invites: AdminInvite[] }>(connection!, token, '/api/admin/invites'),
        adminFetch<{ logs: ServerLog[] }>(connection!, token, logQuery),
        adminFetch<{ users: AdminBlobUser[] }>(connection!, token, '/api/admin/quotas'),
      ]);
      setStatus(s);
      setMode(s.registrationMode);
      setUsers(u.users);
      setInvites(i.invites);
      setLogs(l.logs);
      setBlobUsers(b.users);
      setQuotaGb(Object.fromEntries(b.users.map((row) => [row.username, (row.quotaBytes / 1024 ** 3).toFixed(2)])));
      setCommitQuotaGb(Object.fromEntries(u.users.map((row) => [row.username, (row.commitQuotaBytes / 1024 ** 3).toFixed(2)])));
      setMessage('已刷新');
    } catch (e) {
      setMessage(`连接失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveRegistrationMode() {
    setBusy(true);
    try {
      await adminFetch<{ mode: RegistrationMode }>(connection!, token, '/api/admin/registration', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      await refresh();
    } catch (e) {
      setMessage(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  async function createInvite() {
    setBusy(true);
    try {
      await adminFetch<{ invite: AdminInvite }>(connection!, token, '/api/admin/invites', {
        method: 'POST',
        body: JSON.stringify({ code: newInvite.trim() || undefined }),
      });
      setNewInvite('');
      await refresh();
    } catch (e) {
      setMessage(`创建失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  async function setUserDisabled(user: AdminUser, disabled: boolean) {
    setBusy(true);
    try {
      await adminFetch(connection!, token, `/api/admin/users/${encodeURIComponent(user.username)}/disable`, {
        method: 'POST',
        body: JSON.stringify({ disabled }),
      });
      await refresh();
    } catch (e) {
      setMessage(`操作失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  async function loadDevices(user: AdminUser) {
    setBusy(true);
    try {
      const response = await adminFetch<{ devices: AdminDevice[] }>(
        connection!,
        token,
        `/api/admin/users/${encodeURIComponent(user.username)}/devices`,
      );
      setDeviceOwner(user.username);
      setDevices(response.devices);
      setMessage(`已读取 ${user.username} 的设备会话`);
    } catch (e) {
      setMessage(`设备读取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revokeDevice(device: AdminDevice) {
    setBusy(true);
    try {
      await adminFetch(connection!, token, `/api/admin/sessions/${encodeURIComponent(device.id)}/revoke`, {
        method: 'POST',
        body: '{}',
      });
      const owner = users.find((user) => user.username === device.username);
      if (owner) await loadDevices(owner);
      else await refresh();
      setMessage(`已撤销设备“${device.deviceName}”`);
    } catch (e) {
      setMessage(`撤销失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  async function setInviteDisabled(invite: AdminInvite, disabled: boolean) {
    setBusy(true);
    try {
      await adminFetch(connection!, token, `/api/admin/invites/${encodeURIComponent(invite.code)}/disable`, {
        method: 'POST',
        body: JSON.stringify({ disabled }),
      });
      await refresh();
    } catch (e) {
      setMessage(`操作失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  async function saveBlobQuota(user: AdminBlobUser) {
    const value = quotaGb[user.username]?.trim() ?? '';
    const gigabytes = Number(value);
    if (!value || !Number.isFinite(gigabytes) || gigabytes <= 0) {
      setMessage('配额必须是大于 0 的 GB 数值');
      return;
    }
    setBusy(true);
    try {
      await adminFetch(connection!, token, `/api/admin/quotas/${encodeURIComponent(user.username)}/blobs`, {
        method: 'POST',
        body: JSON.stringify({ quotaBytes: Math.round(gigabytes * 1024 ** 3) }),
      });
      await refresh();
    } catch (e) {
      setMessage(`配额保存失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  async function verifyBlobStorage() {
    setBusy(true);
    try {
      const response = await adminFetch<{ verification: { checkedObjects: number; checkedChunks: number; issues: { detail: string }[] } }>(connection!, token, '/api/admin/quotas/blobs/verify', {
        method: 'POST',
        body: '{}',
      });
      const verification = response.verification;
      const note = verification.issues.length
        ? `附件校验发现 ${verification.issues.length} 个问题：${verification.issues[0]?.detail ?? '未知问题'}`
        : `附件校验通过：${verification.checkedObjects} 个对象、${verification.checkedChunks} 个分块`;
      await refresh();
      setMessage(note);
    } catch (e) {
      setMessage(`附件校验失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  async function saveCommitQuota(user: AdminUser) {
    const value = commitQuotaGb[user.username]?.trim() ?? '';
    const gigabytes = Number(value);
    if (!value || !Number.isFinite(gigabytes) || gigabytes <= 0) {
      setMessage('提交配额必须是大于 0 的 GB 数值');
      return;
    }
    setBusy(true);
    try {
      await adminFetch(connection!, token, `/api/admin/quotas/${encodeURIComponent(user.username)}/commits`, {
        method: 'POST',
        body: JSON.stringify({ commitQuotaBytes: Math.round(gigabytes * 1024 ** 3) }),
      });
      await refresh();
    } catch (e) {
      setMessage(`提交配额保存失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  async function verifyDatabaseStorage() {
    setBusy(true);
    try {
      const response = await adminFetch<{ verification: { ok: boolean; result: string; journalMode: string; schemaVersion: number } }>(connection!, token, '/api/admin/database/verify');
      const verification = response.verification;
      await refresh();
      setMessage(verification.ok
        ? `数据库校验通过：SQLite ${verification.journalMode.toUpperCase()} · 结构 v${verification.schemaVersion}`
        : `数据库校验失败：${verification.result}`);
    } catch (e) {
      setMessage(`数据库校验失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div className="zc-server-admin" style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 980 }}>
      <div style={card}>
        <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>本机服务器</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
              {desktopStatus?.message ?? '正在检查本机服务能力'}
            </div>
          </div>
          <StatePill
            label={desktopStatus?.running ? '已启用' : desktopStatus?.available ? '未启用' : 'Web 模式'}
            tone={desktopStatus?.running ? 'ok' : 'muted'}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => controlDesktopServer('desktop_start_server')}
            disabled={desktopBusy || !desktopStatus?.available || desktopStatus?.running}
            style={primary}
          >
            启动本机服务器
          </button>
          <button
            onClick={() => controlDesktopServer('desktop_stop_server')}
            disabled={desktopBusy || !desktopStatus?.available || !desktopStatus?.running}
            style={outline}
          >
            停止本机服务器
          </button>
          <button onClick={refreshDesktopStatus} disabled={desktopBusy} style={outline}>检查状态</button>
          {!desktopStatus?.available && (
            <code style={{ fontSize: 12, color: 'var(--fg-muted)' }}>npm run start:server</code>
          )}
        </div>
        {!desktopStatus?.running && desktopStatus?.available && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: 12, lineHeight: 1.6, color: 'var(--negative)' }}>
            <input
              type="checkbox"
              checked={lanExposureAccepted}
              onChange={(event) => {
                const accepted = event.target.checked;
                setLanExposureAccepted(accepted);
                try {
                  if (accepted) localStorage.setItem(LAN_EXPOSURE_ACK_KEY, 'accepted');
                  else localStorage.removeItem(LAN_EXPOSURE_ACK_KEY);
                } catch {
                  // The native command still checks this in-memory acknowledgement.
                }
              }}
            />
            我了解：服务器监听 0.0.0.0:8787，同一局域网设备可以访问，Windows 可能显示防火墙提示；应用不会代替我创建防火墙规则。
          </label>
        )}
        {desktopStatus?.dataFile && (
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 10 }}>
            数据文件：{desktopStatus.dataFile}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 14 }}>服务器连接</div>
        <div className="zc-server-admin-connection" style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'end' }}>
          <div>
            <label className="zc-label">当前服务器</label>
            <div style={{ minHeight: 38, display: 'flex', alignItems: 'center', padding: '0 11px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', color: 'var(--fg-muted)', fontSize: 12 }}>
              {connection ? `${connection.alias} · ${endpoint}` : '请先在“账号与同步”中新增并选择服务器'}
            </div>
          </div>
          <button onClick={checkHealth} disabled={busy} style={outline}>检查</button>
          <button onClick={refresh} disabled={busy || !connection || !token} style={primary}>载入管理后台</button>
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-subtle)' }}>
          地址在“账号与同步”中编辑；这里复用当前账号会话。成员账号会收到 403，只有管理员可以载入管理数据。
        </div>
        {message && <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: message.includes('失败') ? 'var(--negative)' : 'var(--positive)' }}>{message}</div>}
      </div>

      {status && (
        <div style={card}>
          <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>运行状态</div>
            <button type="button" disabled={busy} onClick={() => void verifyDatabaseStorage()} style={outline}>校验数据库</button>
          </div>
          <div className="zc-server-admin-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <Metric label="服务器 ID" value={compact(status.serverId)} />
            <Metric label="服务路径" value={status.basePath || '/'} />
            <Metric label="同步 API" value={status.syncEnabled ? '开启' : '关闭'} tone={status.syncEnabled ? 'ok' : 'muted'} />
            <Metric label="Web" value={status.webEnabled ? '开启' : '关闭'} tone={status.webEnabled ? 'ok' : 'muted'} />
            <Metric label="注册策略" value={modeLabel(status.registrationMode)} />
            <Metric label="用户" value={`${status.userCount}`} />
            <Metric label="已禁用" value={`${status.disabledUserCount}`} tone={status.disabledUserCount ? 'bad' : 'muted'} />
            <Metric label="邀请码" value={`${status.inviteCount}`} />
            <Metric label="加密提交" value={`${status.commitCount}`} />
            <Metric label="提交存储" value={formatBytes(status.commitBytes)} />
            <Metric label="在线设备会话" value={`${status.activeSessionCount}`} />
            <Metric label="数据库" value={`SQLite ${status.journalMode.toUpperCase()} · v${status.schemaVersion}`} tone={status.journalMode.toLowerCase() === 'wal' ? 'ok' : 'bad'} />
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--fg-subtle)' }}>数据库：{status.databaseFile}</div>
          <div style={{ marginTop: 5, fontSize: 12, color: 'var(--fg-subtle)' }}>数据目录：{status.dataDir}</div>
        </div>
      )}

      {status && (
        <div style={card}>
          <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>附件存储</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>服务器只能看到加密对象、容量和状态，不能读取文件名、类型或正文。</div>
            </div>
            <button type="button" disabled={busy} onClick={() => void verifyBlobStorage()} style={outline}>校验全部分块</button>
          </div>
          <Table headers={['用户', '有效对象', '已用 / 配额', '配额（GB）', '回收区', '上传暂存']}>
            {blobUsers.map((row) => (
              <tr key={row.username}>
                <td style={tdStyle}>{row.username}</td>
                <td style={tdStyle}>{row.objectCount} · {formatBytes(row.usedBytes)}</td>
                <td style={tdStyle}>{formatBytes(row.usedBytes)} / {formatBytes(row.quotaBytes)}</td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', gap: 6, minWidth: 150 }}>
                    <input aria-label={`${row.username} 附件配额 GB`} className="zc-input" type="number" min="0.001" step="0.25" value={quotaGb[row.username] ?? ''} onChange={(event) => setQuotaGb((current) => ({ ...current, [row.username]: event.target.value }))} style={{ minWidth: 80 }} />
                    <button type="button" disabled={busy} onClick={() => void saveBlobQuota(row)} style={outline}>保存</button>
                  </div>
                </td>
                <td style={tdStyle}>{row.trashCount} · {formatBytes(row.trashBytes)}</td>
                <td style={{ ...tdStyle, color: row.stagingCount ? 'var(--negative)' : 'var(--fg-subtle)' }}>{row.stagingCount} · {formatBytes(row.stagingBytes)}</td>
              </tr>
            ))}
            {blobUsers.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={6}>暂无附件对象</td></tr>}
          </Table>
        </div>
      )}

      {status && (
        <div style={card}>
          <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>服务日志 <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{logs.length}</span></div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>记录登录、注册、同步、管理操作和拒绝请求。</div>
            </div>
            <div className="zc-server-admin-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select className="zc-select" value={logLevel} onChange={(e) => setLogLevel(e.target.value as typeof logLevel)} style={{ width: 110 }}>
                <option value="all">全部</option>
                <option value="info">信息</option>
                <option value="warn">警告</option>
                <option value="error">错误</option>
              </select>
              <button onClick={refresh} disabled={busy} style={outline}>刷新日志</button>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}><DateRangeBar value={logRange} onChange={setLogRange} compact /></div>
          <Table headers={['时间', '级别', '动作', '用户', '来源', '状态', '详情']}>
            {logs.map((l) => (
              <tr key={l.id}>
                <td style={tdStyle}>{fmt(l.at)}</td>
                <td style={{ ...tdStyle, color: levelColor(l.level), fontWeight: 800 }}>{levelLabel(l.level)}</td>
                <td style={tdStyle}>{actionLabel(l.action)}</td>
                <td style={tdStyle}>{l.username ?? '—'}</td>
                <td style={tdStyle}>{l.ip ?? '—'}</td>
                <td style={tdStyle}>{l.status ?? '—'}</td>
                <td style={{ ...tdStyle, maxWidth: 260, color: 'var(--fg-subtle)' }}>{detailText(l)}</td>
              </tr>
            ))}
            {logs.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={7}>暂无日志</td></tr>}
          </Table>
        </div>
      )}

      {status && (
        <div style={card}>
          <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>注册与邀请</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>邀请码使用后会绑定到注册用户。</div>
            </div>
            <div className="zc-server-admin-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select className="zc-select" value={mode} onChange={(e) => setMode(e.target.value as RegistrationMode)} style={{ width: 130 }}>
                <option value="open">开放注册</option>
                <option value="invite">邀请码</option>
                <option value="closed">关闭注册</option>
              </select>
              <button onClick={saveRegistrationMode} disabled={busy} style={primary}>保存</button>
            </div>
          </div>
          <div className="zc-server-admin-invite" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input className="zc-input" value={newInvite} onChange={(e) => setNewInvite(e.target.value)} placeholder="留空自动生成邀请码" />
            <button onClick={createInvite} disabled={busy} style={outline}>创建邀请码</button>
          </div>
          <Table headers={['邀请码', '状态', '使用者', '创建时间', '使用时间', '']}>
            {invites.map((i) => (
              <tr key={i.code}>
                <td style={tdStyle}><code>{i.code}</code></td>
                <td style={tdStyle}>{i.disabled ? '已禁用' : i.usedBy ? '已使用' : '可用'}</td>
                <td style={tdStyle}>{i.usedBy ?? '—'}</td>
                <td style={tdStyle}>{fmt(i.createdAt)}</td>
                <td style={tdStyle}>{fmt(i.usedAt)}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>
                  <button onClick={() => setInviteDisabled(i, !i.disabled)} disabled={busy || Boolean(i.usedBy)} style={outline}>
                    {i.disabled ? '启用' : '禁用'}
                  </button>
                </td>
              </tr>
            ))}
            {invites.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={6}>暂无邀请码</td></tr>}
          </Table>
        </div>
      )}

      {status && (
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>用户</div>
          <Table headers={['用户名', '角色 / 状态', '设备', '提交', '提交存储 / 配额', '配额（GB）', '最后登录', '']}>
            {users.map((u) => (
              <tr key={u.username}>
                <td style={tdStyle}>{u.username}</td>
                <td style={{ ...tdStyle, color: u.disabled ? 'var(--negative)' : 'var(--positive)', fontWeight: 700 }}>{u.role === 'admin' ? '管理员' : '成员'} · {u.disabled ? '已禁用' : '正常'}</td>
                <td style={tdStyle}>{u.activeDeviceCount}</td>
                <td style={tdStyle}>{u.commitCount}</td>
                <td style={tdStyle}>{formatBytes(u.commitBytes)} / {formatBytes(u.commitQuotaBytes)}</td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', gap: 6, minWidth: 150 }}>
                    <input aria-label={`${u.username} 提交配额 GB`} className="zc-input" type="number" min="0.001" step="0.25" value={commitQuotaGb[u.username] ?? ''} onChange={(event) => setCommitQuotaGb((current) => ({ ...current, [u.username]: event.target.value }))} style={{ minWidth: 80 }} />
                    <button type="button" disabled={busy} onClick={() => void saveCommitQuota(u)} style={outline}>保存</button>
                  </div>
                </td>
                <td style={tdStyle}>{fmt(u.lastLoginAt)}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                    <button onClick={() => void loadDevices(u)} disabled={busy} style={outline}>设备</button>
                    <button onClick={() => setUserDisabled(u, !u.disabled)} disabled={busy || u.role === 'admin'} title={u.role === 'admin' ? '不能禁用服务器所有者' : undefined} style={u.disabled ? outline : danger}>
                      {u.disabled ? '启用' : '禁用'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={8}>暂无用户</td></tr>}
          </Table>
          {deviceOwner && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{deviceOwner} 的设备会话</div>
              <Table headers={['设备', '状态', '最后活动', '来源', '会话到期', '']}>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 700 }}>{device.deviceName}</div>
                      <div style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>{compact(device.deviceId)}</div>
                    </td>
                    <td style={{ ...tdStyle, color: device.active ? 'var(--positive)' : 'var(--fg-subtle)' }}>
                      {device.active ? '有效' : device.revokedAt ? '已撤销' : '已过期'}
                    </td>
                    <td style={tdStyle}>{fmt(device.lastSeenAt)}</td>
                    <td style={tdStyle}>{device.lastIp ?? '—'}</td>
                    <td style={tdStyle}>{fmt(device.expiresAt)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <button type="button" disabled={busy || !device.active} onClick={() => void revokeDevice(device)} style={danger}>撤销</button>
                    </td>
                  </tr>
                ))}
                {devices.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={6}>暂无设备会话</td></tr>}
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric(props: { label: string; value: string; tone?: 'ok' | 'bad' | 'muted' }) {
  const color = props.tone === 'ok' ? 'var(--positive)' : props.tone === 'bad' ? 'var(--negative)' : props.tone === 'muted' ? 'var(--fg-subtle)' : 'var(--fg)';
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--surface-2)', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 800, marginBottom: 5 }}>{props.label}</div>
      <div style={{ fontSize: 15, color, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.value}</div>
    </div>
  );
}

function StatePill(props: { label: string; tone: 'ok' | 'muted' }) {
  return (
    <span style={{
      border: '1px solid var(--border)',
      borderRadius: 999,
      padding: '6px 10px',
      fontSize: 12,
      fontWeight: 800,
      color: props.tone === 'ok' ? 'var(--positive)' : 'var(--fg-subtle)',
      background: 'var(--surface-2)',
      whiteSpace: 'nowrap',
    }}>
      {props.label}
    </span>
  );
}

function Table(props: { headers: string[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{props.headers.map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}

function modeLabel(mode: RegistrationMode): string {
  if (mode === 'invite') return '邀请码';
  if (mode === 'closed') return '关闭';
  return '开放';
}

function levelLabel(level: ServerLog['level']): string {
  if (level === 'warn') return '警告';
  if (level === 'error') return '错误';
  return '信息';
}

function levelColor(level: ServerLog['level']): string {
  if (level === 'warn') return '#b7791f';
  if (level === 'error') return 'var(--negative)';
  return 'var(--fg-muted)';
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    admin_disabled: '管理未启用',
    admin_unauthorized: '管理拒绝',
    user_disabled: '用户状态',
    user_enabled: '用户状态',
    invite_created: '创建邀请码',
    invite_disabled: '邀请码状态',
    invite_enabled: '邀请码状态',
    registration_mode_changed: '注册策略',
    register_denied: '注册拒绝',
    register_conflict: '注册冲突',
    register_failed: '注册失败',
    register_success: '注册成功',
    login_failed: '登录失败',
    login_disabled: '禁用用户登录',
    login_success: '登录成功',
    refresh_failed: '会话刷新失败',
    device_revoked: '撤销设备',
    logout: '退出登录',
    rate_limited: '频率限制',
    replica_bound: '绑定账本副本',
    commits_pushed: '提交同步',
    blob_upload_started: '附件上传开始',
    blob_deduplicated: '附件去重命中',
    blob_upload_completed: '附件上传完成',
    blob_trashed: '附件移入回收区',
    blob_restored: '附件恢复',
    blob_request_failed: '附件请求失败',
    request_failed: '请求失败',
    blob_quota_changed: '附件配额',
    commit_quota_changed: '提交配额',
    blob_verification: '附件校验',
  };
  return labels[action] ?? action;
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function detailText(log: ServerLog): string {
  const payload = { ...log.detail };
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return log.message;
  const text = entries.map(([key, value]) => `${key}=${String(value)}`).join(' · ');
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

const outline = { padding: '8px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg-muted)', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' } as const;
const primary = { ...outline, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff' } as const;
const danger = { ...outline, border: '1px solid var(--negative)', color: 'var(--negative)' } as const;
