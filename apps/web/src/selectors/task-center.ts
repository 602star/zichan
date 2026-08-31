import {
  D,
  fixedConsumableRemaining,
  fixedUsageUnitLabel,
  nextUnhandledDcaOccurrence,
  nextUnhandledScheduleOccurrence,
} from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import type { SafetyState } from '../db/safety.js';
import type { SyncConnection } from '../sync-config.js';

export type TaskCenterAction = 'record_dca' | 'open_bills' | 'open_fixed' | 'open_settings' | 'open_sync';
export type TaskCenterSeverity = 'danger' | 'warning' | 'info';

export interface TaskCenterItem {
  id: string;
  kind: 'scheduled' | 'dca' | 'consumable' | 'backup' | 'sync';
  severity: TaskCenterSeverity;
  title: string;
  detail: string;
  dueDate?: string;
  action: TaskCenterAction;
  actionLabel: string;
  dcaPlanId?: string;
}

export interface TaskCenterInput {
  snap: Snapshot;
  today: string;
  backups: Pick<{ createdAt: string }, 'createdAt'>[];
  safety: SafetyState;
  syncProfiles: SyncConnection[];
  lifecycleErrors?: string[];
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000);
}

function dueLabel(days: number): string {
  if (days < 0) return `逾期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天到期';
  return `${days} 天后到期`;
}

const severityOrder: Record<TaskCenterSeverity, number> = { danger: 0, warning: 1, info: 2 };

export function buildTaskCenter(input: TaskCenterInput): TaskCenterItem[] {
  const { snap, today } = input;
  const items: TaskCenterItem[] = [];
  const assetCode = (id: string) => snap.assets.find((asset) => asset.id === id)?.code ?? id;

  for (const schedule of snap.scheduledTransactions.filter((row) => !row.isDeleted && row.status === 'active')) {
    const occurrence = nextUnhandledScheduleOccurrence(schedule, snap.scheduledExecutions);
    if (!occurrence) continue;
    const days = daysBetween(today, occurrence.date);
    const failed = snap.scheduledExecutions.find((execution) => !execution.isDeleted
      && execution.scheduleId === schedule.id
      && execution.occurrenceIndex === occurrence.index
      && execution.status === 'failed');
    if (!failed && days > 7) continue;
    items.push({
      id: `scheduled:${schedule.id}:${occurrence.index}`,
      kind: 'scheduled',
      severity: failed || days < 0 ? 'danger' : 'warning',
      title: schedule.name,
      detail: failed
        ? `自动生成失败：${failed.lastError ?? '未知错误'} · ${occurrence.date}`
        : `${dueLabel(days)} · ${schedule.amount} ${assetCode(schedule.assetId)}`,
      dueDate: occurrence.date,
      action: 'open_bills',
      actionLabel: failed ? '处理失败' : '查看账单',
    });
  }

  for (const plan of snap.dcaPlans.filter((row) => !row.isDeleted && row.status === 'active')) {
    if (plan.frequency === 'manual') {
      items.push({
        id: `dca:${plan.id}:manual`,
        kind: 'dca',
        severity: 'info',
        title: plan.name,
        detail: `手动计划 · ${plan.plannedAmount} ${assetCode(plan.baseCurrencyAssetId)} → ${assetCode(plan.targetAssetId)}`,
        action: 'record_dca',
        actionLabel: '记录一次',
        dcaPlanId: plan.id,
      });
      continue;
    }
    const occurrence = nextUnhandledDcaOccurrence(plan, snap.dcaExecutions);
    if (!occurrence) continue;
    const days = daysBetween(today, occurrence.date);
    if (days > (plan.reminderDaysBefore ?? 3)) continue;
    items.push({
      id: `dca:${plan.id}:${occurrence.index}`,
      kind: 'dca',
      severity: days < 0 ? 'danger' : 'warning',
      title: plan.name,
      detail: `${dueLabel(days)} · ${plan.plannedAmount} ${assetCode(plan.baseCurrencyAssetId)} → ${assetCode(plan.targetAssetId)}`,
      dueDate: occurrence.date,
      action: 'record_dca',
      actionLabel: '记录本期',
      dcaPlanId: plan.id,
    });
  }

  for (const consumable of snap.fixedConsumables.filter((row) => !row.isDeleted && row.status === 'active')) {
    const remaining = fixedConsumableRemaining(consumable, snap.fixedUsageMetrics, snap.fixedUsageLogs);
    if (remaining === undefined || D(remaining).gt(consumable.reminderAtRemaining ?? 0)) continue;
    const asset = snap.fixedAssets.find((row) => row.id === consumable.fixedAssetId);
    const metric = snap.fixedUsageMetrics.find((row) => row.id === consumable.usageMetricId);
    items.push({
      id: `consumable:${consumable.id}`,
      kind: 'consumable',
      severity: D(remaining).lte(0) ? 'danger' : 'warning',
      title: `${asset?.name ?? '物品资产'} · ${consumable.name}`,
      detail: `预计剩余 ${remaining}${metric ? ` ${fixedUsageUnitLabel(metric)}` : ''}`,
      action: 'open_fixed',
      actionLabel: '处理耗材',
    });
  }

  const latestBackupAt = input.backups.reduce(
    (latest, backup) => backup.createdAt > latest ? backup.createdAt : latest,
    '',
  );
  if (input.safety.lastBackupErrorAt && input.safety.lastBackupErrorAt > latestBackupAt) {
    items.push({
      id: 'backup:last-error',
      kind: 'backup',
      severity: 'danger',
      title: '最近本机备份失败',
      detail: input.safety.lastBackupError ?? '未知错误',
      action: 'open_settings',
      actionLabel: '检查备份',
    });
  }
  if (input.safety.lastExternalBackupErrorAt
    && (!input.safety.lastExternalBackupAt
      || input.safety.lastExternalBackupErrorAt >= input.safety.lastExternalBackupAt)) {
    items.push({
      id: 'backup:last-external-error',
      kind: 'backup',
      severity: 'danger',
      title: '最近远端备份失败',
      detail: input.safety.lastExternalBackupError ?? '未知错误',
      action: 'open_settings',
      actionLabel: '检查副本',
    });
  }

  const persistentSyncErrors: string[] = [];
  for (const profile of input.syncProfiles.filter((row) => row.enabled
    && (row.status === 'offline' || row.status === 'login_required'))) {
    const detail = profile.lastSyncError || profile.lastError || '请检查服务器与账号配置';
    persistentSyncErrors.push(detail);
    items.push({
      id: `sync:${profile.id}`,
      kind: 'sync',
      severity: 'danger',
      title: `${profile.alias}同步${profile.status === 'login_required' ? '认证失败' : '离线'}`,
      detail,
      action: 'open_sync',
      actionLabel: '检查同步',
    });
  }
  for (const profile of input.syncProfiles.filter((row) => row.enabled
    && row.status === 'online' && row.lastSyncError)) {
    persistentSyncErrors.push(profile.lastSyncError!);
    items.push({
      id: `sync:${profile.id}:data`,
      kind: 'sync',
      severity: 'warning',
      title: `${profile.alias}同步未完成`,
      detail: profile.lastSyncError!,
      action: 'open_sync',
      actionLabel: '继续同步',
    });
  }
  const lifecycleErrors = (input.lifecycleErrors ?? []).filter((error) => !persistentSyncErrors.some(
    (persistent) => error.includes(persistent) || persistent.includes(error),
  ));
  if (lifecycleErrors.length) {
    items.push({
      id: 'sync:lifecycle',
      kind: 'sync',
      severity: 'danger',
      title: '最近自动同步未完成',
      detail: lifecycleErrors.slice(0, 3).join('；'),
      action: 'open_sync',
      actionLabel: '查看同步',
    });
  }

  return items.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]
    || (left.dueDate ?? '9999-12-31').localeCompare(right.dueDate ?? '9999-12-31')
    || left.title.localeCompare(right.title, 'zh-CN'));
}
