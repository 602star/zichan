import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAFETY_STATE_KEY,
  safetyStateFromSetting,
  safetyWarnings,
  serializeSharedSafetyState,
  successfulBackupSafetyPatch,
} from '../src/db/safety.js';
import type { SavedBackup } from '../src/db/backups.js';
import type { Setting } from '@zichan/core';

function portableLocalBackup(externalSaved = false): SavedBackup {
  return {
    id: 'backup-local-portable',
    createdAt: '2026-08-28T00:00:00.000Z',
    reason: 'manual',
    label: '便携本地恢复点',
    kind: 'device',
    tier: 'pinned',
    pinned: true,
    container: {} as SavedBackup['container'],
    preflight: {
      ok: true,
      issues: [],
      summary: { entities: 1, chains: 0, steps: 0, byType: {} },
    },
    checksum: 'checksum',
    sizeBytes: 1024,
    localPath: 'D:/portable/data/backups/example.zcbak',
    externalSaved,
  };
}

describe('portable backup safety status', () => {
  const now = Date.parse('2026-08-28T01:00:00.000Z');

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('does not treat data/backups in the portable root as an independent copy', () => {
    const warning = safetyWarnings([portableLocalBackup()], {}, now)
      .find((entry) => entry.key === 'no-external-backup');

    expect(warning?.message).toContain('便携 data/backups 与主数据位于同一目录');
  });

  it('accepts a recorded remote or external-directory backup success', () => {
    expect(safetyWarnings([portableLocalBackup()], {
      lastExternalBackupAt: '2026-08-28T00:30:00.000Z',
    }, now).some((entry) => entry.key === 'no-external-backup')).toBe(false);
    expect(safetyWarnings([portableLocalBackup(true)], {}, now)
      .some((entry) => entry.key === 'no-external-backup')).toBe(false);
  });

  it('persists per-server upload failure after the local portable archive succeeds', () => {
    const backup = portableLocalBackup(true);
    backup.remoteCopies = [
      { profileId: 'home', alias: '家庭服务器', saved: true, archiveId: 'archive' },
      { profileId: 'nas', alias: 'NAS', saved: false, archiveId: 'archive', error: '磁盘配额不足' },
    ];
    const patch = successfulBackupSafetyPatch(backup, now);

    expect(patch).toMatchObject({
      lastExternalBackupAt: backup.createdAt,
      lastExternalBackupError: 'NAS：磁盘配额不足',
    });
    expect(safetyWarnings([backup], patch, now)
      .find((entry) => entry.key === 'external-backup-error')?.message).toContain('NAS：磁盘配额不足');
  });

  it('keeps backup results device-local while sharing check and rehearsal results', () => {
    localStorage.setItem(SAFETY_STATE_KEY, JSON.stringify({
      lastExternalBackupAt: '2026-08-28T00:30:00.000Z',
      lastCheckAt: '2026-08-20T00:00:00.000Z',
    }));
    const setting = {
      dataSafetyStateJson: JSON.stringify({
        lastCheckAt: '2026-08-27T00:00:00.000Z',
        lastRehearsalOk: true,
        lastBackupError: '另一台设备的旧错误',
        lastExternalBackupError: '不应同步的旧错误',
      }),
    } as Setting;

    expect(safetyStateFromSetting(setting)).toEqual({
      lastCheckAt: '2026-08-27T00:00:00.000Z',
      lastRehearsalOk: true,
      lastExternalBackupAt: '2026-08-28T00:30:00.000Z',
    });
    expect(JSON.parse(serializeSharedSafetyState({
      lastCheckAt: '2026-08-27T00:00:00.000Z',
      lastBackupError: '本机错误',
    }))).toEqual({ lastCheckAt: '2026-08-27T00:00:00.000Z' });
  });
});
