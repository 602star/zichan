/** Sync diagnostics: every server-visible failure with a reason and a next step. */
import { AccountFilter, TimeRangeFilter } from './filters.js';
import type { AdminClient } from './client.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Panel, Select, muted, row, useCursorPager, useResource, when } from './ui.js';
import { SYNC_CATEGORIES, type SyncEvent } from './types.js';

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

  const list = useResource(() => client.request<{ events: SyncEvent[]; nextCursor?: string; coverage: string }>(
    `/sync-events?limit=50${category ? `&category=${category}` : ''}${outcome ? `&outcome=${outcome}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}${until ? `&until=${encodeURIComponent(until)}` : ''}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`,
  ), [category, outcome, cursor, from, until, accountId]);

  const update = pager.apply;

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
        {accountId ? <Notice>当前只显示账号 {username || accountId} 的记录。</Notice> : null}
        <DataTable
          columns={[
            { key: 'at', header: '服务端接收时间', render: (event) => when(event.at) },
            {
              key: 'account', header: '账号', render: (event) => {
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
            { key: 'device', header: '设备', secondary: true, render: (event) => event.deviceName ?? '暂无数据' },
            { key: 'operation', header: '操作类型', render: (event) => event.operation },
            { key: 'commits', header: '提交数量', secondary: true, render: (event) => event.commitCount === undefined ? '暂无数据' : String(event.commitCount) },
            { key: 'bytes', header: '传输字节', secondary: true, render: (event) => event.bytes === undefined ? '暂无数据' : String(event.bytes) },
            { key: 'duration', header: '耗时', render: (event) => event.durationMs === undefined ? '暂无数据' : `${event.durationMs} ms` },
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
