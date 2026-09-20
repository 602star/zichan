/** User management: filters live in the URL so refresh and sharing keep the view. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { AccountActions } from './AccountActions.js';
import { Badge, Button, ColumnPicker, DataTable, Field, Loading, Panel, Pager, Select, TextInput, bytes, canWrite, muted, roleLabel, row, useCursorPager, useHiddenColumns, useResource, when } from './ui.js';
import { PageSizeSelect, listParamsQuery, readListParams, sortableHeader, type SortChoice } from './list-controls.js';
import type { AccountRow } from './types.js';

/**
 * The columns this list can be ordered by. Anything not listed here has no server-side ordering,
 * and a header that sorts in the browser would reorder the current page only.
 */
/**
 * Columns that may be turned off, listed separately from the render functions so the visibility
 * hook can prune keys this table no longer has. Keeping it next to the table would work too, but
 * then the hook would have to run after the columns are built — and a stale hidden key would come
 * back as a phantom the first time a column is renamed.
 */
const OPTIONAL_COLUMNS = [
  { key: 'protection', header: '保护模式', optional: true },
  { key: 'created', header: '创建时间', optional: true },
  { key: 'sync', header: '最近成功同步', optional: true },
  { key: 'login', header: '最近登录', optional: true },
  { key: 'devices', header: '有效会话', optional: true },
];

const SORTS: SortChoice[] = [
  { key: 'created', label: '创建时间' },
  { key: 'name', label: '用户名', first: 'asc' },
  { key: 'lastLogin', label: '最近登录' },
  { key: 'lastSync', label: '最近成功同步' },
  { key: 'devices', label: '有效会话' },
  { key: 'usage', label: '容量占用' },
];

const quotaTone = (state: AccountRow['quotaState']) => state === 'over' ? 'bad' as const : state === 'warning' ? 'warn' as const : 'ok' as const;
const quotaLabel = (state: AccountRow['quotaState']) => state === 'over' ? '已超额' : state === 'warning' ? '接近上限' : '正常';

