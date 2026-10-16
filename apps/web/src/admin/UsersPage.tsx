/** User management: filters live in the URL so refresh and sharing keep the view. */
import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { AccountActions, type AccountActionMode } from './AccountActions.js';
import { PageHeader, FilterBar, Badge, Button, ColumnPicker, CopyValue, Field, Loading, Notice, Panel, Pager, Select, TextInput, bytes, canEditAccountQuota, canManageAccount, muted, quotaLimit, roleLabel, row, useCursorPager, useHiddenColumns, useResource, useRowSelection, when } from './ui.js';
import { PageSizeSelect, listParamsQuery, readListParams } from './list-controls.js';
import { BULK_LABELS, partitionSelection, runBulkAction, type BulkAction, type BulkOutcome } from './bulk-actions.js';
import type { AccountRow } from './types.js';

/**
 * Optional facts stay in the existing visibility preference when the list switches from a table
 * to cards, so operators do not lose the information choices they already made.
 */
const OPTIONAL_COLUMNS = [
  { key: 'protection', header: '保护模式', optional: true },
  { key: 'created', header: '创建时间', optional: true },
  { key: 'sync', header: '最近成功同步', optional: true },
  { key: 'login', header: '最近登录', optional: true },
  { key: 'devices', header: '有效会话', optional: true },
];

