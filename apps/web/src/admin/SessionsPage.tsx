/** Sessions are the management unit: filter, inspect, and revoke with a reported outcome. */
import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { AccountFilter } from './filters.js';
import { Badge, Button, ColumnPicker, DataTable, Field, Loading, Notice, Panel, Pager, Select, TextInput, canWrite, message, muted, roleLabel, row, useActionError, useCursorPager, useHiddenColumns, useResource, when } from './ui.js';
import { PageSizeSelect, listParamsQuery, readListParams, sortableHeader, type SortChoice } from './list-controls.js';
import type { SessionRow } from './types.js';

/**
 * Sortable columns. Only these are offered: a header that sorts in the browser would reorder the
 * twenty-five rows on screen and present the result as "the newest sessions".
 */
const SESSION_SORTS: SortChoice[] = [
  { key: 'lastSeen', label: '最近活动' },
  { key: 'created', label: '首次登录' },
  { key: 'expires', label: '到期时间' },
  { key: 'name', label: '用户名', first: 'asc' },
];

/** Optional columns, listed so the picker and the table cannot disagree about which exist. */
const SESSION_COLUMNS = [
  { key: 'user', header: '用户' },
  { key: 'device', header: '设备名称' },
  { key: 'kind', header: '会话类型' },
  { key: 'role', header: '角色', optional: true },
  { key: 'state', header: '状态' },
  { key: 'created', header: '首次登录', optional: true },
  { key: 'seen', header: '最近活动' },
  { key: 'expires', header: '到期时间', optional: true },
  { key: 'ip', header: '来源 IP', optional: true },
  { key: 'actions', header: '操作' },
];

