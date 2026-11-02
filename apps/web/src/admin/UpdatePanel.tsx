import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { Button, Notice, Panel, Select, Stat, message, row } from './ui.js';
import { adminIdempotencyKey } from './idempotency.js';

interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'installing' | 'restarting' | 'success' | 'failed';
  currentVersion: string;
  fromVersion?: string;
  targetVersion?: string;
  taskId?: string;
  operation?: 'update' | 'rollback';
  actor?: string;
  percent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
  updatedAt: string;
}
interface UpdateView { enabled: boolean; status: UpdateStatus; available?: boolean; reason?: string }
interface VersionList { installed: string[]; published: string[] }
const labels: Record<UpdateStatus['state'], string> = {
  idle: '尚未检查', checking: '检查中', available: '发现新版本', current: '已是最新版本',
  downloading: '下载并验证中', installing: '安装中', restarting: '重启并验证中',
  success: '操作成功', failed: '操作失败',
};

export function UpdatePanel({ client, role, version }: { client: AdminClient; role: string; version: string }) {
  const [view, setView] = useState<UpdateView>();
  const [versions, setVersions] = useState<VersionList>({ installed: [], published: [] });
  const [history, setHistory] = useState<UpdateStatus[]>([]);
  const [rollbackVersion, setRollbackVersion] = useState('');
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await client.request<UpdateView>('/updates/status');
        if (!active) return;
        if (next.status.currentVersion !== version && next.status.state === 'success') {
          window.location.reload(); return;
        }
        setView(next);
      } catch { /* Restart briefly interrupts the connection. */ }
    };
    const details = async () => {
      try {
        const [nextVersions, nextHistory] = await Promise.all([
          client.request<VersionList>('/updates/versions'),
          client.request<{ entries: UpdateStatus[] }>('/updates/history'),
        ]);
        if (active) { setVersions(nextVersions); setHistory(nextHistory.entries); }
      } catch { /* Status request reports deployment errors. */ }
    };
    void (async () => {
      await poll();
      if (!active) return;
      try { const checked = await client.request<UpdateView>('/updates/check'); if (active) setView(checked); }
      catch { /* Keep the last persisted result visible. */ }
      await details();
    })();
    const statusTimer = setInterval(() => { if (!document.hidden) void poll(); }, 2500);
    const detailsTimer = setInterval(() => { if (!document.hidden) void details(); }, 15_000);
    const discoveryTimer = setInterval(() => {
      if (document.hidden) return;
      void client.request<UpdateView>('/updates/check').then((next) => { if (active) setView(next); }).catch(() => undefined);
    }, 5 * 60_000);
    return () => { active = false; clearInterval(statusTimer); clearInterval(detailsTimer); clearInterval(discoveryTimer); };
  }, [client, version]);
  const check = async () => {
    setBusy(true); setError('');
    try { setView(await client.request<UpdateView>('/updates/check')); }
    catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!view?.status.targetVersion) return;
    setBusy(true); setError('');
    try {
      const status = await client.request<UpdateStatus>('/updates/apply',
        { version: view.status.targetVersion }, { idempotencyKey: adminIdempotencyKey('server-update') });
      setView({ ...view, status, available: false });
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  };
  const rollback = async () => {
    if (!rollbackVersion) return;
    setBusy(true); setError('');
    try {
      const status = await client.request<UpdateStatus>('/updates/rollback',
        { version: rollbackVersion }, { idempotencyKey: adminIdempotencyKey('server-rollback') });
      setView((current) => current ? { ...current, status, available: false } : current);
      setConfirmRollback(false);
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  };
  const status = view?.status;
  const updating = status && ['downloading', 'installing', 'restarting'].includes(status.state);
  const latestVersion = versions.published[0] ??
    (status?.state === 'available' || status?.state === 'current' ? status.targetVersion : undefined);
  const older = versions.installed.filter((entry) => /^0\.3\.\d+$/.test(entry)
    && Number(entry.split('.')[2]) < Number(version.split('.')[2]));
  return <>
    <Panel title="版本更新" note="检查并安装已签名的 0.3.x 服务端与 Web 发布包。">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <Stat label="当前版本" value={version} />
        <Stat label="最新版本" value={latestVersion ?? '待检查'} />
        <Stat label="更新状态" value={status ? labels[status.state] : '读取中'} />
      </div>
      {view && !view.enabled ? <Notice>{view.reason ?? '当前部署未启用自更新。'}</Notice> : null}
      {status?.error ? <Notice tone="bad">{status.error}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {updating ? <p role="status">正在{labels[status.state]}{status.percent !== undefined && status.state === 'downloading' ? ` · ${status.percent}%` : ''}。
        {status.downloadedBytes !== undefined ? ` 已接收 ${(status.downloadedBytes / 1024 / 1024).toFixed(1)}${status.totalBytes ? ` / ${(status.totalBytes / 1024 / 1024).toFixed(1)}` : ''} MiB。` : ''}
        连接可能短暂中断；页面会继续检查结果。</p> : null}
      <div style={{ ...row, marginTop: 12 }}>
        <Button disabled={busy || updating || !view?.enabled} onClick={() => { void check(); }}>检查更新</Button>
        {role === 'owner' ? <Button disabled={busy || updating || !view?.enabled || !view.available}
          onClick={() => { void apply(); }}>立即更新至 {status?.targetVersion ?? '新版本'}</Button> : null}
      </div>
      <p style={{ marginTop: 12 }}>安装后自动重启并检查健康状态；目标版本启动失败时切回先前版本。数据库不会随程序回滚。</p>
    </Panel>
    <Panel title="已安装版本" note="仅同一 0.3.x 数据 schema 的历史程序可在这里回滚。">
      {older.length ? <div style={row}>
        <Select aria-label="选择回滚版本" value={rollbackVersion} disabled={busy || updating || role !== 'owner'} onChange={(event) => {
          setRollbackVersion(event.target.value); setConfirmRollback(false);
        }}>
          <option value="">选择历史版本</option>
          {older.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </Select>
        {role === 'owner' ? <Button disabled={!rollbackVersion || busy || updating || !view?.enabled} onClick={() => {
          if (confirmRollback) void rollback(); else setConfirmRollback(true);
        }}>{confirmRollback ? `确认回滚至 ${rollbackVersion}` : '回滚到所选版本'}</Button> : null}
        {confirmRollback ? <Button onClick={() => setConfirmRollback(false)}>取消</Button> : null}
      </div> : <p>暂无可回滚的历史版本。</p>}
      {versions.published.length ? <p>更新源已发布：{versions.published.join('、')}</p> : null}
    </Panel>
    <Panel title="更新历史" note="记录最近 50 项更新或回滚任务；刷新页面后仍可查看。">
      {history.length ? <ul>{history.map((entry) => <li key={entry.taskId}>
        {new Date(entry.updatedAt).toLocaleString()} · {entry.operation === 'rollback' ? '回滚' : '更新'} {entry.fromVersion ?? (entry.currentVersion === entry.targetVersion ? '旧版本' : entry.currentVersion)} → {entry.targetVersion}
        {' · '}{labels[entry.state]}{entry.actor ? ` · ${entry.actor}` : ''}{entry.error ? ` · ${entry.error}` : ''}
      </li>)}</ul> : <p>暂无更新记录。</p>}
    </Panel>
  </>;
}
