/** Sessions are the management unit: filter, inspect, and revoke with a reported outcome. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Panel, Pager, Select, TextInput, message, muted, row, useResource, when } from './ui.js';
import type { SessionRow } from './types.js';

export function SessionsPage({ client, query, navigate, selfAccountId }: {
  client: AdminClient;
  query: URLSearchParams;
  navigate: (to: string) => void;
  selfAccountId: string;
}) {
  const search = query.get('search') ?? '';
  const state = query.get('state') ?? '';
  const kind = query.get('kind') ?? '';
  const cursor = query.get('cursor') ?? '';
  const [searchDraft, setSearchDraft] = useState(search);
  const [cursors, setCursors] = useState<string[]>(['']);
  const [report, setReport] = useState('');
  const [busy, setBusy] = useState(false);

  const list = useResource(() => client.request<{ sessions: SessionRow[]; nextCursor?: string; paginationUnit: string; note: string }>(
    `/sessions?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}${state ? `&state=${state}` : ''}${kind ? `&kind=${kind}` : ''}`,
  ), [cursor, search, state, kind]);

  const update = (patch: Record<string, string | undefined>, keepCursor = false): void => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key); else next.set(key, value);
    }
    if (!keepCursor) next.delete('cursor');
    setCursors(['']);
    navigate(`/sessions${next.toString() ? `?${next.toString()}` : ''}`);
  };

  const rows = list.data?.sessions ?? [];
  const currentSessionId = client.currentSessionId();
  const activeCount = rows.filter((session) => session.active).length;
  /**
   * Mirrors the server rules: privileged sessions of other accounts stay protected, the
   * current session ends through logout, and everyone may revoke their own other sessions
   * (which the server only accepts within a recent-login window).
   */
  const revocable = (session: SessionRow): boolean => {
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
          <Button onClick={() => { setSearchDraft(''); update({ search: undefined, state: undefined, kind: undefined }); }}>清除筛选</Button>
          <Button disabled={busy || revocableCount === 0} onClick={() => { void revokeMany(); }}>撤销当前页可撤销的会话</Button>
        </div>
        {report ? <Notice tone="warn"><span style={{ whiteSpace: 'pre-wrap' }}>{report}</span></Notice> : null}
      </Panel>

      <Panel title="会话列表" action={<Button onClick={list.reload}>刷新</Button>}>
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <DataTable
          columns={[
            { key: 'user', header: '用户', render: (session) => session.username },
            { key: 'device', header: '设备名称', render: (session) => session.deviceName },
            { key: 'kind', header: '会话类型', render: (session) => session.kind === 'admin' ? '管理后台' : '记账' },
            { key: 'role', header: '角色', secondary: true, render: (session) => session.role === 'owner' ? '所有者' : session.role === 'admin' ? '管理员' : '普通用户' },
            { key: 'state', header: '状态', render: (session) => <Badge tone={session.revokedAt ? 'bad' : session.active ? 'ok' : 'muted'}>{session.revokedAt ? '已撤销' : session.active ? '有效' : '已过期'}</Badge> },
            { key: 'created', header: '首次登录', secondary: true, render: (session) => when(session.createdAt) },
            { key: 'seen', header: '最近活动', render: (session) => when(session.lastSeenAt) },
            { key: 'expires', header: '到期时间', secondary: true, render: (session) => when(session.expiresAt) },
            { key: 'ip', header: '来源 IP', secondary: true, render: (session) => session.lastIp ?? '暂无数据' },
            {
              key: 'actions', header: '操作', render: (session) => (
                <Button disabled={!revocable(session)} title={session.id === currentSessionId ? '当前会话请用顶部「退出管理后台」结束' : undefined}
                  onClick={() => {
                    void client.request(`/sessions/${session.id}/revoke`, {}, { idempotencyKey: adminIdempotencyKey(`revoke-${session.id}`) })
                      .then(() => list.reload())
                      .catch((error) => window.alert(message(error)));
                  }}>撤销</Button>
              ),
            },
          ]}
          rows={rows}
          rowKey={(session) => session.id}
          empty="没有符合条件的会话。"
        />
        <Pager
          hasNext={Boolean(list.data?.nextCursor)}
          hasPrevious={cursors.length > 1}
          onNext={() => { if (list.data?.nextCursor) { setCursors((stack) => [...stack, list.data!.nextCursor!]); update({ cursor: list.data!.nextCursor }, true); } }}
          onPrevious={() => { const next = cursors.slice(0, -1); setCursors(next); update({ cursor: next.at(-1) || undefined }, true); }}
        />
        <p style={muted}>{list.data?.note ?? ''}</p>
        <p style={muted}>所有者与管理员可以撤销自己账号的其他会话（需要最近 5 分钟内的登录）；当前会话请通过顶部「退出管理后台」结束，避免出现不清楚的登录状态。其他账号的管理员或所有者会话受保护。</p>
      </Panel>
    </>
  );
}
