import { useCallback, useEffect, useRef, useState } from 'react';
import { buildSyncBaseUrl, type SyncConnection } from '../sync-config.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { btnOutline, card } from './styles.js';

interface GroupStatus {
  joined: boolean;
  localNodeId?: string;
  memberCount?: number;
  members?: { nodeId: string; label: string }[];
}

interface GroupHealth {
  state: 'NOT_CONFIGURED' | 'BOOTSTRAPPING' | 'CATCHING_UP' | 'VERIFYING' | 'READY';
  memberCount: number;
  readyCount: number;
  checkedAt?: string;
  issues: string[];
  members: { nodeId: string; state: string; receivedAt?: string; issue?: string }[];
}

type ReplicaView =
  | { kind: 'loading' }
  | { kind: 'no-server' }
  | { kind: 'unavailable'; error: string }
  | { kind: 'single' }
  | { kind: 'group'; status: GroupStatus; health?: GroupHealth; healthError?: string };

const STATUS_LABELS: Record<string, string> = {
  READY: '已就绪',
  BOOTSTRAPPING: '正在建立副本',
  CATCHING_UP: '正在同步',
  VERIFYING: '正在核对',
  MISSING: '暂时不可达',
};

async function serverRequest<T>(profile: SyncConnection, path: string): Promise<T> {
  const token = await authenticateSyncProfile(profile);
  const response = await fetch(`${buildSyncBaseUrl(profile)}${path}`, {
    redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function readableTime(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '尚无报告';
}

export function NodeReplicaPanel({ profile, profiles, ledgerId, onConfigureServers, onSyncBrowser }: {
  profile?: SyncConnection;
  profiles: SyncConnection[];
  ledgerId?: string;
  onConfigureServers: () => void;
  onSyncBrowser: () => void;
}) {
  const [view, setView] = useState<ReplicaView>({ kind: 'loading' });
  const [checking, setChecking] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    if (!profile?.enabled || !profile.serverId) { setChecking(false); setView({ kind: 'no-server' }); return; }
    setChecking(true);
    try {
      const status = await serverRequest<GroupStatus>(profile, '/api/v4/group/status');
      if (id !== requestId.current) return;
      if (!status.joined) { setView({ kind: 'single' }); return; }
      if (!ledgerId) { setView({ kind: 'group', status, healthError: '账本尚未建立，暂时无法核对副本。' }); return; }
      try {
        const health = await serverRequest<GroupHealth>(profile, '/api/v4/ledger/group-health');
        if (id === requestId.current) setView({ kind: 'group', status, health });
      } catch (error) {
        if (id === requestId.current) setView({ kind: 'group', status,
          healthError: error instanceof Error ? error.message : String(error) });
      }
    } catch (error) {
      if (id === requestId.current) setView({ kind: 'unavailable',
        error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (id === requestId.current) setChecking(false);
    }
  }, [profile, ledgerId]);

  useEffect(() => {
    setView({ kind: 'loading' });
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !checking) void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh, checking]);

  const health = view.kind === 'group' ? view.health : undefined;
  const expected = view.kind === 'group' ? Math.max(view.status.memberCount ?? 0,
    view.status.members?.length ?? 0, health?.memberCount ?? 0, 1) : 0;
  const members = view.kind === 'group'
    ? view.status.members?.length ? view.status.members : (health?.members ?? []).map((member) => ({ nodeId: member.nodeId, label: '' }))
    : [];
  const healthById = new Map((health?.members ?? []).map((member) => [member.nodeId, member]));
  const readyCount = members.filter((member) => healthById.get(member.nodeId)?.state === 'READY').length;
  const allReady = Boolean(health?.state === 'READY' && expected === members.length && readyCount === expected);
  const singleMemberGroup = view.kind === 'group' && expected === 1;
  const browserReplicas = profiles.filter((item) => item.browserBridge && item.ledgerId === ledgerId);

  return <section aria-label="服务器上的账本" style={{ ...card, marginBottom: 16 }}>
    <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 12 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-title)' }}>服务器上的账本</h3>
        <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', margin: '6px 0 0', lineHeight: 1.6 }}>
          查看这本账保存在哪些服务器，以及各副本是否已同步完成。
        </p>
      </div>
      <button type="button" style={btnOutline} disabled={checking || view.kind === 'loading'} onClick={() => void refresh()}>
        {checking ? '核对中…' : '刷新状态'}
      </button>
    </div>

    {view.kind === 'loading' && <p role="status">正在读取服务器状态…</p>}
    {view.kind === 'no-server' && <div style={{ marginTop: 14 }}>
      <strong>尚未连接服务器</strong>
      <p>连接服务器后，才可以在其他设备登录并同步这本账。</p>
      <button type="button" style={btnOutline} onClick={onConfigureServers}>配置服务器连接</button>
    </div>}
    {view.kind === 'unavailable' && <div style={{ marginTop: 14 }}>
      <strong>暂时无法核对服务器副本</strong>
      <p>当前连接可能已断开或登录已过期。你仍可查看本机账本；请检查下方的服务器连接。</p>
      <details><summary>查看原因</summary><p role="alert">{view.error}</p></details>
      <button type="button" style={btnOutline} onClick={onConfigureServers}>查看服务器连接</button>
    </div>}
    {view.kind === 'single' && <div style={{ marginTop: 14 }}>
      <strong>当前服务器未加入同步组</strong>
      <p>本站可以正常记账。{browserReplicas.length
        ? '其他独立服务器由当前浏览器同步，关闭网页后传输暂停。'
        : '需要把账本复制到其他服务器，可以在下方连接独立服务器，或由管理员在管理后台创建同步组。'}</p>
    </div>}
    {view.kind === 'group' && <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)',
        color: allReady ? 'var(--positive)' : 'var(--text-secondary)' }}>
        {singleMemberGroup ? '同步组目前只有 1 台服务器'
          : health ? `${readyCount}/${expected} 台服务器已就绪` : `${expected} 台服务器已加入，等待核对`}
      </div>
      <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', margin: '5px 0 14px' }}>
        {singleMemberGroup ? '本站可正常使用；加入第二台服务器后才会形成另一份服务器副本。'
          : allReady ? '这本账在组内各节点均通过当前核对。'
          : '已加入同步组不代表副本已完整；下方列出每台服务器的当前状态。'}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {members.map((member) => {
          const node = healthById.get(member.nodeId);
          const alias = profiles.find((item) => item.serverId === member.nodeId)?.alias;
          const name = alias || member.label || `服务器 ${member.nodeId.slice(0, 8)}`;
          const local = member.nodeId === view.status.localNodeId;
          return <div key={member.nodeId} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 12 }}>
            <div style={{ fontWeight: 'var(--fw-medium)' }}>{name}{local ? ' · 当前服务器' : ''}</div>
            <div style={{ color: node?.state === 'READY' ? 'var(--positive)' : 'var(--text-secondary)', marginTop: 6 }}>
              {STATUS_LABELS[node?.state ?? ''] ?? '等待核对'}
            </div>
            <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', marginTop: 4 }}>
              {local ? `最近核对：${readableTime(health?.checkedAt)}` : `最近报告：${readableTime(node?.receivedAt)}`}
            </div>
          </div>;
        })}
      </div>
      {view.healthError && <p role="status">副本状态暂时无法核对，可稍后刷新。</p>}
      {(health?.issues.length || view.healthError) ? <details style={{ marginTop: 12 }}>
        <summary>查看问题与诊断信息</summary>
        {health?.issues.length ? <ul>{health.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
        {view.healthError ? <p>{view.healthError}</p> : null}
      </details> : null}
      <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', marginBottom: 0 }}>
        服务器的加入与管理请联系管理员。
      </p>
    </div>}
    {browserReplicas.length > 0 && <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 14 }}>
      <strong>由当前浏览器同步的服务器</strong>
      <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>
        这些服务器不会互相连接。网页打开并自动同步时，账目和图片经过你的浏览器传送；关闭网页后暂停。
      </p>
      {browserReplicas.map((item) => <div key={item.id} style={{ marginBottom: 8 }}>
        {item.alias} · {item.lastSyncError ? `上次同步有问题：${item.lastSyncError}`
          : item.lastSyncAt ? `上次同步：${readableTime(item.lastSyncAt)}` : '等待首次完整同步'}
      </div>)}
      <button type="button" style={btnOutline} onClick={onSyncBrowser}>立即同步</button>
    </div>}
  </section>;
}
