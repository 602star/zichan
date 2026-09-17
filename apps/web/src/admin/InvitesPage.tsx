/** Registration policy and single-use invitations. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Pager, Panel, Select, TextInput, message, muted, row, useCursorPager, useResource, when } from './ui.js';
import type { Invite } from './types.js';

const stateOf = (invite: Invite): { label: string; tone: 'ok' | 'bad' | 'muted' } => {
  if (invite.usedBy) return { label: '已使用', tone: 'muted' };
  if (invite.disabled) return { label: '已撤销', tone: 'bad' };
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return { label: '已过期', tone: 'muted' };
  return { label: '可用', tone: 'ok' };
};

export function InvitesPage({ client, role, query, navigate }: { client: AdminClient; role: string; query: URLSearchParams; navigate: (to: string) => void }) {
  const state = query.get('state') ?? '';
  const pager = useCursorPager({ query, path: '/invites', navigate });
  const cursor = pager.cursor;
  const [days, setDays] = useState('7');
  const [issued, setIssued] = useState<Invite>();
  const [error, setError] = useState('');

  const mode = useResource(() => client.request<{ mode: string }>('/registration'), []);
  const invites = useResource(() => client.request<{ invites: Invite[]; nextCursor?: string }>(
    `/invites?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${state ? `&state=${state}` : ''}`,
  ), [cursor, state]);

  const update = pager.apply;

  const setMode = (value: string): void => {
    void client.request('/registration', { mode: value }, { idempotencyKey: adminIdempotencyKey(`registration-${value}`) })
      .then(() => mode.reload())
      .catch((caught) => window.alert(message(caught)));
  };

  return (
    <>
      <h2>注册与邀请</h2>
      <Panel title="注册策略" note="新服务器默认仅邀请注册。关闭注册时，邀请码也不能注册。">
        <Loading loading={mode.loading} error={mode.error} />
        <div style={{ ...row, alignItems: 'flex-end' }}>
          <Field label="当前策略">
            <Select disabled={role !== 'owner'} value={mode.data?.mode ?? ''} onChange={(event) => setMode(event.target.value)}>
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
            <Button onClick={() => { void navigator.clipboard?.writeText(issued.code); }}>复制</Button>
          </Notice>
        ) : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
      </Panel>

      <Panel title="邀请列表" action={<Button onClick={invites.reload}>刷新</Button>}>
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
        </div>
        <Loading loading={invites.loading} error={invites.error} stale={invites.stale} loadedAt={invites.loadedAt} />
        <DataTable
          columns={[
            { key: 'code', header: '邀请码', render: (invite) => <code style={{ fontSize: 'var(--fs-sm)' }}>{invite.code}</code> },
            { key: 'state', header: '状态', render: (invite) => { const value = stateOf(invite); return <Badge tone={value.tone}>{value.label}</Badge>; } },
            { key: 'created', header: '创建时间', secondary: true, render: (invite) => when(invite.createdAt) },
            { key: 'expires', header: '有效期至', render: (invite) => when(invite.expiresAt) },
            { key: 'used', header: '使用者', secondary: true, render: (invite) => invite.usedBy ?? '—' },
            {
              key: 'actions', header: '操作', render: (invite) => (
                <Button
                  disabled={Boolean(invite.usedBy)}
                  onClick={() => {
                    void client.request(`/invites/${encodeURIComponent(invite.code)}/disable`, { disabled: !invite.disabled }, { idempotencyKey: adminIdempotencyKey(`invite-${invite.code}-${invite.disabled ? 'enable' : 'disable'}`) })
                      .then(() => invites.reload())
                      .catch((caught) => window.alert(message(caught)));
                  }}
                >{invite.disabled ? '重新启用' : '撤销'}</Button>
              ),
            },
          ]}
          rows={invites.data?.invites ?? []}
          rowKey={(invite) => invite.code}
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
    </>
  );
}
