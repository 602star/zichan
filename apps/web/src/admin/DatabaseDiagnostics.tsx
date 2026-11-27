/** Single database diagnostics surface; process readings live in MonitorPage. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import type { Overview, ResourcesPayload } from './types.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, DataTable, Loading, Notice, Panel, Stat, bytes, canWrite, message, muted, row, useActionError, usePolling, useResource, when } from './ui.js';

export function DatabaseDiagnostics({ client, role, onJob, paused = false }: { client: AdminClient; role: string; onJob: (id: string) => void; paused?: boolean }) {
  const writable = canWrite(role);
  const [tables, setTables] = useState<ResourcesPayload['tables']>();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const actionError = useActionError();
  const resources = useResource(() => client.request<ResourcesPayload>('/resources'), []);
  const overview = useResource(() => client.request<Overview>('/overview'), []);
  usePolling(() => { resources.reload(); overview.reload(); }, 30000, !paused);
  const database = resources.data?.database;
  const walLimit = database?.journalSizeLimitBytes ?? 0;
  const wal = resources.data?.storage.walBytes ?? null;
  const walOver = wal !== null && walLimit > 0 && wal > walLimit;
  const scanTables = () => {
    setScanning(true); setScanError('');
    void client.request<ResourcesPayload>('/resources?tables=1').then((payload) => setTables(payload.tables ?? undefined)).catch((error) => setScanError(message(error))).finally(() => setScanning(false));
  };
  const analyze = () => {
    actionError.clear();
    void client.request<{ job: { jobId: string } }>('/database/analyze', {}, { idempotencyKey: adminIdempotencyKey('database-analyze') }).then((result) => onJob(result.job.jobId)).catch((error) => actionError.setError(message(error)));
  };
  return (<>
    <Loading loading={resources.loading} error={resources.error} stale={resources.stale} />
    <div className="zc-admin-ops-provenance">SQLite · 来源：PRAGMA / 数据卷 · 采样：{when(resources.data?.sampledAt)}<Button onClick={resources.reload}>刷新数据库</Button></div>
    {actionError.error ? <Notice tone="bad">{actionError.error}</Notice> : null}
    <Notice>查询 P95、慢 SQL 和 BUSY / LOCKED 次数未接入统一 SQL 包装层，不用零代替未知。备份与恢复统一在“存储与备份”管理。</Notice>
    <div className="zc-admin-resource-workspace">
      <Panel title="数据库状态" note="全部来自常量时间的 PRAGMA 读数，可以随页面一起刷新。"
        action={<div style={row}>

          <Button disabled={!writable} onClick={analyze}>重建查询计划统计</Button>
        </div>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
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
            hint={database ? `mmap ${database.mmapBytes > 0 ? bytes(database.mmapBytes) : '未启用'}；SQLite 页缓存仍会占用进程内存` : undefined} />
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
    </>);
}