export function UsersPage({ client, query, navigate, role }: {
  client: AdminClient;
  query: URLSearchParams;
  navigate: (to: string) => void;
  role: string;
}) {
  const pager = useCursorPager({ query, path: '/users', navigate });
  const cursor = pager.cursor;
  const [openRow, setOpenRow] = useState('');
  const search = query.get('search') ?? '';
  const roleFilter = query.get('role') ?? '';
  const state = query.get('state') ?? '';
  const protection = query.get('protection') ?? '';
  const quota = query.get('quota') ?? '';
  const [searchDraft, setSearchDraft] = useState(search);
  const listParams = readListParams(query, { sort: 'created', dir: 'desc', limit: 25 });
  const { hidden, toggle, reset } = useHiddenColumns('users', OPTIONAL_COLUMNS);

  const list = useResource(() => client.request<{ users: AccountRow[]; nextCursor?: string; sort?: { key: string; direction: string } }>(
    `/users?${listParamsQuery(listParams)}&cursor=${encodeURIComponent(cursor)}${search ? `&search=${encodeURIComponent(search)}` : ''}${roleFilter ? `&role=${roleFilter}` : ''}${state ? `&state=${state}` : ''}${protection ? `&protection=${protection}` : ''}${quota ? `&quota=${quota}` : ''}`,
  ), [cursor, search, roleFilter, state, protection, quota, listParams.sort, listParams.direction, listParams.limit]);

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

  const canManage = (user: AccountRow) => canWrite(role) && user.role !== 'owner' && (role === 'owner' || user.role === 'member');
  const columns = [
    { key: 'username', header: '用户名', ...sortHeader('name', '用户名'), render: (user: AccountRow) => <button type="button" style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => navigate(`/users/${user.accountId}`)}>{user.username}</button> },
    { key: 'role', header: '角色', render: (user: AccountRow) => roleLabel(user.role) },
    { key: 'state', header: '启用状态', render: (user: AccountRow) => user.disabled ? <Badge tone="bad">已禁用</Badge> : <Badge tone="ok">正常</Badge> },
    { key: 'protection', header: '保护模式', optional: true, render: (user: AccountRow) => user.protectionMode === 'managed' ? '云端托管' : user.protectionMode === 'private' ? '私密' : user.protectionMode === 'relay' ? '中继' : '未设置' },
    {
      key: 'quota', header: '容量使用率', ...sortHeader('usage', '容量使用率'), render: (user: AccountRow) => (
        <span>
          <Badge tone={quotaTone(user.quotaState)}>{quotaLabel(user.quotaState)}</Badge>{' '}
          <span style={muted}>{bytes(user.commitBytes)} / {bytes(user.commitQuotaBytes)}</span>
        </span>
      ),
    },
    { key: 'created', header: '创建时间', ...sortHeader('created', '创建时间'), optional: true, secondary: true, render: (user: AccountRow) => when(user.createdAt) },
    { key: 'sync', header: '最近成功同步', ...sortHeader('lastSync', '最近成功同步'), optional: true, secondary: true, render: (user: AccountRow) => when(user.lastSyncAt) },
    { key: 'login', header: '最近登录', ...sortHeader('lastLogin', '最近登录'), optional: true, secondary: true, render: (user: AccountRow) => when(user.lastLoginAt) },
    { key: 'devices', header: '有效会话', ...sortHeader('devices', '有效会话'), optional: true, secondary: true, render: (user: AccountRow) => String(user.activeDeviceCount) },
    {
      key: 'actions', header: '操作', render: (user: AccountRow) => (
        <div style={row}>
          <Button onClick={() => navigate(`/users/${user.accountId}`)}>详情</Button>
          <Button onClick={() => setOpenRow((current) => current === user.accountId ? '' : user.accountId)}>
            {openRow === user.accountId ? '收起快捷处理' : '快捷处理'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <h2>用户管理</h2>
      <Panel title="筛选" note="筛选条件会写入地址栏；分享或刷新链接会保留当前视图。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <Field label="用户名或 accountId">
            <TextInput value={searchDraft} maxLength={128} onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') update({ search: searchDraft }); }} />
          </Field>
          <Field label="角色">
            <Select value={roleFilter} onChange={(event) => update({ role: event.target.value })}>
              <option value="">全部</option><option value="owner">所有者</option><option value="admin">管理员</option><option value="viewer">只读运维</option><option value="member">普通用户</option>
            </Select>
          </Field>
          <Field label="状态">
            <Select value={state} onChange={(event) => update({ state: event.target.value })}>
              <option value="">全部</option><option value="enabled">正常</option><option value="disabled">已禁用</option>
            </Select>
          </Field>
          <Field label="保护模式">
            <Select value={protection} onChange={(event) => update({ protection: event.target.value })}>
              <option value="">全部</option><option value="managed">云端托管</option><option value="private">私密</option><option value="relay">中继</option><option value="none">未设置</option>
            </Select>
          </Field>
          <Field label="配额状态">
            <Select value={quota} onChange={(event) => update({ quota: event.target.value })}>
              <option value="">全部</option><option value="over">已超额</option><option value="warning">接近上限</option><option value="ok">正常</option>
            </Select>
          </Field>
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ search: searchDraft })}>搜索</Button>
          <Button onClick={() => { setSearchDraft(''); update({ search: undefined, role: undefined, state: undefined, protection: undefined, quota: undefined }); }}>清除筛选</Button>
        </div>
      </Panel>

      <Panel title="用户列表" action={<Button onClick={list.reload}>刷新</Button>}>
        <div style={{ ...row, marginBottom: 8 }}>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} />
          <ColumnPicker columns={columns} hidden={hidden} onToggle={toggle} onReset={reset} />
        </div>
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={columns}
          hiddenColumns={hidden}
          rows={list.data?.users ?? []}
          rowKey={(user) => user.accountId}
          activeKey={openRow || undefined}
          renderExpanded={(user) => (
            <AccountActions
              client={client}
              target={{
                accountId: user.accountId, username: user.username, role: user.role, revision: user.revision,
                disabled: user.disabled, commitBytes: user.commitBytes, commitQuotaBytes: user.commitQuotaBytes,
                activeDeviceCount: user.activeDeviceCount,
              }}
              canManage={canManage(user)}
              canEditQuota={role === 'owner' || user.role === 'member'}
              token="inline"
              onDone={list.reload}
            />
          )}
          empty="没有符合条件的账号。"
        />
        <Pager
          page={pager.page}
          hasNext={Boolean(list.data?.nextCursor)}
          hasPrevious={pager.hasPrevious}
          onNext={() => { if (list.data?.nextCursor) pager.next(list.data.nextCursor); }}
          onPrevious={pager.previous}
        />
      </Panel>
    </>
  );
}
