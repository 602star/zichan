/**
 * Process and database resources.
 *
 * Two questions this page answers that the overview cannot: "is this process about to run out
 * of memory or stop answering" and "is the database growing in a way someone should act on".
 *
 * The split between what is polled and what is fetched on demand is the whole design:
 * everything in the first two panels is a constant-time reading, while the per-table breakdown
 * walks the entire database file and therefore has its own button and its own timestamp.
 */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { PageHeader, Badge, Button, DataTable, Loading, Notice, Panel, Stat, bytes, canWrite, message, muted, row, useActionError, usePolling, useResource, when } from './ui.js';
import { TrendChart } from './chart.js';
import type { Metrics, Overview, ResourcesPayload } from './types.js';
import type { TrendPoint as ChartPoint } from './trend.js';

const RANGES = ['1h', '24h', '7d'] as const;

/** Series the resource chart can draw. All of them are peaks per bucket, not totals. */
const SERIES = [
  { key: 'rss', label: '常驻内存', unit: 'bytes' },
  { key: 'heap', label: 'V8 堆', unit: 'bytes' },
  { key: 'external', label: '堆外内存', unit: 'bytes' },
  { key: 'cpu', label: 'CPU 占用', unit: 'percent' },
  { key: 'lag', label: '事件循环最大延迟', unit: 'ms' },
] as const;
type SeriesKey = (typeof SERIES)[number]['key'];

function seriesValue(bucket: Metrics['buckets'][number], key: SeriesKey): number {
  switch (key) {
    case 'heap': return bucket.heapUsedBytes;
    case 'external': return bucket.externalBytes;
    case 'cpu': return bucket.cpuPercent;
    case 'lag': return bucket.eventLoopMaxMs;
    default: return bucket.rssBytes;
  }
}

function seriesFormat(key: SeriesKey): (value: number) => string {
  const unit = SERIES.find((entry) => entry.key === key)?.unit;
  if (unit === 'bytes') return (value) => bytes(value);
  if (unit === 'percent') return (value) => `${value.toFixed(1)}%`;
  return (value) => `${value.toFixed(1)} ms`;
}

/** A ratio bar: the console shows proportions, so a bare percentage is not enough. */
function Meter({ ratio, tone, label }: { ratio: number | null; tone?: 'warn' | 'bad'; label: string }) {
  if (ratio === null || !Number.isFinite(ratio)) return <span style={muted}>暂无上限可比</span>;
  const clamped = Math.max(0, Math.min(1, ratio));
  const fill = tone === 'bad' ? 'var(--danger)' : tone === 'warn' ? 'var(--warning)' : 'var(--accent)';
  return (
    <div role="img" aria-label={label}>
      <div style={{ height: 8, borderRadius: 'var(--r-pill)', background: 'var(--surface-muted)', overflow: 'hidden' }}>
        <div style={{ width: `${clamped * 100}%`, height: '100%', background: fill }} />
      </div>
      <span style={muted}>{label}</span>
    </div>
  );
}

