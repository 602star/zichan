/** Server resources and application occupancy appear together, with explicit collection scope. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { MetricLineChart } from './chart.js';
import { pendingAlerts, overviewStatus } from './operations.js';
import { ResourcesPage } from './ResourcesPage.js';
import type { Metrics, Overview, SystemMetrics, SystemMonitorReading } from './types.js';
import { Badge, Button, Loading, Notice, PageHeader, Panel, Stat, bytes, muted, usePolling, useResource, when } from './ui.js';

const RANGES = ['1h', '24h', '7d', '30d', '90d'] as const;
type Range = (typeof RANGES)[number];

export function MonitorPage({ client, role }: { client: AdminClient; role: string }) {
  const [range, setRange] = useState<Range>('24h');
  const [jobId, setJobId] = useState('');
  const overview = useResource(() => client.request<Overview>('/overview'), []);
  const systemResource = useResource(() => client.request<SystemMonitorReading>('/system'), []);
  const systemMetrics = useResource(() => client.request<SystemMetrics>(`/system/metrics?range=${range}`), [range]);
  const metrics = useResource(() => client.request<Metrics>(`/metrics?range=${range}`), [range]);
  const logs = useResource(() => client.request<{
    buckets: { bucketAt: string; info: number; warn: number; error: number }[];
  }>(`/logs/summary?range=${range}`), [range]);
  usePolling(() => { overview.reload(); systemResource.reload(); systemMetrics.reload(); metrics.reload(); logs.reload(); }, 30_000);
  const system = systemResource.data;
  const storage = overview.data?.snapshot.storage;
  const scope = system?.scope === 'container' ? '容器' : '主机';
  const diskUsed = storage?.diskTotalBytes != null && storage.diskFreeBytes != null ? storage.diskTotalBytes - storage.diskFreeBytes : null;
  const alerts = pendingAlerts(overview.data?.alerts ?? []);
  const stale = overview.stale || systemResource.stale || metrics.stale;
  const buckets = metrics.data?.buckets ?? [];
  const systemBuckets = systemMetrics.data?.buckets ?? [];
  const logBuckets = logs.data?.buckets ?? [];
  const bucketMs = range === '1h' ? 60_000 : range === '30d' || range === '90d' ? 86_400_000 : 3_600_000;
  const logBucketMs = range === '7d' ? 86_400_000 : bucketMs;
  const asSeries = <T extends { bucketAt: string }>(rows: T[], value: (row: T) => number | null) => rows.map((row) => ({ at: row.bucketAt, value: value(row) }));
  const percent = (part: number | null, total: number | null) => part === null || total === null || total <= 0 ? null : part / total * 100;

  return <>
    <PageHeader title="监控中心" description="在同一页查看服务器资源、软件运行占用和异常。" actions={<>
      <div className="zc-admin-view-switch" aria-label="监控时间范围">{RANGES.map((value) => <Button key={value} aria-pressed={range === value} disabled={range === value} onClick={() => setRange(value)}>{value}</Button>)}</div>
      <Button onClick={() => { overview.reload(); systemResource.reload(); systemMetrics.reload(); metrics.reload(); logs.reload(); }}>刷新全部</Button>
    </>} />
    <Loading loading={overview.loading || systemResource.loading || systemMetrics.loading || metrics.loading || logs.loading}
      error={overview.error || systemResource.error || systemMetrics.error || metrics.error || logs.error}
      stale={stale || systemMetrics.stale || logs.stale} loadedAt={systemResource.loadedAt} />
    {stale ? <Notice tone="warn">采集数据已过期，以下读数不能代表当前状态。</Notice> : null}
    <nav className="zc-admin-overview-jumps" aria-label="监控分区">
      <a href="#section-服务器资源监控">服务器资源监控</a>
      <a href="#section-软件运行占用监控">软件运行占用监控</a>
      <a href="#section-请求与异常">请求与异常</a>
    </nav>

    <section id="section-服务器资源监控" className="zc-admin-monitor-section">
      <h2>服务器资源监控</h2>
      <p style={muted}>{system ? `运行方式：${system.mode === 'docker' ? 'Linux Docker' : system.mode === 'windows' ? 'Windows 直接运行' : system.mode === 'linux' ? 'Linux 直接运行' : '其他'} · 采集范围：${scope} · 采样于 ${when(system.sampledAt)}` : '等待系统资源采样'}</p>
      <Panel title={`${scope}资源`} note={system?.scope === 'container' ? 'CPU/内存采集自 cgroup；网络和进程来自容器当前可见的命名空间。宿主机完整资源需要独立采集器。' : 'CPU、内存、网络和进程来自操作系统；磁盘容量为服务数据所在卷。'}>
        <div className="zc-admin-monitor-stats">
          <Stat label={`${scope} CPU`} value={system?.cpuPercent == null ? '不可用' : `${system.cpuPercent.toFixed(1)}%`} hint={system?.scope === 'container' ? system.unavailable.some((item) => item.includes('未设置 CPU 配额')) ? '单核 100% 基准' : '相对于容器 CPU 配额' : '各逻辑 CPU 的总体负载'} />
          <Stat label={`${scope}内存`} value={system?.memoryUsedBytes == null ? '不可用' : bytes(system.memoryUsedBytes)} hint={system?.memoryTotalBytes == null ? '总量或上限不可用' : `总量或上限 ${bytes(system.memoryTotalBytes)}`} />
          <Stat label="数据卷已用" value={diskUsed == null || !storage?.diskTotalBytes ? '不可用' : `${(diskUsed / storage.diskTotalBytes * 100).toFixed(1)}%`} hint={storage?.diskFreeBytes == null ? '容量不可读' : `剩余 ${bytes(storage.diskFreeBytes)}`} />
          <Stat label="网络接收" value={system?.networkRxBytesPerSecond == null ? '不可用' : `${bytes(system.networkRxBytesPerSecond)}/s`} hint={`${scope}可见网卡总速率`} />
          <Stat label="网络发送" value={system?.networkTxBytesPerSecond == null ? '不可用' : `${bytes(system.networkTxBytesPerSecond)}/s`} hint={`${scope}可见网卡总速率`} />
          <Stat label="磁盘读取" value={system?.diskReadBytesPerSecond == null ? '不可用' : `${bytes(system.diskReadBytesPerSecond)}/s`} />
          <Stat label="磁盘写入" value={system?.diskWriteBytesPerSecond == null ? '不可用' : `${bytes(system.diskWriteBytesPerSecond)}/s`} />
          <Stat label="可见进程" value={system?.processCount == null ? '不可用' : String(system.processCount)} hint={system?.scope === 'container' ? '容器当前可见进程' : '操作系统进程'} />
        </div>
        {system?.unavailable.length ? <p style={muted}>采集说明：{system.unavailable.join('；')}。</p> : null}
      </Panel>
      <div className="zc-admin-monitor-grid">
        <Panel title={`${scope} CPU 趋势`} note="每个分桶保存最后一次系统采样；断线表示采样缺失。">
          <MetricLineChart label={`${scope} CPU 趋势，近 ${range}`} bucketMs={bucketMs} formatValue={(value) => `${value.toFixed(0)}%`} maxValue={100}
            series={[{ label: 'CPU', color: 'var(--accent)', points: asSeries(systemBuckets, (item) => item.cpuPercent) }]} />
        </Panel>
        <Panel title={`${scope}内存趋势`}>
          <MetricLineChart label={`${scope}内存趋势，近 ${range}`} bucketMs={bucketMs} formatValue={bytes}
            series={[{ label: '已用内存', color: 'var(--accent)', points: asSeries(systemBuckets, (item) => item.memoryUsedBytes) }]} />
        </Panel>
        <Panel title="数据卷容量趋势" note="显示服务数据所在卷的已用比例。">
          <MetricLineChart label={`数据卷容量趋势，近 ${range}`} bucketMs={bucketMs} formatValue={(value) => `${value.toFixed(0)}%`} maxValue={100}
            series={[{ label: '已用空间', color: 'var(--warning)', points: asSeries(systemBuckets, (item) => percent(item.diskUsedBytes, item.diskTotalBytes)) }]} />
        </Panel>
        <Panel title={`${scope}磁盘 IO 趋势`}>
          <MetricLineChart label={`${scope}磁盘 IO 趋势，近 ${range}`} bucketMs={bucketMs} formatValue={(value) => `${bytes(value)}/s`}
            series={[
              { label: '读取', color: 'var(--accent)', points: asSeries(systemBuckets, (item) => item.diskReadBytesPerSecond) },
              { label: '写入', color: 'var(--warning)', points: asSeries(systemBuckets, (item) => item.diskWriteBytesPerSecond) },
            ]} />
        </Panel>
        <Panel title={`${scope}网络趋势`}>
          <MetricLineChart label={`${scope}网络趋势，近 ${range}`} bucketMs={bucketMs} formatValue={(value) => `${bytes(value)}/s`}
            series={[
              { label: '接收', color: 'var(--accent)', points: asSeries(systemBuckets, (item) => item.networkRxBytesPerSecond) },
              { label: '发送', color: 'var(--warning)', points: asSeries(systemBuckets, (item) => item.networkTxBytesPerSecond) },
            ]} />
        </Panel>
      </div>
      <Panel title={`${scope}进程排行`} note="按 CPU 占用排序；仅显示进程名称、PID 和资源占用。">
        {system?.topProcesses.length ? <div className="zc-admin-monitor-process-list" role="table" aria-label="进程资源排行">
          <div role="row" className="zc-admin-monitor-process-row"><strong role="columnheader">进程</strong><strong role="columnheader">PID</strong><strong role="columnheader">CPU</strong><strong role="columnheader">RSS</strong></div>
          {system.topProcesses.map((item) => <div role="row" className="zc-admin-monitor-process-row" key={item.pid}>
            <span role="cell">{item.name}</span><span role="cell">{item.pid}</span><span role="cell">{item.cpuPercent.toFixed(1)}%</span><span role="cell">{bytes(item.rssBytes)}</span>
          </div>)}
        </div> : <p style={muted}>进程列表暂不可用。</p>}
      </Panel>
    </section>

    <section id="section-软件运行占用监控" className="zc-admin-monitor-section">
      <h2>软件运行占用监控</h2>
      <p style={muted}>专门统计同步服务器 Node 进程的 CPU、内存、事件循环和 SQLite 数据库。桌面外壳与浏览器进程不计入。</p>
      <div className="zc-admin-monitor-grid">
        <Panel title="软件 CPU 趋势" note="每个分桶的进程 CPU 峰值。">
          <MetricLineChart label={`软件 CPU 趋势，近 ${range}`} bucketMs={bucketMs} formatValue={(value) => `${value.toFixed(0)}%`} maxValue={100}
            series={[{ label: 'Node 进程 CPU', color: 'var(--accent)', points: asSeries(buckets, (item) => item.rssBytes > 0 ? item.cpuPercent : null) }]} />
        </Panel>
        <Panel title="软件内存趋势" note="每个分桶的 Node 进程 RSS 峰值。">
          <MetricLineChart label={`软件内存趋势，近 ${range}`} bucketMs={bucketMs} formatValue={bytes}
            series={[{ label: 'Node 进程 RSS', color: 'var(--warning)', points: asSeries(buckets, (item) => item.rssBytes > 0 ? item.rssBytes : null) }]} />
        </Panel>
      </div>
      {jobId ? <Notice tone="info">已创建维护任务 {jobId}。可在任务中心查看执行结果。</Notice> : null}
      <ResourcesPage client={client} role={role} onJob={setJobId} embedded />
    </section>

    <section id="section-请求与异常" className="zc-admin-monitor-section">
      <h2>请求与异常</h2>
      <div className="zc-admin-monitor-grid">
        <Panel title="请求表现" note="请求量按分桶累计；错误包含 HTTP 4xx 和 5xx。">
          <div className="zc-admin-monitor-mini-stats">
            <Stat label="服务状态" value={stale ? '状态未知' : overviewStatus(overview.data, overview.stale)} />
            <Stat label="请求量" value={metrics.data ? String(metrics.data.totals.requests) : '暂无数据'} />
            <Stat label="错误率" value={metrics.data?.totals.errorRate == null ? '暂无数据' : `${(metrics.data.totals.errorRate * 100).toFixed(1)}%`} />
            <Stat label="平均响应" value={metrics.data?.totals.averageMs == null ? '暂无数据' : `${metrics.data.totals.averageMs} ms`} />
            <Stat label="慢请求" value={metrics.data ? String(metrics.data.totals.slowRequests) : '暂无数据'} hint="耗时至少 1 秒" />
          </div>
          <p style={muted}>当前未保存可计算 API P95 / P99 的延迟分布。</p>
        </Panel>
        <Panel title="异常线索" note="活动告警与最近失败操作直接显示在这里。">
          <div className="zc-admin-monitor-mini-stats"><Stat label="当前异常" value={overview.data ? String(alerts.length) : '暂无数据'} tone={alerts.length ? 'warn' : undefined} /></div>
          {!alerts.length && !overview.data?.recentFailures.length ? <p style={muted}>当前没有活动告警或最近失败的管理操作。</p> : null}
          {alerts.slice(0, 5).map((alert) => <div className="zc-admin-monitor-event" key={alert.key}><Badge tone={alert.severity === 'critical' ? 'bad' : 'warn'}>{alert.state === 'active' ? '活动' : '观察中'}</Badge><span>{alert.rule} · {alert.scope}</span><span style={muted}>{when(alert.lastSeenAt)}</span></div>)}
          {overview.data?.recentFailures.slice(0, 3).map((failure) => <div className="zc-admin-monitor-event" key={failure.id}><Badge tone="warn">操作失败</Badge><span>{failure.action} · {failure.code ?? '未知原因'}</span><span style={muted}>{when(failure.at)}</span></div>)}
        </Panel>
        <Panel title="请求量趋势" note="每个分桶的请求总数。">
          <MetricLineChart label={`请求量趋势，近 ${range}`} bucketMs={bucketMs} formatValue={(value) => value.toFixed(0)}
            series={[{ label: '请求', color: 'var(--accent)', points: asSeries(buckets, (item) => item.requests) }]} />
        </Panel>
        <Panel title="错误率趋势" note="HTTP 4xx 和 5xx 占该分桶请求的比例；没有请求的分桶留空。">
          <MetricLineChart label={`错误率趋势，近 ${range}`} bucketMs={bucketMs} formatValue={(value) => `${value.toFixed(0)}%`} maxValue={100}
            series={[{ label: '错误率', color: 'var(--danger)', points: asSeries(buckets, (item) => item.requests ? item.errors / item.requests * 100 : null) }]} />
        </Panel>
        <Panel title="日志异常趋势" note="统计当前保留的运行日志；超过保留期的数据不会显示。">
          <MetricLineChart label={`日志异常趋势，近 ${range}`} bucketMs={logBucketMs} formatValue={(value) => value.toFixed(0)}
            series={[
              { label: '警告', color: 'var(--warning)', points: asSeries(logBuckets, (item) => item.warn) },
              { label: '错误', color: 'var(--danger)', points: asSeries(logBuckets, (item) => item.error) },
            ]} />
        </Panel>
      </div>
    </section>
  </>;
}
