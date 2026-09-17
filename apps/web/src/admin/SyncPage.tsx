/** Sync diagnostics: every server-visible failure with a reason and a next step. */
import type { AdminClient } from './client.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Panel, Select, TextInput, muted, row, useResource, when } from './ui.js';
import { SYNC_CATEGORIES, type SyncEvent } from './types.js';
import { useState } from 'react';

export function SyncPage({ client, query, navigate }: { client: AdminClient; query: URLSearchParams; navigate: (to: string) => void }) {
  const category = query.get('category') ?? '';
  const outcome = query.get('outcome') ?? '';
  const cursor = query.get('cursor') ?? '';
  const from = query.get('from') ?? '';
  const until = query.get('until') ?? '';
  const [fromDraft, setFromDraft] = useState(from);
  const [untilDraft, setUntilDraft] = useState(until);
  const [cursors, setCursors] = useState<string[]>(['']);

  const list = useResource(() => client.request<{ events: SyncEvent[]; nextCursor?: string; coverage: string }>(
    `/sync-events?limit=50${category ? `&category=${category}` : ''}${outcome ? `&outcome=${outcome}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}${until ? `&until=${encodeURIComponent(until)}` : ''}`,
  ), [category, outcome, cursor, from, until]);

  const update = (patch: Record<string, string | undefined>, keepCursor = false): void => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key); else next.set(key, value);
    }
    if (!keepCursor) next.delete('cursor');
    setCursors(['']);
    navigate(`/sync${next.toString() ? `?${next.toString()}` : ''}`);
  };

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

      <Panel title="筛选">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
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
          <Field label="起始时间（ISO）"><TextInput value={fromDraft} onChange={(event) => setFromDraft(event.target.value)} placeholder="2026-01-01T00:00:00Z" /></Field>
          <Field label="结束时间（ISO）"><TextInput value={untilDraft} onChange={(event) => setUntilDraft(event.target.value)} placeholder="2026-01-02T00:00:00Z" /></Field>
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <Button onClick={() => update({ from: fromDraft, until: untilDraft })}>应用时间范围</Button>
          <Button onClick={() => { setFromDraft(''); setUntilDraft(''); update({ from: undefined, until: undefined, category: undefined, outcome: undefined }); }}>清除筛选</Button>
          <Button onClick={list.reload}>刷新</Button>
        </div>
      </Panel>

      <Panel title="诊断记录">
        <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
        <Notice>{list.data?.coverage ?? '覆盖范围：仅服务端可见的同步结果。'}</Notice>
        <DataTable
          columns={[
            { key: 'at', header: '服务端接收时间', render: (event) => when(event.at) },
            { key: 'account', header: '账号', render: (event) => event.username ?? '暂无数据' },
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
          empty="没有符合条件的诊断记录。"
        />
        <div style={{ ...row, marginTop: 10, justifyContent: 'flex-end' }}>
          <Button disabled={cursors.length <= 1} onClick={() => { const next = cursors.slice(0, -1); setCursors(next); update({ cursor: next.at(-1) || undefined }, true); }}>较新记录</Button>
          <Button disabled={!list.data?.nextCursor} onClick={() => { setCursors((stack) => [...stack, list.data!.nextCursor!]); update({ cursor: list.data!.nextCursor }, true); }}>更早记录</Button>
        </div>
        <p style={muted}>后台不提供“强制重新同步所有用户”这类操作：同步由客户端发起，服务端只记录结果。</p>
      </Panel>
    </>
  );
}
