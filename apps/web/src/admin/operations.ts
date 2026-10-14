import type { AccountDetail, Alert, Overview } from './types.js';

export function pendingAlerts(alerts: Alert[]): Alert[] {
  return alerts.filter((alert) => alert.state === 'active' || (alert.state === 'pending' && alert.consecutive > 0)).sort((a, b) =>
    Number(b.state === 'active') - Number(a.state === 'active')
    || Number(b.severity === 'critical') - Number(a.severity === 'critical')
    || a.firstSeenAt.localeCompare(b.firstSeenAt)
    || a.key.localeCompare(b.key));
}

export function overviewStatus(data: (Pick<Overview, 'alerts' | 'recentJobs' | 'maintenance'> & { snapshot: Pick<Overview['snapshot'], 'stale'> }) | undefined, stale: boolean): string {
  if (!data || stale || data.snapshot.stale) return '状态未知';
  if (data.maintenance?.active) return '维护中';
  // Acknowledging or pausing notifications never repairs the underlying condition.
  if (data.alerts.some((alert) => alert.state === 'active')
    || data.recentJobs.some((job) => job.status === 'failed' || job.status === 'interrupted')) return '需要处理';
  if (pendingAlerts(data.alerts).some((alert) => alert.state === 'pending')) return '需要关注';
  return '运行正常';
}

export function userSupport(detail: AccountDetail) {
  const latest = [...detail.sync.recent].sort((a, b) => b.at.localeCompare(a.at))[0];
  const { account, capacity } = detail;
  return {
    latest,
    sync: !latest ? '暂无同步记录' : latest.outcome === 'ok' ? '最近请求成功' : '最近请求失败',
    quotaExceeded: capacity.commitQuotaBytes !== null && capacity.commitBytes >= capacity.commitQuotaBytes
      || capacity.blobQuotaBytes !== null && capacity.blobUsedBytes >= capacity.blobQuotaBytes,
    preview: !account.protection ? '尚未设置账本保护'
        : !capacity.ledgerId ? '尚未绑定远端账本'
          : account.protection.mode === 'managed' ? '托管模式：可申请只读预览，打开时检查服务器凭据'
            : '保护模式未知，请先检查账号配置',
  };
}
