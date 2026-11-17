import { useState } from 'react';
import type { AdminClient } from './client.js';
import { MetricLineChart } from './chart.js';
import { StartupTimingPanel } from './StartupTimingPanel.js';
import { TrafficPanel } from './TrafficPanel.js';
import { DatabaseDiagnostics } from './DatabaseDiagnostics.js';
import { TrendTimeRange, trendQuery } from './TrendTimeRange.js';
import { WorkspaceTabs } from './WorkspaceTabs.js';
import { Badge, Button, DataTable, Loading, Notice, PageHeader, Panel, Stat, bytes, muted, usePolling, useResource, when } from './ui.js';

interface Envelope<T> {
  data: T;
  meta: { generatedAt: string; dataAsOf: string | null; source: string; stale: boolean; samplingIntervalSeconds: number };
}
interface RequestSummary {
  totalRequests: number; errors5xx: number; errors4xx: number; errorRate5xx: number | null; qpsAverage: number;
  averageMs: number | null; latencyMs: { p50: number | null; p95: number | null; p99: number | null };
}
interface Requests extends RequestSummary {
  bucketMs: number;
  sourceResolution: 'minute' | 'hour'; observedSince: string | null;
  windowStart: string; windowEnd: string; note: string;
  routes: (RequestSummary & { key: string; route: string; method: string })[];
  buckets: (RequestSummary & { bucketAt: string })[];
  collector: { queueDepth: number; dropped: number; writeFailures: number; instanceId: string };
}
interface Heartbeat {
  jobKey: string; instanceId: string; status: string; lastSuccessAt: string | null; lastFailureAt: string | null;
  startedAt: string | null; durationMs: number | null; failureStreak: number; stale: boolean;
}
interface Collectors {
  jobs: Heartbeat[];
  http: { instanceId: string; queueDepth: number; dropped: number; writeFailures: number; lastSuccessAt: string | null };
}

