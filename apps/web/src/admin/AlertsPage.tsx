/**
 * Alert history.
 *
 * The overview only shows alerts that are not resolved, so an alert disappeared the moment it
 * recovered and "how often did the disk alert fire last week" could not be answered. This page
 * reads `GET /alerts?state=resolved` (which the server always supported) and keeps the record
 * readable: first seen, last seen, occurrences, how it ended.
 */
import { AlertControls } from './AlertControls.js';
import type { AdminClient } from './client.js';
import { alertNextStep, alertStateLabel, describeAlert, isSilenced } from './alerts.js';
import { Badge, Button, DataTable, Loading, Notice, Panel, PageHeader, FilterBar, muted, row, useResource, when } from './ui.js';
import type { Alert } from './types.js';

type StateFilter = '' | 'pending' | 'active' | 'resolved';

export function AlertsPage({ client, role, navigate, query }: { client: AdminClient; role: string; query: URLSearchParams; navigate: (to: string) => void }) {
  const requested = query.get('state') ?? 'resolved';
  const state: StateFilter = ['active', 'pending', 'resolved', ''].includes(requested) ? requested as StateFilter : 'resolved';
  const list = useResource(() => client.request<{ alerts: Alert[] }>(`/alerts${state ? `?state=${state}` : ''}`), [state]);

  const alerts = (list.data?.alerts ?? []).filter((alert) => alert.state !== 'pending' || alert.consecutive > 0);
  const resolved = alerts.filter((alert) => alert.state === 'resolved');
  const active = alerts.filter((alert) => alert.state === 'active');

  return (
    <>
      <PageHeader title="告警历史" description="在当前记录上处理告警；知晓与暂停通知都不代表问题恢复。" actions={<Button onClick={list.reload}>刷新</Button>} />
      <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />

      <FilterBar>
        <div className="zc-admin-view-switch" aria-label="告警状态">
          {([['active', '活动'], ['pending', '持续观察'], ['resolved', '已恢复'], ['', '全部']] as const).map(([value, label]) =>
            <Button key={value} aria-pressed={state === value} onClick={() => navigate('/alerts?state=' + value)}>{label}</Button>)}
          <span style={muted}>{list.data ? '当前显示 ' + alerts.length + ' 条' + (state ? '' : '，活动 ' + active.length + ' 条，已恢复 ' + resolved.length + ' 条') : '正在读取告警'}</span>
        </div>
      </FilterBar>

      <Panel title="告警记录">
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
                    <AlertControls client={client} alert={alert} role={role} onChanged={list.reload} />
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
