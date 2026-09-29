/**
 * Authentication failures and throttling.
 *
 * Two questions the console could not answer before: "is one address trying many accounts" and
 * "is this address being throttled right now". The run log has the lines but not the shape —
 * it is capped and one line per attempt, so counting is manual. This page aggregates by source
 * address and reads the limiter's own state rather than inferring throttling from failure counts.
 */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { PageHeader, Badge, Button, DataTable, Field, Loading, Notice, Panel, Select, Stat, muted, row, useResource, when } from './ui.js';
import type { AuthFailuresPayload, RateLimitsPayload } from './types.js';

export function SecurityEventsPage({ client }: { client: AdminClient }) {
  const [minFailures, setMinFailures] = useState('1');
  const failures = useResource(() => client.request<AuthFailuresPayload>(`/auth-failures?minFailures=${minFailures}`), [minFailures]);
  const limits = useResource(() => client.request<RateLimitsPayload>('/rate-limits'), []);

  const sources = failures.data?.sources ?? [];
  const buckets = limits.data?.buckets ?? [];
  const active = buckets.filter((bucket) => bucket.blockedUntil);

  return (
    <>
      <PageHeader title="登录安全" description="查看失败登录来源与限流证据。" actions={<><Button onClick={() => { failures.reload(); limits.reload(); }}>刷新</Button></>} />
      <Loading loading={failures.loading || limits.loading} error={failures.error || limits.error}
        stale={failures.stale || limits.stale} loadedAt={failures.loadedAt ?? limits.loadedAt} />

      <Panel title="失败登录来源"
        note={failures.data?.note ?? '按来源地址聚合登录失败。'}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Stat label="失败总次数" value={failures.data ? String(failures.data.total) : '暂无数据'} hint="含低于筛选阈值的来源" />
          <Stat label="来源地址数" value={failures.data ? String(failures.data.sourceCount) : '暂无数据'} />
          <Stat label="当前被限流" value={limits.data ? String(limits.data.active) : '暂无数据'} hint={limits.data ? `共跟踪 ${limits.data.tracked} 个限流桶` : '等待读取限流状态'} />
        </div>
        <div style={{ ...row, marginTop: 10 }}>
          <Field label="至少失败次数">
            <Select value={minFailures} onChange={(event) => setMinFailures(event.target.value)}>
              <option value="1">全部</option>
              <option value="3">3 次以上</option>
              <option value="10">10 次以上</option>
              <option value="50">50 次以上</option>
            </Select>
          </Field>
        </div>
        {!sources.length && !failures.loading ? (
          <Notice>
            这个范围内没有登录失败记录。这里只统计服务端记录到的失败：账号被禁用、第二因子被拒，
            以及到达服务端的密码校验失败；没有来源地址的记录不计入，客户端在本地就判定为密码错误、
            因而没有发出请求的尝试也不会出现在这里。
          </Notice>
        ) : null}
        <DataTable
          columns={[
            { key: 'source', header: '来源地址', render: (source) => source.source },
            { key: 'failures', header: '失败次数', render: (source) => String(source.failures) },
            {
              key: 'accounts', header: '涉及账号', render: (source) => (
                <span>
                  {source.accounts.length ? source.accounts.join('、') : '暂无数据'}
                  {/* More than the page shows: the count is the signal, the names are the evidence. */}
                  {source.accountCount > source.accounts.length ? <span style={muted}> 等 {source.accountCount} 个</span> : null}
                </span>
              ),
            },
            { key: 'first', header: '首次', secondary: true, render: (source) => when(source.firstAt) },
            { key: 'last', header: '最近', render: (source) => when(source.lastAt) },
            {
              key: 'throttled', header: '限流',
              render: (source) => source.throttled ? <Badge tone="bad">正在限流</Badge> : <span style={muted}>未限流</span>,
            },
          ]}
          rows={sources}
          rowKey={(source) => source.source}
          empty="没有符合条件的失败登录记录。"
        />
      </Panel>

      <Panel title="限流桶"
        note={limits.data?.note ?? '限流桶在每次受限请求时写入。'}>
        <p style={muted}>
          限流按来源地址与用途分桶，超过上限的地址在窗口结束前被拒绝。这里只读展示：解封会让正在进行的暴力尝试重新获得配额，
          因此不提供手动按钮。
        </p>
        <DataTable
          columns={[
            { key: 'source', header: '来源地址', render: (bucket) => bucket.source ?? '未知（旧记录）' },
            { key: 'scope', header: '用途', render: (bucket) => bucket.scope ?? '未知（旧记录）' },
            { key: 'hits', header: '窗口内次数', render: (bucket) => String(bucket.hits) },
            { key: 'window', header: '窗口开始', secondary: true, render: (bucket) => when(bucket.windowStartedAt) },
            { key: 'updated', header: '最近更新', render: (bucket) => when(bucket.updatedAt) },
            {
              key: 'blocked', header: '状态',
              render: (bucket) => bucket.blockedUntil
                ? <Badge tone="bad">限流至 {when(bucket.blockedUntil)}</Badge>
                : <Badge tone="muted">未限流</Badge>,
            },
          ]}
          rows={buckets}
          rowKey={(bucket) => bucket.bucketKey}
          empty="还没有限流记录：没有任何地址触发过限流。"
        />
        {active.length ? <p style={muted}>当前有 {active.length} 个桶处于限流状态。</p> : null}
      </Panel>
    </>
  );
}
