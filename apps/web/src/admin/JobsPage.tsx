/** Task centre: request work, watch progress, cancel at a safe boundary, re-run. */
import { useRef, useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { PageHeader, Badge, Button, ColumnPicker, DataTable, Field, Loading, Notice, Panel, Select, TextInput, bytes, message, muted, row, useActionError, useCursorPager, useHiddenColumns, usePolling, useResource, when, canWrite } from './ui.js';
import { PageSizeSelect, listParamsQuery, readListParams, sortableHeader, type SortChoice } from './list-controls.js';
import { JOB_TYPES, type Job, type JobEvent } from './types.js';

/** Sortable columns; only these have a server-side ordering behind them. */
const SORTS: SortChoice[] = [
  { key: 'created', label: '创建时间' },
  { key: 'status', label: '状态' },
  { key: 'type', label: '类型' },
];

/** Optional columns, listed once so the picker and the table cannot disagree. */
const OPTIONAL_COLUMNS = [
  { key: 'by', header: '发起人', optional: true },
  { key: 'finished', header: '结束时间', optional: true },
];

const statusTone = (status: Job['status']) => status === 'succeeded' ? 'ok' as const : status === 'running' || status === 'queued' ? 'warn' as const
  : status === 'failed' ? 'bad' as const : 'muted' as const;
const statusLabel = (status: Job['status']) => ({
  queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '执行中断',
}[status]);

/** "Finished" and "the data is healthy" are two different results. */
const outcomeOf = (job: Job): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } | undefined => {
  if (job.status === 'failed') return { label: job.errorCode ?? '执行失败', tone: 'bad' };
  if (job.status === 'interrupted') return { label: '执行中断', tone: 'bad' };
  if (job.status === 'cancelled') return { label: '已取消', tone: 'muted' };
  switch (job.outcome) {
    case 'issues-found': return { label: '执行完成 · 校验发现问题', tone: 'warn' };
    case 'clean': return { label: '执行完成 · 未发现问题', tone: 'ok' };
    default: return undefined;
  }
};

/** Plain-language result line; the raw fields stay in the detail view. */
function resultSummary(job: Job): string | undefined {
  const result = job.result ?? {};
  const count = (key: string) => Number(result[key] ?? 0);
  switch (job.type) {
    case 'blobs.verify':
      return `已检查 ${count('checkedObjects')} 个附件对象、${count('checkedChunks')} 个分块，问题 ${count('issueCount')} 个（范围：${String(result['scope'] ?? '全部账号')}）。`;
    case 'database.integrity-check':
      return `PRAGMA integrity_check 结果：${String(result['result'] ?? '未知')}；${result['ok'] ? '未发现问题' : '发现问题，请先保护现有数据。'}`;
    case 'database.analyze':
      return `已重建 ${count('tables')} 个表的查询计划统计，用时 ${count('durationMs')} 毫秒。`;
    case 'backup.verify': {
      const issues = Array.isArray(result['issues']) ? (result['issues'] as string[]).join('；') : '';
      return `校验 ${count('checkedFiles')} 个文件，数据库 ${String(result['databaseResult'] ?? '未知')}；${result['ok'] ? '通过' : `未通过：${issues}`}。`;
    }
    case 'restore.drill':
      return `恢复演练${result['ok'] ? '通过' : '发现问题'}：活动会话 ${count('activeSessions')} 个、未消费恢复凭据 ${count('pendingResets')} 个，架构版本 ${count('schemaVersion')}。`;
    case 'storage.cleanup':
      return `移除回收对象 ${count('lastRemovedObjects')} 个、暂存上传 ${count('lastRemovedUploads')} 个，释放 ${bytes(count('lastFreedBytes'))}。`;
    case 'logs.prune':
      return `保留 ${count('retention')} 条，移除 ${count('removed')} 条。`;
    case 'metrics.prune':
      return `移除指标 ${count('metricsRemoved')} 条、诊断事件 ${count('syncEventsRemoved')} 条。`;
    default:
      return undefined;
  }
}

/** The finished-vs-healthy distinction, with the readable result underneath it. */
function OutcomeNote({ job }: { job: Job }) {
  const outcome = outcomeOf(job);
  if (!outcome) return null;
  const summary = resultSummary(job);
  return (
    <Notice tone={outcome.tone === 'bad' ? 'bad' : outcome.tone === 'warn' ? 'warn' : 'info'}>
      <Badge tone={outcome.tone}>{outcome.label}</Badge>{' '}
      {outcome.tone === 'warn' ? '任务已执行结束，但结果需要处理：这不等于数据健康。' : '任务已执行结束。'}
      {summary ? ` ${summary}` : ''}
    </Notice>
  );
}

