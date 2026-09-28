/**
 * Alert history.
 *
 * The overview only shows alerts that are not resolved, so an alert disappeared the moment it
 * recovered and "how often did the disk alert fire last week" could not be answered. This page
 * reads `GET /alerts?state=resolved` (which the server always supported) and keeps the record
 * readable: first seen, last seen, occurrences, how it ended.
 */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { alertNextStep, alertStateLabel, describeAlert, isSilenced } from './alerts.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Panel, Select, Stat, canWrite, muted, row, useResource, when } from './ui.js';
import type { Alert } from './types.js';

type StateFilter = '' | 'pending' | 'active' | 'resolved';

export function AlertsPage({ client, role, navigate }: { client: AdminClient; role: string; navigate: (to: string) => void }) {
  const [state, setState] = useState<StateFilter>('resolved');
  const list = useResource(() => client.request<{ alerts: Alert[] }>(`/alerts${state ? `?state=${state}` : ''}`), [state]);

  const alerts = list.data?.alerts ?? [];
  const resolved = alerts.filter((alert) => alert.state === 'resolved');
  const active = alerts.filter((alert) => alert.state === 'active');

  return (
    <>
      <h2>告警历史</h2>
      <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />

      <Panel title="筛选" note="告警按规则与影响范围合并；恢复后记录仍然保留，因此可以回看某条告警出现过多少次。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <Field label="状态">
            <Select value={state} onChange={(event) => setState(event.target.value as StateFilter)}>
              <option value="resolved">已恢复</option>
              <option value="active">活动</option>
              <option value="pending">持续观察</option>
              <option value="">全部</option>
            </Select>
          </Field>
          <Stat label="当前显示" value={`${alerts.length} 条`} hint={state ? undefined : `活动 ${active.length} 条，已恢复 ${resolved.length} 条`} />
        </div>
      </Panel>

      <Panel title="告警记录" action={<Button onClick={list.reload}>刷新</Button>}>
        {!alerts.length && !list.loading ? (
          <Notice>
            没有符合条件的告警记录。恢复后的告警会一直留在这里；如果从未产生过告警，这里就是空的。
          </Notice>
        ) : null}
        <DataTable
          columns={[
            {
              key: 'state', header: '状态', render: (alert: Alert) => {
                const label = alertStateLabel(alert);
                return <Badge tone={label.tone}>{label.text}</Badge>;
              },
            },
            { key: 'severity', header: '级别', render: (alert: Alert) => alert.severity === 'critical' ? <Badge tone="bad">严重</Badge> : <Badge tone="warn">警告</Badge> },
            { key: 'rule', header: '规则', render: (alert: Alert) => alert.rule },
            { key: 'scope', header: '影响范围', secondary: true, render: (alert: Alert) => alert.scope },
            { key: 'description', header: '说明', render: (alert: Alert) => describeAlert(alert) },
            { key: 'occurrences', header: '次数', render: (alert: Alert) => String(alert.occurrences) },
            { key: 'first', header: '首次发生', secondary: true, render: (alert: Alert) => when(alert.firstSeenAt) },
            { key: 'last', header: '最近发生', render: (alert: Alert) => when(alert.lastSeenAt) },
            {
              key: 'resolved', header: '恢复时间', secondary: true,
              render: (alert: Alert) => alert.state === 'resolved' ? when(alert.resolvedAt) : '未恢复',
            },
            {
              key: 'ack', header: '知晓记录', secondary: true,
              render: (alert: Alert) => alert.acknowledgedAt
                ? <span style={muted}>{alert.acknowledgedBy ?? ''} · {when(alert.acknowledgedAt)}</span>
                : <span style={muted}>未标记知晓</span>,
            },
            {
              key: 'actions', header: '操作', render: (alert: Alert) => {
                const next = alertNextStep(alert);
                return (
                  <div style={row}>
                    {next ? <Button onClick={() => navigate(next.to)}>{next.label}</Button> : null}
                    {alert.state === 'resolved'
                      // A resolved alert has nothing left to act on; saying so beats a disabled button.
                      ? <span style={muted}>已结束</span>
                      : <span style={muted}>{canWrite(role) ? '在运行概览处理' : '只读运维不可处理'}</span>}
                    {isSilenced(alert) ? <Badge tone="muted">通知暂停至 {when(alert.silencedUntil ?? '')}</Badge> : null}
                  </div>
                );
              },
            },
          ]}
          rows={alerts}
          rowKey={(alert) => alert.key}
          empty="没有符合条件的告警记录。"
        />
      </Panel>
    </>
  );
}
