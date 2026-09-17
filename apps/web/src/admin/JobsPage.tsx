/** Task centre: request work, watch progress, cancel at a safe boundary, re-run. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Panel, Select, TextInput, message, muted, row, usePolling, useResource, when } from './ui.js';
import { JOB_TYPES, type Job, type JobEvent } from './types.js';

const statusTone = (status: Job['status']) => status === 'succeeded' ? 'ok' as const : status === 'running' || status === 'queued' ? 'warn' as const
  : status === 'failed' ? 'bad' as const : 'muted' as const;
const statusLabel = (status: Job['status']) => ({
  queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '执行中断',
}[status]);

export function JobsPage({ client, query, navigate, role }: { client: AdminClient; query: URLSearchParams; navigate: (to: string) => void; role: string }) {
  const status = query.get('status') ?? '';
  const type = query.get('type') ?? '';
  const cursor = query.get('cursor') ?? '';
  const jobId = query.get('job') ?? '';
  const [cursors, setCursors] = useState<string[]>(['']);
  const [jobType, setJobType] = useState('blobs.verify');
  const [accountId, setAccountId] = useState('');
  const [recordId, setRecordId] = useState('');
  const [error, setError] = useState('');

  const list = useResource(() => client.request<{ jobs: Job[]; nextCursor?: string }>(
    `/jobs?limit=25${status ? `&status=${status}` : ''}${type ? `&type=${type}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ), [status, type, cursor]);
  const detail = useResource(
    () => jobId ? client.request<{ job: Job; events: JobEvent[] }>(`/jobs/${jobId}`) : Promise.resolve(undefined),
    [jobId],
  );
  usePolling(() => { list.reload(); detail.reload(); }, 5_000, Boolean(jobId) || Boolean(list.data?.jobs.some((job) => ['queued', 'running'].includes(job.status))));

  const update = (patch: Record<string, string | undefined>, keepCursor = false): void => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key); else next.set(key, value);
    }
    if (!keepCursor) next.delete('cursor');
    setCursors(['']);
    navigate(`/jobs${next.toString() ? `?${next.toString()}` : ''}`);
  };

  const selected = JOB_TYPES.find((entry) => entry.value === jobType)!;
  const submit = async (): Promise<void> => {
    setError('');
    try {
      await client.request('/jobs', {
        type: jobType,
        ...(accountId ? { accountId } : {}),
        ...(recordId && (jobType === 'backup.verify' || jobType === 'restore.drill') ? { recordId } : {}),
      }, { idempotencyKey: adminIdempotencyKey(`job-${jobType}`) });
      list.reload();
    } catch (caught) {
      setError(message(caught));
    }
  };

  return (
    <>
      <h2>任务中心</h2>
      <Panel title="创建维护任务" note="首期重型维护任务最多同时执行一个；创建后返回 202，执行期间刷新或关闭页面都不影响任务。">
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
          <Button onClick={() => { void submit(); }}>创建任务</Button>
          <Button onClick={list.reload}>刷新列表</Button>
          <Button onClick={() => navigate('/storage')}>查看备份记录</Button>
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
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'type', header: '类型', render: (job) => JOB_TYPES.find((entry) => entry.value === job.type)?.label ?? job.type },
            { key: 'status', header: '状态', render: (job) => <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge> },
            { key: 'progress', header: '进度', render: (job) => job.total ? `${job.processed}/${job.total}` : job.processed ? String(job.processed) : (job.phase ?? '—') },
            { key: 'by', header: '发起人', secondary: true, render: (job) => job.createdBy },
            { key: 'created', header: '创建时间', render: (job) => when(job.createdAt) },
            { key: 'finished', header: '结束时间', secondary: true, render: (job) => when(job.finishedAt) },
            { key: 'error', header: '结果', render: (job) => job.errorCode ? <span title={job.errorMessage}>{job.errorCode}</span> : '—' },
            {
              key: 'actions', header: '操作', render: (job) => (
                <div style={row}>
                  <Button onClick={() => update({ job: job.jobId })}>查看</Button>
                  <Button disabled={!['queued', 'running'].includes(job.status)} onClick={() => {
                    void client.request(`/jobs/${job.jobId}/cancel`, {}, { idempotencyKey: adminIdempotencyKey(`cancel-${job.jobId}`) }).then(list.reload).catch((caught) => window.alert(message(caught)));
                  }}>取消</Button>
                  <Button disabled={['queued', 'running'].includes(job.status)} onClick={() => {
                    void client.request(`/jobs/${job.jobId}/retry`, {}, { idempotencyKey: adminIdempotencyKey(`retry-${job.jobId}`) }).then(list.reload).catch((caught) => window.alert(message(caught)));
                  }}>重新执行</Button>
                </div>
              ),
            },
          ]}
          rows={list.data?.jobs ?? []}
          rowKey={(job) => job.jobId}
          empty="还没有维护任务。"
          activeKey={jobId || undefined}
        />
        <div style={{ ...row, marginTop: 10, justifyContent: 'flex-end' }}>
          <Button disabled={cursors.length <= 1} onClick={() => { const next = cursors.slice(0, -1); setCursors(next); update({ cursor: next.at(-1) || undefined }, true); }}>上一页</Button>
          <Button disabled={!list.data?.nextCursor} onClick={() => { setCursors((stack) => [...stack, list.data!.nextCursor!]); update({ cursor: list.data!.nextCursor }, true); }}>下一页</Button>
        </div>
      </Panel>

      {jobId && detail.data ? (
        <Panel title={`任务详情 · ${detail.data.job.jobId}`} action={<Button onClick={() => update({ job: undefined })}>关闭</Button>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <div><div style={muted}>状态</div><Badge tone={statusTone(detail.data.job.status)}>{statusLabel(detail.data.job.status)}</Badge></div>
            <div><div style={muted}>阶段</div>{detail.data.job.phase ?? '—'}</div>
            <div><div style={muted}>进度</div>{detail.data.job.total ? `${detail.data.job.processed}/${detail.data.job.total}` : String(detail.data.job.processed)}</div>
            <div><div style={muted}>原任务</div>{detail.data.job.retryOf ?? '—'}</div>
            <div><div style={muted}>取消请求</div>{detail.data.job.cancelRequested ? '已请求，将在安全边界生效' : '无'}</div>
            <div><div style={muted}>参数</div><code style={{ fontSize: 'var(--fs-sm)' }}>{JSON.stringify(detail.data.job.params)}</code></div>
          </div>
          {detail.data.job.errorMessage ? <Notice tone="bad">{detail.data.job.errorCode}：{detail.data.job.errorMessage}</Notice> : null}
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
          <Button onClick={() => navigate(`/logs?search=${encodeURIComponent(detail.data!.job.type)}`)}>查看关联日志</Button>
        </Panel>
      ) : null}
    </>
  );
}
