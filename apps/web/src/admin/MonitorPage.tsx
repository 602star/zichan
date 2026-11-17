import type { AdminClient } from './client.js';
import { MetricLineChart } from './chart.js';
import { MetricCatalog } from './MetricCatalog.js';
import { TrendTimeRange, trendQuery } from './TrendTimeRange.js';
import { WorkspaceTabs } from './WorkspaceTabs.js';
import type { Metrics, Overview, SystemMetrics, SystemMonitorReading } from './types.js';
import { Badge, Button, DataTable, Loading, Notice, PageHeader, Panel, Stat, bytes, usePolling, useResource, when } from './ui.js';

const RANGES = ['1h','24h','7d','30d','90d'] as const;
export function MonitorPage({ client, query, navigate }: { client: AdminClient; role: string; query: URLSearchParams; navigate: (path: string) => void }) {
  const windowQuery = trendQuery(query, [...RANGES]);
  const range = new URLSearchParams(windowQuery).get('range')!;
  const view = query.get('view') === 'system' ? 'system' : query.get('view') === 'metrics' ? 'metrics' : 'application';
  const update = (patch: Record<string, string>) => { const next = new URLSearchParams(query); for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); } navigate(`/monitor?${next}`); };
  const overview = useResource(() => client.request<Overview>('/overview'), []);
  const system = useResource(() => client.request<SystemMonitorReading>('/system'), []);
  const metrics = useResource(() => client.request<Metrics>(`/metrics?${windowQuery}`), [windowQuery]);
  const history = useResource(() => client.request<SystemMetrics>(`/system/metrics?${windowQuery}`), [windowQuery]);
  const refresh = () => { overview.reload(); system.reload(); metrics.reload(); history.reload(); };
  usePolling(refresh, 30000);
  const current = overview.data?.snapshot.process;
  const reading = system.data;
  const scope = reading?.scope === 'container' ? '容器' : '主机';
  const stale = overview.stale || system.stale || metrics.stale || history.stale || overview.data?.snapshot.stale;
  const granularity = view === 'system' ? history.data?.granularity : metrics.data?.granularity;
  const bucketMs = granularity === 'minute' ? 60_000 : granularity === 'day' ? 86_400_000 : 3_600_000;
  const ms = (n: number | null | undefined) => n == null ? '未采集' : `${n.toFixed(1)} ms`;
  return <>
    <PageHeader title="运行监控" description="应用自身与当前可见系统资源。访问与请求、数据库分析使用各自的主入口。" actions={<Button onClick={refresh}>刷新</Button>} />
    <WorkspaceTabs path="/monitor" query={query} navigate={navigate} />
    <TrendTimeRange label="历史趋势时间范围" query={query} presets={[...RANGES]} maxDays={90} onChange={update} />
    <Loading loading={overview.loading || system.loading || metrics.loading || history.loading} error={overview.error || system.error || metrics.error || history.error} stale={Boolean(stale)} />
    <div className="zc-admin-ops-provenance"><Badge tone={stale ? 'warn' : 'muted'}>{stale ? '数据过期' : overview.data ? '采样已更新' : '未采集'}</Badge><span>来源：{view === 'application' ? 'Node process API' : reading?.scope === 'container' ? 'cgroup / 当前命名空间' : '操作系统'}</span><span>采样：{when(overview.data?.snapshot.sampledAt)}</span><span>时区：{Intl.DateTimeFormat().resolvedOptions().timeZone} · {range === 'custom' ? '自定义区间' : `近 ${range}`}</span></div>
    <p className="zc-admin-history-note">顶部当前读数不受历史区间影响；趋势按完整 UTC 分钟／小时桶覆盖边界，缺失采样不补零。{metrics.data && `${when(metrics.data.from)} 至 ${when(metrics.data.until)}`}</p>
    {view === 'metrics' ? <MetricCatalog metrics={metrics.data} system={history.data} reading={reading} range={range} /> : view === 'application' ? <>
      <Panel title="Node 进程" note="CPU 以单核 100% 为基准，可超过 100%；RSS、V8 堆和 external 属不同内存口径。">
        <div className="zc-admin-ops-band"><Stat label="RSS" value={current ? bytes(current.rssBytes) : '未采集'} /><Stat label="V8 堆已用" value={current ? bytes(current.heapUsedBytes) : '未采集'} hint={current ? `已分配 ${bytes(current.heapTotalBytes)}` : undefined} /><Stat label="堆外内存" value={current ? bytes(current.externalBytes) : '未采集'} hint={current ? `ArrayBuffer ${bytes(current.arrayBuffersBytes)}` : undefined} /><Stat label="CPU · 单核基准" value={current?.cpuPercent == null ? '未采集' : `${current.cpuPercent.toFixed(1)}%`} /></div>
        <dl className="zc-admin-ops-facts"><div><dt>事件循环 P95 / P99</dt><dd>{ms(current?.eventLoopP95Ms)} / {ms(current?.eventLoopP99Ms)}</dd></div><div><dt>事件循环均值 / 最大</dt><dd>{ms(current?.eventLoopMeanMs)} / {ms(current?.eventLoopMaxMs)}</dd></div><div><dt>PID / Node</dt><dd>{current?.pid ?? '未采集'} / {current?.nodeVersion ?? '未采集'}</dd></div><div><dt>启动时间</dt><dd>{when(current?.startedAt)}</dd></div></dl>
      </Panel>
      <div className="zc-admin-monitor-grid"><Panel title="进程内存趋势" note="每个桶保存峰值，缺失样本不补零。"><MetricLineChart label="进程 RSS 与 V8 堆趋势" bucketMs={bucketMs} formatValue={bytes} series={[
        { label: 'RSS', color: 'var(--accent)', points: (metrics.data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.rssBytes || null })) },
        { label: 'V8 堆', color: 'var(--positive)', points: (metrics.data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.heapUsedBytes || null })) },
      ]} /></Panel><Panel title="进程 CPU 趋势" note="单核 100% 基准；历史为分桶峰值。"><MetricLineChart label="进程 CPU 趋势" bucketMs={bucketMs} formatValue={(n) => `${n.toFixed(1)}%`} series={[{ label: 'CPU', color: 'var(--positive)', points: (metrics.data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.rssBytes ? r.cpuPercent : null })) }]} /></Panel></div>
    </> : <>
      <Panel title={`${scope}资源`} note={reading?.scope === 'container' ? 'CPU/内存来自 cgroup；其他指标来自当前命名空间。完整宿主机与容器生命周期状态进入“主机与容器”。' : '直接运行时采集当前主机可见资源。独立探活和容器生命周期状态进入“主机与容器”。'}>
        <div className="zc-admin-ops-band"><Stat label={`${scope} CPU`} value={reading?.cpuPercent == null ? '未采集' : `${reading.cpuPercent.toFixed(1)}%`} /><Stat label={`${scope}内存`} value={reading?.memoryUsedBytes == null ? '未采集' : bytes(reading.memoryUsedBytes)} hint={reading?.memoryTotalBytes == null ? '总量或限额未配置' : `总量 / 限额 ${bytes(reading.memoryTotalBytes)}`} /><Stat label="网络接收" value={reading?.networkRxBytesPerSecond == null ? '未采集' : `${bytes(reading.networkRxBytesPerSecond)}/s`} /><Stat label="网络发送" value={reading?.networkTxBytesPerSecond == null ? '未采集' : `${bytes(reading.networkTxBytesPerSecond)}/s`} /></div>
        {reading?.unavailable.length ? <Notice tone="warn">{reading.unavailable.join('；')}</Notice> : null}<Button onClick={() => navigate('/host')}>独立宿主机与容器探测</Button>
      </Panel>
      <div className="zc-admin-monitor-grid"><Panel title={`${scope}内存趋势`}><MetricLineChart label="系统内存趋势" bucketMs={bucketMs} formatValue={bytes} series={[{ label: '已用内存', color: 'var(--accent)', points: (history.data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.memoryUsedBytes })) }]} /></Panel><Panel title="磁盘 IO 趋势"><MetricLineChart label="系统磁盘 IO 趋势" bucketMs={bucketMs} formatValue={(n) => `${bytes(n)}/s`} series={[
        { label: '读取', color: 'var(--positive)', points: (history.data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.diskReadBytesPerSecond })) },
        { label: '写入', color: 'var(--accent)', points: (history.data?.buckets ?? []).map((r) => ({ at: r.bucketAt, value: r.diskWriteBytesPerSecond })) },
      ]} /></Panel></div>
      <Panel title="可见进程"><DataTable rows={reading?.topProcesses ?? []} rowKey={(r) => String(r.pid)} empty="未采集到进程列表。" columns={[{ key: 'name', header: '进程', render: (r) => r.name },{ key: 'pid', header: 'PID', render: (r) => r.pid },{ key: 'cpu', header: 'CPU', render: (r) => `${r.cpuPercent.toFixed(1)}%` },{ key: 'rss', header: 'RSS', render: (r) => bytes(r.rssBytes) }]} /></Panel>
    </>}
  </>;
}