const TITLES = { requests: '请求分析', traffic: '访问分析', database: '数据库', collectors: '采集任务', host: '主机与容器' };
type View = keyof typeof TITLES;
const ms = (value: number | null | undefined) => value == null ? '未采集' : `${value.toFixed(1)} ms`;
const percent = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(2)}%`;

export function OperationsPage({ client, view, query, navigate, role }: { client: AdminClient; view: View; query: URLSearchParams; navigate: (to: string) => void; role: string }) {
  const [paused, setPaused] = useState(false);
  const presets = view === 'requests' ? ['15m', '1h', '24h', '7d', '30d', '90d'] : ['1h', '24h', '7d', '30d', '90d'];
  const windowQuery = trendQuery(query, presets);
  const range = new URLSearchParams(windowQuery).get('range')!;
  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    navigate(`/${view}?${next}`);
  };
  return <>
    <PageHeader title={TITLES[view]} description={{ requests: '按真实响应分析 API 请求，沿路由和请求 ID 继续排查。', traffic: '页面访问与 API 性能分别统计，保留清楚的访客与活动口径。', database: '只展示当前 SQLite 引擎实际可采集的状态。', collectors: '检查采集任务本身，分开查看最近成功与最近失败。', host: '独立宿主机检查器提供的数据，应用停止后仍可探测和推送。' }[view]}
      actions={<Button aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? '恢复自动刷新' : '暂停自动刷新'}</Button>} />
    {view !== 'database' && <WorkspaceTabs path={`/${view}`} query={query} navigate={navigate} />}
    <div className="zc-admin-ops-toolbar">
      {view === 'requests' || view === 'traffic' ? <TrendTimeRange label="统计时间范围" query={query} presets={presets} maxDays={90} onChange={update} /> : <span>当前状态快照，不提供历史区间查询。</span>}
      <span>时区：{Intl.DateTimeFormat().resolvedOptions().timeZone} · {paused ? '自动刷新已暂停' : '每 30 秒刷新'}</span>
    </div>
    {view === 'requests' ? <RequestsPanel client={client} range={range} windowQuery={windowQuery} route={query.get('route') ?? ''} paused={paused} update={update} navigate={navigate} /> : null}
    {view === 'traffic' ? <><TrafficPanel client={client} range={range} windowQuery={windowQuery} paused={paused} country={query.get('country') ?? ''} onCountry={(country) => update({ country })} /><StartupTimingPanel client={client} range={range === '30d' || range === '90d' ? range : '7d'} windowQuery={range === 'custom' ? windowQuery : undefined} /></> : null}
    {view === 'database' ? <><DatabaseDiagnostics client={client} paused={paused} role={role} onJob={(id) => navigate(`/jobs?job=${encodeURIComponent(id)}`)} /><Button onClick={() => navigate('/storage')}>存储与备份</Button></> : null}
    {view === 'collectors' ? <CollectorsPanel client={client} paused={paused} /> : null}
    {view === 'host' ? <HostPanel client={client} paused={paused} /> : null}
  </>;
}

function HostPanel({ client, paused }: { client: AdminClient; paused: boolean }) {
  const resource = useResource(() => client.request<Envelope<null | { active: boolean; targetStatus: string; failures: string[]; disk: null | { availableBytes: number; totalBytes: number; inodeAvailable: number; inodeTotal: number }; containers: { name: string; running: boolean; health: string; oomKilled: boolean; restartCount: number }[]; delivery: { status: string; code: string } }>>('/ops/host'), []);
  usePolling(resource.reload, 30000, !paused);
  const data = resource.data?.data;
  return <>
    <Loading loading={resource.loading} error={resource.error} stale={resource.stale} loadedAt={resource.loadedAt} />
    <Sampling meta={resource.data?.meta} stale={resource.stale} />
    {!data ? <Notice tone="warn">未采集。请在 Linux 宿主机启用独立探活 timer，并将状态文件写入应用数据目录的 host-observability.json。未安装前无法报告容器停止、OOM 或进程退出告警。</Notice> : <>
      <Panel title="宿主机探测" action={<Button onClick={resource.reload}>刷新探测</Button>}>
        <div className="zc-admin-ops-band">
          <Stat label="应用探活" value={resource.stale || resource.data?.meta.stale ? '数据过期' : data.targetStatus === 'healthy' ? '可应答' : '不可用'} tone={data.targetStatus === 'healthy' ? undefined : 'bad'} />
          <Stat label="磁盘可用空间" value={data.disk ? bytes(data.disk.availableBytes) : '未采集'} />
          <Stat label="可用 inode" value={data.disk?.inodeAvailable?.toLocaleString() ?? '未采集'} />
          <Stat label="推送受理状态" value={data.delivery.status} hint={data.delivery.code} />
        </div>
        {data.failures.length ? <Notice tone="warn">{data.failures.join('；')}</Notice> : null}
      </Panel>
      <Panel title="容器状态"><DataTable rows={data.containers} rowKey={(r) => r.name} empty="未配置容器白名单。" columns={[
        { key: 'name', header: '容器', render: (r) => r.name },
        { key: 'running', header: '运行', render: (r) => resource.data?.meta.stale || resource.stale ? '数据过期' : r.running ? '运行中' : '已停止' },
        { key: 'health', header: '健康检查', render: (r) => r.health },
        { key: 'oom', header: 'OOM', render: (r) => r.oomKilled ? '是' : '否' },
        { key: 'restarts', header: '重启次数', render: (r) => r.restartCount },
      ]} /></Panel>
    </>}
    <p style={muted}>探活来自独立宿主机进程。整台服务器宕机或断网仍需异机探测；Bark 受理不等于手机已展示通知。</p>
  </>;
}

function Sampling({ meta, stale = false }: { meta?: Envelope<unknown>['meta']; stale?: boolean }) {
  return <div className="zc-admin-ops-provenance" role="status">
    <Badge tone={!meta || meta.stale || stale ? 'warn' : 'muted'}>{!meta?.dataAsOf ? '未采集' : meta.stale || stale ? '数据过期' : '采样已更新'}</Badge>
    <span>来源：{meta?.source ?? '等待连接'}</span><span>采样：{meta?.dataAsOf ? when(meta.dataAsOf) : '尚无成功样本'}</span>
    {meta?.generatedAt ? <span>响应：{when(meta.generatedAt)}</span> : null}
  </div>;
}

export function RequestsPanel({ client, range, windowQuery = `range=${range}`, route = '', paused = false, update, navigate }: { client: AdminClient; range: string; windowQuery?: string; route?: string; paused?: boolean; update?: (patch: Record<string, string>) => void; navigate: (to: string) => void }) {
  const resource = useResource(() => client.request<Envelope<Requests>>(`/ops/requests/summary?${windowQuery}&route=${encodeURIComponent(route)}`), [windowQuery, route]);
  usePolling(resource.reload, 30000, !paused);
  const data = resource.data?.data;
  const available = data && resource.data?.meta.dataAsOf;
  return <>
    <Loading loading={resource.loading} error={resource.error} stale={resource.stale} loadedAt={resource.loadedAt} />
    <Sampling meta={resource.data?.meta} stale={resource.stale} />
    <Panel title={route ? `${route} · 请求表现` : 'API 请求表现'} action={<><Button onClick={resource.reload}>刷新请求</Button>{route ? <Button onClick={() => update?.({ route: '' })}>全部路由</Button> : null}</>} note={data?.note}>
      <div className="zc-admin-ops-band">
        <Stat label="有效响应" value={available ? data.totalRequests.toLocaleString() : '未采集'} hint="所选 UTC 统计窗口内" />
        <Stat label="平均 QPS" value={available ? data.qpsAverage.toFixed(2) : '—'} hint="有效响应数 / 窗口秒数" />
        <Stat label="5xx 错误率" value={available ? percent(data.errorRate5xx) : '—'} hint={available ? `${data.errors5xx} 次 5xx / ${data.totalRequests} 次响应` : '等待样本'} tone={data?.errors5xx ? 'bad' : undefined} />
        <Stat label="P95 响应耗时" value={available ? ms(data.latencyMs.p95) : '未采集'} hint="固定直方图桶近似 · ms" />
      </div>
      <p style={muted}>P50 {ms(data?.latencyMs.p50)} · P99 {ms(data?.latencyMs.p99)} · 4xx {data?.errors4xx ?? '—'} 次（单独统计）</p>
      {data ? <p style={muted}>{when(data.windowStart)} 至 {when(data.windowEnd)} · 按完整 UTC {data.sourceResolution === 'hour' ? '小时' : '分钟'}桶覆盖边界；无请求时延迟与错误率显示为空。</p> : null}
      <p style={muted}>分钟数据保留 7 天，更早转为小时汇总并保留 90 天；长区间按天展示趋势。升级前已清理的数据无法恢复，空区间不代表历史上没有请求。{data?.observedSince ? `本区间最早保留样本：${when(data.observedSince)}。` : ''}</p>
    </Panel>
    <div className="zc-admin-monitor-grid">
      <Panel title="请求量与 5xx" note="计数 / 时间桶；缺失桶保留断线。">
        <MetricLineChart label="API 请求量与 5xx 趋势" bucketMs={data?.bucketMs ?? (range === '15m' || range === '1h' ? 60000 : 3600000)} formatValue={(n) => n.toFixed(0)} series={[
          { label: '有效响应', color: 'var(--positive)', points: (data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.totalRequests })) },
          { label: '5xx', color: 'var(--danger)', points: (data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.errors5xx })) },
        ]} />
      </Panel>
      <Panel title="P95 延迟趋势" note="先合并各时间桶直方图，再计算分位数；单位 ms。">
        <MetricLineChart label="API P95 延迟趋势" bucketMs={data?.bucketMs ?? (range === '15m' || range === '1h' ? 60000 : 3600000)} formatValue={(n) => `${n.toFixed(0)} ms`} series={[
          { label: 'P95', color: 'var(--accent)', points: (data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.latencyMs.p95 })) },
        ]} />
      </Panel>
    </div>
    <Panel title="路由排行" note="只保存规范化路由，不保存查询参数或账号、账本、附件标识。最多显示 50 条。" action={<Button onClick={() => navigate('/access-logs')}>查看访问日志</Button>}>
      <DataTable rows={data?.routes ?? []} rowKey={(r) => r.key} empty="此窗口尚无已落库请求，采集周期为 30 秒。" columns={[
        { key: 'method', header: '方法', render: (r: Requests['routes'][number]) => r.method },
        { key: 'route', header: '路由', render: (r: Requests['routes'][number]) => <button className="zc-admin-inline-link" onClick={() => update?.({ route: r.route })}>{r.route}</button> },
        { key: 'count', header: '响应数', render: (r: Requests['routes'][number]) => r.totalRequests },
        { key: 'errors', header: '5xx / 响应数', render: (r: Requests['routes'][number]) => `${r.errors5xx} / ${r.totalRequests}` },
        { key: 'p95', header: 'P95 · ms', render: (r: Requests['routes'][number]) => ms(r.latencyMs.p95) },
      ]} />
    </Panel>
  </>;
}

function CollectorsPanel({ client, paused }: { client: AdminClient; paused: boolean }) {
  const resource = useResource(() => client.request<Envelope<Collectors>>('/ops/jobs/heartbeats'), []);
  usePolling(resource.reload, 30000, !paused);
  const data = resource.data?.data;
  const names: Record<string, string> = { running: '采集中', timeout: '执行超时', failed: '最近采集失败', stale: '数据过期', healthy: '正常', unknown: '未采集' };
  return <>
    <Loading loading={resource.loading} error={resource.error} stale={resource.stale} loadedAt={resource.loadedAt} />
    <Sampling meta={resource.data?.meta} stale={resource.stale} />
    <Panel title="采集器健康" action={<Button onClick={resource.reload}>刷新心跳</Button>} note="超时优先于失败，失败优先于过期；最近失败不会被旧成功掩盖。">
      <div className="zc-admin-ops-band">
        <Stat label="待写入维度" value={data?.http.queueDepth ?? '未采集'} hint="最多 2,000 个维度桶" />
        <Stat label="丢弃请求样本" value={data?.http.dropped ?? '未采集'} tone={data?.http.dropped ? 'warn' : undefined} />
        <Stat label="写入失败" value={data?.http.writeFailures ?? '未采集'} tone={data?.http.writeFailures ? 'bad' : undefined} />
      </div>
      <DataTable rows={data?.jobs ?? []} rowKey={(r) => r.jobKey} empty="采集任务尚未完成首个周期。" columns={[
        { key: 'key', header: '采集任务', render: (r: Heartbeat) => <>{r.jobKey}<small>Node / HTTP / 系统资源 · 30 秒</small></> },
        { key: 'status', header: '状态', render: (r: Heartbeat) => <><Badge tone={r.status === 'healthy' && !resource.stale ? 'ok' : 'warn'}>{resource.stale ? '状态未知' : names[r.status] ?? r.status}</Badge>{r.stale && r.status === 'failed' ? ' · 已过期' : ''}</> },
        { key: 'success', header: '最后成功', render: (r: Heartbeat) => when(r.lastSuccessAt) },
        { key: 'failure', header: '最后失败', render: (r: Heartbeat) => when(r.lastFailureAt) },
        { key: 'duration', header: '执行耗时', render: (r: Heartbeat) => ms(r.durationMs) },
        { key: 'streak', header: '连续失败', render: (r: Heartbeat) => r.failureStreak },
      ]} />
      <p style={muted}>当前实例：{data?.http.instanceId ?? '等待采集'}。宿主机探活独立于此进程；本页无法在应用退出后继续刷新。</p>
    </Panel>
  </>;
}