export function ResourcesPage({ client, role, onJob, embedded = false }: { client: AdminClient; role: string; onJob: (jobId: string) => void; embedded?: boolean }) {
  const writable = canWrite(role);
  const [range, setRange] = useState<(typeof RANGES)[number]>('1h');
  const [series, setSeries] = useState<SeriesKey>('rss');
  // The table scan is a separate resource with its own lifetime: it is requested, not polled.
  const [tables, setTables] = useState<ResourcesPayload['tables']>();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const actionError = useActionError();
  const resources = useResource(() => client.request<ResourcesPayload>('/resources'), []);
  const overview = useResource(() => client.request<Overview>('/overview'), []);
  const metrics = useResource(() => client.request<Metrics>(`/metrics?range=${range}`), [range]);
  usePolling(() => { resources.reload(); overview.reload(); metrics.reload(); }, 30_000);

  const process_ = resources.data?.process;
  const database = resources.data?.database;
  const thresholds = resources.data?.thresholds;
  const ceiling = process_?.constrainedBytes && process_.constrainedBytes > 0 ? process_.constrainedBytes : null;
  const configuredWarn = thresholds?.memoryWarnBytes && thresholds.memoryWarnBytes > 0 ? thresholds.memoryWarnBytes : null;
  const memoryLimit = ceiling ?? configuredWarn;
  const memoryRatio = process_ && memoryLimit ? process_.rssBytes / memoryLimit : null;
  const memoryTone = memoryRatio === null ? undefined : memoryRatio >= 0.95 ? 'bad' : memoryRatio >= 0.85 ? 'warn' : undefined;
  const lagTone = process_?.eventLoopMeanMs !== null && process_?.eventLoopMeanMs !== undefined && thresholds
    ? process_.eventLoopMeanMs >= thresholds.eventLoopLagWarnMs * 2 ? 'bad'
      : process_.eventLoopMeanMs >= thresholds.eventLoopLagWarnMs ? 'warn' : undefined
    : undefined;
  const cpuTone = process_?.cpuPercent !== null && process_?.cpuPercent !== undefined && thresholds && process_.cpuPercent >= thresholds.cpuWarnPercent ? 'warn' : undefined;
  const walLimit = database?.journalSizeLimitBytes ?? 0;
  const wal = resources.data?.storage.walBytes ?? 0;
  const walOver = walLimit > 0 && wal > walLimit;

  const scanTables = () => {
    setScanning(true);
    setScanError('');
    void client.request<ResourcesPayload>('/resources?tables=1')
      .then((payload) => setTables(payload.tables ?? undefined))
      .catch((error) => setScanError(message(error)))
      .finally(() => setScanning(false));
  };

  const analyze = () => {
    actionError.clear();
    void client.request<{ job: { jobId: string } }>('/database/analyze', {}, { idempotencyKey: adminIdempotencyKey('database-analyze') })
      .then((result) => onJob(result.job.jobId))
      .catch((error) => actionError.setError(message(error)));
  };

  return (
    <>
      {!embedded ? <PageHeader title="进程与数据库" description="检查资源瓶颈与数据库占用，按需执行维护。" actions={<><Button onClick={resources.reload}>刷新</Button></>} /> : null}
      <Loading loading={resources.loading} error={resources.error} stale={resources.stale} loadedAt={resources.loadedAt} />
      {actionError.error ? <Notice tone="bad">{actionError.error}</Notice> : null}

      {process_ && !process_.available ? (
        <Notice tone="warn">最近一次采样失败，下面显示的是上一次成功的读数，不代表当前状态。</Notice>
      ) : null}

      <div className="zc-admin-resource-workspace">
      <Panel title="进程资源" note={resources.data?.note}
       >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Stat label="常驻内存（RSS）" tone={memoryTone} value={process_ ? bytes(process_.rssBytes) : '暂无数据'}
            hint={process_ ? `进程 ${process_.pid} · Node ${process_.nodeVersion}` : undefined} />
          <Stat label="V8 堆使用" value={process_ ? bytes(process_.heapUsedBytes) : '暂无数据'}
            hint={process_?.heapLimitBytes ? `堆上限 ${bytes(process_.heapLimitBytes)}，已用 ${((process_.heapUsedBytes / process_.heapLimitBytes) * 100).toFixed(1)}%` : '堆上限未知'} />
          <Stat label="堆外内存" value={process_ ? bytes(process_.externalBytes) : '暂无数据'}
            hint={process_ ? `其中 ArrayBuffer ${bytes(process_.arrayBuffersBytes)}；附件与备份的缓冲在这里，不在堆里` : undefined} />
          <Stat label="CPU 占用" tone={cpuTone} value={process_?.cpuPercent === null || process_?.cpuPercent === undefined ? '暂无数据' : `${process_.cpuPercent.toFixed(1)}%`}
            hint={thresholds ? `采样窗口平均；阈值 ${thresholds.cpuWarnPercent}%（单核满负荷约 100%）` : '采样窗口平均'} />
          <Stat label="事件循环延迟" tone={lagTone}
            value={process_?.eventLoopMeanMs === null || process_?.eventLoopMeanMs === undefined ? '暂无数据' : `${process_.eventLoopMeanMs.toFixed(1)} ms`}
            hint={process_ ? `峰值 ${process_.eventLoopMaxMs?.toFixed(1) ?? '—'} ms，P99 ${process_.eventLoopP99Ms?.toFixed(1) ?? '—'} ms` : undefined} />
          <Stat label="进程启动于" value={process_ ? when(process_.startedAt) : '暂无数据'}
            hint={resources.data ? `已运行 ${Math.floor(resources.data.uptimeSeconds / 3600)} 小时` : undefined} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 12 }}>
          <Meter ratio={memoryRatio} tone={memoryTone}
            label={memoryLimit
              ? `${bytes(process_?.rssBytes ?? 0)} / ${bytes(memoryLimit)}（${ceiling ? '容器内存上限' : '配置的告警阈值'}）`
              : '未设置容器上限，也没有配置内存告警阈值'} />
        </div>

        {process_?.availableBytes ? (
          <p style={muted}>系统可用内存 {bytes(process_.availableBytes)}。这一项是主机层面的，其他进程也会消耗。</p>
        ) : null}
        {process_?.constrainedBytes === null ? (
          <p style={muted}>未能读到容器内存上限：这通常意味着进程不在受限制的容器内运行，或运行时未提供该信息。</p>
        ) : null}
      </Panel>

      {!embedded ? <Panel
        title="资源趋势"
        action={<div style={row}>{RANGES.map((value) => <Button key={value} disabled={value === range} onClick={() => setRange(value)}>{value}</Button>)}</div>}
        note="每 30 秒采样一次；分桶内保存的是峰值，因此这张图显示的是「这段时间里最坏的一刻」，不是平均值。"
      >
        {metrics.error ? <Notice tone="bad">{metrics.error}</Notice> : null}
        <div style={{ ...row, marginBottom: 8 }}>
          {SERIES.map((entry) => (
            <Button key={entry.key} disabled={entry.key === series} onClick={() => setSeries(entry.key)}>{entry.label}</Button>
          ))}
        </div>
        {metrics.data ? (
          <>
            <TrendChart
              points={(metrics.data.buckets ?? []).map((bucket): ChartPoint => ({ at: bucket.bucketAt, value: seriesValue(bucket, series) }))}
              label={`${SERIES.find((entry) => entry.key === series)?.label ?? ''}趋势（近 ${range}）`}
              formatValue={seriesFormat(series)}
              tone={series === 'lag' || series === 'cpu' ? 'warn' : 'ok'}
              granularityNote={metrics.data.granularity === 'minute' ? '分钟分桶' : '小时分桶'}
              // These series are peaks, so the summary reports the highest reading.
              summaryMode="peak"
            />
            <p style={muted}>
              该范围内峰值：常驻内存 {bytes(metrics.data.resourcePeak.rssBytes)}、堆 {bytes(metrics.data.resourcePeak.heapUsedBytes)}
              、堆外 {bytes(metrics.data.resourcePeak.externalBytes)}、CPU {metrics.data.resourcePeak.cpuPercent.toFixed(1)}%
              、事件循环 {metrics.data.resourcePeak.eventLoopMaxMs.toFixed(1)} ms。
            </p>
          </>
        ) : null}
      </Panel> : null}

      <Panel title="数据库状态" note="全部来自常量时间的 PRAGMA 读数，可以随页面一起刷新。"
        action={<div style={row}>

          <Button disabled={!writable} onClick={analyze}>重建查询计划统计</Button>
        </div>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Stat label="文件大小" value={bytes(resources.data?.storage.databaseBytes)}
            hint={database ? `逻辑大小 ${bytes(database.logicalBytes)}（${database.pageCount} 页 × ${database.pageSize} B）` : undefined} />
          <Stat label="WAL 文件" tone={walOver ? 'warn' : undefined} value={bytes(wal)}
            hint={walLimit > 0 ? `上限 ${bytes(walLimit)}；超过说明检查点没有及时回收` : '未设置 journal_size_limit'} />
          <Stat label="可回收空间" tone={(database?.freelistRatio ?? 0) >= 0.25 ? 'warn' : undefined}
            value={database ? bytes(database.freelistBytes) : '暂无数据'}
            hint={database ? `空闲页占比 ${(database.freelistRatio * 100).toFixed(1)}%；VACUUM 可释放，需停服执行` : undefined} />
          <Stat label="日志模式" value={database?.journalMode || '暂无数据'}
            hint={database ? `同步级别 ${database.synchronous} · 自动整理 ${database.autoVacuum === 'none' ? '关闭' : database.autoVacuum}` : undefined} />
          <Stat label="缓存与映射" value={database?.cacheSizeKiB ? `${database.cacheSizeKiB} KiB` : '暂无数据'}
            hint={database ? `mmap ${database.mmapBytes > 0 ? bytes(database.mmapBytes) : '未启用'}；未启用时数据库页不占用进程内存` : undefined} />
          <Stat label="写入等待上限" value={database ? `${database.busyTimeoutMs} ms` : '暂无数据'}
            hint={database ? `WAL 自动检查点 ${database.walAutocheckpointPages} 页 · 临时存储 ${database.tempStore}` : undefined} />
          <Stat label="查询计划统计" value={database ? `${database.analyzedTables} 张表` : '暂无数据'}
            hint={database?.analyzedAt ? `最近重建 ${when(database.analyzedAt)}` : '尚未在后台执行过 ANALYZE'} />
          <Stat label="最近完整性校验" value={typeof overview.data?.snapshot.verification.database?.['checkedAt'] === 'string' ? when(String(overview.data.snapshot.verification.database['checkedAt'])) : '暂无数据'}
            hint={typeof overview.data?.snapshot.verification.database?.['result'] === 'string' ? `结果 ${String(overview.data.snapshot.verification.database['result'])}` : '尚未执行'} />
        </div>
        {walOver ? (
          <Notice tone="warn">WAL 文件（{bytes(wal)}）已超过配置上限（{bytes(walLimit)}）：通常意味着检查点没有完成，请确认没有长事务或长期只读连接占住快照。</Notice>
        ) : null}
        <p style={muted}>
          「可回收空间」是 SQLite 已释放但未归还给操作系统的页。它不是故障，只是磁盘占用偏高；回收需要停服后执行
          <code> VACUUM</code>，因此后台不提供该按钮。
        </p>
      </Panel>

      <Panel title="表与索引占用" note="这一项会扫描整库，因此按需执行，不随页面轮询。数据库越大耗时越长。"
        action={<div style={row}>
          <Button disabled={scanning} onClick={scanTables}>{scanning ? '扫描中…' : tables ? '重新扫描' : '扫描表占用'}</Button>
        </div>}>
        {scanError ? <Notice tone="bad">{scanError}</Notice> : null}
        {tables ? (
          <>
            <p style={muted}>扫描于 {when(tables.scannedAt)}，用时 {tables.durationMs} 毫秒；按占用降序显示前 40 项。</p>
            <DataTable
              columns={[
                { key: 'name', header: '名称', render: (entry) => <code style={{ fontSize: 'var(--fs-sm)' }}>{entry.name}</code> },
                { key: 'kind', header: '类型', render: (entry) => <Badge tone={entry.kind === 'table' ? 'ok' : 'muted'}>{entry.kind === 'table' ? '表' : entry.kind === 'index' ? '索引' : '其他'}</Badge> },
                { key: 'size', header: '占用', render: (entry) => bytes(entry.bytes) },
                { key: 'pages', header: '页数', secondary: true, render: (entry) => String(entry.pages) },
                { key: 'rows', header: '行数', render: (entry) => entry.rowCount === null ? '—' : String(entry.rowCount) },
              ]}
              rows={tables.tables}
              rowKey={(entry) => entry.name}
              empty="没有读到任何表或索引。"
            />
            <p style={muted}>
              索引单独列出，因为它们常常比表本身更占空间；行数只对表统计，索引不重复计算。日志、指标分桶与诊断事件表通常增长最快，
              它们的保留策略可以在「系统设置」里调整。
            </p>
          </>
        ) : (
          <p style={muted}>
            尚未扫描。表级占用需要逐页统计整库（实测约 125 MiB 用时 250 毫秒，且会占用事件循环），
            所以它不在 30 秒轮询里；需要时点一次即可。
          </p>
        )}
      </Panel>
      </div>
    </>
  );
}
