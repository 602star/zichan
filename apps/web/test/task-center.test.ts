import { describe, expect, it } from 'vitest';
import { buildTaskCenter } from '../src/selectors/task-center.js';
import type { SyncConnection } from '../src/sync-config.js';
import { makeSnapshot } from './fixtures.js';

function syncConnection(patch: Partial<SyncConnection> = {}): SyncConnection {
  return {
    id: 'sync',
    serverRef: 'sync',
    alias: '服务器',
    baseUrl: 'https://example.test',
    activeUrl: 'https://example.test',
    alternateUrls: [],
    sharedUrls: ['https://example.test'],
    deviceUrls: [],
    username: 'me',
    enabled: true,
    status: 'online',
    ...patch,
  };
}

describe('task center', () => {
  it('aggregates due work from schedules, DCA, consumables, backup and sync in priority order', () => {
    const snap = makeSnapshot();
    const base = snap.assets[0]!;
    const fixed = snap.fixedAssets[0]!;
    snap.setting!.asOfDate = '2020-01-01';
    snap.scheduledTransactions = [{
      ...base, id: 'bill', name: '房租', type: 'expense', category: 'housing', amount: '800', assetId: snap.ids.gbp,
      frequency: 'monthly', anchorDate: '2026-03-08', anchorMode: 'calendar_day', timezone: 'Asia/Shanghai',
      autoCreate: false, catchUpPolicy: 'latest', status: 'active',
    }];
    snap.dcaPlans = [{
      ...base, id: 'dca', name: '定投 BTC', targetAssetId: snap.ids.btc, baseCurrencyAssetId: snap.ids.gbp,
      anchorDate: '2026-03-11', anchorMode: 'calendar_day', timezone: 'Asia/Shanghai', frequency: 'monthly',
      plannedAmount: '100', reminderDaysBefore: 3, status: 'active',
    }];
    snap.fixedUsageMetrics = [{
      ...base, id: 'metric', fixedAssetId: fixed.id, name: '页数', unit: 'count', entryMode: 'increment',
      startValue: '0', isPrimary: true, isActive: true,
    }];
    snap.fixedUsageLogs = [{
      ...base, id: 'log', fixedAssetId: fixed.id, metricId: 'metric', date: '2026-03-01', value: '95', entryMode: 'increment',
    }];
    snap.fixedConsumables = [{
      ...base, id: 'ink', fixedAssetId: fixed.id, name: '墨盒', amountBase: '20', cashflowMode: 'record_only',
      purchaseDate: '2026-01-01', usageMetricId: 'metric', installedAtUsage: '0', targetLife: '100',
      reminderAtRemaining: '10', status: 'active',
    }];

    const tasks = buildTaskCenter({
      snap,
      today: '2026-03-10',
      backups: [{ createdAt: '2026-03-01T00:00:00.000Z' }],
      safety: { lastBackupErrorAt: '2026-03-09T00:00:00.000Z', lastBackupError: '磁盘写入失败' },
      syncProfiles: [syncConnection({
        alias: '家庭服务器',
        baseUrl: 'http://localhost:8787',
        activeUrl: 'http://localhost:8787',
        sharedUrls: [],
        deviceUrls: ['http://localhost:8787'],
        status: 'offline',
        lastError: '连接失败',
      })],
    });

    expect(tasks.map((task) => task.kind)).toEqual(expect.arrayContaining(['scheduled', 'dca', 'consumable', 'backup', 'sync']));
    expect(tasks.find((task) => task.kind === 'scheduled')).toMatchObject({ severity: 'danger', detail: expect.stringContaining('逾期 2 天') });
    expect(tasks.find((task) => task.kind === 'dca')).toMatchObject({ dueDate: '2026-03-11', action: 'record_dca' });
    expect(tasks.find((task) => task.kind === 'consumable')?.detail).toContain('5');
    expect(tasks.slice(0, 3).every((task) => task.severity === 'danger')).toBe(true);
  });

  it('does not create stale backup or successful-sync tasks', () => {
    const snap = makeSnapshot();
    const tasks = buildTaskCenter({
      snap,
      today: '2026-03-10',
      backups: [{ createdAt: '2026-03-10T12:00:00.000Z' }],
      safety: { lastBackupErrorAt: '2026-03-09T00:00:00.000Z', lastBackupError: '旧失败' },
      syncProfiles: [syncConnection({ lastError: '登录成功' })],
    });
    expect(tasks.filter((task) => task.kind === 'backup' || task.kind === 'sync')).toEqual([]);
  });

  it('keeps an online synchronization failure visible without duplicating its lifecycle event', () => {
    const snap = makeSnapshot();
    const tasks = buildTaskCenter({
      snap,
      today: '2026-03-10',
      backups: [],
      safety: {},
      syncProfiles: [syncConnection({
        lastError: '附件上传失败',
        lastSyncError: '附件上传失败',
      })],
      lifecycleErrors: ['服务器：附件上传失败'],
    });
    expect(tasks.filter((task) => task.kind === 'sync')).toEqual([
      expect.objectContaining({ title: '服务器同步未完成', detail: '附件上传失败', severity: 'warning' }),
    ]);
  });

  it('keeps a failed remote backup copy actionable after the local archive succeeds', () => {
    const tasks = buildTaskCenter({
      snap: makeSnapshot(),
      today: '2026-03-10',
      backups: [{ createdAt: '2026-03-10T12:00:00.000Z' }],
      safety: {
        lastExternalBackupAt: '2026-03-10T12:00:00.000Z',
        lastExternalBackupErrorAt: '2026-03-10T12:00:01.000Z',
        lastExternalBackupError: 'NAS：磁盘配额不足',
      },
      syncProfiles: [],
    });
    expect(tasks.filter((task) => task.kind === 'backup')).toEqual([
      expect.objectContaining({ title: '最近远端备份失败', detail: 'NAS：磁盘配额不足' }),
    ]);
  });
});
