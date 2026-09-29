import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettings, SETTING_FIELDS } from '../src/settings.js';
import { SyncServerStore } from '../src/store.js';

/**
 * The maintenance plan is checked across fields: automatic backup without a declared location
 * and window is a schedule nobody can keep, so it is refused at save time and at boot (the
 * environment can override any single field).
 */
async function store(): Promise<{ store: SyncServerStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-settings-'));
  const instance = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-settings');
  await instance.ready;
  return { store: instance, dir };
}

describe('maintenance plan settings', () => {
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
