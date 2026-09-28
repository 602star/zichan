import { describe, expect, it } from 'vitest';
import { overviewStatus, pendingAlerts } from '../src/admin/operations.js';
import { alertStateLabel } from '../src/admin/alerts.js';
import { mergeSettingDrafts, settingGroup } from '../src/admin/setting-groups.js';
import type { Alert } from '../src/admin/types.js';

const alert = (key: string, state: Alert['state'], severity: Alert['severity'] = 'warning'): Alert => ({
  key, state, severity, rule: 'backup-failure', scope: 'server', firstSeenAt: '2026-09-28T00:00:00Z',
  lastSeenAt: '2026-09-28T00:00:00Z', occurrences: 2, consecutive: 2,
});

describe('operator decisions', () => {
  it('never calls missing or stale data healthy', () => {
    const data = { snapshot: { stale: false }, alerts: [], recentJobs: [] };
    expect(overviewStatus(undefined, false)).toBe('状态未知');
    expect(overviewStatus(data, true)).toBe('状态未知');
    expect(overviewStatus({ ...data, snapshot: { stale: true } }, false)).toBe('状态未知');
    expect(overviewStatus(data, false)).toBe('运行正常');
  });

  it('keeps paused and acknowledged incidents actionable until recovery', () => {
    const active = { ...alert('active', 'active', 'critical'), silencedUntil: '2099-01-01T00:00:00Z', acknowledgedAt: '2026-09-28T00:01:00Z' };
    expect(overviewStatus({ snapshot: { stale: false }, alerts: [active], recentJobs: [] }, false)).toBe('需要处理');
    expect(alertStateLabel(active).text).toBe('未恢复 · 通知已暂停');
    expect(alertStateLabel({ ...active, state: 'resolved' }).text).toBe('已恢复');
  });

  it('orders active critical incidents first and removes recovered incidents without mutating the input', () => {
    const input = [alert('pending', 'pending', 'critical'), alert('resolved', 'resolved'), alert('warning', 'active'), alert('critical', 'active', 'critical')];
    expect(pendingAlerts(input).map((entry) => entry.key)).toEqual(['critical', 'warning', 'pending']);
    expect(input[0]?.key).toBe('pending');
  });

  it('does not turn unused sampling rules or a cleared pending sample into work', () => {
    const unused = { ...alert('unused', 'pending'), occurrences: 0, consecutive: 0 };
    const cleared = { ...alert('cleared', 'pending'), occurrences: 1, consecutive: 0 };
    expect(pendingAlerts([unused, cleared])).toEqual([]);
    expect(overviewStatus({ snapshot: { stale: false }, alerts: [unused, cleared], recentJobs: [] }, false)).toBe('运行正常');
  });
});

describe('grouped configuration drafts', () => {
  it('refreshes unchanged values and preserves a different group’s unsaved draft', () => {
    expect(mergeSettingDrafts({ backupRetentionCount: '4', logRetention: '6000' },
      { backupRetentionCount: '3', logRetention: '5000' },
      { backupRetentionCount: '4', logRetention: '5000', newSetting: 'on' })).toEqual({ backupRetentionCount: '4', logRetention: '6000', newSetting: 'on' });
    expect(mergeSettingDrafts({ logRetention: '5000' }, { logRetention: '5000' }, { logRetention: '7000' }).logRetention).toBe('7000');
  });

  it('keeps backup retention with the backup plan and unknown extensions accessible under advanced settings', () => {
    expect(settingGroup('backupRetentionCount')).toBe('backup');
    expect(settingGroup('auditFailureRetention')).toBe('retention');
    expect(settingGroup('futureSetting')).toBe('advanced');
  });
});
