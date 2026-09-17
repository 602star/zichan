/** Runtime overview: the day-to-day entry point, not a wall of counters. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, Loading, Notice, Panel, Stat, bytes, message, muted, row, usePolling, useResource, when } from './ui.js';
import type { Alert, Metrics, Overview } from './types.js';

const RANGES = ['1h', '24h', '7d'] as const;

export function OverviewPage({ client, navigate, accountName }: {
  client: AdminClient;
  navigate: (to: string) => void;
  accountName: string;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h');
  const overview = useResource(() => client.request<Overview>('/overview'), []);
  const metrics = useResource(() => client.request<Metrics>(`/metrics?range=${range}`), [range]);
  usePolling(overview.reload, 30_000);

  const snapshot = overview.data?.snapshot;
  const alerts = overview.data?.alerts ?? [];
  const blocking = alerts.filter((alert) => alert.state === 'active');
  const degraded = Boolean(blocking.length) || overview.stale;
  const diskFree = snapshot?.storage.diskFreeBytes ?? null;
  const diskTotal = snapshot?.storage.diskTotalBytes ?? null;
  const diskLow = diskFree !== null && diskTotal !== null && diskTotal > 0 && diskFree / diskTotal < 0.1;

  return (
    <>
      <h2>运行概览</h2>
      <Loading loading={overview.loading} error={overview.error} stale={overview.stale} loadedAt={overview.loadedAt} />

      <Panel title="服务状态">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Stat label="状态" value={degraded ? '降级' : '正常'} tone={degraded ? 'warn' : undefined}
            hint={blocking.length ? `${blocking.length} 条告警处于活动状态` : '没有活动告警'} />
          <Stat label="运行时间" value={snapshot ? formatUptime(snapshot.uptimeSeconds) : '暂无数据'} />
          <Stat label="服务版本" value={overview.data?.version ?? '暂无数据'} hint={`服务器 ID ${overview.data?.serverId ?? ''}`} />
          <Stat label="最后采样" value={snapshot ? new Date(snapshot.sampledAt).toLocaleTimeString() : '暂无数据'}
            hint={overview.data ? `${Math.round((snapshot?.sampledWithinMs ?? 0) / 1000)} 秒前` : undefined} />
          <Stat label="有效会话" value={snapshot ? snapshot.counts.activeSessionCount : '暂无数据'} hint="有效会话不代表在线人数" />
        </div>
      </Panel>

      <Panel
        title="核心指标"
        action={<div style={row}>{RANGES.map((value) => <Button key={value} disabled={value === range} onClick={() => setRange(value)}>{value}</Button>)}</div>}
        note={metrics.data?.note}
      >
        {metrics.error ? <Notice tone="bad">{metrics.error}</Notice> : null}
        {metrics.data && metrics.data.totals.requests === 0 ? (
          <p style={muted}>暂无数据：这个时间范围内还没有采集到请求。</p>
        ) : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Stat label="请求量" value={metrics.data ? metrics.data.totals.requests : '暂无数据'} />
          <Stat label="错误率" value={metrics.data?.totals.errorRate === null || metrics.data?.totals.errorRate === undefined ? '暂无数据' : `${(metrics.data.totals.errorRate * 100).toFixed(1)}%`} />
          <Stat label="平均耗时" value={metrics.data?.totals.averageMs === null || metrics.data?.totals.averageMs === undefined ? '暂无数据' : `${metrics.data.totals.averageMs} ms`}
            hint={metrics.data ? `慢请求 ${metrics.data.totals.slowRequests}` : undefined} />
          <Stat label="提交推送" value={metrics.data ? `${metrics.data.totals.syncPushOk} 成功 / ${metrics.data.totals.syncPushFailed} 失败` : '暂无数据'} />
          <Stat label="附件请求" value={metrics.data ? `${metrics.data.totals.blobOk} 成功 / ${metrics.data.totals.blobFailed} 失败` : '暂无数据'} />
        </div>
        {metrics.data?.observedSince ? <p style={muted}>自 {when(metrics.data.observedSince)} 起有数据。</p> : null}
      </Panel>

      <Panel title="数据保障">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Stat label="磁盘余量" tone={diskLow ? 'bad' : undefined}
            value={diskFree === null ? '暂无数据' : bytes(diskFree)}
            hint={diskFree === null || !diskTotal ? '无法读取磁盘信息' : `共 ${bytes(diskTotal)}，剩余 ${((diskFree / diskTotal) * 100).toFixed(1)}%`} />
          <Stat label="最近成功备份" tone={snapshot?.backup?.status === 'failed' ? 'bad' : undefined}
            value={snapshot?.backup ? when(snapshot.backup.createdAt) : '暂无数据'}
            hint={snapshot?.backup ? `状态 ${snapshot.backup.status}` : '尚未登记备份记录'} />
          <Stat label="最近数据库校验" value={typeof snapshot?.verification.database?.['checkedAt'] === 'string' ? when(String(snapshot.verification.database['checkedAt'])) : '暂无数据'}
            hint={typeof snapshot?.verification.database?.['result'] === 'string' ? `结果 ${snapshot.verification.database['result']}` : '尚未执行'} />
          <Stat label="最近附件校验" value={typeof snapshot?.verification.blobs?.['issueCount'] === 'number' ? `问题 ${snapshot.verification.blobs['issueCount']}` : '暂无数据'}
            hint="在任务中心发起" />
          <Stat label="最近清理" tone={snapshot?.cleanup.lastOk === false ? 'bad' : undefined}
            value={snapshot?.cleanup.lastFinishedAt ? when(snapshot.cleanup.lastFinishedAt) : '暂无数据'}
            hint={snapshot?.cleanup.lastOk === false ? `连续失败 ${snapshot.cleanup.consecutiveFailures} 次：${snapshot.cleanup.lastError ?? ''}` : snapshot?.cleanup.lastOk ? `释放 ${bytes(snapshot.cleanup.lastFreedBytes)}` : '尚未运行'} />
        </div>
        <p style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => navigate('/storage')}>查看存储与备份</Button>
          <Button onClick={() => navigate('/jobs')}>进入任务中心</Button>
          <Button onClick={() => navigate('/sync')}>同步诊断</Button>
        </p>
      </Panel>

      <Panel title="待处理事项" note="同类告警会被合并；每条都会记录首次发生、最后发生与次数。">
        {alerts.length === 0 ? <p style={muted}>暂无待处理事项。</p> : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {alerts.map((alert) => (
              <li key={alert.key} style={{ marginBottom: 8 }}>
                <Badge tone={alert.state === 'active' ? 'bad' : 'warn'}>{alert.state === 'active' ? '活动' : '待确认'}</Badge>{' '}
                {describeAlert(alert)}{' '}
                <span style={muted}>影响：{alert.scope}；首次 {when(alert.firstSeenAt)}，最近 {when(alert.lastSeenAt)}，共 {alert.occurrences} 次</span>{' '}
                <Button onClick={() => { void acknowledge(client, alert, overview.reload); }}>确认</Button>{' '}
                <NextStep alert={alert} navigate={navigate} />
              </li>
            ))}
          </ul>
        )}
        {overview.data?.recentFailures.length ? (
          <>
            <strong style={{ display: 'block', marginTop: 12 }}>最近失败的管理操作</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {overview.data.recentFailures.map((failure) => (
                <li key={failure.id}>
                  {when(failure.at)} · {failure.action} · {failure.code ?? '未知错误'}{failure.requestId ? ` · 请求 ${failure.requestId}` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {overview.data?.recentJobs.some((job) => ['failed', 'interrupted'].includes(job.status)) ? (
          <p><Notice tone="warn">存在失败或中断的维护任务，<button type="button" onClick={() => navigate('/jobs')} style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }}>在任务中心查看</button>。</Notice></p>
        ) : null}
        <p style={{ marginTop: 8 }}>
          <Button onClick={() => navigate('/users?quota=over')}>查看超额账号</Button>
          <span style={muted}> 当前管理员：{accountName}</span>
        </p>
      </Panel>
    </>
  );
}

async function acknowledge(client: AdminClient, alert: Alert, reload: () => void): Promise<void> {
  try {
    await client.request(`/alerts/${encodeURIComponent(alert.key)}/acknowledge`, {}, { idempotencyKey: adminIdempotencyKey(`ack-${alert.key}`) });
  } catch (error) {
    window.alert(message(error));
  }
  reload();
}

function NextStep({ alert, navigate }: { alert: Alert; navigate: (to: string) => void }) {
  if (alert.rule === 'capacity') return <Button onClick={() => navigate('/users?quota=over')}>进入用户管理</Button>;
  if (alert.rule.startsWith('backup')) return <Button onClick={() => navigate('/storage')}>查看备份</Button>;
  if (alert.rule === 'verification-issue') return <Button onClick={() => navigate('/jobs')}>查看校验任务</Button>;
  if (alert.rule === 'cleanup-failure') return <Button onClick={() => navigate('/storage')}>查看清理状态</Button>;
  if (alert.rule === 'sync-errors') return <Button onClick={() => navigate('/sync?outcome=error')}>查看同步诊断</Button>;
  if (alert.rule === 'disk-space') return <Button onClick={() => navigate('/storage')}>查看存储</Button>;
  return null;
}

function describeAlert(alert: Alert): string {
  const detail = alert.detail ?? {};
  switch (alert.rule) {
    case 'capacity': return `账号 ${String(detail['username'] ?? '')} 的${alert.scope === 'commit' ? '提交' : '附件'}用量接近上限`;
    case 'backup-failure': return '备份失败或校验未通过';
    case 'backup-overdue': return `超过 ${String(detail['intervalHours'] ?? '')} 小时没有成功备份`;
    case 'verification-issue': return alert.scope === 'database' ? '数据库校验发现问题' : '附件校验发现问题';
    case 'cleanup-failure': return `附件清理连续失败 ${String(detail['consecutiveFailures'] ?? '')} 次`;
    case 'sync-errors': return `持续出现同步错误（最近 ${String(detail['recentErrors'] ?? '')} 次）`;
    case 'disk-space': return '磁盘剩余空间不足';
    default: return alert.rule;
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', `${minutes} 分钟`].filter(Boolean).join(' ');
}
