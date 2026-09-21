/** Runtime overview: the day-to-day entry point, not a wall of counters. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { Badge, Button, DataTable, Loading, Notice, Panel, PanelIndex, sectionId, Select, Stat, TextInput, bytes, canWrite, message, muted, roleLabel, row, usePolling, useResource, when } from './ui.js';
import { alertNextStep, alertStateLabel, acknowledgeAlert, describeAlert, isSilenced, silenceAlert, unsilenceAlert, SILENCE_HOURS } from './alerts.js';
import { TrendChart } from './chart.js';
import { MaintenancePanel } from './MaintenancePanel.js';
import type { TrendPoint } from './trend.js';
import type { AdminLoginSummary, Alert, Metrics, Overview } from './types.js';

const RANGES = ['1h', '24h', '7d'] as const;

/** Bucket series the trend chart can draw; totals stay in the cards above it. */
const SERIES = [
  { key: 'requests', label: '请求量' },
  { key: 'errors', label: '错误数' },
  { key: 'averageMs', label: '平均耗时' },
  { key: 'syncFailed', label: '失败同步' },
] as const;
type SeriesKey = (typeof SERIES)[number]['key'];

function seriesValue(bucket: Metrics['buckets'][number], key: SeriesKey): number {
  switch (key) {
    case 'errors': return bucket.errors;
    case 'averageMs': return bucket.requests ? Math.round(bucket.durationMs / bucket.requests) : 0;
    case 'syncFailed': return bucket.syncPushFailed + bucket.blobFailed;
    default: return bucket.requests;
  }
}

/** Silence windows offered in the console: one shift, one day, one week. */

