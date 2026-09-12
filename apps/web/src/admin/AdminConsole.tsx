import { useEffect, useState, type ReactNode } from 'react';
import type { SyncAuthMe } from '@zichan/db';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { AdminClient, AdminError } from './client.js';
import { PasswordResetIssuer } from './PasswordResetIssuer.js';

type Role = SyncAuthMe['role'];
type Mode = 'open' | 'invite' | 'closed';
interface User {
  accountId: string; username: string; role: Role; disabled: boolean;
  activeDeviceCount: number; commitBytes: number; commitQuotaBytes: number;
  createdAt: string; lastLoginAt?: string;
}
interface Device { id: string; deviceName: string; active: boolean; lastSeenAt: string; lastIp?: string; expiresAt: string; username?: string; accountId?: string; role?: Role }
interface Invite { code: string; disabled: boolean; usedBy?: string; expiresAt?: string }
interface Status {
  serverId: string; userCount: number; disabledUserCount: number; activeSessionCount: number;
  commitBytes: number; schemaVersion: number; registrationMode: Mode; journalMode: string;
}
interface Usage { quotaBytes: number; usedBytes: number; objectCount: number; trashBytes: number; stagingBytes: number }
interface Audit { id: number; at: string; action: string; actorAccountId: string; targetAccountId?: string; before: unknown; after: unknown }
type Confirm = (title: string, description: string, action: () => Promise<unknown>) => void;
interface PaneProps { client: AdminClient; revision: number; account: SyncAuthMe; confirm: Confirm }
const roleName = (role: Role) => role === 'owner' ? '所有者' : role === 'admin' ? '管理员' : '普通用户';
const bytes = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;
const date = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const panel = { padding: 20, borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', marginTop: 16 };

function message(error: unknown): string {
  if (error instanceof AdminError) {
    const labels: Record<string, string> = { RECENT_LOGIN_REQUIRED: '敏感操作需要最近 5 分钟内的登录。请退出管理后台并重新登录，再执行此操作。', PROTECTED_ACCOUNT: '此账号受保护，你无权修改。', OWNER_REQUIRED: '仅服务器所有者可以执行此操作。', ACCOUNT_DISABLED: '请先启用该账号。', INVITE_USED: '邀请码已使用，不能再改变状态。' };
    return labels[error.code] ?? (error.code === 'REQUEST_TIMEOUT' ? error.message : `操作未完成（HTTP ${error.status}）：${error.message}`);
  }
  return error instanceof Error ? error.message : String(error);
}

function useData<T>(client: AdminClient, path: string, revision: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData(undefined); setError('');
    void client.request<T>(path).then((result) => { if (active) setData(result); }).catch((reason) => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [client, path, revision]);
  return { data, error };
}

function Result({ error, loading, children }: { error: string; loading: boolean; children: ReactNode }) {
  if (error) return <p role="alert">{error}</p>;
  if (loading) return <p role="status">正在读取…</p>;
  return <>{children}</>;
}
function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}><thead><tr>{headers.map((label) => <th key={label} style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>{label}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
function Cell({ children }: { children: ReactNode }) { return <td style={{ padding: 12, borderBottom: '1px solid var(--border)', overflowWrap: 'anywhere' }}>{children}</td>; }

export function AdminConsole({ client, account }: { client: AdminClient; account: SyncAuthMe }) {
  const tabs = ['概览', '用户管理', '注册与邀请', '设备与安全', '存储维护', '审计日志'] as const;
  const [tab, setTab] = useState<typeof tabs[number]>('概览');
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<{ title: string; description: string; action: () => Promise<unknown> }>();
  const [notice, setNotice] = useState('');
  const confirm: Confirm = (title, description, action) => setPending({ title, description, action });
  const props = { client, account, revision, confirm };
  return <>
    <nav aria-label="服务器管理导航" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{tabs.map((name) => <button key={name} aria-pressed={tab === name} onClick={() => { setTab(name); setNotice(''); }} style={{ padding: '10px 16px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: tab === name ? 'var(--accent)' : 'var(--surface)', color: tab === name ? '#fff' : 'var(--fg)' }}>{name}</button>)}<button onClick={() => setRevision((value) => value + 1)}>刷新</button></nav>
    {notice && <p role="status">{notice}</p>}
    <section style={panel}>
      {tab === '概览' && <Overview {...props} />}
      {tab === '用户管理' && <Users {...props} />}
      {tab === '注册与邀请' && <Invites {...props} />}
      {tab === '设备与安全' && <Security {...props} />}
      {tab === '存储维护' && <Storage {...props} />}
      {tab === '审计日志' && <AuditLog {...props} />}
    </section>
    {pending && <ConfirmDialog title={pending.title} confirmLabel="确认执行" tone="danger" onCancel={() => setPending(undefined)} onConfirm={async () => {
      try { await pending.action(); setPending(undefined); setNotice('操作成功。'); setRevision((value) => value + 1); }
      catch (error) { throw new Error(message(error)); }
    }}><p>{pending.description}</p></ConfirmDialog>}
  </>;
}

function Overview({ client, revision }: PaneProps) {
  const { data, error } = useData<Status>(client, '/status', revision);
  return <><h2>服务器概览</h2><Result error={error} loading={!data}>{data && <>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>{[
      ['账号总数', data.userCount], ['已禁用账号', data.disabledUserCount], ['有效会话', data.activeSessionCount], ['加密提交用量', bytes(data.commitBytes)], ['数据库版本', data.schemaVersion], ['存储模式', data.journalMode],
    ].map(([label, value]) => <div key={label} style={panel}><div>{label}</div><strong style={{ fontSize: 'var(--fs-display)' }}>{value}</strong></div>)}</div>
    <p>服务器 ID：{data.serverId}</p><p>“有效会话”指尚未撤销且未过期的登录，不等于此刻在线人数。服务器管理不会解密用户账本。</p>
  </>}</Result></>;
}

function Users(props: PaneProps) {
  const { client, revision, account, confirm } = props;
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [state, setState] = useState('');
  const [filter, setFilter] = useState('');
  const [cursors, setCursors] = useState(['']);
  const [selected, setSelected] = useState<User>();
  const cursor = cursors[cursors.length - 1]!;
  const { data, error } = useData<{ users: User[]; nextCursor?: string }>(client, `/users?limit=25&cursor=${encodeURIComponent(cursor)}&${filter}`, revision);
  const manageable = (user: User) => user.role !== 'owner' && (account.role === 'owner' || user.role === 'member');
  const quotaManageable = (user: User) => account.role === 'owner' || user.role === 'member';
  return <><h2>用户管理</h2>
    <p>{account.role === 'owner' ? '所有者可调整所有账号（包括自己）的配额；所有者不能被禁用或降权。' : '管理员可管理普通用户的状态、设备与配额；管理员和所有者账号由所有者管理。'}</p>
    <form onSubmit={(event) => { event.preventDefault(); setCursors(['']); setSelected(undefined); setFilter(new URLSearchParams({ search, role, state }).toString()); }} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
      <input aria-label="搜索账号" className="zc-input" style={{ width: 250 }} placeholder="用户名或完整 accountId" value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label="角色筛选" value={role} onChange={(event) => setRole(event.target.value)}><option value="">全部角色</option><option value="owner">所有者</option><option value="admin">管理员</option><option value="member">普通用户</option></select>
      <select aria-label="状态筛选" value={state} onChange={(event) => setState(event.target.value)}><option value="">全部状态</option><option value="enabled">正常</option><option value="disabled">已禁用</option></select><button>搜索</button>
    </form>
    <Result error={error} loading={!data}><Table headers={['账号', '角色 / 状态', '有效会话', '提交用量', '最近登录', '操作']}>
      {data?.users.map((user) => <tr key={user.accountId}><Cell><strong>{user.username}</strong><small style={{ display: 'block', maxWidth: 220 }}>{user.accountId}</small></Cell><Cell>{roleName(user.role)} · {user.disabled ? '已禁用' : '正常'}</Cell><Cell>{user.activeDeviceCount}</Cell><Cell>{bytes(user.commitBytes)} / {bytes(user.commitQuotaBytes)}</Cell><Cell>{date(user.lastLoginAt)}</Cell><Cell><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button disabled={!quotaManageable(user)} title={!quotaManageable(user) ? '此账号的配额需由所有者调整' : undefined} onClick={() => setSelected(user)}>设备与配额</button>
        <button disabled={!manageable(user)} onClick={() => confirm(`${user.disabled ? '启用' : '禁用'} ${user.username}`, user.disabled ? '启用后用户须重新登录，已撤销的会话不会恢复。' : '立即撤销此账号全部会话；保留加密账本，不删除数据。', () => client.request(`/accounts/${user.accountId}/state`, { disabled: !user.disabled }))}>{user.disabled ? '启用' : '禁用'}</button>
        {account.role === 'owner' && user.role !== 'owner' && <button disabled={user.disabled} onClick={() => confirm(`${user.role === 'admin' ? '撤销' : '授予'}管理员：${user.username}`, '角色改变后撤销该账号现有会话，用户须重新登录。此操作要求所有者最近 5 分钟内登录。', () => client.request(`/accounts/${user.accountId}/role`, { role: user.role === 'admin' ? 'member' : 'admin' }))}>{user.role === 'admin' ? '撤销管理员' : '授予管理员'}</button>}
      </div></Cell></tr>)}
    </Table>{data?.users.length === 0 && <p>没有匹配账号。</p>}</Result>
    <div style={{ display: 'flex', gap: 12, marginTop: 16 }}><button disabled={cursors.length === 1 || !data} onClick={() => { setSelected(undefined); setCursors((rows) => rows.slice(0, -1)); }}>上一页</button><span>第 {cursors.length} 页</span><button disabled={!data?.nextCursor} onClick={() => { setSelected(undefined); setCursors((rows) => [...rows, data!.nextCursor!]); }}>下一页</button></div>
    {selected && data?.users.filter((user) => user.accountId === selected.accountId && quotaManageable(user)).map((user) => <UserDetail key={`${user.accountId}:${revision}`} {...props} user={user} onClose={() => setSelected(undefined)} />)}
  </>;
}

function UserDetail({ client, revision, confirm, user, onClose }: PaneProps & { user: User; onClose: () => void }) {
  const { data, error } = useData<{ devices: Device[] }>(client, `/accounts/${user.accountId}/devices`, revision);
  const usage = useData<Usage>(client, `/accounts/${user.accountId}/usage`, revision);
  const [commitMiB, setCommitMiB] = useState(String(user.commitQuotaBytes / 1024 ** 2));
  const [blobMiB, setBlobMiB] = useState('');
  const [quotaError, setQuotaError] = useState('');
  useEffect(() => { if (usage.data) setBlobMiB(String(usage.data.quotaBytes / 1024 ** 2)); }, [usage.data]);
  function resetQuota(kind: 'commits' | 'blobs') {
    if (kind === 'blobs' && !usage.data) return;
    confirm(`恢复 ${user.username} 的默认配额`, '恢复服务器默认上限，不删除已有数据。', () => client.request(`/accounts/${user.accountId}/${kind}`, kind === 'commits' ? { commitQuotaBytes: null } : { quotaBytes: null }));
  }
  function quota(kind: 'commits' | 'blobs', value: string) {
    if (kind === 'blobs' && !usage.data) return;
    const amount = Number(value) * 1024 ** 2;
    if (!value.trim() || !Number.isSafeInteger(amount) || amount < 1024 ** 2 || amount > 1024 ** 4) { setQuotaError('配额必须在 1 至 1048576 MiB 之间，且换算后为整数 Byte。'); return; }
    setQuotaError('');
    confirm(`修改 ${user.username} 的${kind === 'commits' ? '提交' : '附件'}配额`, `新配额 ${bytes(amount)}。降低配额不会删除已有数据，但会限制后续上传。`, () => client.request(`/accounts/${user.accountId}/${kind}`, kind === 'commits' ? { commitQuotaBytes: amount } : { quotaBytes: amount }));
  }
  return <section style={panel} aria-label={`${user.username} 的设备与配额`}><button onClick={onClose} style={{ float: 'right' }}>关闭详情</button><h3>{user.username} · 设备与配额</h3><p>{user.accountId}</p>
    {quotaError && <p role="alert">{quotaError}</p>}
    {user.role !== 'owner' && !user.disabled && <PasswordResetIssuer client={client} accountId={user.accountId} username={user.username} />}
    <p>提交已用 {bytes(user.commitBytes)} / {bytes(user.commitQuotaBytes)}。恢复默认仅改变上限，不会清理数据；超过配额后会限制新上传。</p>
    <button onClick={() => resetQuota('commits')}>恢复默认提交配额</button><button disabled={!usage.data} onClick={() => resetQuota('blobs')}>恢复默认附件配额</button>
    <form onSubmit={(event) => { event.preventDefault(); quota('commits', commitMiB); }}><label>提交配额（MiB）<input aria-label="提交配额 MiB" type="number" min="1" max="1048576" step="1" required value={commitMiB} onChange={(event) => setCommitMiB(event.target.value)} /></label><button>保存提交配额</button></form>
    <Result error={usage.error} loading={!usage.data}>{usage.data && <p>附件已用 {bytes(usage.data.usedBytes)} / {bytes(usage.data.quotaBytes)}；回收区 {bytes(usage.data.trashBytes)}；上传暂存 {bytes(usage.data.stagingBytes)}</p>}</Result>
    <form onSubmit={(event) => { event.preventDefault(); quota('blobs', blobMiB); }}><label>附件配额（MiB）<input aria-label="附件配额 MiB" disabled={!usage.data} type="number" min="1" max="1048576" step="1" required value={blobMiB} onChange={(event) => setBlobMiB(event.target.value)} /></label><button disabled={!usage.data}>保存附件配额</button></form>
    {usage.error && <p>附件配额尚未读取成功，已暂停修改；请点击顶部“刷新”重试。</p>}
    <Result error={error} loading={!data}><DeviceTable devices={data?.devices ?? []} revoke={user.role === 'owner' ? undefined : (device) => confirm(`撤销设备 ${device.deviceName}`, `立即使 ${user.username} 的此设备会话失效。保留本机及服务器账本。`, () => client.request(`/sessions/${device.id}/revoke`, {}))} /></Result>
  </section>;
}

function DeviceTable({ devices, revoke }: { devices: Device[]; revoke?: (device: Device) => void }) {
  return <><Table headers={['设备 / 所属账号', '状态', '最后活动', '来源 IP', '到期', '操作']}>{devices.map((device) => <tr key={device.id}><Cell>{device.deviceName}{device.username && <small>{device.username}{device.role ? ` · ${roleName(device.role)}` : ''}</small>}</Cell><Cell>{device.active ? '有效' : '已过期或撤销'}</Cell><Cell>{date(device.lastSeenAt)}</Cell><Cell>{device.lastIp ?? '—'}</Cell><Cell>{date(device.expiresAt)}</Cell><Cell>{revoke && device.role !== 'owner' && <button disabled={!device.active} onClick={() => revoke(device)}>撤销会话</button>}{device.role === 'owner' && '所有者会话受保护'}</Cell></tr>)}</Table>{devices.length === 0 && <p>本页没有设备会话；如有下一页，可继续查看其他账号。</p>}</>;
}

function Invites({ client, revision, account, confirm }: PaneProps) {
  const [state, setState] = useState('');
  const [cursors, setCursors] = useState(['']);
  const cursor = cursors[cursors.length - 1]!;
  const { data, error } = useData<{ invites: Invite[]; nextCursor?: string }>(client, `/invites?limit=25&state=${state}&cursor=${encodeURIComponent(cursor)}`, revision);
  const status = useData<{ mode: Mode }>(client, '/registration', revision);
  const [mode, setMode] = useState<Mode>('invite');
  useEffect(() => { if (status.data) setMode(status.data.mode); }, [status.data]);
  const [days, setDays] = useState('7');
  return <><h2>注册与邀请</h2><Result error={status.error} loading={!status.data}><p>当前策略：{status.data?.mode === 'open' ? '开放注册' : status.data?.mode === 'closed' ? '关闭注册' : '仅邀请注册'}</p></Result>
    {account.role === 'owner' ? <div><select aria-label="新注册策略" disabled={!status.data} value={mode} onChange={(event) => setMode(event.target.value as Mode)}><option value="invite">仅邀请注册</option><option value="closed">关闭注册</option><option value="open">开放注册</option></select><button disabled={!status.data || mode === status.data.mode} onClick={() => confirm('修改注册策略', mode === 'open' ? '任何访客均可注册普通账号。已有账号及管理员权限不变。' : '只影响后续注册，不禁用已有账号。', () => client.request('/registration', { mode }))}>保存注册策略</button></div> : <p>只有所有者可以改变注册策略。</p>}
    <form onSubmit={(event) => { event.preventDefault(); confirm('创建单次邀请码', `有效期 ${days} 天；只可注册一个普通用户，不授予管理权限。`, async () => { await client.request('/invites', { days: Number(days) }); setState(''); setCursors(['']); }); }} style={{ margin: '18px 0' }}><label>有效期（天）<input aria-label="邀请有效期" type="number" min="1" max="30" required value={days} onChange={(event) => setDays(event.target.value)} /></label><button>生成邀请码</button></form>
    {status.data?.mode === 'closed' && <p>当前关闭注册，即使有可用邀请码也不能注册。已有邀请码仍保留原有效期。</p>}
    <label>邀请状态<select aria-label="邀请状态筛选" value={state} onChange={(event) => { setState(event.target.value); setCursors(['']); }}><option value="">全部</option><option value="available">可用</option><option value="used">已使用</option><option value="revoked">已撤销</option><option value="expired">已过期</option></select></label>
    <Result error={error} loading={!data}><Table headers={['邀请码', '状态', '使用者', '有效期至', '操作']}>{data?.invites.map((invite) => {
      const expired = Boolean(invite.expiresAt && invite.expiresAt <= new Date().toISOString());
      return <tr key={invite.code}><Cell><code>{invite.code}</code></Cell><Cell>{invite.usedBy ? '已使用' : invite.disabled ? '已撤销' : expired ? '已过期' : '可用'}</Cell><Cell>{invite.usedBy ?? '—'}</Cell><Cell>{invite.expiresAt ? date(invite.expiresAt) : '旧邀请码：未设置期限'}</Cell><Cell><button disabled={Boolean(invite.usedBy) || expired} onClick={() => confirm('修改邀请码状态', invite.disabled ? '重新启用此邀请码，不延长有效期。' : '撤销后，此邀请码不能再注册账号。', () => client.request(`/invites/${encodeURIComponent(invite.code)}/disable`, { disabled: !invite.disabled }))}>{invite.disabled ? '启用' : '撤销'}</button></Cell></tr>;
    })}</Table>{data?.invites.length === 0 && <p>没有匹配的邀请码。</p>}</Result>
    <div style={{ display: 'flex', gap: 12, marginTop: 16 }}><button disabled={cursors.length === 1 || !data} onClick={() => setCursors((rows) => rows.slice(0, -1))}>上一页</button><span>第 {cursors.length} 页</span><button disabled={!data?.nextCursor} onClick={() => setCursors((rows) => [...rows, data!.nextCursor!])}>下一页</button></div>
    <p>邀请码是注册凭据，仅分享给预期用户；不会写入审计日志正文。</p></>;
}

function Security({ account, client, revision, confirm }: PaneProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [cursors, setCursors] = useState(['']);
  const cursor = cursors[cursors.length - 1]!;
  const { data, error } = useData<{ devices: Device[]; nextCursor?: string }>(client, `/devices?limit=25&search=${encodeURIComponent(filter)}&cursor=${encodeURIComponent(cursor)}`, revision);
  return <><h2>设备与安全</h2><p>当前管理账号：{account.username}（{roleName(account.role)}）</p><p>本次登录：{date(account.session.createdAt)}；会话到期：{date(account.session.expiresAt)}</p>
    <p>{account.role === 'owner' ? '显示全部账号的会话；所有者会话受保护，请使用顶部退出按钮结束自己的管理登录。' : '仅显示你有权管理的普通用户会话。'}按账号分页，每页最多 25 个账号；有效会话不代表设备当前在线。</p>
    <form onSubmit={(event) => { event.preventDefault(); setFilter(search.trim()); setCursors(['']); }}><input aria-label="搜索设备所属账号" maxLength={128} placeholder="用户名或完整 accountId" value={search} onChange={(event) => setSearch(event.target.value)} /><button>查询设备</button></form>
    <Result error={error} loading={!data}><DeviceTable devices={data?.devices ?? []} revoke={(device) => confirm(`撤销设备 ${device.deviceName}`, `立即使 ${device.username} 的此会话失效。保留本机及服务器账本。`, () => client.request(`/sessions/${device.id}/revoke`, {}))} /></Result>
    <div style={{ display: 'flex', gap: 12, marginTop: 16 }}><button disabled={cursors.length === 1 || !data} onClick={() => setCursors((rows) => rows.slice(0, -1))}>上一页</button><span>第 {cursors.length} 页</span><button disabled={!data?.nextCursor} onClick={() => setCursors((rows) => [...rows, data!.nextCursor!])}>下一页</button></div>
    <p>退出管理后台会撤销本次管理会话，并通知其他管理标签页清空界面，不影响独立的记账登录。</p><p>已支持管理员核实身份后发放一次性密码重置码，入口在“用户管理 → 设备与配额”。托管账本可在重置账号密码后恢复；私密账本仍需用户的恢复码。所有者密码恢复和所有权转移未开放。</p></>;
}

function Storage({ client, confirm }: PaneProps) {
  const [result, setResult] = useState('');
  const [issues, setIssues] = useState<unknown[]>([]);
  return <><h2>存储维护</h2><p>仅检查服务器数据库和加密文件完整性，不读取明文账本。大型校验可能耗时，不提供一键清库。</p><div style={{ display: 'flex', gap: 12 }}>
    <button onClick={() => confirm('校验服务器数据库', '执行 SQLite 完整性检查，不修改账本。', async () => { setResult(''); setIssues([]); const response = await client.request<{ verification: { ok: boolean; result: string } }>('/database/verify'); setResult(response.verification.ok ? '数据库校验通过。' : `数据库校验异常：${response.verification.result}`); })}>校验数据库</button>
    <button onClick={() => confirm('校验加密附件', '遍历服务器附件分块；不会删除或修复数据。', async () => { setResult(''); setIssues([]); const response = await client.request<{ verification: { checkedObjects: number; checkedChunks: number; issues: unknown[] } }>('/quotas/blobs/verify', {}); setResult(`已检查 ${response.verification.checkedObjects} 个对象、${response.verification.checkedChunks} 个分块，发现 ${response.verification.issues.length} 个问题。`); setIssues(response.verification.issues); })}>校验附件分块</button>
  </div>{result && <p role="status">{result}</p>}{issues.length > 0 && <details><summary>查看问题详情（{issues.length} 项）</summary><pre>{JSON.stringify(issues, null, 2)}</pre></details>}<p>用户配额可在“用户管理 → 设备与配额”中调整。</p></>;
}

function AuditLog({ client, revision }: PaneProps) {
  const [cursors, setCursors] = useState(['']);
  const cursor = cursors[cursors.length - 1]!;
  const [search, setSearch] = useState('');
  const { data, error } = useData<{ entries: Audit[]; nextCursor?: string }>(client, `/audit?search=${encodeURIComponent(search)}${cursor ? `&cursor=${cursor}` : ''}`, revision);
  const [filter, setFilter] = useState('');
  const labels: Record<string, string> = { role: '角色变更', state: '账号状态', 'commit-quota': '提交配额', 'blob-quota': '附件配额', registration: '注册策略', 'revoke-session': '设备撤销', 'invite-create': '创建邀请', 'invite-state': '邀请状态', 'password-reset-issue': '发放密码重置码', 'password-reset-complete': '完成账号密码重置' };
  return <><h2>管理审计</h2><p>关键变更与审计同事务写入；查询覆盖全部历史记录，再分页返回。操作者与目标使用稳定 accountId。</p><form onSubmit={(event) => { event.preventDefault(); setCursors(['']); setSearch(filter.trim()); }}><label>查询全部记录<input aria-label="查询全部审计" maxLength={128} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="账号 ID 或操作代码（如 commit-quota）" /></label><button>查询审计</button></form>
    <Result error={error} loading={!data}><Table headers={['时间', '操作', '操作者', '目标账号', '变更前 → 后']}>{data?.entries.map((row) => <tr key={row.id}><Cell>{date(row.at)}</Cell><Cell>{labels[row.action] ?? row.action}</Cell><Cell>{row.actorAccountId}</Cell><Cell>{row.targetAccountId ?? '服务器配置'}</Cell><Cell><code>{JSON.stringify(row.before)} → {JSON.stringify(row.after)}</code></Cell></tr>)}</Table>{data?.entries.length === 0 && <p>没有匹配记录。</p>}</Result>
    <div style={{ display: 'flex', gap: 12, marginTop: 16 }}><button disabled={cursors.length === 1 || !data} onClick={() => setCursors((rows) => rows.slice(0, -1))}>较新记录</button><button disabled={!data?.nextCursor} onClick={() => setCursors((rows) => [...rows, data!.nextCursor!])}>更早记录</button></div>
  </>;
}
