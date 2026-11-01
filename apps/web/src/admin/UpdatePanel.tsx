import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { Button, Notice, Panel, Stat, message, row } from './ui.js';
import { adminIdempotencyKey } from './idempotency.js';

interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'installing' | 'restarting' | 'success' | 'failed';
  currentVersion: string;
  targetVersion?: string;
  taskId?: string;
  error?: string;
}
interface UpdateView { enabled: boolean; status: UpdateStatus; available?: boolean; reason?: string }
const labels: Record<UpdateStatus['state'], string> = {
  idle: '尚未检查', checking: '检查中', available: '发现新版本', current: '已是最新版本',
  downloading: '下载并验证中', installing: '安装中', restarting: '重启并验证中',
  success: '更新成功', failed: '更新失败',
};

export function UpdatePanel({ client, role, version }: { client: AdminClient; role: string; version: string }) {
  const [view, setView] = useState<UpdateView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await client.request<UpdateView>('/updates/status');
        if (!active) return;
        if (next.status.currentVersion !== version && next.status.state === 'success') {
          window.location.reload();
          return;
        }
        setView(next);
      } catch { /* The server can briefly disappear while restarting. */ }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 2500);
    return () => { active = false; clearInterval(timer); };
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
  const status = view?.status;
  const updating = status && ['downloading', 'installing', 'restarting'].includes(status.state);
  return <Panel title="一键更新" note="仅安装已签名的 0.3.x 发布包；安装后服务自动重启并检查健康状态。">
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
      <Stat label="当前版本" value={version} />
      <Stat label="最新版本" value={status?.targetVersion ?? '待检查'} />
      <Stat label="更新状态" value={status ? labels[status.state] : '读取中'} />
    </div>
    {view && !view.enabled ? <Notice>{view.reason ?? '当前部署未启用自更新。'}</Notice> : null}
    {status?.error ? <Notice tone="bad">{status.error}</Notice> : null}
    {error ? <Notice tone="bad">{error}</Notice> : null}
    {updating ? <p role="status">正在{labels[status.state]}。连接可能短暂中断；页面会继续检查结果。</p> : null}
    <div style={{ ...row, marginTop: 12 }}>
      <Button disabled={busy || updating || !view?.enabled} onClick={() => { void check(); }}>检查更新</Button>
      {role === 'owner' ? <Button disabled={busy || updating || !view?.enabled || !view.available}
        onClick={() => { void apply(); }}>立即更新至 {status?.targetVersion ?? '新版本'}</Button> : null}
    </div>
    <p style={{ marginTop: 12 }}>更新期间会短暂中断服务。若新版本无法启动，固定启动器会恢复先前版本；数据库迁移仍需按升级手册评估。</p>
  </Panel>;
}
