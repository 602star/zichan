/** Registration policy and single-use invitations. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { PageHeader, Badge, Button, ColumnPicker, CopyValue, DataTable, Field, Loading, Notice, Pager, Panel, Select, Stat, TextInput, message, muted, row, useActionError, useCursorPager, useHiddenColumns, useResource, when, canWrite } from './ui.js';
import { PageSizeSelect, listParamsQuery, readListParams, sortableHeader, type SortChoice } from './list-controls.js';
import type { Invite, RegistrationGrowth } from './types.js';
import { TrendChart } from './chart.js';
import type { TrendPoint } from './trend.js';

/** Sortable columns of the invitation list; none of them is the invitation code itself. */
const SORTS: SortChoice[] = [
  { key: 'created', label: '创建时间' },
  { key: 'expires', label: '有效期至' },
  { key: 'state', label: '状态', first: 'asc' },
];

/** Optional columns, listed once so the picker and the table cannot disagree. */
const OPTIONAL_COLUMNS = [
  { key: 'created', header: '创建时间', optional: true },
  { key: 'used', header: '使用者', optional: true },
];

const stateOf = (invite: Invite): { label: string; tone: 'ok' | 'bad' | 'muted' } => {
  if (invite.usedBy) return { label: '已使用', tone: 'muted' };
  if (invite.disabled) return { label: '已撤销', tone: 'bad' };
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return { label: '已过期', tone: 'muted' };
  return { label: '可用', tone: 'ok' };
};

