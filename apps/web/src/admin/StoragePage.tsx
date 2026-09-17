/** Storage and backups: physical usage, logical quota, the maintenance plan, records and drills. */
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, DataTable, Loading, Notice, Panel, Stat, bytes, message, muted, row, useResource, when, canWrite } from './ui.js';
import type { BackupRecord, SettingsPayload, Storage } from './types.js';

/** One line of the declared plan: the raw value plus how the page should show it. */
function planField(settings: SettingsPayload | undefined, name: string): { raw: string; display: string } {
  const field = settings?.settings.find((entry) => entry.name === name);
  if (!field) return { raw: '', display: '暂无数据' };
  const raw = String(field.value ?? '');
  const display = field.source === 'env' ? `${raw || '空'}（环境变量 ${field.envVar}）` : (raw || '未配置');
  return { raw, display };
}

export function StoragePage({ client, role, onJob }: { client: AdminClient; role: string; onJob: (jobId: string) => void }) {
  const writable = canWrite(role);
  const storage = useResource(() => client.request<Storage>('/storage'), []);
  const backups = useResource(() => client.request<{ backups: BackupRecord[]; note: string }>('/backups'), []);
  const settings = useResource(() => client.request<SettingsPayload>('/settings'), []);
  const composition = storage.data;

  const autoPlan = planField(settings.data, 'backupAutoEnabled');
  const directory = planField(settings.data, 'backupDirectory');
  // Named `windowLabel`, not `window`: a local named `window` shadows the global one and breaks
  // every `window.alert` in this file.
  const windowLabel = planField(settings.data, 'backupWindow');
  const retentionPlan = planField(settings.data, 'backupRetentionCount');
  const intervalHours = planField(settings.data, 'backupIntervalHours');
  const autoEnabled = autoPlan.raw === 'on';
  const planIncomplete = autoEnabled && (!directory.raw || !windowLabel.raw);
  // The newest record that actually passed verification: what an overdue check should count.
  const lastVerified = (backups.data?.backups ?? []).find((record) => record.verification && record.verification['ok'] !== false);
  const lastRetention = (backups.data?.backups ?? []).find((record) => record.retention);

  const startJob = (type: 'storage.cleanup' | 'backup.verify' | 'restore.drill', recordId?: string) => {
    void client.request<{ job: { jobId: string } }>('/jobs', { type, ...(recordId ? { recordId } : {}) }, { idempotencyKey: adminIdempotencyKey(`${type}-${recordId ?? 'all'}`) })
      .then((result) => onJob(result.job.jobId))
      .catch((error) => window.alert(message(error)));
  };

  return (
    <>
      <h2>存储与备份</h2>
      <Loading loading={storage.loading} error={storage.error} stale={storage.stale} loadedAt={storage.loadedAt} />

      <Panel title="维护计划" action={<Button onClick={settings.reload}>刷新</Button>}
        note="这里只声明与检查计划：自动备份默认关闭，且必须先配置备份位置与维护窗口才能启用。真正的停服备份由部署侧程序在维护窗口内执行，后台不会自己停服。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Stat label="自动备份" tone={planIncomplete ? 'bad' : undefined} value={autoEnabled ? '已启用' : '未启用（默认）'}
            hint={autoEnabled ? '实际执行仍在部署侧' : '开启前需要备份位置与维护窗口'} />
          <Stat label="备份位置" value={directory.display} hint="部署侧实际路径；后台不读写该目录" />
          <Stat label="维护窗口" value={windowLabel.display} hint="停服备份与恢复演练只允许在该窗口内进行" />
          <Stat label="保留份数" value={retentionPlan.display} hint="只清理校验成功的历史备份，且始终保留最近一个有效备份" />
          <Stat label="逾期告警间隔" value={intervalHours.raw === '0' ? '不检查' : `${intervalHours.display} 小时`} hint="超过该间隔没有成功备份时告警" />
          <Stat label="最近校验通过的备份" value={lastVerified ? when(lastVerified.createdAt) : '暂无数据'}
            hint={lastVerified ? lastVerified.recordId : '尚未有校验通过的备份记录'} />
        </div>
        {planIncomplete ? <Notice tone="bad">已启用自动备份，但备份位置或维护窗口仍为空：请到「系统设置」补齐，否则这个计划无法执行。</Notice> : null}
        {autoEnabled && !lastVerified ? <Notice tone="warn">已启用自动备份，但还没有校验通过的备份记录：请确认部署侧程序确实在运行，并完成一次备份与校验。</Notice> : null}
        {lastRetention ? (
          <Notice>
            最近一次保留清理：{when(lastRetention.createdAt)} · {lastRetention.note ?? '已执行'}
            {lastRetention.retention ? ` · 已清理 ${String(lastRetention.retention['removed'] ? String((lastRetention.retention['removed'] as unknown[]).length) : '0')} 份`
              + `${Number(lastRetention.retention['unverifiedCount'] ?? 0) > 0 ? ` · 保留未通过校验的 ${String(lastRetention.retention['unverifiedCount'])} 份待人工处理` : ''}` : ''}
          </Notice>
        ) : <p style={muted}>还没有保留清理记录：运行 <code>{`npm run server:prune-backups -- --backup-dir <目录> --keep ${retentionPlan.raw || '3'}`}</code> 后这里会显示结果（可先加 <code>--dry-run</code> 预演）。</p>}
      </Panel>

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
          <Button disabled={!writable} onClick={() => startJob('storage.cleanup')}>立即清理回收站与暂存上传</Button>
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
            {
              key: 'retention', header: '保留清理', secondary: true, render: (record) => {
                const retention = record.retention;
                if (!retention) return '—';
                if (retention['dryRun'] === true) return '预演（未删除）';
                const removed = Array.isArray(retention['removed']) ? retention['removed'].length : 0;
                const unverified = Number(retention['unverifiedCount'] ?? 0);
                return `${removed ? `已清理 ${removed} 份` : '无需清理'}${unverified ? ` · 保留未通过校验 ${unverified} 份` : ''}`;
              },
            },
            { key: 'path', header: '位置', secondary: true, render: (record) => record.outputPath ?? '暂无数据' },
            {
              key: 'actions', header: '操作', render: (record) => (
                <div style={row}>
                  <Button disabled={role !== 'owner' || !writable} onClick={() => startJob('backup.verify', record.recordId)}>校验</Button>
                  <Button disabled={role !== 'owner' || !writable} onClick={() => startJob('restore.drill', record.recordId)}>恢复演练</Button>
                </div>
              ),
            },
          ]}
          rows={backups.data?.backups ?? []}
          rowKey={(record) => record.recordId}
          empty="还没有备份记录。备份位置与维护窗口需要在部署侧配置后才能启用自动备份。"
        />
        <p style={muted}>恢复演练在隔离目录执行：验证清单、数据库、附件引用，以及恢复后旧会话与未消费的恢复凭据未复活。生产恢复继续走部署侧受控流程，并保留替换前的数据目录。</p>
        <p style={muted}>备份目录不在 Web 静态服务范围内；保留策略只清理校验成功的历史备份，未通过校验的一律保留并列出，且始终至少保留最近一个有效备份。</p>
      </Panel>
    </>
  );
}
