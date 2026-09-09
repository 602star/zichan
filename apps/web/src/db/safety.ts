import { accountLocalStorage } from '../account-storage.js';
import type { SavedBackup } from './backups.js';
import type { Setting } from '@zichan/core';

export const SAFETY_STATE_KEY = 'zichan.safety.v1';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SafetyState {
  lastCheckAt?: string;
  lastCheckCount?: number;
  lastRehearsalAt?: string;
  lastRehearsalOk?: boolean;
  lastRehearsalLabel?: string;
  lastBackupErrorAt?: string;
  lastBackupError?: string;
  lastExternalBackupAt?: string;
  lastExternalBackupErrorAt?: string;
  lastExternalBackupError?: string;
}

export interface SafetyWarning {
  key: string;
  message: string;
  tone: 'warning' | 'danger';
}

const SHARED_SAFETY_KEYS = [
  'lastCheckAt',
  'lastCheckCount',
  'lastRehearsalAt',
  'lastRehearsalOk',
  'lastRehearsalLabel',
] as const satisfies readonly (keyof SafetyState)[];

const DEVICE_SAFETY_KEYS = [
  'lastBackupErrorAt',
  'lastBackupError',
  'lastExternalBackupAt',
  'lastExternalBackupErrorAt',
  'lastExternalBackupError',
] as const satisfies readonly (keyof SafetyState)[];

function pickSafetyState(
  state: SafetyState,
  keys: readonly (keyof SafetyState)[],
): SafetyState {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = state[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked as SafetyState;
}

export function readSafetyState(): SafetyState {
  try {
    return parseSafetyState(accountLocalStorage.getItem(SAFETY_STATE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function parseSafetyState(raw?: string): SafetyState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as SafetyState;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function serializeSafetyState(state: SafetyState): string {
  return JSON.stringify(state);
}

/** Only consistency-check and restore-rehearsal results belong to ledger settings. */
export function serializeSharedSafetyState(state: SafetyState): string {
  return serializeSafetyState(pickSafetyState(state, SHARED_SAFETY_KEYS));
}

export function safetyStateFromStoredJson(raw?: string): SafetyState {
  const local = readSafetyState();
  const stored = parseSafetyState(raw);
  return {
    ...pickSafetyState(local, SHARED_SAFETY_KEYS),
    ...pickSafetyState(stored, SHARED_SAFETY_KEYS),
    ...pickSafetyState(local, DEVICE_SAFETY_KEYS),
  };
}

export function safetyStateFromSetting(setting?: Setting): SafetyState {
  return safetyStateFromStoredJson(setting?.dataSafetyStateJson);
}

export function writeSafetyState(patch: Partial<SafetyState>): SafetyState {
  const next = { ...readSafetyState(), ...patch };
  accountLocalStorage.setItem(SAFETY_STATE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('zichan:safety-updated'));
  return next;
}

/** Translate a completed local archive plus per-server results into durable safety state. */
export function successfulBackupSafetyPatch(entry: SavedBackup, now = Date.now()): Partial<SafetyState> {
  const patch: Partial<SafetyState> = {
    lastBackupErrorAt: undefined,
    lastBackupError: undefined,
  };
  const remoteFailures = (entry.remoteCopies ?? []).filter((copy) => !copy.saved && copy.error);
  if (entry.externalSaved) patch.lastExternalBackupAt = entry.createdAt;
  if (remoteFailures.length) {
    patch.lastExternalBackupErrorAt = new Date(Math.max(
      now,
      (Date.parse(entry.createdAt) || 0) + 1,
    )).toISOString();
    patch.lastExternalBackupError = remoteFailures.map((copy) => `${copy.alias}：${copy.error}`).join('；');
  } else if (entry.externalSaved) {
    patch.lastExternalBackupErrorAt = undefined;
    patch.lastExternalBackupError = undefined;
  }
  return patch;
}

/** Drop backup/check timestamps that describe the ledger being deleted. */
export function clearSafetyState(): void {
  accountLocalStorage?.removeItem(SAFETY_STATE_KEY);
  globalThis.dispatchEvent?.(new CustomEvent('zichan:safety-updated'));
}

export function safetyWarnings(backups: SavedBackup[], state: SafetyState, now = Date.now()): SafetyWarning[] {
  const latestBackup = backups[0];
  const warnings: SafetyWarning[] = [];
  if (!latestBackup) {
    warnings.push({ key: 'no-backup', message: '还没有本地备份', tone: 'danger' });
  } else if (now - Date.parse(latestBackup.createdAt) > DAY_MS) {
    warnings.push({ key: 'backup-stale', message: '最近备份已超过 24 小时', tone: 'warning' });
  }
  if (state.lastBackupErrorAt && (!latestBackup || Date.parse(state.lastBackupErrorAt) > Date.parse(latestBackup.createdAt))) {
    warnings.push({ key: 'backup-error', message: `最近本机备份失败：${state.lastBackupError ?? '未知错误'}`, tone: 'danger' });
  }
  if (state.lastExternalBackupErrorAt
    && (!state.lastExternalBackupAt || state.lastExternalBackupErrorAt >= state.lastExternalBackupAt)) {
    warnings.push({ key: 'external-backup-error', message: `最近远端备份失败：${state.lastExternalBackupError ?? '未知错误'}`, tone: 'danger' });
  }
  if (!backups.some((backup) => backup.externalSaved) && !state.lastExternalBackupAt) {
    warnings.push({ key: 'no-external-backup', message: '尚未成功写入远端或外部目录副本；便携 data/backups 与主数据位于同一目录', tone: 'warning' });
  }
  if (!state.lastCheckAt) {
    warnings.push({ key: 'no-check', message: '还没有运行过数据自检', tone: 'warning' });
  } else if ((state.lastCheckCount ?? 0) > 0) {
    warnings.push({ key: 'check-issues', message: `最近自检发现 ${state.lastCheckCount} 个问题`, tone: 'danger' });
  } else if (now - Date.parse(state.lastCheckAt) > 7 * DAY_MS) {
    warnings.push({ key: 'check-stale', message: '最近自检已超过 7 天', tone: 'warning' });
  }
  if (!state.lastRehearsalAt) {
    warnings.push({ key: 'no-rehearsal', message: '还没有做过恢复演练', tone: 'warning' });
  } else if (!state.lastRehearsalOk) {
    warnings.push({ key: 'rehearsal-failed', message: '最近恢复演练未通过', tone: 'danger' });
  } else if (now - Date.parse(state.lastRehearsalAt) > 7 * DAY_MS) {
    warnings.push({ key: 'rehearsal-stale', message: '最近恢复演练已超过 7 天', tone: 'warning' });
  }
  return warnings;
}
