/** Run log and management audit: different purposes, retention and failure handling. */
import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { TrendChart } from './chart.js';
import { AccountFilter, TimeRangeFilter } from './filters.js';
import { auditActionLabel, auditTargetLabel } from './audit-presentation.js';
import { LogWorkspaceNav } from './LogWorkspaceNav.js';
import { logActionGroup, logActionOption, logActionTitle, logDetailLabel, logDetailValue, logLevelLabel, logRequestId, logSummary } from './log-presentation.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Panel, Pager, PageHeader, FilterBar, Select, Stat, TextInput, message, muted, row, useActionError, usePolling, useResource, when } from './ui.js';
import { PageSizeSelect, SortHeader, listParamsQuery, readListParams, type SortChoice } from './list-controls.js';
import type { AuditEntry, LogEntry } from './types.js';

/** Sortable columns of the management audit. */
const AUDIT_SORTS: SortChoice[] = [
  { key: 'at', label: '时间' },
  { key: 'action', label: '动作代码', first: 'asc' },
  { key: 'actor', label: '操作者', first: 'asc' },
  { key: 'target', label: '目标', first: 'asc' },
];

export function LogsPage({ client, query, navigate }: { client: AdminClient; query: URLSearchParams; navigate: (to: string) => void }) {
  const [summaryRange, setSummaryRange] = useState<'1h' | '24h' | '7d'>('24h');
  const summary = useResource(() => client.request<{
    range: string; granularity: string;
    buckets: { bucketAt: string; info: number; warn: number; error: number }[];
    totals: { info: number; warn: number; error: number };
    note: string;
  }>(`/logs/summary?range=${summaryRange}`), [summaryRange]);
  const level = query.get('level') ?? '';
  const requestId = query.get('requestId') ?? '';
  const search = query.get('search') ?? '';
  const action = query.get('action') ?? '';
  const accountId = query.get('accountId') ?? '';
  const username = query.get('username') ?? '';
  const from = query.get('from') ?? '';
  const until = query.get('until') ?? '';
  const [requestDraft, setRequestDraft] = useState(requestId);
  const [searchDraft, setSearchDraft] = useState(search);
  const [following, setFollowing] = useState(false);
  useEffect(() => { setRequestDraft(requestId); setSearchDraft(search); }, [requestId, search]);
  const [cursor, setCursor] = useState('');
  const [stack, setStack] = useState<string[]>(['']);
  const [expanded, setExpanded] = useState<string>();
  const [copiedRequestId, setCopiedRequestId] = useState('');
  const listParams = readListParams(query, { sort: 'at', dir: 'desc', limit: 100 }, [50, 100, 200, 500]);
  useEffect(() => {
    if (stack.length > 1 || until || listParams.sort !== 'at' || listParams.direction !== 'desc') setFollowing(false);
  }, [stack.length, until, listParams.sort, listParams.direction]);
  // An export that silently does nothing is worse than one that says why it failed, so a
  // failed download is reported in-page like every other action on this console.
  // Named `exportError` because `action` is already the URL action filter on this page.
  const exportError = useActionError();

  const list = useResource(() => client.request<{ logs: LogEntry[]; nextCursor?: string; actions?: string[]; sort?: { key: string; direction: string } }>(
    `/logs?${listParamsQuery(listParams)}${level ? `&level=${level}` : ''}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}${action ? `&action=${encodeURIComponent(action)}` : ''}${username ? `&username=${encodeURIComponent(username)}` : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}${until ? `&until=${encodeURIComponent(until)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  ), [level, requestId, search, action, username, from, until, cursor, listParams.sort, listParams.direction, listParams.limit]);
  usePolling(list.reload, 5_000, following && stack.length === 1 && !until && listParams.sort === 'at' && listParams.direction === 'desc');

  // The export follows the current filters but not the cursor: it is "everything matching this
  // view", not "this page of it".
  const exportQuery = new URLSearchParams();
  for (const [key, value] of Object.entries({ level, requestId, search, action, username, from, until })) {
    if (value) exportQuery.set(key, value);
  }

  const update = (patch: Record<string, string | undefined>): void => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) { if (!value) next.delete(key); else next.set(key, value); }
    next.delete('cursor');
    setCursor(''); setStack(['']);
    setExpanded(undefined);
    navigate(`/logs${next.toString() ? `?${next.toString()}` : ''}`);
  };
  const appliedSort = list.data?.sort ?? { key: listParams.sort, direction: listParams.direction };
  const actionOptions = [...new Set([...(list.data?.actions ?? []), ...(action ? [action] : [])])].sort((a, b) =>
    logActionGroup(a).localeCompare(logActionGroup(b), 'zh-CN') || logActionTitle(a).localeCompare(logActionTitle(b), 'zh-CN'));
  const actionGroups = [...new Set(actionOptions.map(logActionGroup))];
  const rangeLabel = { '1h': '近 1 小时', '24h': '近 24 小时', '7d': '近 7 天' }[summaryRange];
  const copyRequestId = (value: string): void => {
    if (!navigator.clipboard?.writeText) { exportError.setError('当前浏览器无法复制请求 ID，请从详情中手动复制。'); return; }
    void navigator.clipboard.writeText(value).then(() => { setCopiedRequestId(value); exportError.clear(); }).catch((caught) => exportError.setError(`复制请求 ID 失败：${message(caught)}`));
  };

  return (
    <>
      <PageHeader title="运行日志" description="先看发生了什么，再展开查看请求和技术信息。可按账号、时间、事件或请求定位问题。" actions={<><Button onClick={() => { list.reload(); summary.reload(); }}>刷新</Button><Button onClick={() => void exportLogs(client, 'json', exportQuery.toString()).then(exportError.clear).catch((caught) => exportError.setError(message(caught)))}>导出 JSON</Button><Button onClick={() => void exportLogs(client, 'csv', exportQuery.toString()).then(exportError.clear).catch((caught) => exportError.setError(message(caught)))}>导出 CSV</Button></>} />
      <LogWorkspaceNav current="logs" query={query} navigate={navigate} />
      {exportError.error ? <Notice tone="warn">{exportError.error}</Notice> : null}
      {requestId ? <Notice>正在按请求 {requestId} 关联日志。</Notice> : null}

      <Panel title="日志概况" note={`${summary.data?.note ?? '仅统计服务端当前保留的日志。'} 下方筛选和分页不影响此统计；普通记录不等于操作成功，需关注也不一定代表服务故障。`}
        action={<div className="zc-admin-view-switch" aria-label="日志趋势时间范围">
          {(['1h', '24h', '7d'] as const).map((range) => <Button key={range} disabled={summaryRange === range} aria-pressed={summaryRange === range} onClick={() => setSummaryRange(range)}>{{ '1h': '近 1 小时', '24h': '近 24 小时', '7d': '近 7 天' }[range]}</Button>)}
        </div>}>
        <Loading loading={summary.loading} error={summary.error} stale={summary.stale} loadedAt={summary.loadedAt} />
        <div className="zc-admin-monitor-mini-stats">
          <Stat label="普通记录" value={summary.data ? String(summary.data.totals.info) : '暂无数据'} />
          <Stat label="需关注" value={summary.data ? String(summary.data.totals.warn) : '暂无数据'} tone={summary.data?.totals.warn ? 'warn' : undefined} />
          <Stat label="错误" value={summary.data ? String(summary.data.totals.error) : '暂无数据'} tone={summary.data?.totals.error ? 'bad' : undefined} />
        </div>
        <h3 className="zc-admin-chart-title">错误记录趋势 · {rangeLabel}</h3>
        {(summary.data?.buckets.length ?? 0) >= 2 ? (
          <TrendChart points={summary.data!.buckets.map((bucket) => ({ at: bucket.bucketAt, value: bucket.error }))}
            label={`错误记录趋势，${rangeLabel}`} formatValue={String}
            granularityNote={summary.data?.granularity === 'minute' ? '每分钟统计' : summary.data?.granularity === 'day' ? '每天统计' : '每小时统计'} tone="bad" />
        ) : <p style={muted}>当前只有 {summary.data?.buckets.length ?? 0} 个日志分桶；至少需要 2 个才能展示趋势。</p>}
      </Panel>


      <FilterBar note="来源：同步服务器 SQLite，默认保留最近 5,000 条运行日志，实际条数以服务器设置为准。按账号查日志需要该账号名出现在日志行上；纯系统事件没有账号。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <AccountFilter client={client} accountId={accountId} username={username} onApply={(next) => update({ accountId: next.accountId, username: next.username })} />
          <Field label="级别">
            <Select value={level} onChange={(event) => update({ level: event.target.value })}>
              <option value="">全部级别</option><option value="info">普通记录</option><option value="warn">需关注</option><option value="error">错误</option>
            </Select>
          </Field>
          <Field label="请求 ID"><TextInput value={requestDraft} onChange={(event) => setRequestDraft(event.target.value)} placeholder="req-..." /></Field>
          <Field label="关键词"><TextInput value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="事件、消息或详情" maxLength={128} /></Field>
          <Field label="事件">
            <Select value={action} onChange={(event) => update({ action: event.target.value })}>
              <option value="">全部事件</option>
              {actionGroups.map((group) => <optgroup key={group} label={group}>
                {actionOptions.filter((value) => logActionGroup(value) === group).map((value) => <option key={value} value={value}>{logActionOption(value)}</option>)}
              </optgroup>)}
            </Select>
          </Field>
        </div>
        <TimeRangeFilter from={from} until={until} onApply={(range) => update({ from: range.from, until: range.until })} />
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ requestId: requestDraft.trim(), search: searchDraft.trim() })}>查询日志</Button>
          <Button onClick={() => { setRequestDraft(''); setSearchDraft(''); update({ requestId: undefined, search: undefined, from: undefined, until: undefined, level: undefined, action: undefined, accountId: undefined, username: undefined }); }}>清除筛选</Button>
        </div>
        <p style={muted}>
          导出当前筛选条件下的全部匹配日志；数据量大时可能需要较长时间。字段按名称与取值形态脱敏：令牌、密钥、邀请码与重置码不会出现在文件里。
          账号 ID、任务 ID 与请求 ID 保留，否则导出无法与后台对应。
        </p>
      </FilterBar>

      <Panel title="日志记录" note="每条记录显示事件、简述和关键线索；展开后可查看原始英文内容。">
        <div className="zc-admin-log-toolbar">
          <label className="zc-admin-log-follow"><input type="checkbox" checked={following} disabled={stack.length > 1 || Boolean(until) || listParams.sort !== 'at' || listParams.direction !== 'desc'} onChange={(event) => setFollowing(event.target.checked)} /> 追踪新日志 <span>页面可见时每 5 秒刷新首页</span></label>
          <Field label="排序">
            <Select value={`${appliedSort.key}:${appliedSort.direction}`} onChange={(event) => {
              const [sort, dir] = event.target.value.split(':');
              update({ sort, dir });
            }}>
              <option value="at:desc">时间：最新在前</option><option value="at:asc">时间：最早在前</option>
              <option value="severity:asc">级别：普通记录在前</option><option value="severity:desc">级别：错误在前</option>
              {appliedSort.key === 'level' ? <option value={`level:${appliedSort.direction}`}>旧版级别排序</option> : null}
              <option value="action:asc">事件：正序</option><option value="action:desc">事件：倒序</option>
              <option value="username:asc">账号：正序</option><option value="username:desc">账号：倒序</option>
            </Select>
          </Field>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} sizes={[50, 100, 200, 500]} />
        </div>
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        {list.data?.logs.length ? <div className="zc-admin-log-list">
          {list.data.logs.map((entry) => {
            const request = logRequestId(entry);
            const isExpanded = expanded === entry.id;
            return <article key={entry.id} className="zc-admin-log-card" data-level={entry.level}>
              <div className="zc-admin-log-head">
                <div className="zc-admin-log-title">
                  <Badge tone={entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : 'muted'}>{logLevelLabel(entry.level)}</Badge>
                  <strong>{logActionTitle(entry.action)}</strong>
                </div>
                <time dateTime={entry.at}>{when(entry.at)}</time>
              </div>
              <p className="zc-admin-log-summary">{logSummary(entry)}</p>
              <div className="zc-admin-log-bottom">
                <div className="zc-admin-log-chips">
                  {entry.username ? <span>账号：{entry.username}</span> : <span>系统事件</span>}
                  {entry.status !== undefined ? <span>HTTP {entry.status}</span> : null}
                  {request ? <span>请求：{request}</span> : null}
                </div>
                <Button aria-expanded={isExpanded} aria-controls={isExpanded ? `log-detail-${entry.id}` : undefined} onClick={() => setExpanded(isExpanded ? undefined : entry.id)}>{isExpanded ? '收起详情' : '查看详情'}</Button>
              </div>
              {isExpanded ? <div className="zc-admin-log-detail" id={`log-detail-${entry.id}`}>
                <section>
                  <h4>基本信息</h4>
                  <dl>
                    <div><dt>发生时间</dt><dd>{when(entry.at)}</dd></div>
                    <div><dt>日志级别</dt><dd>{logLevelLabel(entry.level)}</dd></div>
                    <div><dt>事件类别</dt><dd>{logActionGroup(entry.action)}</dd></div>
                    <div><dt>账号</dt><dd>{entry.username ?? '未关联账号'}</dd></div>
                    <div><dt>来源 IP</dt><dd>{entry.ip ?? '未记录'}</dd></div>
                    <div><dt>HTTP 状态码</dt><dd>{entry.status ?? '未记录'}</dd></div>
                  </dl>
                </section>
                {request ? <section className="zc-admin-log-request">
                  <h4>关联请求</h4>
                  <p>{request}</p>
                  <div className="zc-admin-log-actions">
                    <Button onClick={() => update({ requestId: request })}>查看同一请求</Button>
                    <Button onClick={() => copyRequestId(request)}>{copiedRequestId === request ? '已复制请求 ID' : '复制请求 ID'}</Button>
                  </div>
                </section> : null}
                {entry.detail && Object.keys(entry.detail).some((key) => key !== 'requestId') ? <section>
                  <h4>补充信息</h4>
                  <dl>{Object.entries(entry.detail).filter(([key]) => key !== 'requestId').map(([key, value]) =>
                    <div key={key}><dt>{logDetailLabel(key)}</dt><dd>{logDetailValue(value)}</dd></div>)}</dl>
                </section> : null}
                <details className="zc-admin-log-raw">
                  <summary>技术详情 · 原始字段与英文消息</summary>
                  <dl>
                    <div><dt>事件代码</dt><dd><code>{entry.action}</code></dd></div>
                    <div><dt>原始级别</dt><dd><code>{entry.level}</code></dd></div>
                    <div><dt>原始消息</dt><dd>{entry.message}</dd></div>
                  </dl>
                  {entry.detail ? <pre>{JSON.stringify(entry.detail, null, 2)}</pre> : null}
                </details>
              </div> : null}
            </article>;
          })}
        </div> : !list.loading && !list.error ? <p className="zc-admin-log-empty">没有符合条件的日志。可调整筛选条件后重试。</p> : null}
        <div className="zc-admin-log-pager">
          <span>第 {stack.length} 页</span>
          <Button disabled={stack.length <= 1} onClick={() => { const next = stack.slice(0, -1); setExpanded(undefined); setStack(next); setCursor(next.at(-1) ?? ''); }}>较新记录</Button>
          <Button disabled={!list.data?.nextCursor} onClick={() => { if (list.data?.nextCursor) { setExpanded(undefined); setStack((rows) => [...rows, list.data!.nextCursor!]); setCursor(list.data!.nextCursor!); } }}>更早记录</Button>
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
  useEffect(() => { setSearchDraft(search); setActorDraft(actor); setTargetDraft(target); }, [search, actor, target]);
  const [expanded, setExpanded] = useState<number>();
  const [cursor, setCursor] = useState('');
  const [stack, setStack] = useState<string[]>(['']);
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const listParams = readListParams(query, { sort: 'at', dir: 'desc', limit: 50 });

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
    setSearchDraft(''); setActorDraft(''); setTargetDraft('');
    setExpanded(undefined); setCursor(''); setStack(['']);
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
      <PageHeader title="管理审计" description="追溯谁在何时做了什么；详情在记录下方就地显示。" actions={<><Button onClick={list.reload}>刷新</Button><Button disabled={exporting || list.loading || list.data?.entries.length === 0} onClick={() => { setExporting(true); setExportError(''); void download(client, 'json', filterQuery).catch((error) => setExportError(error instanceof Error ? error.message : String(error))).finally(() => setExporting(false)); }}>导出 JSON</Button><Button disabled={exporting || list.loading || list.data?.entries.length === 0} onClick={() => { setExporting(true); setExportError(''); void download(client, 'csv', filterQuery).catch((error) => setExportError(error instanceof Error ? error.message : String(error))).finally(() => setExporting(false)); }}>导出 CSV</Button></>} />
      <LogWorkspaceNav current="audit" query={query} navigate={navigate} />
      <Notice>操作审计记录已提交的管理变更；失败尝试在页底单独列出。这里只记录同步服务器的管理操作，不包含本机账本中的日常记账。</Notice>
      <FilterBar note="审计用于追溯权限、账号与配置变更；筛选在服务端执行。导出当前筛选条件下的全部匹配记录，数据量大时可能需要较长时间。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <Field label="关键字（动作或 accountId）"><TextInput value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="role、account-…" /></Field>
          <Field label="动作">
            <Select value={action} onChange={(event) => update({ action: event.target.value })}>
              <option value="">全部</option>
              {(list.data?.actions ?? [action].filter(Boolean)).map((value) => <option key={value} value={value}>{auditActionLabel(value)} · {value}</option>)}
            </Select>
          </Field>
          <Field label="操作者 accountId"><TextInput value={actorDraft} onChange={(event) => setActorDraft(event.target.value)} placeholder="account-…" /></Field>
          <Field label="目标 accountId"><TextInput value={targetDraft} onChange={(event) => setTargetDraft(event.target.value)} placeholder="account-…" /></Field>
        </div>
        <TimeRangeFilter from={from} until={until} onApply={(range) => update({ from: range.from, until: range.until })} />
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ search: searchDraft, actor: actorDraft, target: targetDraft })}>应用筛选</Button>
          <Button onClick={clear}>清除筛选</Button>
        </div>
        {exportError ? <Notice tone="bad">{exportError}</Notice> : null}
      </FilterBar>

      <Panel title="审计记录">
        <div style={{ ...row, marginTop: 10 }}>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} sizes={[25, 50, 100, 200]} />
        </div>
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'target', header: '资源', headerNode: sortHeader('target', '资源'), render: (entry) => auditTargetLabel(entry) },
            { key: 'actor', header: '操作者', headerNode: sortHeader('actor', '操作者'), render: (entry) => entry.actorName || entry.actorAccountId },
            { key: 'summary', header: '操作内容', render: (entry) => <div className="zc-admin-audit-action"><strong>{auditActionLabel(entry.action)}</strong><span>{entry.summary}</span></div> },
            { key: 'result', header: '结果', render: () => <Badge tone="ok">已完成</Badge> },
            { key: 'at', header: '时间', headerNode: sortHeader('at', '时间'), render: (entry) => when(entry.at) },
            {
              key: 'detail', header: '详情', render: (entry) => (
                <Button aria-expanded={expanded === entry.id} onClick={() => setExpanded(expanded === entry.id ? undefined : entry.id)}>{expanded === entry.id ? '收起' : '展开'}</Button>
              ),
            },
          ]}
          activeKey={expanded === undefined ? undefined : String(expanded)}
          renderExpanded={(entry) => <div className="zc-admin-audit-detail">
            <dl><div><dt>动作代码</dt><dd><code>{entry.action}</code></dd></div><div><dt>操作者 ID</dt><dd>{entry.actorAccountId}</dd></div><div><dt>目标 ID</dt><dd>{entry.targetAccountId ?? '—'}</dd></div><div><dt>请求 ID</dt><dd>{entry.requestId ?? '—'}</dd></div><div><dt>原因</dt><dd>{entry.reason ?? '未填写'}</dd></div></dl>
            <details><summary>查看变更前后值</summary><div className="zc-admin-audit-values"><section><strong>变更前</strong><pre>{JSON.stringify(entry.before, null, 2)}</pre></section><section><strong>变更后</strong><pre>{JSON.stringify(entry.after, null, 2)}</pre></section></div></details>
          </div>}
          rows={list.data?.entries ?? []}
          rowKey={(entry) => String(entry.id)}
          empty="没有符合条件的审计记录。"
        />

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
        ) : <p style={muted}>暂无失败的管理操作。</p>}
      </Panel>
    </>
  );
}

async function download(client: AdminClient, format: 'json' | 'csv', filters: string): Promise<void> {
  const blob = await client.download(`/audit/export?format=${format}${filters ? `&${filters}` : ''}`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `management-audit.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Same download path as the audit export; the file is the run log, redacted server-side. */
async function exportLogs(client: AdminClient, format: 'json' | 'csv', filters: string): Promise<void> {
  const blob = await client.download(`/logs/export?format=${format}${filters ? `&${filters}` : ''}`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `run-log.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
