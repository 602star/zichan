/**
 * Alert history.
 *
 * The overview only shows alerts that are not resolved, so an alert disappeared the moment it
 * recovered and "how often did the disk alert fire last week" could not be answered. This page
 * reads `GET /alerts?state=resolved` (which the server always supported) and keeps the record
 * readable: first seen, last seen, occurrences, how it ended.
 */
import { useState } from 'react';
import { AlertControls } from './AlertControls.js';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { alertNextStep, alertStateLabel, describeAlert, isSilenced } from './alerts.js';
import { Badge, Button, DataTable, Loading, Notice, Panel, PageHeader, FilterBar, muted, row, useResource, when } from './ui.js';
import type { Alert } from './types.js';

type StateFilter = '' | 'pending' | 'active' | 'resolved';

export function AlertsPage({ client, role, navigate, query }: { client: AdminClient; role: string; query: URLSearchParams; navigate: (to: string) => void }) {
  const [testResult, setTestResult] = useState('');
  const [testing, setTesting] = useState(false);
  const requested = query.get('state') ?? 'active';
  const state: StateFilter = ['active', 'pending', 'resolved', ''].includes(requested) ? requested as StateFilter : 'resolved';
  const list = useResource(() => client.request<{ alerts: Alert[] }>(`/alerts${state ? `?state=${state}` : ''}`), [state]);
  const deliveries = useResource(() => client.request<{ data: { deliveries: { id: string; event_key: string; created_at: string; status: string; attempts: number; next_retry_at: string; error_code: string | null }[] } }>('/ops/notifications/deliveries'), []);

  const alerts = (list.data?.alerts ?? []).filter((alert) => alert.state !== 'pending' || alert.consecutive > 0);
  const resolved = alerts.filter((alert) => alert.state === 'resolved');
  const active = alerts.filter((alert) => alert.state === 'active');

  return (
    <>
      <PageHeader title="告警中心" description="在当前记录上处理告警；知晓与暂停通知都不代表问题恢复。" actions={<>
        {role === 'owner' ? <><Button onClick={() => navigate('/settings?group=advanced')}>配置规则阈值</Button><Button onClick={() => navigate('/settings?group=notifications')}>通知渠道</Button>
          <Button disabled={testing} onClick={() => {
            setTesting(true); setTestResult('');
            void client.request<{ state: string; error?: string }>('/alerts/test-notification', {}, { idempotencyKey: adminIdempotencyKey('alert-notification-test') })
              .then((result) => setTestResult(result.state === 'sent' ? result.error ? `通知服务已受理，${result.error}` : '通知服务已受理；Bark 受理不等于手机已展示推送' : result.state === 'skipped' ? '没有启用的通知渠道' : `通知发送失败：${result.error ?? '未知原因'}`))
              .catch((error) => setTestResult(error instanceof Error ? error.message : String(error)))
              .finally(() => setTesting(false));
          }}>测试通知</Button></> : null}
        <Button onClick={() => { list.reload(); deliveries.reload(); }}>刷新</Button>
      </>} />
      {testResult ? <Notice tone={testResult.includes('失败') ? 'bad' : 'info'}>{testResult}</Notice> : null}
      <Loading loading={list.loading} error={list.error} stale={list.stale} loadedAt={list.loadedAt} />
      <FilterBar>
        <div className="zc-admin-view-switch" aria-label="告警状态">
          {([['active', '活动'], ['pending', '持续观察'], ['resolved', '已恢复'], ['', '全部']] as const).map(([value, label]) =>
            <Button key={value} aria-pressed={state === value} onClick={() => navigate('/alerts?state=' + value)}>{label}</Button>)}
          <span style={muted}>{list.data ? '当前显示 ' + alerts.length + ' 条' + (state ? '' : '，活动 ' + active.length + ' 条，已恢复 ' + resolved.length + ' 条') : '正在读取告警'}</span>
        </div>
      </FilterBar>

      <Panel title="告警记录">
        <DataTable
          columns={[
            {
              key: 'state', header: '状态与级别', render: (alert: Alert) => {
                const label = alertStateLabel(alert);
                return (
                  <div style={row}>
                    <Badge tone={label.tone}>{label.text}</Badge>
                    {alert.severity === 'critical' ? <Badge tone="bad">严重</Badge> : <Badge tone="warn">警告</Badge>}
                  </div>
                );
              },
            },
            {
              key: 'rule', header: '规则与范围', render: (alert: Alert) => (
                <div>
                  <div>{alert.rule}</div>
                  {alert.scope ? <small>{alert.scope}</small> : null}
                </div>
              ),
            },
            { key: 'description', header: '说明', render: (alert: Alert) => describeAlert(alert) },
            { key: 'occurrences', header: '次数', render: (alert: Alert) => String(alert.occurrences) },
            {
              key: 'last', header: '发生与恢复', render: (alert: Alert) => (
                <div>
                  <div>最近：{when(alert.lastSeenAt)}</div>
                  <small>首次：{when(alert.firstSeenAt)}</small>
                  {alert.state === 'resolved' ? <small>恢复：{when(alert.resolvedAt)}</small> : null}
                </div>
              ),
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
          empty="没有符合条件的告警记录。恢复后的告警会一直留在这里；如果从未产生过告警，这里就是空的。"
        />
      </Panel>

      <Panel title="通知投递" note="触发与恢复分别持久化，失败最多尝试 5 次，按 1、2、4、8 分钟退避。受理不等于设备已展示。显示最近 100 条，含各渠道汇总结果。">
        <Loading loading={deliveries.loading} error={deliveries.error} stale={deliveries.stale} loadedAt={deliveries.loadedAt} />
        <DataTable rows={deliveries.data?.data.deliveries ?? []} rowKey={(item) => item.id} empty="暂无通知投递记录。" columns={[
          { key: 'at', header: '创建时间', render: (item) => when(item.created_at) },
          { key: 'event', header: '告警', render: (item) => item.event_key },
          { key: 'state', header: '状态', render: (item) => ({ pending: '等待发送', retrying: '等待重试', sent: '服务已受理', failed: '发送失败', skipped: '已跳过' })[item.status] ?? item.status },
          { key: 'attempts', header: '尝试次数', render: (item) => item.attempts },
          { key: 'error', header: '失败或部分失败说明', render: (item) => item.error_code ?? '—' },
        ]} />
      </Panel>
    </>
  );
}
