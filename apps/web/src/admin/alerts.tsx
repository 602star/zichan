/**
 * Alert presentation and actions, shared by the overview and the alert history page.
 *
 * These lived inside `OverviewPage.tsx`, which is why the resolved ones had nowhere to be seen:
 * the overview only ever receives the non-resolved items from the snapshot. Keeping the wording,
 * the next step and the write actions here means the history page cannot describe an alert
 * differently from the page that raised it.
 */
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { bytes, when } from './ui.js';
import type { Alert } from './types.js';

/** A silence with an end time in the past no longer applies. */
export function isSilenced(alert: Alert): boolean {
  return Boolean(alert.silencedUntil) && Date.parse(alert.silencedUntil ?? '') > Date.now();
}

export function alertStateLabel(alert: Alert): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (alert.state === 'resolved') return { text: '已恢复', tone: 'ok' };
  if (isSilenced(alert)) return { text: '未恢复 · 通知已暂停', tone: alert.severity === 'critical' ? 'bad' : 'warn' };
  if (alert.state === 'active') return { text: '活动', tone: 'bad' };
  return { text: '持续观察', tone: 'warn' };
}

export function describeAlert(alert: Alert): string {
  const detail = alert.detail ?? {};
  switch (alert.rule) {
    case 'capacity': return `账号 ${String(detail['username'] ?? '')} 的${alert.scope === 'commit' ? '提交' : '附件'}用量接近上限`;
    case 'backup-failure': return '备份失败或校验未通过';
    case 'backup-overdue': {
      const lastSuccess = typeof detail['lastSuccessAt'] === 'string' ? when(detail['lastSuccessAt']) : '从未';
      return `超过 ${String(detail['intervalHours'] ?? '')} 小时没有成功备份（最近成功：${lastSuccess}）`;
    }
    case 'verification-issue': return alert.scope === 'database' ? '数据库校验发现问题' : '附件校验发现问题';
    case 'cleanup-failure': return `附件清理连续失败 ${String(detail['consecutiveFailures'] ?? '')} 次`;
    case 'sync-errors': return `持续出现同步错误（最近 ${String(detail['recentErrors'] ?? '')} 次）`;
    case 'disk-space': return '磁盘剩余空间不足';
    case 'process-memory': {
      const ratio = typeof detail['ratio'] === 'number' ? `，已占上限 ${(detail['ratio'] * 100).toFixed(0)}%` : '';
      return `服务器进程常驻内存 ${bytes(Number(detail['rssBytes'] ?? 0))}${ratio}`;
    }
    case 'process-memory-growth': {
      const window = String(detail['windowMinutes'] ?? '');
      return `常驻内存持续上升：${window} 分钟内增加 ${bytes(Number(detail['growthBytes'] ?? 0))}`;
    }
    case 'event-loop-lag': return `事件循环平均延迟 ${String(detail['meanMs'] ?? '')} 毫秒，请求处理可能被同步任务阻塞`;
    case 'process-cpu': return `服务器进程 CPU 占用 ${String(detail['cpuPercent'] ?? '')}%`;
    case 'database-wal': return `WAL 文件 ${bytes(Number(detail['walBytes'] ?? 0))} 超过配置上限 ${bytes(Number(detail['journalSizeLimitBytes'] ?? 0))}`;
    case 'database-fragmentation': return `数据库有 ${bytes(Number(detail['freelistBytes'] ?? 0))} 空闲页可回收（占比 ${((Number(detail['freelistRatio'] ?? 0)) * 100).toFixed(1)}%）`;
    default: return alert.rule;
  }
}

/**
 * Where to go next. Returned as a label and a path rather than a rendered button, so a caller
 * that is not a router (a plain list row) can still link to it.
 */
export function alertNextStep(alert: Alert): { label: string; to: string } | undefined {
  // Capacity alerts name one account, so the next step is that account's page, not a filtered
  // list the operator would have to pick from by hand.
  if (alert.rule === 'capacity') {
    // The key itself is `capacity:<scope>:<accountId>`, so the fallback works even for a
    // record written before the detail carried the accountId.
    const fromDetail = typeof alert.detail?.['accountId'] === 'string' ? alert.detail['accountId'] : '';
    const accountId = fromDetail || (alert.key.split(':')[2] ?? '');
    return accountId ? { label: '进入该用户详情', to: `/users/${encodeURIComponent(accountId)}` } : { label: '进入用户管理', to: '/users?quota=over' };
  }
  if (alert.rule.startsWith('backup')) return { label: '查看备份', to: '/storage' };
  if (alert.rule === 'verification-issue') return { label: '查看校验任务', to: '/jobs' };
  if (alert.rule === 'cleanup-failure') return { label: '查看清理状态', to: '/storage' };
  if (alert.rule === 'sync-errors') return { label: '查看同步诊断', to: '/sync?outcome=error' };
  if (alert.rule === 'disk-space') return { label: '查看存储', to: '/storage' };
  // Resource and database alerts all live on one page, so every one of them leads there.
  if (alert.rule.startsWith('process-') || alert.rule.startsWith('database-') || alert.rule === 'event-loop-lag') {
    return { label: '查看进程与数据库', to: '/resources' };
  }
  return undefined;
}

export async function acknowledgeAlert(client: AdminClient, alert: Alert): Promise<void> {
  await client.request(`/alerts/${encodeURIComponent(alert.key)}/acknowledge`, {}, { idempotencyKey: adminIdempotencyKey(`ack-${alert.key}`) });
}

export async function silenceAlert(client: AdminClient, alert: Alert, draft: { hours: number; reason: string }): Promise<void> {
  // The reason is part of the request: an unexplained silence is not auditable.
  await client.request(`/alerts/${encodeURIComponent(alert.key)}/silence`, { hours: draft.hours, reason: draft.reason.trim() },
    { idempotencyKey: adminIdempotencyKey(`silence-${alert.key}`) });
}

export async function unsilenceAlert(client: AdminClient, alert: Alert): Promise<void> {
  await client.request(`/alerts/${encodeURIComponent(alert.key)}/unsilence`, {}, { idempotencyKey: adminIdempotencyKey(`unsilence-${alert.key}`) });
}

export const SILENCE_HOURS = [1, 4, 12, 24, 72, 168, 720];
