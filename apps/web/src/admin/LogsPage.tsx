/** Run log and management audit: different purposes, retention and failure handling. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Panel, Pager, Select, TextInput, muted, row, useResource, when } from './ui.js';
import type { AuditEntry, LogEntry } from './types.js';

export function LogsPage({ client, query, navigate }: { client: AdminClient; query: URLSearchParams; navigate: (to: string) => void }) {
  const level = query.get('level') ?? '';
  const requestId = query.get('requestId') ?? '';
  const search = query.get('search') ?? '';
  const from = query.get('from') ?? '';
  const until = query.get('until') ?? '';
  const [requestDraft, setRequestDraft] = useState(requestId);
  const [fromDraft, setFromDraft] = useState(from);
  const [untilDraft, setUntilDraft] = useState(until);
  const [cursor, setCursor] = useState('');
  const [stack, setStack] = useState<string[]>(['']);

  const list = useResource(() => client.request<{ logs: LogEntry[]; nextCursor?: string }>(
    `/logs?limit=100${level ? `&level=${level}` : ''}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}${until ? `&until=${encodeURIComponent(until)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ), [level, requestId, from, until, cursor]);

  const update = (patch: Record<string, string | undefined>): void => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) { if (!value) next.delete(key); else next.set(key, value); }
    next.delete('cursor');
    setCursor(''); setStack(['']);
    navigate(`/logs${next.toString() ? `?${next.toString()}` : ''}`);
  };

  return (
    <>
      <h2>运行日志</h2>
      <Panel title="用途" note="运行日志用于排查错误与性能问题；它按时间和大小限制裁剪，且写入失败时会降级输出，避免日志故障放大业务故障。">
        <Button onClick={() => update({ search: undefined })}>清空关键字</Button>
        {search ? <span style={muted}> 当前关键字：{search}</span> : null}
      </Panel>

      <Panel title="筛选">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <Field label="级别">
            <Select value={level} onChange={(event) => update({ level: event.target.value })}>
              <option value="">全部</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option>
            </Select>
          </Field>
          <Field label="请求 ID"><TextInput value={requestDraft} onChange={(event) => setRequestDraft(event.target.value)} placeholder="req-..." /></Field>
          <Field label="起始时间（ISO）"><TextInput value={fromDraft} onChange={(event) => setFromDraft(event.target.value)} /></Field>
          <Field label="结束时间（ISO）"><TextInput value={untilDraft} onChange={(event) => setUntilDraft(event.target.value)} /></Field>
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ requestId: requestDraft, from: fromDraft, until: untilDraft })}>应用</Button>
          <Button onClick={() => { setRequestDraft(''); setFromDraft(''); setUntilDraft(''); update({ requestId: undefined, from: undefined, until: undefined, level: undefined }); }}>清除筛选</Button>
          <Button onClick={list.reload}>刷新</Button>
        </div>
        {search ? <Notice>来自其他页面的关键字：{search}（运行日志按请求 ID 关联，如需按内容检索请使用请求 ID）。</Notice> : null}
      </Panel>

      <Panel title="日志">
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'at', header: '时间', render: (entry) => when(entry.at) },
            { key: 'level', header: '级别', render: (entry) => <Badge tone={entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : 'muted'}>{entry.level}</Badge> },
            { key: 'action', header: '动作', render: (entry) => entry.action },
            { key: 'message', header: '说明', render: (entry) => entry.message },
            { key: 'status', header: '状态码', secondary: true, render: (entry) => entry.status === undefined ? '—' : String(entry.status) },
            { key: 'user', header: '用户', secondary: true, render: (entry) => entry.username ?? '—' },
            {
              key: 'request', header: '请求 ID', render: (entry) => {
                const value = typeof entry.detail?.['requestId'] === 'string' ? entry.detail['requestId'] : '';
                return value ? <button type="button" style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => update({ requestId: value })}>{value}</button> : '—';
              },
            },
          ]}
          rows={list.data?.logs ?? []}
          rowKey={(entry) => entry.id}
          empty="没有符合条件的日志。"
        />
        <div style={{ ...row, marginTop: 10, justifyContent: 'flex-end' }}>
          <Button disabled={stack.length <= 1} onClick={() => { const next = stack.slice(0, -1); setStack(next); setCursor(next.at(-1) ?? ''); }}>较新记录</Button>
          <Button disabled={!list.data?.nextCursor} onClick={() => { if (list.data?.nextCursor) { setStack((rows) => [...rows, list.data!.nextCursor!]); setCursor(list.data!.nextCursor!); } }}>更早记录</Button>
        </div>
      </Panel>
    </>
  );
}

export function AuditPage({ client, query, navigate }: { client: AdminClient; query: URLSearchParams; navigate: (to: string) => void }) {
  const action = query.get('action') ?? '';
  const search = query.get('search') ?? '';
  const actor = query.get('actor') ?? '';
  const target = query.get('target') ?? '';
  const from = query.get('from') ?? '';
  const until = query.get('until') ?? '';
  const [searchDraft, setSearchDraft] = useState(search);
  const [actorDraft, setActorDraft] = useState(actor);
  const [targetDraft, setTargetDraft] = useState(target);
  const [fromDraft, setFromDraft] = useState(from);
  const [untilDraft, setUntilDraft] = useState(until);
  const [expanded, setExpanded] = useState<number>();
  const [cursor, setCursor] = useState('');
  const [stack, setStack] = useState<string[]>(['']);
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);

  /** Filters go to the server so paging walks the filtered history, not just page one. */
  const filters = new URLSearchParams();
  for (const [key, value] of [['action', action], ['search', search], ['actor', actor], ['target', target], ['from', from], ['until', until]] as const) {
    if (value) filters.set(key, value);
  }
  const filterQuery = filters.toString();

  const list = useResource(() => client.request<{ entries: AuditEntry[]; actions?: string[]; nextCursor?: string }>(
    `/audit?limit=50${filterQuery ? `&${filterQuery}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ), [action, search, actor, target, from, until, cursor]);
  const failures = useResource(() => client.request<{ failures: { id: number; at: string; action: string; code: string | null; message: string | null; requestId: string | null }[]; note: string }>('/audit/failures'), []);

  const update = (patch: Record<string, string | undefined>): void => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) { if (!value) next.delete(key); else next.set(key, value); }
    next.delete('cursor');
    setCursor(''); setStack(['']);
    navigate(`/audit${next.toString() ? `?${next.toString()}` : ''}`);
  };
  const clear = (): void => {
    setSearchDraft(''); setActorDraft(''); setTargetDraft(''); setFromDraft(''); setUntilDraft('');
    setExpanded(undefined);
    navigate('/audit');
  };

  return (
    <>
      <h2>管理审计</h2>
      <Panel title="筛选" note="审计用于追溯权限、账号与配置变更；筛选在服务端执行，翻页会继续沿着同一组筛选条件。导出遵循当前筛选条件。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <Field label="关键字（动作或 accountId）"><TextInput value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="role、account-…" /></Field>
          <Field label="动作">
            <Select value={action} onChange={(event) => update({ action: event.target.value })}>
              <option value="">全部</option>
              {(list.data?.actions ?? [action].filter(Boolean)).map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </Field>
          <Field label="操作者 accountId"><TextInput value={actorDraft} onChange={(event) => setActorDraft(event.target.value)} placeholder="account-…" /></Field>
          <Field label="目标 accountId"><TextInput value={targetDraft} onChange={(event) => setTargetDraft(event.target.value)} placeholder="account-…" /></Field>
          <Field label="起始时间（ISO）"><TextInput value={fromDraft} onChange={(event) => setFromDraft(event.target.value)} /></Field>
          <Field label="结束时间（ISO）"><TextInput value={untilDraft} onChange={(event) => setUntilDraft(event.target.value)} /></Field>
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ search: searchDraft, actor: actorDraft, target: targetDraft, from: fromDraft, until: untilDraft })}>应用筛选</Button>
          <Button onClick={clear}>清除筛选</Button>
          <Button onClick={list.reload}>刷新</Button>
          <Button disabled={exporting || list.loading || list.data?.entries.length === 0} onClick={() => { setExporting(true); setExportError(''); void download(client, 'json', filterQuery).catch((error) => setExportError(error instanceof Error ? error.message : String(error))).finally(() => setExporting(false)); }}>导出 JSON</Button>
          <Button disabled={exporting || list.loading || list.data?.entries.length === 0} onClick={() => { setExporting(true); setExportError(''); void download(client, 'csv', filterQuery).catch((error) => setExportError(error instanceof Error ? error.message : String(error))).finally(() => setExporting(false)); }}>导出 CSV</Button>
        </div>
        {exportError ? <Notice tone="bad">{exportError}</Notice> : null}
      </Panel>

      <Panel title="审计记录">
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'at', header: '时间', render: (entry) => when(entry.at) },
            { key: 'summary', header: '操作', render: (entry) => entry.summary },
            { key: 'action', header: '动作代码', secondary: true, render: (entry) => entry.action },
            { key: 'reason', header: '原因', secondary: true, render: (entry) => entry.reason ?? '—' },
            { key: 'request', header: '请求 ID', secondary: true, render: (entry) => entry.requestId ?? '—' },
            {
              key: 'detail', header: '详情', render: (entry) => (
                <Button onClick={() => setExpanded(expanded === entry.id ? undefined : entry.id)}>{expanded === entry.id ? '收起' : '展开'}</Button>
              ),
            },
          ]}
          rows={list.data?.entries ?? []}
          rowKey={(entry) => String(entry.id)}
          empty="没有符合条件的审计记录。"
        />
        {expanded !== undefined ? (
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-sm)', background: 'var(--surface-2)', padding: 8, borderRadius: 'var(--r-sm)' }}>
            {JSON.stringify(list.data?.entries.find((entry) => entry.id === expanded), null, 2)}
          </pre>
        ) : null}
        <Pager
          page={stack.length}
          hasNext={Boolean(list.data?.nextCursor)}
          hasPrevious={stack.length > 1}
          onNext={() => { if (list.data?.nextCursor) { setStack((rows) => [...rows, list.data!.nextCursor!]); setCursor(list.data!.nextCursor!); } }}
          onPrevious={() => { const next = stack.slice(0, -1); setStack(next); setCursor(next.at(-1) ?? ''); }}
        />
        <p style={muted}>导出不包含邀请码、重置码、令牌或密钥。</p>
      </Panel>

      <Panel title="失败的管理操作" note={failures.data?.note}>
        {failures.data?.failures.length ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {failures.data.failures.map((failure) => (
              <li key={failure.id}>{when(failure.at)} · {failure.action} · {failure.code ?? '未知'}{failure.requestId ? ` · 请求 ${failure.requestId}` : ''}</li>
            ))}
          </ul>
        ) : <p style={muted}>暂无失败记录。失败尝试单独记录，不与已经回滚的事务审计混在一起。</p>}
      </Panel>
    </>
  );
}

async function download(client: AdminClient, format: 'json' | 'csv', filters: string): Promise<void> {
  const text = await client.download(`/audit/export?format=${format}${filters ? `&${filters}` : ''}`);
  const blob = new Blob([text], { type: format === 'csv' ? 'text/csv' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `management-audit.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
