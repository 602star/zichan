/** Run log and management audit: different purposes, retention and failure handling. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { AccountFilter, TimeRangeFilter } from './filters.js';
import { Badge, Button, ColumnPicker, DataTable, Field, Loading, Notice, Panel, Pager, PanelIndex, sectionId, Select, TextInput, message, muted, row, useActionError, useHiddenColumns, useResource, when } from './ui.js';
import { PageSizeSelect, SortHeader, listParamsQuery, readListParams, type SortChoice } from './list-controls.js';
import type { AuditEntry, LogEntry } from './types.js';

/** Sortable columns of the run log; only these have a server-side ordering. */
const LOG_SORTS: SortChoice[] = [
  { key: 'at', label: '时间' },
  { key: 'level', label: '级别', first: 'asc' },
  { key: 'action', label: '动作', first: 'asc' },
  { key: 'username', label: '用户', first: 'asc' },
];

/** Optional columns of the run log, listed once so the picker and the table cannot disagree. */
const LOG_OPTIONAL_COLUMNS = [
  { key: 'status', header: '状态码', optional: true },
  { key: 'user', header: '用户', optional: true },
  { key: 'request', header: '请求 ID', optional: true },
];

/** Sortable columns of the management audit. */
const AUDIT_SORTS: SortChoice[] = [
  { key: 'at', label: '时间' },
  { key: 'action', label: '动作代码', first: 'asc' },
  { key: 'actor', label: '操作者', first: 'asc' },
  { key: 'target', label: '目标', first: 'asc' },
];

/** Optional columns of the management audit. */
const AUDIT_OPTIONAL_COLUMNS = [
  { key: 'action', header: '动作代码', optional: true },
  { key: 'reason', header: '原因', optional: true },
  { key: 'request', header: '请求 ID', optional: true },
];

