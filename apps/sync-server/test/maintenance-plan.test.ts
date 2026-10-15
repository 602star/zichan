import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettings, SETTING_FIELDS } from '../src/settings.js';
import { SyncServerStore } from '../src/store.js';
import { NodeSqliteDriver } from '@zichan/db/node';

/**
 * The maintenance plan is checked across fields: automatic backup without a declared location
 * and window is a schedule nobody can keep, so it is refused at save time and at boot (the
 * deployment values seed fields until an owner saves them in the console).
 */
async function store(): Promise<{ store: SyncServerStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-settings-'));
  const instance = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-settings');
  await instance.ready;
  return { store: instance, dir };
}

describe('maintenance plan settings', () => {
  it('lets a saved value override the deployment value and validates integer storage policies', async () => {
    const { store: instance, dir } = await store();
    try {
      const { settings, load } = createSettings(instance, { COMMIT_QUOTA_BYTES: String(64 * 1024 ** 2) });
      await load();
      expect(settings.resolve(SETTING_FIELDS.find((field) => field.name === 'defaultCommitQuotaBytes')!))
        .toMatchObject({ source: 'env', value: 64 * 1024 ** 2, editable: true });
      await settings.save({ defaultCommitQuotaBytes: 32 * 1024 ** 2 });
      expect(settings.effective('defaultCommitQuotaBytes')).toBe(32 * 1024 ** 2);
      expect(settings.resolve(SETTING_FIELDS.find((field) => field.name === 'defaultCommitQuotaBytes')!))
        .toMatchObject({ source: 'database', editable: true });
      await expect(settings.save({ attachmentMaxFileBytes: 1.5 })).rejects.toThrow(/取值无效/);
      await expect(settings.save({ metricsHourRetentionDays: 0 })).rejects.toThrow(/取值无效/);
    } finally { await instance.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('prunes minute and hourly monitoring records using separate day limits', async () => {
    const { store: instance, dir } = await store();
    const driver = new NodeSqliteDriver(join(dir, 'server.sqlite'));
    try {
      const now = new Date('2026-01-01T00:00:00.000Z');
      const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
      for (const [granularity, days] of [['minute', 3], ['minute', 10], ['hour', 10], ['hour', 150]] as const) {
        await driver.run('INSERT INTO server_metric_buckets (granularity, bucket_at) VALUES (?, ?)', [granularity, at(days)]);
      }
      expect(await instance.pruneMetrics(now, 5, 120)).toEqual({ removed: 2 });
      const rows = await driver.all<{ granularity: string; bucket_at: string }>(
        'SELECT granularity, bucket_at FROM server_metric_buckets ORDER BY granularity, bucket_at');
      expect(rows).toEqual([
        { granularity: 'hour', bucket_at: at(10) },
        { granularity: 'minute', bucket_at: at(3) },
      ]);
    } finally { await driver.close(); await instance.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps legacy free-text schedules readable while refusing newly enabled ambiguous schedules', async () => {
    const { store: instance, dir } = await store();
    try {
      for (const [name, value] of Object.entries({ backupAutoEnabled: 'on', backupDirectory: '/srv/backups', backupWindow: '每周日 凌晨' })) {
        await instance.setMaintenanceState(`setting:${name}`, { value });
      }
      const settings = createSettings(instance, {});
      await expect(settings.load()).resolves.toBeDefined();
      await expect(settings.settings.save({ backupAutoEnabled: 'on' })).rejects.toThrow(/维护窗口格式/);
      await expect(settings.settings.save({ backupAutoEnabled: 'off' })).resolves.toBeDefined();
    } finally { await instance.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('exposes the plan fields with their own text formats', () => {
    const byName = new Map(SETTING_FIELDS.map((field) => [field.name, field]));
    expect(byName.get('backupAutoEnabled')).toMatchObject({ kind: 'select', default: 'off', options: ['off', 'on'] });
    expect(byName.get('backupDirectory')).toMatchObject({ kind: 'text', textFormat: 'free' });
    expect(byName.get('backupWindow')).toMatchObject({ kind: 'text', textFormat: 'free' });
    expect(byName.get('backupRetentionCount')).toMatchObject({ kind: 'number', default: 3, min: 1 });
    // The webhook is still a URL: the format is per field, not per kind.
    expect(byName.get('alertWebhookUrl')).toMatchObject({ kind: 'text', textFormat: 'url' });
  });

  it('refuses to enable automatic backup without a location and a window', async () => {
    const { store: instance, dir } = await store();
    try {
      const { settings } = createSettings(instance, {});
      await expect(settings.save({ backupAutoEnabled: 'on' })).rejects.toThrow(/备份位置/);
      // A location alone is still not a plan.
      await expect(settings.save({ backupDirectory: '/srv/backups', backupAutoEnabled: 'on' })).rejects.toThrow(/维护窗口/);
      await settings.save({ backupDirectory: '/srv/backups', backupWindow: '周日 03:00-04:00' });
      const saved = await settings.save({ backupAutoEnabled: 'on' });
      expect(saved.find((field) => field.name === 'backupAutoEnabled')?.value).toBe('on');
      // Turning it back off never needs the plan.
      expect((await settings.save({ backupAutoEnabled: 'off' })).find((field) => field.name === 'backupAutoEnabled')?.value).toBe('off');
    } finally { await instance.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a path or a window that is not text and keeps free text out of URL rules', async () => {
    const { store: instance, dir } = await store();
    try {
      const { settings } = createSettings(instance, {});
      // Free text: a Windows path and a Chinese window label both pass.
      await settings.save({ backupDirectory: 'D:/zichan/backups', backupWindow: '每周日 凌晨' });
      // The webhook keeps the URL rule.
      await expect(settings.save({ alertWebhookUrl: 'D:/zichan/backups' })).rejects.toThrow();
      await settings.save({ alertWebhookUrl: '' });
      const fields = await settings.save({});
      expect(fields.find((field) => field.name === 'alertWebhookUrl')?.value).toBe('');
    } finally { await instance.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails loudly at boot when the environment enables a plan that cannot run', async () => {
    const { store: instance, dir } = await store();
    try {
      const { settings, load } = createSettings(instance, { ADMIN_BACKUP_AUTO: 'on' });
      await expect(load()).rejects.toThrow(/备份位置/);
      // With the rest of the plan supplied through the environment it loads.
      const complete = createSettings(instance, {
        ADMIN_BACKUP_AUTO: 'on',
        ADMIN_BACKUP_DIRECTORY: '/srv/backups',
        ADMIN_BACKUP_WINDOW: 'Sun 03:00-04:00',
      });
      await expect(complete.load()).resolves.toBeDefined();
      expect(settings.stored).toBeDefined();
    } finally { await instance.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