export function SessionsPage({ client, query, navigate, role, selfAccountId }: {
  client: AdminClient;
  query: URLSearchParams;
  navigate: (to: string) => void;
  role: string;
  selfAccountId: string;
}) {
  const search = query.get('search') ?? '';
  const accountId = query.get('accountId') ?? '';
  const state = query.get('state') ?? '';
  const kind = query.get('kind') ?? '';
  const pager = useCursorPager({ query, path: '/sessions', navigate });
  const cursor = pager.cursor;
  const listParams = readListParams(query, { sort: 'lastSeen', dir: 'desc', limit: 25 });
  const { hidden, toggle, reset } = useHiddenColumns('sessions', SESSION_COLUMNS);
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => { setSearchDraft(search); }, [search]);
  const [report, setReport] = useState('');
  const [busy, setBusy] = useState(false);
  const actionError = useActionError();

  const list = useResource(() => client.request<{ sessions: SessionRow[]; nextCursor?: string; paginationUnit: string; note: string; sort?: { key: string; direction: string } }>(
    `/sessions?${listParamsQuery(listParams)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}${state ? `&state=${state}` : ''}${kind ? `&kind=${kind}` : ''}`,
  ), [cursor, accountId, search, state, kind, listParams.sort, listParams.direction, listParams.limit]);

  const update = pager.apply;
  // The sort the server actually used, which is not always the one that was asked for: a page
  // built against an older server must show what it got rather than what it wanted.
  const appliedSort = list.data?.sort ?? { key: listParams.sort, direction: listParams.direction };
  // One spreadable value per column, so the clickable header and the announced sort state cannot
  // drift apart.
  const sortHeader = (key: string, label: string) => sortableHeader(
    SESSION_SORTS.find((entry) => entry.key === key) ?? { key, label },
    appliedSort.key,
    appliedSort.direction,
    (next) => update({ sort: next.sort, dir: next.dir }),
  );

  const rows = list.data?.sessions ?? [];
  const currentSessionId = client.currentSessionId();
  const activeCount = rows.filter((session) => session.active).length;
  /**
   * Mirrors the server rules: privileged sessions of other accounts stay protected, the
   * current session ends through logout, and everyone may revoke their own other sessions
   * (which the server only accepts within a recent-login window).
   */
  const revocable = (session: SessionRow): boolean => {
    if (!canWrite(role)) return false;
    if (!session.active || session.id === currentSessionId) return false;
    return session.accountId === selfAccountId || session.role === 'member';
  };
  const revocableCount = rows.filter(revocable).length;

  const revokeMany = async (): Promise<void> => {
    setBusy(true); setReport('');
    const succeeded: string[] = [];
    const failed: string[] = [];
    const forbidden: string[] = [];
    for (const session of rows.filter(revocable)) {
      try {
        await client.request(`/sessions/${session.id}/revoke`, {}, { idempotencyKey: adminIdempotencyKey(`revoke-${session.id}`) });
        succeeded.push(session.deviceName);
      } catch (error) {
        const text = message(error);
        if (text.includes('无权') || text.includes('不能管理')) forbidden.push(session.deviceName);
        else failed.push(`${session.deviceName}：${text}`);
      }
    }
    setReport([
      `范围：当前页 ${rows.length} 个会话，其中有效 ${activeCount} 个，可撤销 ${revocableCount} 个。`,
      '当前会话与受保护账号的会话不在范围内：当前会话请用顶部「退出管理后台」结束。',
      `成功 ${succeeded.length} 个。`,
      failed.length ? `失败 ${failed.length} 个：${failed.join('；')}` : '失败 0 个。',
      forbidden.length ? `无权限 ${forbidden.length} 个：${forbidden.join('、')}` : '无权限 0 个。',
    ].join('\n'));
    setBusy(false);
    list.reload();
  };

  return (
    <>
      <h2>设备与会话</h2>
      <Panel title="筛选" note="按会话分页：每页会话数固定，不再按账号展开。">
        <AccountFilter client={client} accountId={accountId} username={query.get('username') ?? ''} onApply={update} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <Field label="用户名、accountId 或设备名">
            <TextInput value={searchDraft} maxLength={128} onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') update({ search: searchDraft }); }} />
          </Field>
          <Field label="状态">
            <Select value={state} onChange={(event) => update({ state: event.target.value })}>
              <option value="">全部</option><option value="active">有效</option><option value="revoked">已撤销</option><option value="expired">已过期</option>
            </Select>
          </Field>
          <Field label="会话类型">
            <Select value={kind} onChange={(event) => update({ kind: event.target.value })}>
              <option value="">全部</option><option value="ledger">记账</option><option value="admin">管理后台</option>
            </Select>
          </Field>
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ search: searchDraft })}>搜索</Button>
          <Button onClick={() => { setSearchDraft(''); update({ search: undefined, accountId: undefined, username: undefined, state: undefined, kind: undefined }); }}>清除筛选</Button>
          <Button disabled={busy || revocableCount === 0} onClick={() => { void revokeMany(); }}>撤销当前页可撤销的会话</Button>
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} />
          <ColumnPicker columns={SESSION_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />
        </div>
        {report ? <Notice tone="warn"><span style={{ whiteSpace: 'pre-wrap' }}>{report}</span></Notice> : null}
      </Panel>

      <Panel title="会话列表" action={<Button onClick={list.reload}>刷新</Button>}>
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'user', header: '用户', ...sortHeader('name', '用户名'), render: (session) => (
              <button type="button" style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => navigate(`/users/${encodeURIComponent(session.accountId ?? '')}${session.accountId ? '' : `?search=${encodeURIComponent(session.username)}`}`)}>{session.username}</button>
            ) },
            { key: 'device', header: '设备名称', render: (session) => session.deviceName },
            { key: 'kind', header: '会话类型', render: (session) => session.kind === 'admin' ? '管理后台' : '记账' },
            { key: 'role', header: '角色', secondary: true, optional: true, render: (session) => roleLabel(session.role) },
            { key: 'state', header: '状态', render: (session) => <Badge tone={session.revokedAt ? 'bad' : session.active ? 'ok' : 'muted'}>{session.revokedAt ? '已撤销' : session.active ? '有效' : '已过期'}</Badge> },
            { key: 'created', header: '首次登录', secondary: true, optional: true, ...sortHeader('created', '首次登录'), render: (session) => when(session.createdAt) },
            { key: 'seen', header: '最近活动', ...sortHeader('lastSeen', '最近活动'), render: (session) => when(session.lastSeenAt) },
            { key: 'expires', header: '到期时间', secondary: true, optional: true, ...sortHeader('expires', '到期时间'), render: (session) => when(session.expiresAt) },
            { key: 'ip', header: '来源 IP', secondary: true, optional: true, render: (session) => session.lastIp ?? '暂无数据' },
            {
              key: 'actions', header: '操作', render: (session) => (
                <Button disabled={!revocable(session)} title={session.id === currentSessionId ? '当前会话请用顶部「退出管理后台」结束' : undefined}
                  onClick={() => {
                    void client.request(`/sessions/${session.id}/revoke`, {}, { idempotencyKey: adminIdempotencyKey(`revoke-${session.id}`) })
                      .then(() => list.reload())
                      .catch((error) => actionError.setError(message(error)));
                  }}>撤销</Button>
              ),
            },
          ]}
          rows={rows}
          hiddenColumns={hidden}
          rowKey={(session) => session.id}
          empty="没有符合条件的会话。"
        />
        <Pager
          page={pager.page}
          hasNext={Boolean(list.data?.nextCursor)}
          hasPrevious={pager.hasPrevious}
          onNext={() => { if (list.data?.nextCursor) pager.next(list.data.nextCursor); }}
          onPrevious={pager.previous}
        />
        <p style={muted}>{list.data?.note ?? ''}</p>
        <p style={muted}>所有者与管理员可以撤销自己账号的其他会话（需要最近 5 分钟内的登录）；当前会话请通过顶部「退出管理后台」结束，避免出现不清楚的登录状态。其他账号的管理员或所有者会话受保护。</p>
        {actionError.error ? <Notice tone="bad">{actionError.error}</Notice> : null}
      </Panel>
    </>
  );
}