export function InvitesPage({ client, role, query, navigate }: { client: AdminClient; role: string; query: URLSearchParams; navigate: (to: string) => void }) {
  const writable = canWrite(role);
  const state = query.get('state') ?? '';
  const pager = useCursorPager({ query, path: '/invites', navigate });
  const cursor = pager.cursor;
  const listParams = readListParams(query, { sort: 'created', dir: 'desc', limit: 25 });
  const { hidden, toggle, reset } = useHiddenColumns('invites', OPTIONAL_COLUMNS);
  const [days, setDays] = useState('7');
  const range = query.get('growth') ?? '90d';
  const [issued, setIssued] = useState<Invite>();
  const [error, setError] = useState('');
  const actionError = useActionError();

  const mode = useResource(() => client.request<{ mode: string }>('/registration'), []);
  const growth = useResource(() => client.request<RegistrationGrowth>(`/registration/growth?range=${range}`), [range]);
  const invites = useResource(() => client.request<{ invites: Invite[]; nextCursor?: string; sort?: { key: string; direction: string } }>(
    `/invites?${listParamsQuery(listParams)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${state ? `&state=${state}` : ''}`,
  ), [cursor, state, listParams.sort, listParams.direction, listParams.limit]);

  const update = pager.apply;
  // The sort the server actually used, which is not always the one that was asked for.
  const appliedSort = invites.data?.sort ?? { key: listParams.sort, direction: listParams.direction };
  // One spreadable value per column, so the clickable header and the announced sort state cannot
  // drift apart.
  const sortHeader = (key: string, label: string) => sortableHeader(
    SORTS.find((entry) => entry.key === key) ?? { key, label },
    appliedSort.key,
    appliedSort.direction,
    (next) => update({ sort: next.sort, dir: next.dir }),
  );

  const setMode = (value: string): void => {
    actionError.clear();
    void client.request('/registration', { mode: value }, { idempotencyKey: adminIdempotencyKey(`registration-${value}`) })
      .then(() => mode.reload())
      .catch((caught) => actionError.setError(message(caught)));
  };

  return (
    <>
      <PageHeader title="注册与邀请" description="管理注册策略与邀请码，查看邀请使用情况。" actions={<><Button onClick={invites.reload}>刷新</Button></>} />
      <div className="zc-admin-two-column">
      <Panel title="注册策略" note="新服务器默认仅邀请注册。关闭注册时，邀请码也不能注册。">
        <Loading loading={mode.loading} error={mode.error} />
        <div style={{ ...row, alignItems: 'flex-end' }}>
          <Field label="当前策略">
            <Select disabled={role !== 'owner' || !writable} value={mode.data?.mode ?? ''} onChange={(event) => setMode(event.target.value)}>
              <option value="invite">仅邀请</option>
              <option value="open">开放注册</option>
              <option value="closed">关闭注册</option>
            </Select>
          </Field>
          <span style={muted}>生效值直接来自服务器；保存前不会回显未确认的改动。</span>
        </div>
        {mode.data?.mode === 'closed' ? <Notice tone="warn">当前已关闭注册：即使持有邀请码也无法注册。</Notice> : null}
      </Panel>

      <Panel title="生成邀请码">
        <div style={{ ...row, alignItems: 'flex-end' }}>
          <Field label="有效期（1–30 天）"><TextInput value={days} inputMode="numeric" onChange={(event) => setDays(event.target.value)} style={{ width: 90 }} /></Field>
          <Button onClick={() => {
            setError('');
            void client.request<{ invite: Invite }>('/invites', { days: Number(days) }, { idempotencyKey: adminIdempotencyKey('invite-create') })
              .then((result) => { setIssued(result.invite); invites.reload(); })
              .catch((caught) => setError(message(caught)));
          }}>生成一次性邀请码</Button>
        </div>
        {issued ? (
          <Notice tone="warn">
            <span>新邀请码（离开本页后仍可在列表中看到）：<code>{issued.code}</code></span>{' '}
            <CopyValue value={issued.code} />
          </Notice>
        ) : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
      </Panel>

      </div>
      <Panel title="邀请列表">
        <div style={{ ...row, marginBottom: 10 }}>
          <Field label="状态">
            <Select value={state} onChange={(event) => update({ state: event.target.value })}>
              <option value="">全部</option>
              <option value="available">可用</option>
              <option value="used">已使用</option>
              <option value="revoked">已撤销</option>
              <option value="expired">已过期</option>
            </Select>
          </Field>
          <PageSizeSelect value={listParams.limit} onApply={(size) => update({ limit: String(size) })} />
          <ColumnPicker columns={OPTIONAL_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />
        </div>
        <Loading loading={invites.loading} error={invites.error} stale={invites.stale} loadedAt={invites.loadedAt} />
        <DataTable
          columns={[
            { key: 'code', header: '邀请码', render: (invite) => <code style={{ fontSize: 'var(--fs-sm)' }}>{invite.code}</code> },
            { key: 'state', header: '状态', ...sortHeader('state', '状态'), render: (invite) => { const value = stateOf(invite); return <Badge tone={value.tone}>{value.label}</Badge>; } },
            { key: 'created', header: '创建时间', secondary: true, optional: true, ...sortHeader('created', '创建时间'), render: (invite) => when(invite.createdAt) },
            { key: 'expires', header: '有效期至', ...sortHeader('expires', '有效期至'), render: (invite) => when(invite.expiresAt) },
            { key: 'used', header: '使用者', secondary: true, optional: true, render: (invite) => invite.usedBy ?? '—' },
            {
              key: 'actions', header: '操作', render: (invite) => (
                <Button
                  disabled={Boolean(invite.usedBy)}
                  onClick={() => {
                    void client.request(`/invites/${encodeURIComponent(invite.code)}/disable`, { disabled: !invite.disabled }, { idempotencyKey: adminIdempotencyKey(`invite-${invite.code}-${invite.disabled ? 'enable' : 'disable'}`) })
                      .then(() => invites.reload())
                      .catch((caught) => actionError.setError(message(caught)));
                  }}
                >{invite.disabled ? '重新启用' : '撤销'}</Button>
              ),
            },
          ]}
          rows={invites.data?.invites ?? []}
          rowKey={(invite) => invite.code}
          hiddenColumns={hidden}
          empty="还没有邀请码。"
        />
        <Pager
          page={pager.page}
          hasNext={Boolean(invites.data?.nextCursor)}
          hasPrevious={pager.hasPrevious}
          onNext={() => { if (invites.data?.nextCursor) pager.next(invites.data.nextCursor); }}
          onPrevious={pager.previous}
        />
      </Panel>
      <Panel
        title="注册与邀请增长"
        note="新账号按注册时间分桶；「来自邀请」是邀请码里记着这个账号的那部分。没有邀请码的账号不区分开放注册与部署创建的账号——数据里没有这个区别。"
        action={(
          <Field label="范围">
            <Select value={range} onChange={(event) => update({ growth: event.target.value })}>
              <option value="30d">近 30 天</option>
              <option value="90d">近 90 天</option>
              <option value="365d">近一年</option>
              <option value="all">全部</option>
            </Select>
          </Field>
        )}
      >
        <Loading loading={growth.loading} error={growth.error} stale={growth.stale} loadedAt={growth.loadedAt} />
        {growth.data ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              <Stat label="新账号" value={String(growth.data.growth.totals.accounts)} hint={`${growth.data.growth.granularity === 'month' ? '按月' : '按日'}分桶，共 ${growth.data.growth.buckets.length} 个`} />
              <Stat label="其中来自邀请" value={String(growth.data.growth.totals.invited)} />
              <Stat label="无邀请码" value={String(growth.data.growth.totals.uninvited)} hint="开放注册或部署创建" />
              <Stat
                label="邀请码使用率"
                value={growth.data.attribution.totals.issued ? `${Math.round(growth.data.attribution.totals.used / growth.data.attribution.totals.issued * 100)}%` : '—'}
                hint={`累计发出 ${growth.data.attribution.totals.issued}，已用 ${growth.data.attribution.totals.used}`}
              />
            </div>
            <TrendChart
              points={growth.data.growth.buckets.map((bucket): TrendPoint => ({ at: bucket.at, value: bucket.accounts }))}
              label={`新账号趋势，${growth.data.range}`}
              formatValue={(value) => `${value} 个账号`}
              granularityNote={growth.data.granularity === 'month' ? '按自然月' : '按自然日'}
            />
            {growth.data.attribution.batches.length ? (
              <DataTable
                columns={[
                  { key: 'at', header: '发放日期', render: (batch) => batch.at },
                  { key: 'issued', header: '发出', render: (batch) => String(batch.issued) },
                  { key: 'used', header: '已用', render: (batch) => String(batch.used) },
                  {
                    key: 'rate',
                    header: '使用率',
                    secondary: true,
                    render: (batch) => (batch.issued ? `${Math.round(batch.used / batch.issued * 100)}%` : '—'),
                  },
                ]}
                rows={growth.data.attribution.batches.slice(0, 30)}
                rowKey={(batch) => batch.at}
                empty="这个范围内没有发出过邀请码。"
              />
            ) : null}
            <p style={muted}>
              邀请码状态汇总（全部历史）：可用 {growth.data.attribution.totals.available}、已用 {growth.data.attribution.totals.used}、
              已撤销 {growth.data.attribution.totals.revoked}、已过期 {growth.data.attribution.totals.expired}。
              上面按日期列出的是所选范围内发出的批次，最多 30 行。
            </p>
          </>
        ) : null}
      </Panel>

      {actionError.error ? <Notice tone="bad">{actionError.error}</Notice> : null}
    </>
  );
}