const quotaTone = (state: AccountRow['quotaState']) => state === 'over' ? 'bad' as const : state === 'warning' ? 'warn' as const : 'ok' as const;
const quotaLabel = (state: AccountRow['quotaState']) => state === 'over' ? '已超额' : state === 'warning' ? '接近上限' : '正常';
const protectionLabel = (mode: AccountRow['protectionMode']) => mode === 'managed' ? '云端托管' : mode === 'relay' ? '中继' : '未设置';
const quotaPercent = (user: AccountRow): number | undefined => user.commitQuotaBytes === null
  ? undefined : user.commitQuotaBytes <= 0 ? 100 : Math.min(100, Math.max(0, user.commitBytes / user.commitQuotaBytes * 100));

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
  const canManage = (user: AccountRow) => canManageAccount(role, user.role);
  const selectableKeys = rows.filter(canManage).map((user) => user.accountId);
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selection.selected.includes(key));
  const showActivity = ['protection', 'created', 'sync', 'login', 'devices'].some((key) => !hidden.includes(key));

  return (
    <>
      <PageHeader title="用户管理" description="查找账号，查看容量和近期活动，或处理访问权限与配额。" actions={<><Button onClick={list.reload}>刷新</Button></>} />
      <FilterBar note="筛选条件会写入地址栏；分享或刷新链接会保留当前视图。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <Field label="登录账号、昵称或账号 ID">
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

      <Panel title="用户列表" className="zc-admin-user-records" note="账号卡片按当前排序展示；批量操作只作用于当前页已选账号。">
        {rowNotice ? <Notice>{rowNotice}</Notice> : null}
        <div className="zc-admin-user-toolbar">
          <Field label="排序">
            <Select value={`${appliedSort.key}:${appliedSort.direction}`} onChange={(event) => {
              const [sort, dir] = event.target.value.split(':');
              update({ sort, dir });
            }}>
              <option value="created:desc">创建时间：最新在前</option><option value="created:asc">创建时间：最早在前</option>
              <option value="name:asc">登录账号：正序</option><option value="name:desc">登录账号：倒序</option>
              <option value="lastLogin:desc">最近登录：最新在前</option><option value="lastLogin:asc">最近登录：最早在前</option>
              <option value="lastSync:desc">最近同步：最新在前</option><option value="lastSync:asc">最近同步：最早在前</option>
              <option value="devices:desc">有效会话：多到少</option><option value="devices:asc">有效会话：少到多</option>
              <option value="usage:desc">容量占用：多到少</option><option value="usage:asc">容量占用：少到多</option>
            </Select>
          </Field>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} />
          <ColumnPicker columns={OPTIONAL_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} label="卡片信息" />
          <label className="zc-admin-user-select-all">
            <input type="checkbox" checked={allSelected} disabled={!selectableKeys.length}
              aria-label="选择本页可管理的账号" onChange={() => selection.setAll(allSelected ? [] : selectableKeys)} />
            选择本页可管理账号
          </label>
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
        {rows.length ? <div className={`zc-admin-user-card-grid${rows.some((user) => user.accountId === openRow) ? ' is-editing' : ''}`}>
          {rows.map((user) => {
            const active = openRow === user.accountId;
            const percent = quotaPercent(user);
            const allowed = canManage(user);
            return <article key={user.accountId} className="zc-admin-user-card"
              data-disabled={user.disabled} data-quota={user.quotaState} data-active={active}>
              <div className="zc-admin-user-card-head">
                <label className="zc-admin-user-select">
                  <input type="checkbox" checked={selection.selected.includes(user.accountId)} disabled={!allowed}
                    aria-label={`选择 ${user.username}`} title={!allowed ? user.role === 'owner' ? '所有者账号不可批量处理' : '你的角色不能管理该账号' : undefined}
                    onChange={() => selection.toggle(user.accountId)} />
                </label>
                <div className="zc-admin-user-identity">
                  <button type="button" className="zc-admin-user-name" onClick={() => navigate(`/users/${user.accountId}`)}>{user.username}</button>
                  {user.displayName ? <span>{user.displayName}</span> : null}
                </div>
                <div className="zc-admin-user-badges">
                  <Badge tone="muted">{roleLabel(user.role)}</Badge>
                  <Badge tone={user.disabled ? 'bad' : 'ok'}>{user.disabled ? '已禁用' : '正常'}</Badge>
                </div>
              </div>
              <div className="zc-admin-user-quota">
                <div className="zc-admin-user-quota-top">
                  <span>加密记录容量</span>
                  <Badge tone={quotaTone(user.quotaState)}>{user.commitQuotaBytes === null ? '无限额' : quotaLabel(user.quotaState)}</Badge>
                </div>
                <strong>{bytes(user.commitBytes)} <span>/ {quotaLimit(user.commitQuotaBytes)}</span></strong>
                {percent !== undefined ? <div className="zc-admin-user-meter" role="meter" aria-label={`${user.username} 容量使用率`}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
                  <span style={{ width: `${percent}%` }} />
                </div> : null}
              </div>
              {showActivity ? <dl className="zc-admin-user-facts">
                {!hidden.includes('protection') ? <div><dt>保护模式</dt><dd>{protectionLabel(user.protectionMode)}</dd></div> : null}
                {!hidden.includes('sync') ? <div><dt>最近成功同步</dt><dd>{when(user.lastSyncAt)}</dd></div> : null}
                {!hidden.includes('login') ? <div><dt>最近登录</dt><dd>{when(user.lastLoginAt)}</dd></div> : null}
                {!hidden.includes('devices') ? <div><dt>有效会话</dt><dd>{user.activeDeviceCount}</dd></div> : null}
                {!hidden.includes('created') ? <div><dt>创建时间</dt><dd>{when(user.createdAt)}</dd></div> : null}
              </dl> : null}
              <div className="zc-admin-user-card-footer">
                <div className="zc-admin-user-id"><span>账号 ID</span><code>{user.accountId}</code><CopyValue value={user.accountId} /></div>
                <div className="zc-admin-row-actions">
                  <Button onClick={() => navigate(`/users/${user.accountId}`)}>账号详情</Button>
                  <Button onClick={() => navigate(`/preview?username=${encodeURIComponent(user.username)}`)}>预览账本</Button>
                  <details>
                    <summary>更多操作</summary>
                    <div className="zc-admin-row-menu">
                      {([
                        ['state', user.disabled ? '启用账号' : '禁用账号'], ['commit', '调整提交配额'],
                        ['blob', '调整附件配额'], ['role', '修改角色'], ['sessions', '撤销全部可管理会话'],
                      ] as const).map(([mode, label]) => <Button key={mode}
                        disabled={rowBusy || (mode === 'commit' || mode === 'blob' ? !canEditAccountQuota(role, user.role) : !allowed)}
                        onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setRowNotice(''); setRowMode(mode); setOpenRow(user.accountId); }}>{label}</Button>)}
                    </div>
                  </details>
                </div>
              </div>
              {active ? <div className="zc-admin-user-action-panel">
                <Button disabled={rowBusy} onClick={() => setOpenRow('')}>关闭处理面板</Button>
                <AccountActions key={user.accountId + rowMode} initialMode={rowMode} hideTriggers
                  onBusyChange={setRowBusy} client={client}
                  target={{ accountId: user.accountId, username: user.username, role: user.role, revision: user.revision,
                    disabled: user.disabled, commitBytes: user.commitBytes, commitQuotaBytes: user.commitQuotaBytes,
                    activeDeviceCount: user.activeDeviceCount }}
                  canManage={allowed} canEditQuota={canEditAccountQuota(role, user.role)}
                  onDone={() => { setOpenRow(''); setRowNotice(`${user.username}：操作已完成。`); list.reload(); }} />
              </div> : null}
            </article>;
          })}
        </div> : !list.loading && !list.error ? <p style={muted}>没有符合条件的账号。</p> : null}
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