export function JobsPage({ client, query, navigate, role }: { client: AdminClient; query: URLSearchParams; navigate: (to: string) => void; role: string }) {
  const writable = canWrite(role);
  const status = query.get('status') ?? '';
  const type = query.get('type') ?? '';
  const jobId = query.get('job') ?? '';
  // A deep link from the user detail page filters the list to one account; the same value
  // seeds the create form so "run a task for this account" needs no retyping.
  const accountFilter = query.get('accountId') ?? '';
  const pager = useCursorPager({ query, path: '/jobs', navigate });
  const cursor = pager.cursor;
  const listParams = readListParams(query, { sort: 'created', dir: 'desc', limit: 25 });
  const { hidden, toggle, reset } = useHiddenColumns('jobs', OPTIONAL_COLUMNS);
  const [jobType, setJobType] = useState('blobs.verify');
  const [accountId, setAccountId] = useState(accountFilter);
  const [recordId, setRecordId] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const submitting = useRef(false);
  const actionError = useActionError();

  const list = useResource(() => client.request<{ jobs: Job[]; nextCursor?: string; sort?: { key: string; direction: string } }>(
    `/jobs?${listParamsQuery(listParams)}${status ? `&status=${status}` : ''}${type ? `&type=${type}` : ''}${accountFilter ? `&accountId=${encodeURIComponent(accountFilter)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ), [status, type, accountFilter, cursor, listParams.sort, listParams.direction, listParams.limit]);
  const detail = useResource(
    () => jobId ? client.request<{ job: Job; events: JobEvent[] }>(`/jobs/${jobId}`) : Promise.resolve(undefined),
    [jobId],
  );
  usePolling(() => { list.reload(); detail.reload(); }, 5_000, Boolean(jobId) || Boolean(list.data?.jobs.some((job) => ['queued', 'running'].includes(job.status))));

  const update = pager.apply;
  // The sort the server actually used, which is not always the one that was asked for: a page
  // built against an older server must show what it got rather than what it wanted.
  const appliedSort = list.data?.sort ?? { key: listParams.sort, direction: listParams.direction };
  // One spreadable value per column, so the clickable header and the announced sort state cannot
  // drift apart.
  const sortHeader = (key: string, label: string) => sortableHeader(
    SORTS.find((entry) => entry.key === key) ?? { key, label },
    appliedSort.key,
    appliedSort.direction,
    (next) => update({ sort: next.sort, dir: next.dir }),
  );

  const selected = JOB_TYPES.find((entry) => entry.value === jobType)!;
  const submit = async (): Promise<void> => {
    if (submitting.current || !writable) return;
    submitting.current = true; setCreating(true); setError('');
    try {
      const created = await client.request<{ job: Job }>('/jobs', {
        type: jobType,
        ...(accountId && jobType === 'blobs.verify' ? { accountId } : {}),
        ...(recordId && (jobType === 'backup.verify' || jobType === 'restore.drill') ? { recordId } : {}),
      }, { idempotencyKey: adminIdempotencyKey(`job-${jobType}`) });
      list.reload();
      update({ job: created.job.jobId });
    } catch (caught) {
      setError(message(caught));
    } finally { submitting.current = false; setCreating(false); }
  };

  return (
    <>
      <PageHeader title="任务中心" description="执行维护、查看进度与结果，失败后核对是否需要重试。" actions={<><Button onClick={list.reload}>刷新列表</Button><Button onClick={() => navigate('/storage')}>查看备份记录</Button></>} />
      {jobId ? <Loading loading={detail.loading} error={detail.error} stale={detail.stale} loadedAt={detail.loadedAt} /> : null}
      {jobId && detail.data ? (
        <Panel title={`任务详情 · ${detail.data.job.jobId}`} action={<Button onClick={() => update({ job: undefined, cursor })}>关闭</Button>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <div><div style={muted}>状态</div><Badge tone={statusTone(detail.data.job.status)}>{statusLabel(detail.data.job.status)}</Badge></div>
            <div><div style={muted}>阶段</div>{detail.data.job.phase ?? '—'}</div>
            <div><div style={muted}>进度</div>{detail.data.job.total ? `${detail.data.job.processed}/${detail.data.job.total}` : String(detail.data.job.processed)}</div>
            <div><div style={muted}>原任务</div>{detail.data.job.retryOf ?? '—'}</div>
            <div><div style={muted}>取消请求</div>{detail.data.job.cancelRequested ? '已请求，将在安全边界生效' : '无'}</div>
            <div><div style={muted}>参数</div><code style={{ fontSize: 'var(--fs-sm)' }}>{JSON.stringify(detail.data.job.params)}</code></div>
          </div>
          {detail.data.job.errorMessage ? <Notice tone="bad">{detail.data.job.errorCode}：{detail.data.job.errorMessage}</Notice> : null}
          <OutcomeNote job={detail.data.job} />
          {detail.data.job.result ? (
            <>
              <strong style={{ display: 'block', marginTop: 10 }}>结果摘要</strong>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-sm)' }}>{JSON.stringify(detail.data.job.result, null, 2)}</pre>
            </>
          ) : null}
          <strong style={{ display: 'block', marginTop: 10 }}>执行记录</strong>
          {detail.data.events.length === 0 ? <p style={muted}>暂无记录。</p> : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {detail.data.events.map((event) => <li key={event.id}>{when(event.at)} · {event.level} · {event.message}</li>)}
            </ul>
          )}
          <Button onClick={() => navigate(`/logs?action=job_${encodeURIComponent(detail.data!.job.type.replace(/[.]/g, '_'))}`)}>查看同类任务日志</Button>
        </Panel>
      ) : null}
      <div className="zc-admin-jobs-workspace">
      <Panel title="创建维护任务" note="重型维护任务逐个执行；创建后自动显示进度，刷新或关闭页面不影响执行。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Field label="任务类型">
            <Select value={jobType} onChange={(event) => setJobType(event.target.value)}>
              {JOB_TYPES.filter((entry) => !entry.ownerOnly || role === 'owner').map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </Select>
          </Field>
          {jobType === 'blobs.verify' ? (
            <Field label="限定账号（可选，accountId）"><TextInput value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="留空表示全部账号" /></Field>
          ) : null}
          {jobType === 'backup.verify' || jobType === 'restore.drill' ? (
            <Field label="备份记录 ID"><TextInput value={recordId} onChange={(event) => setRecordId(event.target.value)} placeholder="backup-..." /></Field>
          ) : null}
        </div>
        <p style={muted}>{selected.hint}</p>
        <div style={row}>
          <Button disabled={!writable || creating} onClick={() => { void submit(); }}>{creating ? '正在创建…' : '创建任务'}</Button>


        </div>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Notice>任务只接受预定义类型与参数，不接受命令或任意文件路径。</Notice>
      </Panel>

      <Panel title="任务列表">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <Field label="状态">
            <Select value={status} onChange={(event) => update({ status: event.target.value })}>
              <option value="">全部</option>
              {['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].map((value) => <option key={value} value={value}>{statusLabel(value as Job['status'])}</option>)}
            </Select>
          </Field>
          <Field label="类型">
            <Select value={type} onChange={(event) => update({ type: event.target.value })}>
              <option value="">全部</option>
              {JOB_TYPES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </Select>
          </Field>
        </div>
        {accountFilter ? (
          <p style={row}>
            <Notice>当前只显示目标账号为 <code>{accountFilter}</code> 的任务。</Notice>
            <Button onClick={() => update({ accountId: undefined })}>取消该账号筛选</Button>
          </p>
        ) : null}
        <div style={{ ...row, marginTop: 10 }}>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} />
          <ColumnPicker columns={OPTIONAL_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />
        </div>
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'type', header: '类型', ...sortHeader('type', '类型'), render: (job) => JOB_TYPES.find((entry) => entry.value === job.type)?.label ?? job.type },
            { key: 'status', header: '状态', ...sortHeader('status', '状态'), render: (job) => <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge> },
            { key: 'progress', header: '进度', render: (job) => job.total ? `${job.processed}/${job.total}` : job.processed ? String(job.processed) : (job.phase ?? '—') },
            { key: 'by', header: '发起人', secondary: true, optional: true, render: (job) => job.createdBy },
            { key: 'created', header: '创建时间', ...sortHeader('created', '创建时间'), render: (job) => when(job.createdAt) },
            { key: 'finished', header: '结束时间', secondary: true, optional: true, render: (job) => when(job.finishedAt) },
            { key: 'error', header: '结果', render: (job) => { const value = outcomeOf(job); return value ? <Badge tone={value.tone}>{value.label}</Badge> : '—'; } },
            {
              key: 'actions', header: '操作', render: (job) => (
                <div style={row}>
                  <Button onClick={() => update({ job: job.jobId, cursor })}>查看</Button>
                  <Button disabled={!writable || !['queued', 'running'].includes(job.status)} onClick={() => {
                    void client.request(`/jobs/${job.jobId}/cancel`, {}, { idempotencyKey: adminIdempotencyKey(`cancel-${job.jobId}`) }).then(list.reload).catch((caught) => actionError.setError(message(caught)));
                  }}>取消</Button>
                  <Button disabled={!writable || ['queued', 'running'].includes(job.status)} onClick={() => {
                    void client.request(`/jobs/${job.jobId}/retry`, {}, { idempotencyKey: adminIdempotencyKey(`retry-${job.jobId}`) }).then(list.reload).catch((caught) => actionError.setError(message(caught)));
                  }}>重新执行</Button>
                </div>
              ),
            },
          ]}
          rows={list.data?.jobs ?? []}
          rowKey={(job) => job.jobId}
          hiddenColumns={hidden}
          empty="还没有维护任务。"
          activeKey={jobId || undefined}
        />
        <div style={{ ...row, marginTop: 10, justifyContent: 'flex-end' }}>
          {list.data?.nextCursor ? <span style={muted}>第 {pager.page} 页</span> : null}
          <Button disabled={!pager.hasPrevious} onClick={pager.previous}>上一页</Button>
          <Button disabled={!list.data?.nextCursor} onClick={() => { if (list.data?.nextCursor) pager.next(list.data.nextCursor); }}>下一页</Button>
        </div>
        {actionError.error ? <Notice tone="bad">{actionError.error}</Notice> : null}
      </Panel>



      </div>
    </>
  );
}
