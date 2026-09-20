/** Sync diagnostics: every server-visible failure with a reason and a next step. */
import { AccountFilter, TimeRangeFilter } from './filters.js';
import type { AdminClient } from './client.js';
import { Badge, Button, ColumnPicker, DataTable, Field, Loading, Notice, Panel, Select, muted, row, useCursorPager, useHiddenColumns, useResource, when } from './ui.js';
import { PageSizeSelect, listParamsQuery, readListParams, sortableHeader, type SortChoice } from './list-controls.js';
import { SYNC_CATEGORIES, type SyncEvent } from './types.js';

/** Sortable columns; only these have a server-side ordering behind them. */
const SORTS: SortChoice[] = [
  { key: 'at', label: '服务端接收时间' },
  { key: 'account', label: '账号', first: 'asc' },
  { key: 'operation', label: '操作类型', first: 'asc' },
  { key: 'duration', label: '耗时' },
  { key: 'commits', label: '提交数量' },
];

/** Optional columns, listed once so the picker and the table cannot disagree. */
const OPTIONAL_COLUMNS = [
  { key: 'device', header: '设备', optional: true },
  { key: 'client', header: '客户端', optional: true },
  { key: 'commits', header: '提交数量', optional: true },
  { key: 'bytes', header: '传输字节', optional: true },
];

