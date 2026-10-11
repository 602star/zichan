/** Storage and backups: physical usage, logical quota, the maintenance plan, records and drills. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { PageHeader, Badge, Button, ColumnPicker, DataTable, Field, Loading, Notice, Panel, Select, Stat, bytes, message, muted, row, useActionError, useCursorPager, useHiddenColumns, usePolling, useResource, when, canWrite } from './ui.js';
import { PageSizeSelect, listParamsQuery, readListParams, sortableHeader, type SortChoice } from './list-controls.js';
import type { BackupsPayload, BlobOwnershipDecision, SettingsPayload, Storage,
  UnownedReplicaRecordsPayload } from './types.js';

/** Sortable columns; only these have a server-side ordering behind them. */
const SORTS: SortChoice[] = [
  { key: 'created', label: '创建时间' },
  { key: 'status', label: '状态', first: 'asc' },
  { key: 'kind', label: '类型', first: 'asc' },
  { key: 'files', label: '文件数' },
  { key: 'size', label: '总大小' },
];

/** Optional columns, listed once so the picker and the table cannot disagree. */
const OPTIONAL_COLUMNS = [
  { key: 'files', header: '文件数', optional: true },
  { key: 'size', header: '总大小', optional: true },
  { key: 'retention', header: '保留清理', optional: true },
  { key: 'path', header: '位置', optional: true },
];

/** One line of the declared plan: the raw value plus how the page should show it. */
function planField(settings: SettingsPayload | undefined, name: string): { raw: string; display: string } {
  const field = settings?.settings.find((entry) => entry.name === name);
  if (!field) return { raw: '', display: '暂无数据' };
  const raw = String(field.value ?? '');
  const display = field.source === 'env' ? `${raw || '空'}（环境变量 ${field.envVar}）` : (raw || '未配置');
  return { raw, display };
}

