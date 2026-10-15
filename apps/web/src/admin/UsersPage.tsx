/** User management: filters live in the URL so refresh and sharing keep the view. */
import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { AccountActions, type AccountActionMode } from './AccountActions.js';
import { PageHeader, FilterBar, Badge, Button, ColumnPicker, CopyValue, DataTable, Field, Loading, Notice, Panel, Pager, Select, TextInput, bytes, canEditAccountQuota, canManageAccount, muted, quotaLimit, roleLabel, row, useCursorPager, useHiddenColumns, useResource, useRowSelection, when } from './ui.js';
import { PageSizeSelect, listParamsQuery, readListParams, sortableHeader, type SortChoice } from './list-controls.js';
import { BULK_LABELS, partitionSelection, runBulkAction, type BulkAction, type BulkOutcome } from './bulk-actions.js';
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

/**
 * States the scope of a bulk action before it runs.
 *
 * The count is not enough: an operator who selected the wrong rows needs to see *which* rows, and
 * which ones will be skipped and why, while they can still cancel. The same partition the run will
 * use is shown here, so the confirmation and the report cannot disagree.
 */
function BulkConfirm({ action, rows, selected, canManage, busy, onConfirm, onCancel }: {
  action: BulkAction;
  rows: AccountRow[];
  selected: string[];
  canManage: (account: AccountRow) => boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { ready, skipped } = partitionSelection(rows, selected, action, canManage);
  return (
    <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8, marginBottom: 8 }}>
      <strong>{BULK_LABELS[action]}：确认范围</strong>
      <p style={muted}>
        {action === 'revoke-sessions'
          ? '将结束所选账号的全部会话，用户需要重新登录。数据保留。'
          : action === 'disable'
            ? '将禁用所选账号并立即结束其会话，数据保留。'
            : '将启用所选账号；旧会话不会复活，用户需要重新登录。'}
        每个账号单独执行并单独报告结果。
      </p>
      <p style={muted}>将处理 {ready.length} 个：{ready.length ? ready.map((account) => account.username).join('、') : '（无）'}</p>
      {skipped.length ? (
        <p style={muted}>将跳过 {skipped.length} 个：{skipped.map((entry) => `${entry.account.username}（${entry.reason}）`).join('；')}</p>
      ) : null}
      <div style={row}>
        <Button disabled={busy || ready.length === 0} onClick={onConfirm}>确认执行</Button>
        <Button onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

export function UsersPage({ client, query, navigate, role }: {
  client: AdminClient;
  query: URLSearchParams;
  navigate: (to: string) => void;
  role: string;
}) {
  const pager = useCursorPager({ query, path: '/users', navigate });
  const cursor = pager.cursor;
  const [rowMode, setRowMode] = useState<AccountActionMode>('');
  const [openRow, setOpenRow] = useState('');
  const [rowBusy, setRowBusy] = useState(false);
  const [rowNotice, setRowNotice] = useState('');
  const search = query.get('search') ?? '';
  const roleFilter = query.get('role') ?? '';
  const state = query.get('state') ?? '';
  const protection = query.get('protection') ?? '';
  const quota = query.get('quota') ?? '';
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => { setSearchDraft(search); }, [search]);
  const listParams = readListParams(query, { sort: 'created', dir: 'desc', limit: 25 });
  const { hidden, toggle, reset } = useHiddenColumns('users', OPTIONAL_COLUMNS);
  const [bulk, setBulk] = useState<BulkAction | ''>('');
  const [bulkOutcome, setBulkOutcome] = useState<BulkOutcome>();
  const [bulkBusy, setBulkBusy] = useState(false);

  const list = useResource(() => client.request<{ users: AccountRow[]; nextCursor?: string; sort?: { key: string; direction: string } }>(
    `/users?${listParamsQuery(listParams)}&cursor=${encodeURIComponent(cursor)}${search ? `&search=${encodeURIComponent(search)}` : ''}${roleFilter ? `&role=${roleFilter}` : ''}${state ? `&state=${state}` : ''}${protection ? `&protection=${protection}` : ''}${quota ? `&quota=${quota}` : ''}`,
  ), [cursor, search, roleFilter, state, protection, quota, listParams.sort, listParams.direction, listParams.limit]);

  const rows = list.data?.users ?? [];
  const selection = useRowSelection(rows);

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

  const canManage = (user: AccountRow) => canManageAccount(role, user.role);
  const columns = [
    { key: 'username', header: '登录账号 / 昵称', ...sortHeader('name', '登录账号'), render: (user: AccountRow) => <span><button type="button" style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => navigate(`/users/${user.accountId}`)}>{user.username}</button>{user.displayName && <span style={{ display: 'block', ...muted }}>{user.displayName}</span>}</span> },
    { key: 'role', header: '角色', render: (user: AccountRow) => roleLabel(user.role) },
    { key: 'state', header: '启用状态', render: (user: AccountRow) => user.disabled ? <Badge tone="bad">已禁用</Badge> : <Badge tone="ok">正常</Badge> },
    // The account id is what appears in logs, audit rows and support tickets, but the list only
    // ever showed it as a link target: an operator who needed to quote it had to open the detail
    // page first. The value stays on screen — a column headed 账号 ID that only offers a button
    // labelled the same thing shows nothing to read.
    { key: 'accountId', header: '账号 ID', optional: true, secondary: true, render: (user: AccountRow) => <span style={row}><code style={{ fontSize: 'var(--fs-sm)' }}>{user.accountId}</code><CopyValue value={user.accountId} /></span> },
    { key: 'protection', header: '保护模式', optional: true, render: (user: AccountRow) => user.protectionMode === 'managed' ? '云端托管' : user.protectionMode === 'relay' ? '中继' : '未设置' },
    {
      key: 'quota', header: '容量使用率', ...sortHeader('usage', '容量使用率'), render: (user: AccountRow) => (
        <span>
          <Badge tone={quotaTone(user.quotaState)}>{user.commitQuotaBytes === null ? '无限' : quotaLabel(user.quotaState)}</Badge>{' '}
          <span style={muted}>{bytes(user.commitBytes)} / {quotaLimit(user.commitQuotaBytes)}</span>
        </span>
      ),
    },
    { key: 'created', header: '创建时间', ...sortHeader('created', '创建时间'), optional: true, secondary: true, render: (user: AccountRow) => when(user.createdAt) },
    { key: 'sync', header: '最近成功同步', ...sortHeader('lastSync', '最近成功同步'), optional: true, secondary: true, render: (user: AccountRow) => when(user.lastSyncAt) },
    { key: 'login', header: '最近登录', ...sortHeader('lastLogin', '最近登录'), optional: true, secondary: true, render: (user: AccountRow) => when(user.lastLoginAt) },
    { key: 'devices', header: '有效会话', ...sortHeader('devices', '有效会话'), optional: true, secondary: true, render: (user: AccountRow) => String(user.activeDeviceCount) },
    {
      key: 'actions', header: '操作', render: (user: AccountRow) => (
        <div className="zc-admin-row-actions">
          <Button onClick={() => navigate(`/users/${user.accountId}`)}>详情</Button>
          {/* Reading a ledger is allowed on any account, so this needs no permission check —
              the server refuses only where it holds no key to decrypt with. */}
          <Button onClick={() => navigate(`/preview?username=${encodeURIComponent(user.username)}`)}>预览</Button>
          <details>
            <summary>更多操作</summary>
            <div className="zc-admin-row-menu">
              {([
                ['state', user.disabled ? '启用账号' : '禁用账号'], ['commit', '调整提交配额'],
                ['blob', '调整附件配额'], ['role', '修改角色'], ['sessions', '撤销全部可管理会话'],
              ] as const).map(([mode, label]) => <Button key={mode}
                disabled={rowBusy || (mode === 'commit' || mode === 'blob' ? !canEditAccountQuota(role, user.role) : !canManage(user))}
                onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setRowNotice(''); setRowMode(mode); setOpenRow(user.accountId); }}>{label}</Button>)}
            </div>
          </details>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="用户管理" description="查找账号、预览记账，或直接处理访问与配额。" actions={<><Button onClick={list.reload}>刷新</Button></>} />
      <FilterBar note="筛选条件会写入地址栏；分享或刷新链接会保留当前视图。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <Field label="登录账号、昵称或 accountId">
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
              <option value="">全部</option><option value="managed">云端托管</option><option value="relay">中继</option><option value="none">未设置</option>
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
      </FilterBar>

      <Panel title="用户列表" className="zc-admin-user-records">
        {rowNotice ? <Notice>{rowNotice}</Notice> : null}
        <div style={{ ...row, marginBottom: 8 }}>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} />
          <ColumnPicker columns={columns} hidden={hidden} onToggle={toggle} onReset={reset} />
        </div>
        {selection.selected.length ? (
          <div style={{ ...row, marginBottom: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span style={muted}>已选 {selection.selected.length} 个账号（仅当前页）</span>
            <Select aria-label="批量操作" value={bulk} onChange={(event) => { setBulk(event.target.value as BulkAction | ''); setBulkOutcome(undefined); }}>
              <option value="">批量操作…</option>
              <option value="disable">禁用账号</option>
              <option value="enable">启用账号</option>
              <option value="revoke-sessions">结束全部会话</option>
            </Select>
            <Button onClick={() => selection.clear()}>取消选择</Button>
          </div>
        ) : null}
        {bulk && selection.selected.length ? (
          <BulkConfirm
            action={bulk}
            rows={rows}
            selected={selection.selected}
            canManage={canManage}
            busy={bulkBusy}
            onCancel={() => setBulk('')}
            onConfirm={() => {
              setBulkBusy(true);
              void runBulkAction(client, bulk, rows, selection.selected, canManage).then((outcome) => {
                setBulkOutcome(outcome);
                setBulk('');
                setBulkBusy(false);
                selection.clear();
                list.reload();
              });
            }}
          />
        ) : null}
        {bulkOutcome ? <Notice tone={bulkOutcome.failed.length ? 'warn' : undefined}><span style={{ whiteSpace: 'pre-wrap' }}>{bulkOutcome.lines.join('\n')}</span></Notice> : null}
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={columns}
          hiddenColumns={hidden}
          rows={rows}
          rowKey={(user) => user.accountId}
          activeKey={openRow || undefined}
          selection={{
            selected: selection.selected,
            onToggle: selection.toggle,
            onToggleAll: selection.setAll,
            selectable: canManage,
            reason: (user) => user.role === 'owner' ? '所有者账号不可批量处理' : '你的角色不能管理该账号',
            label: '选择本页可管理的账号',
          }}
          renderExpanded={(user) => (
            <div><Button disabled={rowBusy} onClick={() => setOpenRow('')}>关闭处理面板</Button><AccountActions
              key={user.accountId + rowMode} initialMode={rowMode} hideTriggers
              onBusyChange={setRowBusy}
              client={client}
              target={{
                accountId: user.accountId, username: user.username, role: user.role, revision: user.revision,
                disabled: user.disabled, commitBytes: user.commitBytes, commitQuotaBytes: user.commitQuotaBytes,
                activeDeviceCount: user.activeDeviceCount,
              }}
              canManage={canManage(user)}
              canEditQuota={canEditAccountQuota(role, user.role)}
              onDone={() => { setOpenRow(''); setRowNotice(`${user.username}：操作已完成。`); list.reload(); }}
            /></div>
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