export function SyncPage({ client, query, navigate }: { client: AdminClient; query: URLSearchParams; navigate: (to: string) => void }) {
  const category = query.get('category') ?? '';
  const outcome = query.get('outcome') ?? '';
  const from = query.get('from') ?? '';
  const until = query.get('until') ?? '';
  // The account filter is carried twice on purpose: the accountId is the query, the username
  // is only a label, so a link stays correct when the readable name changes.
  const accountId = query.get('accountId') ?? '';
  const username = query.get('username') ?? '';
  const pager = useCursorPager({ query, path: '/sync', navigate });
  const cursor = pager.cursor;
  const listParams = readListParams(query, { sort: 'at', dir: 'desc', limit: 50 });
  const { hidden, toggle, reset } = useHiddenColumns('sync', OPTIONAL_COLUMNS);

  const list = useResource(() => client.request<{ events: SyncEvent[]; nextCursor?: string; coverage: string; sort?: { key: string; direction: string } }>(
    `/sync-events?${listParamsQuery(listParams)}${category ? `&category=${category}` : ''}${outcome ? `&outcome=${outcome}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}${until ? `&until=${encodeURIComponent(until)}` : ''}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`,
  ), [category, outcome, cursor, from, until, accountId, listParams.sort, listParams.direction, listParams.limit]);

  const update = pager.apply;
  // The sort the server actually used, which is not always the one that was asked for.
  const appliedSort = list.data?.sort ?? { key: listParams.sort, direction: listParams.direction };
  // One spreadable value per column, so the clickable header and the announced sort state cannot
  // drift apart.
  const sortHeader = (key: string, label: string) => sortableHeader(
    SORTS.find((entry) => entry.key === key) ?? { key, label },
    appliedSort.key,
    appliedSort.direction,
    (next) => update({ sort: next.sort, dir: next.dir }),
  );

  return (
    <>
      <h2>同步诊断</h2>
      <Panel title="错误分类">
        <DataTable
          columns={[
            { key: 'label', header: '类型', render: (entry) => entry.label },
            { key: 'meaning', header: '页面解释', render: (entry) => entry.value },
            { key: 'next', header: '下一步', render: (entry) => entry.next },
          ]}
          rows={SYNC_CATEGORIES}
          rowKey={(entry) => entry.value}
          empty="暂无分类。"
        />
        <Button onClick={() => update({ category: 'session-invalid' })}>只看会话失效</Button>{' '}
        <Button onClick={() => update({ outcome: 'error' })}>只看失败</Button>
      </Panel>

      <Panel title="筛选" note="从用户详情页进来时会带着该账号的时间范围无关筛选，可直接看到这个用户的同步结果。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <AccountFilter client={client} accountId={accountId} username={username} onApply={(next) => update({ accountId: next.accountId, username: next.username })} />
          <Field label="错误分类">
            <Select value={category} onChange={(event) => update({ category: event.target.value })}>
              <option value="">全部</option>
              {SYNC_CATEGORIES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </Select>
          </Field>
          <Field label="结果">
            <Select value={outcome} onChange={(event) => update({ outcome: event.target.value })}>
              <option value="">全部</option><option value="ok">成功</option><option value="error">失败</option>
            </Select>
          </Field>
        </div>
        <TimeRangeFilter from={from} until={until} onApply={(range) => update({ from: range.from, until: range.until })} />
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ category: undefined, outcome: undefined, from: undefined, until: undefined, accountId: undefined, username: undefined })}>清除筛选</Button>
          <Button onClick={list.reload}>刷新</Button>
        </div>
      </Panel>

      <Panel title="诊断记录">
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <Notice>{list.data?.coverage ?? '覆盖范围：仅服务端可见的同步结果。'}</Notice>
        <Notice>
          客户端信息由客户端自报，服务端不据此改变任何行为：它只用来判断“这个设备是不是旧版本”，不构成身份证明。
          早于该字段的记录显示“未知”，那是当时没有上报，不等于客户端旧。
        </Notice>
        {accountId ? <Notice>当前只显示账号 {username || accountId} 的记录。</Notice> : null}
        <div style={{ ...row, marginTop: 10 }}>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} sizes={[25, 50, 100, 200]} />
          <ColumnPicker columns={OPTIONAL_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />
        </div>
        <DataTable
          columns={[
            { key: 'at', header: '服务端接收时间', ...sortHeader('at', '服务端接收时间'), render: (event) => when(event.at) },
            {
              key: 'account', header: '账号', ...sortHeader('account', '账号'), render: (event) => {
                // Empty rather than '—': '—' is a sentinel that short-circuits every fallback.
                if (!event.username) return '暂无数据';
                return (
                  <button type="button" style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => navigate(`/users/${encodeURIComponent(event.accountId ?? '')}${event.accountId ? '' : `?search=${encodeURIComponent(event.username ?? '')}`}`)}>
                    {event.username}
                  </button>
                );
              },
            },
            { key: 'device', header: '设备', secondary: true, optional: true, render: (event) => event.deviceName ?? '暂无数据' },
            {
              key: 'client', header: '客户端', secondary: true, optional: true,
              // Self-reported, so it is shown as a claim rather than a fact. "未知" is the
              // honest reading for a client that sends nothing — not "old".
              render: (event) => describeClient(event),
            },
            { key: 'operation', header: '操作类型', ...sortHeader('operation', '操作类型'), render: (event) => event.operation },
            { key: 'commits', header: '提交数量', secondary: true, optional: true, ...sortHeader('commits', '提交数量'), render: (event) => event.commitCount === undefined ? '暂无数据' : String(event.commitCount) },
            { key: 'bytes', header: '传输字节', secondary: true, optional: true, render: (event) => event.bytes === undefined ? '暂无数据' : String(event.bytes) },
            { key: 'duration', header: '耗时', ...sortHeader('duration', '耗时'), render: (event) => event.durationMs === undefined ? '暂无数据' : `${event.durationMs} ms` },
            { key: 'result', header: '结果', render: (event) => event.outcome === 'ok' ? <Badge tone="ok">成功</Badge> : <Badge tone="bad">{event.resultCode ?? '失败'}</Badge> },
            { key: 'reason', header: '原因', render: (event) => SYNC_CATEGORIES.find((entry) => entry.value === event.category)?.label ?? '暂无数据' },
            {
              key: 'request', header: '关联请求', render: (event) => event.requestId
                ? <button type="button" style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => navigate(`/logs?requestId=${event.requestId}`)}>{event.requestId}</button>
                : '暂无数据',
            },
          ]}
          rows={list.data?.events ?? []}
          rowKey={(event) => event.id}
          hiddenColumns={hidden}
          empty={accountId ? '该账号在这个范围内没有服务端可见的同步记录：可能当前离线或没有新操作，这不等于故障。' : '没有符合条件的诊断记录。'}
        />
        <div style={{ ...row, marginTop: 10, justifyContent: 'flex-end' }}>
          <span style={muted}>第 {pager.page} 页</span>
          <Button disabled={!pager.hasPrevious} onClick={pager.previous}>较新记录</Button>
          <Button disabled={!list.data?.nextCursor} onClick={() => { if (list.data?.nextCursor) pager.next(list.data.nextCursor); }}>更早记录</Button>
        </div>
        <p style={muted}>后台不提供“强制重新同步所有用户”这类操作：同步由客户端发起，服务端只记录结果。</p>
      </Panel>
    </>
  );
}

/** One line describing the client that produced an event, or the reason there is none. */
function describeClient(event: SyncEvent): string {
  const kind = event.clientKind === 'desktop' ? '桌面端' : event.clientKind === 'web' ? '网页版' : event.clientKind === 'mobile' ? '移动端' : event.clientKind;
  if (!kind && !event.clientVersion) return '未知';
  const parts = [kind ?? '未知客户端'];
  if (event.clientVersion) parts.push(`版本 ${event.clientVersion}`);
  // Protocol is only worth showing when the server can compare it against something; the
  // version alone is what answers "is this an old build".
  if (event.protocolVersion) parts.push(`协议 v${event.protocolVersion}`);
  return parts.join(' · ');
}