export function OverviewPage({ client, navigate, accountName, role }: {
  client: AdminClient;
  navigate: (to: string) => void;
  accountName: string;
  role: string;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h');
  const [series, setSeries] = useState<SeriesKey>('requests');
  // Silence is a recorded decision: the duration and the reason travel together.
  const [silenceDraft, setSilenceDraft] = useState<{ key: string; hours: number; reason: string }>();
  // Alert actions report in place instead of a blocking dialog that cannot carry a request id.
  const [actionError, setActionError] = useState('');
  const overview = useResource(() => client.request<Overview>('/overview'), []);
  const metrics = useResource(() => client.request<Metrics>(`/metrics?range=${range}`), [range]);
  // Both views age together: a poll that refreshed only the overview left the counters stale.
  usePolling(() => { overview.reload(); metrics.reload(); }, 30_000);

  const snapshot = overview.data?.snapshot;
  const backup = snapshot?.backup ?? null;
  const alerts = overview.data?.alerts ?? [];
  // A silenced alert is a decision, not an outage: it stays visible but stops colouring
  // the service status. The server counts the same way, so the two never disagree.
  const blocking = alerts.filter((alert) => alert.state === 'active' && !isSilenced(alert));
  const silenced = alerts.filter(isSilenced);
  // A declared maintenance window is not a degradation: it is a planned state, and it already
  // explains why writes are refused. Folding it into "降级" would send an operator hunting for a
  // fault that does not exist.
  const maintenance = overview.data?.maintenance;
  const drain = overview.data?.drain;
  const degraded = (Boolean(blocking.length) || overview.stale) && !maintenance?.active;
  const diskFree = snapshot?.storage.diskFreeBytes ?? null;
  const diskTotal = snapshot?.storage.diskTotalBytes ?? null;
  const diskLow = diskFree !== null && diskTotal !== null && diskTotal > 0 && diskFree / diskTotal < 0.1;
  // The memory ceiling shown here is the same one the alert rule uses, so the card and the
  // alert can never disagree about what "85%" means. A configured threshold is not in the
  // overview payload; the resources page shows that one.
  const process_ = snapshot?.process;
  const memoryLimit = process_?.constrainedBytes && process_.constrainedBytes > 0 ? process_.constrainedBytes : null;
  const memoryRatio = process_ && memoryLimit ? process_.rssBytes / memoryLimit : null;

  return (
    <>
      <h2>运行概览</h2>
      <PanelIndex sections={[
        { id: sectionId('服务状态'), label: '服务状态' },
        { id: sectionId('最近管理员登录'), label: '管理员登录' },
        { id: sectionId('待处理事项'), label: '待处理事项' },
      ]} />
      <Loading loading={overview.loading} error={overview.error} stale={overview.stale} loadedAt={overview.loadedAt} />

      <Panel title="服务状态">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Stat label="状态" value={maintenance?.active ? '维护中' : degraded ? '降级' : '正常'} tone={maintenance?.active ? 'warn' : degraded ? 'warn' : undefined}
            hint={maintenance?.active ? '客户端写入已暂停，读取正常' : blocking.length ? `${blocking.length} 条告警处于活动状态` : silenced.length ? `没有活动告警；${silenced.length} 条已静默` : '没有活动告警'} />
          <Stat label="运行时间" value={snapshot ? formatUptime(snapshot.uptimeSeconds) : '暂无数据'} />
          <Stat label="服务版本" value={overview.data?.version ?? '暂无数据'} hint={`服务器 ID ${overview.data?.serverId ?? ''}`} />
          <Stat label="最后采样" value={snapshot ? new Date(snapshot.sampledAt).toLocaleTimeString() : '暂无数据'}
            hint={overview.data ? `${Math.round((snapshot?.sampledWithinMs ?? 0) / 1000)} 秒前` : undefined} />
          <Stat label="有效会话" value={snapshot ? snapshot.counts.activeSessionCount : '暂无数据'} hint="有效会话不代表在线人数" />
        </div>
      </Panel>

      <MaintenancePanel client={client} role={role} view={maintenance} drain={drain} onChanged={() => overview.reload()} />

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
        {metrics.data ? (
          <>
            <div style={{ ...row, marginTop: 12 }}>
              {SERIES.map((entry) => (
                <Button key={entry.key} disabled={entry.key === series} onClick={() => setSeries(entry.key)}>{entry.label}</Button>
              ))}
            </div>
            <TrendChart
              points={(metrics.data.buckets ?? []).map((bucket): TrendPoint => ({ at: bucket.bucketAt, value: seriesValue(bucket, series) }))}
              label={`${SERIES.find((entry) => entry.key === series)?.label ?? ''}趋势（近 ${range}）`}
              formatValue={(value) => series === 'averageMs' ? `${value} ms` : String(value)}
              tone={series === 'errors' || series === 'syncFailed' ? 'bad' : series === 'averageMs' ? 'warn' : 'ok'}
              granularityNote={metrics.data.granularity === 'minute' ? '分钟分桶' : '小时分桶'}
            />
          </>
        ) : null}
        {metrics.data?.observedSince ? <p style={muted}>自 {when(metrics.data.observedSince)} 起有数据。</p> : null}
        {metrics.loadedAt ? <p style={muted}>最后读取：{new Date(metrics.loadedAt).toLocaleTimeString()}（与「服务状态」一起每 30 秒刷新）</p> : null}
      </Panel>

      <Panel title="数据保障">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Stat label="磁盘余量" tone={diskLow ? 'bad' : undefined}
            value={diskFree === null ? '暂无数据' : bytes(diskFree)}
            hint={diskFree === null || !diskTotal ? '无法读取磁盘信息' : `共 ${bytes(diskTotal)}，剩余 ${((diskFree / diskTotal) * 100).toFixed(1)}%`} />
          <Stat label="最近成功备份" tone={backup && (backup.status === 'failed' || backup.verificationOk === false) ? 'bad' : undefined}
            value={backup?.lastSuccessAt ? when(backup.lastSuccessAt) : '暂无数据'}
            hint={backup
              ? `最近尝试 ${when(backup.attemptedAt)}（${backup.status}${backup.verificationOk === false ? ' · 校验未通过' : ''}）${backup.lastVerifiedAt ? `；最近校验通过 ${when(backup.lastVerifiedAt)}` : '；尚未成功校验'}`
              : '尚未登记备份记录'} />
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

      <Panel title="进程与数据库" action={<Button onClick={() => navigate('/resources')}>查看详情与趋势</Button>}
        note="这一节的数字只是同步服务器进程本身；数据库页缓存之外的部分不在此列。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Stat label="常驻内存" tone={memoryRatio !== null && memoryRatio >= 0.85 ? 'warn' : undefined}
            value={snapshot?.process ? bytes(snapshot.process.rssBytes) : '暂无数据'}
            hint={memoryLimit ? `上限 ${bytes(memoryLimit)}，已用 ${((memoryRatio ?? 0) * 100).toFixed(1)}%` : '未设置容器上限或内存阈值'} />
          <Stat label="堆外内存" value={snapshot?.process ? bytes(snapshot.process.externalBytes) : '暂无数据'}
            hint="附件校验与备份的缓冲区在这里；只看堆会漏掉它" />
          <Stat label="CPU 占用" value={snapshot?.process.cpuPercent === null || snapshot?.process.cpuPercent === undefined ? '暂无数据' : `${snapshot.process.cpuPercent.toFixed(1)}%`}
            hint="采样窗口平均，不是瞬时值" />
          <Stat label="事件循环延迟" tone={snapshot?.process.eventLoopMeanMs !== null && snapshot?.process.eventLoopMeanMs !== undefined && snapshot.process.eventLoopMeanMs >= 50 ? 'warn' : undefined}
            value={snapshot?.process.eventLoopMeanMs === null || snapshot?.process.eventLoopMeanMs === undefined ? '暂无数据' : `${snapshot.process.eventLoopMeanMs.toFixed(1)} ms`}
            hint="单线程 Node 上，这一项升高说明同步任务堵住了请求处理" />
          <Stat label="数据库大小" value={bytes(snapshot?.storage.databaseBytes)}
            hint={snapshot?.database ? `WAL ${bytes(snapshot.storage.walBytes)} · 可回收 ${bytes(snapshot.database.freelistBytes)}` : undefined} />
        </div>
      </Panel>

      <Panel title="最近管理员登录" note="只列管理后台的登录会话（同步客户端会话不在此列）。IP 来自请求来源，反向代理部署时可能是代理地址。">
        {!overview.data?.recentAdminLogins?.length ? <p style={muted}>暂无管理员登录记录。</p> : (
          <DataTable
            columns={[
              { key: 'user', header: '账号', render: (entry: AdminLoginSummary) => <>{entry.username} <span style={muted}>{roleLabel(entry.role)}</span></> },
              { key: 'at', header: '登录时间', render: (entry: AdminLoginSummary) => when(entry.at) },
              { key: 'ip', header: '来源 IP', render: (entry: AdminLoginSummary) => entry.ip || '未记录' },
              { key: 'state', header: '状态', render: (entry: AdminLoginSummary) => entry.active ? <Badge tone="ok">有效</Badge> : <Badge tone="muted">已结束</Badge> },
            ]}
            rows={overview.data.recentAdminLogins}
            rowKey={(entry) => entry.sessionId}
            empty="暂无管理员登录记录。"
          />
        )}
      </Panel>

      <Panel title="待处理事项" note="同类告警会被合并；每条都会记录首次发生、最后发生与次数。静默只停外部通知，规则、记录与恢复判断都不变。恢复后的告警在「告警历史」里仍可回看。">
        {alerts.length === 0 ? <p style={muted}>暂无待处理事项。</p> : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {alerts.map((alert) => {
              const silenced = isSilenced(alert);
              const stateLabel = alertStateLabel(alert);
              return (
                <li key={alert.key} style={{ marginBottom: 10 }}>
                  <Badge tone={stateLabel.tone}>{stateLabel.text}</Badge>{' '}
                  {alert.acknowledgedAt ? <Badge tone="muted">已确认</Badge> : null}{' '}
                  {describeAlert(alert)}{' '}
                  <span style={muted}>影响：{alert.scope}；首次 {when(alert.firstSeenAt)}，最近 {when(alert.lastSeenAt)}，共 {alert.occurrences} 次（连续 {alert.consecutive} 次）</span>{' '}
                  <NextStep alert={alert} navigate={navigate} />{' '}
                  <Button disabled={!canWrite(role) || Boolean(alert.acknowledgedAt)} onClick={() => {
                    void acknowledgeAlert(client, alert).catch((error) => setActionError(message(error))).finally(overview.reload);
                  }}>
                    {alert.acknowledgedAt ? `已由 ${alert.acknowledgedBy ?? ''} 确认` : '确认'}
                  </Button>{' '}
                  {silenced ? (
                    <span style={muted}>
                      已静默至 {when(alert.silencedUntil ?? '')}{alert.silenceReason ? `（${alert.silenceReason}）` : ''}{' '}
                      <Button disabled={!canWrite(role)} onClick={() => {
                        void unsilenceAlert(client, alert).catch((error) => setActionError(message(error))).finally(overview.reload);
                      }}>取消静默</Button>
                    </span>
                  ) : silenceDraft?.key === alert.key ? (
                    <span style={row}>
                      <Select
                        value={String(silenceDraft.hours)}
                        onChange={(event) => setSilenceDraft({ ...silenceDraft, hours: Number(event.target.value) })}
                      >
                        {SILENCE_HOURS.map((hours) => <option key={hours} value={hours}>{hours >= 24 ? `${hours / 24} 天` : `${hours} 小时`}</option>)}
                      </Select>
                      <TextInput placeholder="静默原因（必填，写入审计）" value={silenceDraft.reason}
                        onChange={(event) => setSilenceDraft({ ...silenceDraft, reason: event.target.value })} />
                      <Button disabled={!silenceDraft.reason.trim()} onClick={() => {
                        void silenceAlert(client, alert, silenceDraft)
                          .then(() => setSilenceDraft(undefined))
                          .catch((error) => setActionError(message(error)))
                          .finally(overview.reload);
                      }}>确认静默</Button>
                      <Button onClick={() => setSilenceDraft(undefined)}>取消</Button>
                    </span>
                  ) : (
                    <Button disabled={!canWrite(role)} onClick={() => setSilenceDraft({ key: alert.key, hours: 24, reason: '' })}>静默…</Button>
                  )}
                  {alert.notifyState ? (
                    <div style={muted}>
                      外部通知：{alert.notifyState === 'sent' ? '已发送' : alert.notifyState === 'skipped' ? '已跳过' : '发送失败'}
                      {alert.lastNotifiedAt ? ` · ${when(alert.lastNotifiedAt)}` : ''}{alert.notifyError ? ` · ${alert.notifyError}` : ''}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {actionError ? <Notice tone="bad">{actionError}</Notice> : null}
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

/** Renders the shared next step as a button, so the history page and this page agree. */
function NextStep({ alert, navigate }: { alert: Alert; navigate: (to: string) => void }) {
  const next = alertNextStep(alert);
  return next ? <Button onClick={() => navigate(next.to)}>{next.label}</Button> : null;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', `${minutes} 分钟`].filter(Boolean).join(' ');
}
