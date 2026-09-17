/** Storage and backups: physical usage, logical quota, records and drills. */
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, DataTable, Loading, Notice, Panel, Stat, bytes, message, muted, row, useResource, when } from './ui.js';
import type { BackupRecord, Storage } from './types.js';

export function StoragePage({ client, role, onJob }: { client: AdminClient; role: string; onJob: (jobId: string) => void }) {
  const storage = useResource(() => client.request<Storage>('/storage'), []);
  const backups = useResource(() => client.request<{ backups: BackupRecord[]; note: string }>('/backups'), []);
  const composition = storage.data;

  const startJob = (type: 'storage.cleanup' | 'backup.verify' | 'restore.drill', recordId?: string) => {
    void client.request<{ job: { jobId: string } }>('/jobs', { type, ...(recordId ? { recordId } : {}) }, { idempotencyKey: adminIdempotencyKey(`${type}-${recordId ?? 'all'}`) })
      .then((result) => onJob(result.job.jobId))
      .catch((error) => window.alert(message(error)));
  };

  return (
    <>
      <h2>存储与备份</h2>
      <Loading loading={storage.loading} error={storage.error} stale={storage.stale} loadedAt={storage.loadedAt} />

      <Panel title="空间组成" note={composition?.note ?? '逻辑配额占用与物理磁盘占用分开显示。'}>
        <DataTable
          columns={[
            { key: 'item', header: '项目', render: (entry) => entry.item },
            { key: 'size', header: '占用', render: (entry) => entry.size },
            { key: 'detail', header: '说明', render: (entry) => entry.detail },
          ]}
          rows={[
            { item: '数据库', size: bytes(composition?.databaseBytes), detail: '主库 server.sqlite' },
            { item: 'WAL 文件', size: bytes(composition?.walBytes), detail: `共享内存 ${bytes(composition?.shmBytes)}` },
            { item: '有效附件', size: bytes(composition?.objectBytes), detail: `对象 ${composition?.objectCount ?? 0} 个` },
            { item: '回收站', size: bytes(composition?.trashBytes), detail: `对象 ${composition?.trashCount ?? 0} 个；计入用户配额` },
            { item: '暂存上传', size: bytes(composition?.stagingBytes), detail: `上传 ${composition?.stagingCount ?? 0} 个；计入用户配额` },
            { item: '备份目录', size: composition?.backupDirectory ?? '暂无数据', detail: '由部署侧维护程序写入选定位置' },
            {
              item: '磁盘可用空间',
              size: bytes(composition?.diskFreeBytes),
              detail: composition?.diskFreeRatio === null || composition?.diskFreeRatio === undefined
                ? '无法读取磁盘信息' : `共 ${bytes(composition?.diskTotalBytes)}，剩余 ${(composition.diskFreeRatio * 100).toFixed(1)}%`,
            },
          ]}
          rowKey={(entry) => entry.item}
          empty="暂无数据。"
        />
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => startJob('storage.cleanup')}>立即清理回收站与暂存上传</Button>
          <Button onClick={storage.reload}>刷新</Button>
        </div>
      </Panel>

      <Panel title="清理状态" note="定时清理不再静默处理失败：这里能看到最近一次运行、成功或失败，以及释放的空间。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Stat label="最近运行" value={when(composition?.cleanup.lastFinishedAt)} />
          <Stat label="结果" tone={composition?.cleanup.lastOk === false ? 'bad' : undefined}
            value={composition?.cleanup.lastOk === null || composition?.cleanup.lastOk === undefined ? '暂无数据' : composition.cleanup.lastOk ? '成功' : '失败'}
            hint={composition?.cleanup.lastError ?? undefined} />
          <Stat label="连续失败次数" tone={(composition?.cleanup.consecutiveFailures ?? 0) > 1 ? 'bad' : undefined}
            value={String(composition?.cleanup.consecutiveFailures ?? 0)} />
          <Stat label="释放空间" value={bytes(composition?.cleanup.lastFreedBytes)} hint={`移除对象 ${composition?.cleanup.lastRemovedObjects ?? 0} 个、上传 ${composition?.cleanup.lastRemovedUploads ?? 0} 个`} />
        </div>
      </Panel>

      <Panel title="备份记录" action={<Button onClick={backups.reload}>刷新</Button>} note={backups.data?.note}>
        <Loading loading={backups.loading} error={backups.error} stale={backups.stale} loadedAt={backups.loadedAt} />
        <Notice tone="warn">
          备份与恢复必须在服务停止时执行，由部署侧维护程序完成（停止服务 → 备份 → 校验 → 恢复启动）。
          后台不直接调用这类流程，也不提供在浏览器里下载整套服务器备份。
        </Notice>
        <DataTable
          columns={[
            { key: 'record', header: '记录', render: (record) => <code style={{ fontSize: 'var(--fs-sm)' }}>{record.recordId}</code> },
            { key: 'status', header: '状态', render: (record) => <Badge tone={record.status === 'failed' ? 'bad' : 'ok'}>{record.status === 'failed' ? '失败' : record.status === 'planned' ? '计划中' : '已完成'}</Badge> },
            { key: 'created', header: '创建时间', render: (record) => when(record.createdAt) },
            { key: 'files', header: '文件数', secondary: true, render: (record) => record.fileCount === undefined ? '暂无数据' : String(record.fileCount) },
            { key: 'size', header: '总大小', secondary: true, render: (record) => bytes(record.totalBytes) },
            { key: 'verify', header: '校验状态', render: (record) => record.verification ? (record.verification['ok'] === false ? <Badge tone="bad">未通过</Badge> : <Badge tone="ok">通过</Badge>) : '尚未校验' },
            { key: 'drill', header: '恢复演练', render: (record) => record.drill ? (record.drill['ok'] === false ? <Badge tone="bad">未通过</Badge> : <Badge tone="ok">通过</Badge>) : '尚未演练' },
            { key: 'path', header: '位置', secondary: true, render: (record) => record.outputPath ?? '暂无数据' },
            {
              key: 'actions', header: '操作', render: (record) => (
                <div style={row}>
                  <Button disabled={role !== 'owner'} onClick={() => startJob('backup.verify', record.recordId)}>校验</Button>
                  <Button disabled={role !== 'owner'} onClick={() => startJob('restore.drill', record.recordId)}>恢复演练</Button>
                </div>
              ),
            },
          ]}
          rows={backups.data?.backups ?? []}
          rowKey={(record) => record.recordId}
          empty="还没有备份记录。备份位置与维护窗口需要在部署侧配置后才能启用自动备份。"
        />
        <p style={muted}>恢复演练在隔离目录执行：验证清单、数据库、附件引用，以及恢复后旧会话与未消费的恢复凭据未复活。生产恢复继续走部署侧受控流程，并保留替换前的数据目录。</p>
        <p style={muted}>备份目录不在 Web 静态服务范围内；保留策略只清理校验成功的历史备份，并至少保留最近一个有效备份。</p>
      </Panel>
    </>
  );
}
