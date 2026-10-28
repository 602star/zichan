import { useState } from 'react';
import { MetricLineChart } from './chart.js';
import type { Metrics, SystemMetrics, SystemMonitorReading } from './types.js';
import { Button, DataTable, Panel, TextInput, bytes, muted } from './ui.js';

type Point = { at: string; value: number | null };
type MetricRow = {
  key: string; label: string; type: '分桶计数' | '采样读数'; scope: string; unit: string;
  current: number | null; points: Point[]; format: (value: number) => string;
};
const number = (value: number) => value.toFixed(0);
const percent = (value: number) => `${value.toFixed(1)}%`;
const milliseconds = (value: number) => `${value.toFixed(1)} ms`;

function downloadCsv(metric: MetricRow): void {
  const csv = `time,value,unit\n${metric.points.map((point) => `${point.at},${point.value ?? ''},${metric.unit}`).join('\n')}\n`;
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `metric-${metric.key}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function MetricCatalog({ metrics, system, reading, range }: {
  metrics: Metrics | undefined; system: SystemMetrics | undefined;
  reading: SystemMonitorReading | undefined; range: string;
}) {
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState('requests');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const requestPoints = <K extends keyof Metrics['buckets'][number]>(key: K) => (metrics?.buckets ?? []).map((bucket) => ({ at: bucket.bucketAt, value: Number(bucket[key]) }));
  const systemPoints = <K extends keyof SystemMetrics['buckets'][number]>(key: K) => (system?.buckets ?? []).map((bucket) => ({ at: bucket.bucketAt, value: bucket[key] as number | null }));
  const lastRequest = metrics?.buckets.at(-1);
  const scope = reading?.scope === 'container' ? '容器' : '主机';
  const rows: MetricRow[] = [
    { key: 'requests', label: 'HTTP 请求量', type: '分桶计数', scope: '同步服务器', unit: '次', current: lastRequest?.requests ?? null, points: requestPoints('requests'), format: number },
    { key: 'errors', label: 'HTTP 4xx/5xx', type: '分桶计数', scope: '同步服务器', unit: '次', current: lastRequest?.errors ?? null, points: requestPoints('errors'), format: number },
    { key: 'slowRequests', label: '慢请求', type: '分桶计数', scope: '同步服务器', unit: '次', current: lastRequest?.slowRequests ?? null, points: requestPoints('slowRequests'), format: number },
    { key: 'syncPushOk', label: '同步推送成功', type: '分桶计数', scope: '同步服务器', unit: '次', current: lastRequest?.syncPushOk ?? null, points: requestPoints('syncPushOk'), format: number },
    { key: 'syncPushFailed', label: '同步推送失败', type: '分桶计数', scope: '同步服务器', unit: '次', current: lastRequest?.syncPushFailed ?? null, points: requestPoints('syncPushFailed'), format: number },
    { key: 'syncPullOk', label: '同步拉取成功', type: '分桶计数', scope: '同步服务器', unit: '次', current: lastRequest?.syncPullOk ?? null, points: requestPoints('syncPullOk'), format: number },
    { key: 'blobOk', label: '附件请求成功', type: '分桶计数', scope: '同步服务器', unit: '次', current: lastRequest?.blobOk ?? null, points: requestPoints('blobOk'), format: number },
    { key: 'blobFailed', label: '附件请求失败', type: '分桶计数', scope: '同步服务器', unit: '次', current: lastRequest?.blobFailed ?? null, points: requestPoints('blobFailed'), format: number },
    { key: 'rssBytes', label: '进程 RSS 峰值', type: '采样读数', scope: 'Node 进程', unit: '字节', current: lastRequest?.rssBytes ?? null, points: requestPoints('rssBytes'), format: bytes },
    { key: 'heapUsedBytes', label: '进程堆已用峰值', type: '采样读数', scope: 'Node 进程', unit: '字节', current: lastRequest?.heapUsedBytes ?? null, points: requestPoints('heapUsedBytes'), format: bytes },
    { key: 'cpuPercent', label: '进程 CPU 峰值', type: '采样读数', scope: 'Node 进程', unit: '%', current: lastRequest?.cpuPercent ?? null, points: requestPoints('cpuPercent'), format: percent },
    { key: 'eventLoopMaxMs', label: '事件循环最大延迟', type: '采样读数', scope: 'Node 进程', unit: 'ms', current: lastRequest?.eventLoopMaxMs ?? null, points: requestPoints('eventLoopMaxMs'), format: milliseconds },
    { key: 'systemCpu', label: `${scope} CPU`, type: '采样读数', scope, unit: '%', current: reading?.cpuPercent ?? null, points: systemPoints('cpuPercent'), format: percent },
    { key: 'systemMemory', label: `${scope}内存已用`, type: '采样读数', scope, unit: '字节', current: reading?.memoryUsedBytes ?? null, points: systemPoints('memoryUsedBytes'), format: bytes },
    { key: 'systemDiskRead', label: `${scope}磁盘读取`, type: '采样读数', scope, unit: '字节/秒', current: reading?.diskReadBytesPerSecond ?? null, points: systemPoints('diskReadBytesPerSecond'), format: bytes },
    { key: 'systemDiskWrite', label: `${scope}磁盘写入`, type: '采样读数', scope, unit: '字节/秒', current: reading?.diskWriteBytesPerSecond ?? null, points: systemPoints('diskWriteBytesPerSecond'), format: bytes },
    { key: 'systemNetworkRx', label: `${scope}网络接收`, type: '采样读数', scope, unit: '字节/秒', current: reading?.networkRxBytesPerSecond ?? null, points: systemPoints('networkRxBytesPerSecond'), format: bytes },
    { key: 'systemNetworkTx', label: `${scope}网络发送`, type: '采样读数', scope, unit: '字节/秒', current: reading?.networkTxBytesPerSecond ?? null, points: systemPoints('networkTxBytesPerSecond'), format: bytes },
  ];
  const filtered = rows.filter((row) => `${row.label} ${row.key} ${row.scope}`.toLowerCase().includes(search.toLowerCase().trim()));
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0]!;
  const bucketMs = range === '1h' ? 60_000 : range === '30d' || range === '90d' ? 86_400_000 : 3_600_000;
  return <section className="zc-admin-monitor-section">
    <h2>指标总表</h2>
    <p style={muted}>登记的是现有服务器与系统采样。计数列显示最近分桶的次数；采样读数显示当前读数或最近分桶峰值，缺失保持空白。</p>
    <Panel title="登记指标" action={<TextInput aria-label="搜索指标" placeholder="搜索名称、键或来源" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />}>
      <DataTable rows={visible} rowKey={(row) => row.key} activeKey={selected.key} onRowClick={(row) => setSelectedKey(row.key)} empty="没有匹配的指标"
        columns={[
          { key: 'name', header: '指标', render: (row: MetricRow) => <><strong>{row.label}</strong><br /><code>{row.key}</code></> },
          { key: 'type', header: '类型', render: (row: MetricRow) => row.type },
          { key: 'scope', header: '来源', render: (row: MetricRow) => row.scope },
          { key: 'value', header: '最近值', render: (row: MetricRow) => row.current === null ? '—' : row.format(row.current) },
        ]} />
      <div className="zc-admin-monitor-catalog-controls">
        <span>{filtered.length} 项 · 第 {Math.min(page + 1, Math.max(1, Math.ceil(filtered.length / pageSize)))} 页</span>
        <label>每页 <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}><option value={10}>10</option><option value={20}>20</option></select></label>
        <Button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
        <Button disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage(page + 1)}>下一页</Button>
      </div>
    </Panel>
    <Panel title={`${selected.label} · 历史趋势`} note={`${selected.scope} · ${selected.type} · ${selected.unit}。数据从服务端 SQLite 指标分桶读取。`} action={<Button disabled={!selected.points.length} onClick={() => downloadCsv(selected)}>导出 CSV</Button>}>
      <MetricLineChart label={`${selected.label}，近 ${range}`} bucketMs={bucketMs} formatValue={selected.format}
        series={[{ label: selected.label, color: 'var(--accent)', points: selected.points }]} />
    </Panel>
  </section>;
}
