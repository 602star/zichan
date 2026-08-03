import type { SavedBackup } from './backups.js';
import type { Setting } from '@zichan/core';

const SAFETY_KEY = 'zichan.safety.v1';
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
}

export interface SafetyWarning {
  key: string;
  message: string;
  tone: 'warning' | 'danger';
}

export function readSafetyState(): SafetyState {
  try {
    return parseSafetyState(localStorage.getItem(SAFETY_KEY) ?? '{}');
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

export function safetyStateFromSetting(setting?: Setting): SafetyState {
  return { ...readSafetyState(), ...parseSafetyState(setting?.dataSafetyStateJson) };
}

export function writeSafetyState(patch: Partial<SafetyState>): SafetyState {
  const next = { ...readSafetyState(), ...patch };
  localStorage.setItem(SAFETY_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('zichan:safety-updated'));
  return next;
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
    warnings.push({ key: 'backup-error', message: `最近自动备份失败：${state.lastBackupError ?? '未知错误'}`, tone: 'danger' });
  }
  if (!backups.some((backup) => backup.externalSaved)) {
    warnings.push({ key: 'no-external-backup', message: '还没有独立于主账本存储的备份', tone: 'warning' });
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