export function StoragePage({ client, role, query, navigate, onJob }: {
  client: AdminClient; role: string; query: URLSearchParams; navigate: (to: string) => void; onJob: (jobId: string) => void;
}) {
  const writable = canWrite(role);
  const actionError = useActionError();
  const storage = useResource(() => client.request<Storage>('/storage'), []);
  const [unownedKind, setUnownedKind] = useState<'object' | 'state' | 'upload'>('object');
  const [unownedCursor, setUnownedCursor] = useState('');
  const [unownedHistory, setUnownedHistory] = useState<string[]>([]);
  const [repairTargets, setRepairTargets] = useState<Record<string, string>>({});
  const [repairReasons, setRepairReasons] = useState<Record<string, string>>({});
  const [repairing, setRepairing] = useState('');
  const [repairNotice, setRepairNotice] = useState('');
  const unowned = useResource(() => client.request<UnownedReplicaRecordsPayload>(
    `/storage/unowned?kind=${unownedKind}${unownedCursor ? `&cursor=${encodeURIComponent(unownedCursor)}` : ''}`,
  ), [unownedKind, unownedCursor]);
  const ownershipDecisions = useResource(() => client.request<{ decisions: BlobOwnershipDecision[] }>(
    '/storage/unowned/decisions'), []);
  const backupStatus = query.get('status') ?? '';
  const backupKind = query.get('kind') ?? '';
  const cursor = query.get('cursor') ?? '';
  const pager = useCursorPager({ query, path: '/storage', navigate });
  const listParams = readListParams(query, { sort: 'created', dir: 'desc', limit: 25 });
  const { hidden, toggle, reset } = useHiddenColumns('backups', OPTIONAL_COLUMNS);
  const backups = useResource(() => client.request<BackupsPayload>(
    `/backups?${listParamsQuery(listParams)}${backupStatus ? `&status=${backupStatus}` : ''}${backupKind ? `&kind=${backupKind}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ), [backupStatus, backupKind, cursor, listParams.sort, listParams.direction, listParams.limit]);
  const settings = useResource(() => client.request<SettingsPayload>('/settings'), []);
  const composition = storage.data;
  // The sort the server actually used, which is not always the one that was asked for.
  const appliedSort = backups.data?.sort ?? { key: listParams.sort, direction: listParams.direction };
  // One spreadable value per column, so the clickable header and the announced sort state cannot
  // drift apart.
  const sortHeader = (key: string, label: string) => sortableHeader(
    SORTS.find((entry) => entry.key === key) ?? { key, label },
    appliedSort.key,
    appliedSort.direction,
    (next) => pager.apply({ sort: next.sort, dir: next.dir, cursor: undefined }),
  );

  const autoPlan = planField(settings.data, 'backupAutoEnabled');
  const directory = planField(settings.data, 'backupDirectory');
  // Named `windowLabel`, not `window`: a local named `window` shadows the global one. Page
  // errors are reported in place through `useActionError`, never through a blocking dialog.
  const windowLabel = planField(settings.data, 'backupWindow');
  const retentionPlan = planField(settings.data, 'backupRetentionCount');
  const intervalHours = planField(settings.data, 'backupIntervalHours');
  const autoEnabled = autoPlan.raw === 'on';
  const planIncomplete = autoEnabled && (!directory.raw || !windowLabel.raw);
  // Read from the server, not picked out of the visible page: with a filter applied — or simply
  // after a run of failures — the newest success may not be on this page, and showing "暂无数据"
  // for a backup that succeeded last week is a lie the operator would act on.
  usePolling(backups.reload, 10_000, true);
  const summary = backups.data?.summary;
  const executor = backups.stale ? undefined : backups.data?.executor;
  const executorLabel = { unknown: '运行状态未知', offline: '心跳已失联', starting: '正在启动', disabled: '在线 · 自动备份未启用', waiting: '在线 · 等待执行', running: '正在备份', error: '执行异常', stopped: '执行器已停止' };

  const startJob = (type: 'storage.cleanup' | 'backup.verify' | 'restore.drill', recordId?: string) => {
    actionError.clear();
    void client.request<{ job: { jobId: string } }>('/jobs', { type, ...(recordId ? { recordId } : {}) }, { idempotencyKey: adminIdempotencyKey(`${type}-${recordId ?? 'all'}`) })
      .then((result) => onJob(result.job.jobId))
      .catch((error) => actionError.setError(message(error)));
  };

  const assignOwnership = (entry: UnownedReplicaRecordsPayload['records'][number]) => {
    const key = `${entry.username}\0${entry.ledgerId}\0${entry.recordId}`;
    const replicaId = repairTargets[key] ?? '';
    const reason = (repairReasons[key] ?? '').trim();
    if (!replicaId || reason.length < 12 || repairing) return;
    setRepairing(key);
    setRepairNotice('');
    actionError.clear();
    void client.request<{ decision: BlobOwnershipDecision }>('/storage/unowned/assign', {
      kind: entry.kind, username: entry.username, ledgerId: entry.ledgerId,
      blobId: entry.blobId, ...(entry.kind === 'upload' ? { uploadId: entry.recordId } : {}),
      replicaId, reason,
    }, { idempotencyKey: adminIdempotencyKey('blob-ownership-assign') })
      .then((result) => {
        setRepairNotice(`已将${entry.kind === 'state' ? '删除状态' : entry.kind === 'upload' ? '暂存上传' : '附件对象'} ${entry.blobId} 归入 ${result.decision.toReplicaId}，决定 ${result.decision.decisionId} 已记录。`);
        unowned.reload();
        ownershipDecisions.reload();
        storage.reload();
      })
      .catch((error) => actionError.setError(message(error)))
      .finally(() => setRepairing(''));
  };

  return (
    <>
      <PageHeader title="存储与备份" />
      <Loading loading={storage.loading} error={storage.error} stale={storage.stale} loadedAt={storage.loadedAt} />
      {actionError.error ? <Notice tone="bad">{actionError.error}</Notice> : null}

      <div className="zc-admin-storage-workspace">
      <Panel title="备份执行状态" note="计划配置、执行记录、校验结果分别判断。登记过一次成功备份，不代表自动执行程序当前仍在运行。">
        <Loading loading={backups.loading} error={backups.error} stale={backups.stale} loadedAt={backups.loadedAt} />
        <div className="zc-admin-grid">
          <Stat label="最近执行" value={!summary ? '状态未知' : !summary.lastAttempt ? '尚无执行记录' : summary.lastAttempt.status === 'failed' || summary.lastAttempt.verificationOk === false ? '失败或校验未通过' : '已完成'}
            tone={summary?.lastAttempt?.status === 'failed' || summary?.lastAttempt?.verificationOk === false ? 'bad' : undefined}
            hint={summary?.lastAttempt ? `${when(summary.lastAttempt.createdAt)} · ${summary.lastAttempt.errorMessage ?? summary.lastAttempt.recordId}` : '等待部署侧执行并登记备份'} />
          <Stat label="可用证据" value={!summary ? '状态未知' : summary.lastVerified ? '存在已校验备份' : summary.lastSuccess ? '有完成记录，尚无校验通过记录' : '尚无成功备份记录'} hint="还原能力应通过恢复演练验证" />
          <Stat label="自动执行程序" value={executor ? executorLabel[executor.status] : '运行状态未知'}
            tone={executor && ['offline', 'error', 'stopped'].includes(executor.status) ? 'bad' : undefined}
            hint={executor?.heartbeatAt ? `最近心跳 ${when(executor.heartbeatAt)}` : '尚未收到有效的执行器心跳'} />
          <Stat label="下一次执行" value={executor?.nextRunAt ? when(executor.nextRunAt) : '暂无计划时间'} hint={`服务器时区：${executor?.timezone ?? '未知'}；每个维护窗口最多尝试一次`} />
          <Stat label="执行器上次结果" value={executor?.lastResult === 'completed' ? '备份与校验完成' : executor?.lastResult === 'failed' ? '失败' : executor?.lastResult === 'interrupted' ? '执行中断' : '尚无执行结果'} hint={executor?.lastFinishedAt ? when(executor.lastFinishedAt) : '以执行记录为准'} />
        </div>
        {executor?.error ? <Notice tone="warn">{executor.error}</Notice> : null}
        {executor?.executorId ? <p style={muted}>执行器：{executor.executorId}</p> : null}
        <p style={row}>
          <Button onClick={() => navigate('/storage?status=failed')}>查看失败记录</Button>
          {role === 'owner' ? <Button onClick={() => navigate('/settings?group=backup')}>配置备份计划</Button> : null}
        </p>
      </Panel>

      <Panel title="备份记录" action={<Button onClick={backups.reload}>刷新</Button>} note={backups.data?.note}>
        <Loading loading={backups.loading} error={backups.error} stale={backups.stale} loadedAt={backups.loadedAt} />
        <Notice tone="warn">
          备份与恢复必须在服务停止时执行，由部署侧维护程序完成（停止服务 → 备份 → 校验 → 恢复启动）。
          后台不直接调用这类流程，也不提供在浏览器里下载整套服务器备份。
        </Notice>
        <div style={{ ...row, marginBottom: 10 }}>
          <Field label="状态">
            <Select value={backupStatus} onChange={(event) => pager.apply({ status: event.target.value || undefined, cursor: undefined })}>
              <option value="">全部</option>
              <option value="completed">已完成</option>
              <option value="failed">失败</option>
              <option value="planned">计划中</option>
            </Select>
          </Field>
          <Field label="类型">
            <Select value={backupKind} onChange={(event) => pager.apply({ kind: event.target.value || undefined, cursor: undefined })}>
              <option value="">全部</option>
              <option value="scheduled">计划备份</option>
              <option value="manual">手动备份</option>
              <option value="drill">恢复演练</option>
            </Select>
          </Field>
          <PageSizeSelect value={listParams.limit} onApply={(size) => pager.apply({ limit: String(size), cursor: undefined })} />
          <ColumnPicker columns={OPTIONAL_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />
          {/* The count is of the filtered set, not this page: "how many failed backups are kept"
              is a question about the whole set. */}
          <span style={muted}>共 {backups.data?.total ?? 0} 条记录</span>
        </div>
        <DataTable
          columns={[
            { key: 'record', header: '记录', render: (record) => <code style={{ fontSize: 'var(--fs-sm)' }}>{record.recordId}</code> },
            { key: 'status', header: '状态', ...sortHeader('status', '状态'), render: (record) => <Badge tone={record.status === 'failed' ? 'bad' : 'ok'}>{record.status === 'failed' ? '失败' : record.status === 'planned' ? '计划中' : '已完成'}</Badge> },
            { key: 'created', header: '创建时间', ...sortHeader('created', '创建时间'), render: (record) => when(record.createdAt) },
            { key: 'files', header: '文件数', secondary: true, optional: true, ...sortHeader('files', '文件数'), render: (record) => record.fileCount === undefined ? '暂无数据' : String(record.fileCount) },
            { key: 'size', header: '总大小', secondary: true, optional: true, ...sortHeader('size', '总大小'), render: (record) => bytes(record.totalBytes) },
            { key: 'kind', header: '类型', ...sortHeader('kind', '类型'), render: (record) => record.kind === 'scheduled' ? '计划备份' : record.kind === 'manual' ? '手动备份' : '恢复演练' },
            { key: 'verify', header: '校验状态', render: (record) => record.verification ? (record.verification['ok'] === false ? <Badge tone="bad">未通过</Badge> : <Badge tone="ok">通过</Badge>) : '尚未校验' },
            { key: 'drill', header: '恢复演练', render: (record) => record.drill ? (record.drill['ok'] === false ? <Badge tone="bad">未通过</Badge> : <Badge tone="ok">通过</Badge>) : '尚未演练' },
            {
              key: 'retention', header: '保留清理', secondary: true, optional: true, render: (record) => {
                const retention = record.retention;
                if (!retention) return '—';
                if (retention['dryRun'] === true) return '预演（未删除）';
                const removed = Array.isArray(retention['removed']) ? retention['removed'].length : 0;
                const unverified = Number(retention['unverifiedCount'] ?? 0);
                return `${removed ? `已清理 ${removed} 份` : '无需清理'}${unverified ? ` · 保留未通过校验 ${unverified} 份` : ''}`;
              },
            },
            { key: 'path', header: '位置', secondary: true, optional: true, render: (record) => record.outputPath ?? '暂无数据' },
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
          hiddenColumns={hidden}
          empty="还没有备份记录。备份位置与维护窗口需要在部署侧配置后才能启用自动备份。"
        />
        <div style={{ ...row, marginTop: 10, justifyContent: 'flex-end' }}>
          {backups.data?.nextCursor ? <span style={muted}>第 {pager.page} 页</span> : null}
          <Button disabled={!pager.hasPrevious} onClick={pager.previous}>上一页</Button>
          <Button disabled={!backups.data?.nextCursor} onClick={() => backups.data?.nextCursor && pager.next(backups.data.nextCursor)}>下一页</Button>
        </div>
        <p style={muted}>恢复演练在隔离目录执行：验证清单、数据库、附件引用，以及恢复后旧会话与未消费的恢复凭据未复活。生产恢复继续走部署侧受控流程，并保留替换前的数据目录。</p>
        <p style={muted}>备份目录不在 Web 静态服务范围内；保留策略只清理校验成功的历史备份，未通过校验的一律保留并列出，且始终至少保留最近一个有效备份。</p>
      </Panel>

      <Panel title="维护计划" action={<Button onClick={settings.reload}>刷新</Button>}
        note="自动备份默认关闭。启用后，执行器在服务器本地时区的维护窗口内自动停服、备份校验并重启；期间同步与后台短暂不可用。失败不会在同一窗口内反复重试。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Stat label="自动备份计划" tone={planIncomplete ? 'bad' : undefined} value={!settings.data ? '状态未知' : planIncomplete ? '配置不完整' : autoEnabled ? '已配置启用' : '未启用'}
            hint={autoEnabled ? '请同时核对执行器心跳和执行结果' : '开启前需要备份位置与维护窗口'} />
          <Stat label="备份位置" value={directory.display} hint="服务器绝对路径；执行器需要写入权限" />
          <Stat label="维护窗口" value={windowLabel.display} hint="停服备份与恢复演练只允许在该窗口内进行" />
          <Stat label="保留份数" value={retentionPlan.display} hint="只清理校验成功的历史备份，且始终保留最近一个有效备份" />
          <Stat label="逾期告警间隔" value={intervalHours.raw === '0' ? '不检查' : `${intervalHours.display} 小时`} hint="超过该间隔没有成功备份时告警" />
          <Stat label="最近校验通过的备份" value={summary?.lastVerified ? when(summary.lastVerified.verifiedAt) : '暂无数据'}
            hint={summary?.lastVerified ? summary.lastVerified.recordId : '尚未有校验通过的备份记录'} />
          <Stat label="最近成功备份" value={summary?.lastSuccess ? when(summary.lastSuccess.createdAt) : '暂无数据'}
            hint={summary?.lastSuccess ? summary.lastSuccess.recordId : '尚未有成功备份'} />
        </div>
        {planIncomplete ? <Notice tone="bad">已启用自动备份，但备份位置或维护窗口仍为空：请到「系统设置」补齐，否则这个计划无法执行。</Notice> : null}
        {autoEnabled && !summary?.lastVerified ? <Notice tone="warn">已启用自动备份，但还没有校验通过的备份记录：请确认部署侧程序确实在运行，并完成一次备份与校验。</Notice> : null}
        {summary?.lastRetention ? (
          <Notice>
            最近一次保留清理：{when(summary.lastRetention.createdAt)} · {summary.lastRetention.note ?? '已执行'}
            {summary.lastRetention.retention ? ` · 已清理 ${String(summary.lastRetention.retention['removed'] ? String((summary.lastRetention.retention['removed'] as unknown[]).length) : '0')} 份`
              + `${Number(summary.lastRetention.retention['unverifiedCount'] ?? 0) > 0 ? ` · 保留未通过校验的 ${String(summary.lastRetention.retention['unverifiedCount'])} 份待人工处理` : ''}` : ''}
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
            { item: '未归属历史记录', size: `${composition?.unowned?.objects ?? 0} 个对象`,
              detail: `删除状态 ${composition?.unowned?.states ?? 0} 条 · 暂存上传 ${composition?.unowned?.uploads ?? 0} 个；须核对旧账号与账本后处理` },
            { item: '损坏附件隔离区', size: bytes(composition?.quarantineBytes), detail: '保留供排查与备份；占用物理磁盘空间' },
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

      <Panel title="未归属附件清单" note="候选副本来自当前账号路由及替换检查点。未归属的回收站对象和暂存上传会跳过定时清理。修复 V2 对象或暂存上传须核对原账本密钥和密文；孤立删除状态须核对原始操作来源。请先在概览页声明维护窗口。暂存上传修复后需在新的有效期内续传。">
        <Loading loading={unowned.loading} error={unowned.error} stale={unowned.stale} loadedAt={unowned.loadedAt} />
        {repairNotice ? <Notice tone="info">{repairNotice}</Notice> : null}
        <div style={{ ...row, marginBottom: 10 }}>
          <Field label="记录类型">
            <Select value={unownedKind} onChange={(event) => {
              setUnownedKind(event.target.value as 'object' | 'state' | 'upload');
              setUnownedCursor('');
              setUnownedHistory([]);
            }}>
              <option value="object">附件对象</option>
              <option value="state">删除与恢复状态</option>
              <option value="upload">暂存上传</option>
            </Select>
          </Field>
          <Button onClick={unowned.reload}>刷新清单</Button>
        </div>
        <DataTable
          columns={[
            { key: 'account', header: '账号 / 账本', render: (entry) => <span style={{ overflowWrap: 'anywhere' }}>
              {entry.username}<br /><code>{entry.ledgerId}</code>
            </span> },
            { key: 'object', header: '密文对象', render: (entry) => <span style={{ overflowWrap: 'anywhere' }}>
              <code>{entry.blobId}</code>{entry.kind === 'upload' ? <><br />上传 {entry.recordId}</> : null}
            </span> },
            { key: 'state', header: '状态 / 容量', render: (entry) => <span>
              {entry.state}{entry.formatVersion === null ? '' : ` · V${entry.formatVersion}`}
              {entry.cipherBytes === null ? '' : ` · ${bytes(entry.cipherBytes)}`}
              <br />{when(entry.createdAt)}
            </span> },
            { key: 'candidates', header: '候选副本', render: (entry) => <span style={{ overflowWrap: 'anywhere' }}>
              {entry.candidateReplicaIds.length ? entry.candidateReplicaIds.map((id) => <code key={id} style={{ display: 'block' }}>{id}</code>) : '无可验证候选'}
              {entry.namespaceMatches.length ? `目录匹配 ${entry.namespaceMatches.join('、')}` : ''}
              {entry.replicaId ? `原记录 ${entry.replicaId}` : ''}
            </span> },
            { key: 'repair', header: '人工核对', render: (entry) => {
              if (entry.kind !== 'state' && entry.formatVersion !== 2
                || role !== 'owner' || !entry.candidateReplicaIds.length) return '只读';
              const key = `${entry.username}\0${entry.ledgerId}\0${entry.recordId}`;
              return <div style={{ display: 'grid', gap: 6, minWidth: 210 }}>
                <Select aria-label={`目标副本 ${entry.blobId}`} value={repairTargets[key] ?? ''}
                  onChange={(event) => setRepairTargets({ ...repairTargets, [key]: event.target.value })}>
                  <option value="">选择已核对副本</option>
                  {entry.candidateReplicaIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </Select>
                <input className="zc-input" aria-label={`核对依据 ${entry.blobId}`}
                  placeholder={entry.kind === 'state' ? '填写删除状态来源核对依据（至少 12 字）'
                    : '填写密钥与密文核对依据（至少 12 字）'} value={repairReasons[key] ?? ''}
                  onChange={(event) => setRepairReasons({ ...repairReasons, [key]: event.target.value })} />
                <Button disabled={Boolean(repairing) || !repairTargets[key]
                  || (repairReasons[key] ?? '').trim().length < 12}
                  onClick={() => assignOwnership(entry)}>确认归属</Button>
              </div>;
            } },
          ]}
          rows={!unowned.loading && !unowned.error ? unowned.data?.records ?? [] : []}
          rowKey={(entry) => `${entry.kind}:${entry.username}:${entry.ledgerId}:${entry.recordId}`}
          empty="此类记录暂无未归属项。"
        />
        <div style={{ ...row, marginTop: 10 }}>
          <Button disabled={unownedHistory.length === 0} onClick={() => {
            const previous = unownedHistory.at(-1) ?? '';
            setUnownedHistory(unownedHistory.slice(0, -1));
            setUnownedCursor(previous);
          }}>上一页</Button>
          <Button disabled={unowned.loading || Boolean(unowned.error) || !unowned.data?.nextCursor} onClick={() => {
            if (!unowned.data?.nextCursor) return;
            setUnownedHistory([...unownedHistory, unownedCursor]);
            setUnownedCursor(unowned.data.nextCursor);
          }}>下一页</Button>
        </div>
      </Panel>

      <Panel title="附件归属修复记录" note="每次修复记录操作者账号 ID、记录类型、原归属、目标副本、依据和时间；对象侧写也保存对象归属决定。">
        <Loading loading={ownershipDecisions.loading} error={ownershipDecisions.error}
          stale={ownershipDecisions.stale} loadedAt={ownershipDecisions.loadedAt} />
        <DataTable
          columns={[
            { key: 'at', header: '时间', render: (entry) => when(entry.decidedAt) },
            { key: 'object', header: '记录', render: (entry) => <span style={{ overflowWrap: 'anywhere' }}>
              {entry.kind === 'state' ? '删除状态' : entry.kind === 'upload' ? '暂存上传' : '附件对象'} · {entry.username}
              <br /><code>{entry.blobId}</code>{entry.uploadId ? <><br />上传 {entry.uploadId}</> : null}
            </span> },
            { key: 'route', header: '归属', render: (entry) => `${entry.fromReplicaId ?? '未归属'} → ${entry.toReplicaId}` },
            { key: 'actor', header: '操作者 / 依据', render: (entry) => <span style={{ overflowWrap: 'anywhere' }}>
              {entry.actorAccountId}<br />{entry.reason}
            </span> },
          ]}
          rows={ownershipDecisions.data?.decisions ?? []}
          rowKey={(entry) => entry.decisionId}
          empty="暂无人工归属修复记录。"
        />
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


      </div>
    </>
  );
}