export function LogsPage({ client, query, navigate }: { client: AdminClient; query: URLSearchParams; navigate: (to: string) => void }) {
  const level = query.get('level') ?? '';
  const requestId = query.get('requestId') ?? '';
  const action = query.get('action') ?? '';
  const accountId = query.get('accountId') ?? '';
  const username = query.get('username') ?? '';
  const from = query.get('from') ?? '';
  const until = query.get('until') ?? '';
  const [requestDraft, setRequestDraft] = useState(requestId);
  const [cursor, setCursor] = useState('');
  const [stack, setStack] = useState<string[]>(['']);
  const listParams = readListParams(query, { sort: 'at', dir: 'desc', limit: 100 });
  const { hidden, toggle, reset } = useHiddenColumns('logs', LOG_OPTIONAL_COLUMNS);
  // An export that silently does nothing is worse than one that says why it failed, so a
  // failed download is reported in-page like every other action on this console.
  // Named `exportError` because `action` is already the URL action filter on this page.
  const exportError = useActionError();

  const list = useResource(() => client.request<{ logs: LogEntry[]; nextCursor?: string; actions?: string[]; sort?: { key: string; direction: string } }>(
    `/logs?${listParamsQuery(listParams)}${level ? `&level=${level}` : ''}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ''}${action ? `&action=${encodeURIComponent(action)}` : ''}${username ? `&username=${encodeURIComponent(username)}` : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}${until ? `&until=${encodeURIComponent(until)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ), [level, requestId, action, username, from, until, cursor, listParams.sort, listParams.direction, listParams.limit]);

  // The export follows the current filters but not the cursor: it is "everything matching this
  // view", not "this page of it".
  const exportQuery = new URLSearchParams();
  for (const [key, value] of Object.entries({ level, requestId, action, username, from, until })) {
    if (value) exportQuery.set(key, value);
  }

  const update = (patch: Record<string, string | undefined>): void => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) { if (!value) next.delete(key); else next.set(key, value); }
    next.delete('cursor');
    setCursor(''); setStack(['']);
    navigate(`/logs${next.toString() ? `?${next.toString()}` : ''}`);
  };
  // The sort the server actually used, which is not always the one that was asked for.
  const appliedSort = list.data?.sort ?? { key: listParams.sort, direction: listParams.direction };
  const sortHeader = (key: string, label: string) => (
    <SortHeader
      choice={LOG_SORTS.find((entry) => entry.key === key) ?? { key, label }}
      sort={appliedSort.key}
      direction={appliedSort.direction}
      onSort={(next) => update({ sort: next.sort, dir: next.dir })}
    />
  );

  return (
    <>
      <h2>运行日志</h2>
      <PanelIndex sections={[
        { id: sectionId('用途'), label: '用途' },
        { id: sectionId('筛选'), label: '筛选' },
        { id: sectionId('日志'), label: '日志' },
      ]} />
      {exportError.error ? <Notice tone="warn">{exportError.error}</Notice> : null}
      <Panel title="用途" note="运行日志用于排查错误与性能问题；它按时间和大小限制裁剪，且写入失败时会降级输出，避免日志故障放大业务故障。">
        {requestId ? <p><Notice>正在按请求 {requestId} 关联日志。从用户详情页进来时会同时带上账号筛选。</Notice></p> : null}
      </Panel>

      <Panel title="筛选" note="按账号查日志需要该账号名同时出现在日志行上（登录、同步、管理操作都带账号名）；纯系统事件没有账号。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <AccountFilter client={client} accountId={accountId} username={username} onApply={(next) => update({ accountId: next.accountId, username: next.username })} />
          <Field label="级别">
            <Select value={level} onChange={(event) => update({ level: event.target.value })}>
              <option value="">全部</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option>
            </Select>
          </Field>
          <Field label="请求 ID"><TextInput value={requestDraft} onChange={(event) => setRequestDraft(event.target.value)} placeholder="req-..." /></Field>
          <Field label="动作">
            <Select value={action} onChange={(event) => update({ action: event.target.value })}>
              <option value="">全部</option>
              {(list.data?.actions ?? [action].filter(Boolean)).map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </Field>
        </div>
        <TimeRangeFilter from={from} until={until} onApply={(range) => update({ from: range.from, until: range.until })} />
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ requestId: requestDraft })}>按请求 ID 筛选</Button>
          <Button onClick={() => { setRequestDraft(''); update({ requestId: undefined, from: undefined, until: undefined, level: undefined, action: undefined, accountId: undefined, username: undefined }); }}>清除筛选</Button>
          <Button onClick={list.reload}>刷新</Button>
          <Button onClick={() => void exportLogs(client, 'json', exportQuery.toString()).then(exportError.clear).catch((caught) => exportError.setError(message(caught)))}>导出 JSON</Button>
          <Button onClick={() => void exportLogs(client, 'csv', exportQuery.toString()).then(exportError.clear).catch((caught) => exportError.setError(message(caught)))}>导出 CSV</Button>
        </div>
        <p style={muted}>
          导出沿用当前筛选条件（最多 5000 条），并按字段名与取值形态脱敏：令牌、密钥、邀请码与重置码不会出现在文件里。
          账号 ID、任务 ID 与请求 ID 保留，否则导出无法与后台对应。
        </p>
      </Panel>

      <Panel title="日志">
        <div style={{ ...row, marginTop: 10 }}>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} sizes={[50, 100, 200, 500]} />
          <ColumnPicker columns={LOG_OPTIONAL_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />
        </div>
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'at', header: '时间', headerNode: sortHeader('at', '时间'), render: (entry) => when(entry.at) },
            { key: 'level', header: '级别', headerNode: sortHeader('level', '级别'), render: (entry) => <Badge tone={entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : 'muted'}>{entry.level}</Badge> },
            { key: 'action', header: '动作', headerNode: sortHeader('action', '动作'), render: (entry) => entry.action },
            { key: 'message', header: '说明', render: (entry) => entry.message },
            { key: 'status', header: '状态码', secondary: true, optional: true, render: (entry) => entry.status === undefined ? '—' : String(entry.status) },
            { key: 'user', header: '用户', secondary: true, optional: true, headerNode: sortHeader('username', '用户'), render: (entry) => entry.username ?? '—' },
            {
              key: 'request', header: '请求 ID', optional: true, render: (entry) => {
                const value = typeof entry.detail?.['requestId'] === 'string' ? entry.detail['requestId'] : '';
                return value ? <button type="button" style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => update({ requestId: value })}>{value}</button> : '—';
              },
            },
          ]}
          rows={list.data?.logs ?? []}
          rowKey={(entry) => entry.id}
          hiddenColumns={hidden}
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
  const listParams = readListParams(query, { sort: 'at', dir: 'desc', limit: 50 });
  const { hidden, toggle, reset } = useHiddenColumns('audit', AUDIT_OPTIONAL_COLUMNS);

  /** Filters go to the server so paging walks the filtered history, not just page one. */
  const filters = new URLSearchParams();
  for (const [key, value] of [['action', action], ['search', search], ['actor', actor], ['target', target], ['from', from], ['until', until]] as const) {
    if (value) filters.set(key, value);
  }
  const filterQuery = filters.toString();

  const list = useResource(() => client.request<{ entries: AuditEntry[]; actions?: string[]; nextCursor?: string; sort?: { key: string; direction: string } }>(
    `/audit?${listParamsQuery(listParams)}${filterQuery ? `&${filterQuery}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ), [action, search, actor, target, from, until, cursor, listParams.sort, listParams.direction, listParams.limit]);
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
  // The sort the server actually used, which is not always the one that was asked for.
  const appliedSort = list.data?.sort ?? { key: listParams.sort, direction: listParams.direction };
  const sortHeader = (key: string, label: string) => (
    <SortHeader
      choice={AUDIT_SORTS.find((entry) => entry.key === key) ?? { key, label }}
      sort={appliedSort.key}
      direction={appliedSort.direction}
      onSort={(next) => update({ sort: next.sort, dir: next.dir })}
    />
  );

  return (
    <>
      <h2>管理审计</h2>
      <PanelIndex sections={[
        { id: sectionId('筛选'), label: '筛选' },
        { id: sectionId('审计记录'), label: '审计记录' },
        { id: sectionId('失败的管理操作'), label: '失败的管理操作' },
      ]} />
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
        <div style={{ ...row, marginTop: 10 }}>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} sizes={[25, 50, 100, 200]} />
          <ColumnPicker columns={AUDIT_OPTIONAL_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />
        </div>
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'at', header: '时间', headerNode: sortHeader('at', '时间'), render: (entry) => when(entry.at) },
            { key: 'summary', header: '操作', render: (entry) => entry.summary },
            { key: 'action', header: '动作代码', secondary: true, optional: true, headerNode: sortHeader('action', '动作代码'), render: (entry) => entry.action },
            { key: 'actor', header: '操作者', secondary: true, optional: true, headerNode: sortHeader('actor', '操作者'), render: (entry) => entry.actorName ?? entry.actorAccountId },
            { key: 'target', header: '目标', secondary: true, optional: true, headerNode: sortHeader('target', '目标'), render: (entry) => entry.targetName ?? entry.targetAccountId ?? '—' },
            { key: 'reason', header: '原因', secondary: true, optional: true, render: (entry) => entry.reason ?? '—' },
            { key: 'request', header: '请求 ID', secondary: true, optional: true, render: (entry) => entry.requestId ?? '—' },
            {
              key: 'detail', header: '详情', render: (entry) => (
                <Button onClick={() => setExpanded(expanded === entry.id ? undefined : entry.id)}>{expanded === entry.id ? '收起' : '展开'}</Button>
              ),
            },
          ]}
          rows={list.data?.entries ?? []}
          rowKey={(entry) => String(entry.id)}
          hiddenColumns={hidden}
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

/** Same download path as the audit export; the file is the run log, redacted server-side. */
async function exportLogs(client: AdminClient, format: 'json' | 'csv', filters: string): Promise<void> {
  const text = await client.download(`/logs/export?format=${format}${filters ? `&${filters}` : ''}`);
  const blob = new Blob([text], { type: format === 'csv' ? 'text/csv' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `run-log.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
