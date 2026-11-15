import { nextUnhandledScheduleOccurrence } from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import type { ScreenTarget } from '../screen-target.js';

export interface DashboardAgendaItem {
  id: string;
  kind: 'scheduled' | 'repayment';
  title: string;
  date: string;
  days: number;
  status: 'failed' | 'late' | 'today' | 'upcoming';
  statusLabel: string;
  detail: string;
  amount?: string;
  assetId?: string;
  target: ScreenTarget;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Calendar reminder only: a recurring due day does not prove an unpaid balance. */
function nextPaymentDay(day: number, today: string): string {
  const [year, month] = today.split('-').map(Number);
  const inMonth = (offset: number) => {
    const lastDay = new Date(Date.UTC(year!, month! + offset, 0));
    return new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), Math.min(day, lastDay.getUTCDate()))).toISOString().slice(0, 10);
  };
  const date = inMonth(0);
  return date < today ? inMonth(1) : date;
}

/** Pending scheduled entries and credit-card calendar reminders, never payment estimates. */
export function buildDashboardAgenda(snap: Snapshot, today: string): DashboardAgendaItem[] {
  const items: DashboardAgendaItem[] = [];
  for (const schedule of snap.scheduledTransactions.filter((row) => !row.isDeleted && row.status === 'active')) {
    const occurrence = nextUnhandledScheduleOccurrence(schedule, snap.scheduledExecutions);
    if (!occurrence) continue;
    const days = daysBetween(today, occurrence.date);
    if (days > 30) continue;
    const failure = snap.scheduledExecutions.find((row) => !row.isDeleted && row.scheduleId === schedule.id
      && row.occurrenceIndex === occurrence.index && row.status === 'failed');
    const account = snap.accounts.find((row) => row.id === schedule.accountId);
    items.push({
      id: `scheduled:${schedule.id}:${occurrence.index}`, kind: 'scheduled', title: schedule.name,
      date: occurrence.date, days, status: failure ? 'failed' : days < 0 ? 'late' : days === 0 ? 'today' : 'upcoming',
      statusLabel: failure ? '生成失败' : days < 0 ? `计划日已过 ${Math.abs(days)} 天` : days === 0 ? '今日计划' : `${days} 天后`,
      detail: failure ? `${failure.lastError ?? '请检查账单执行记录'} · 未生成流水`
        : `${schedule.autoCreate ? '自动记账' : '待登记'}${account ? ` · ${account.name}` : ''} · ${schedule.type === 'income' ? '定期收入' : schedule.type === 'transfer' ? '定期转账' : '定期账单'}`,
      amount: schedule.amount, assetId: schedule.assetId,
      target: { screen: 'transactions', tab: 'bills' },
    });
  }
  for (const account of snap.accounts.filter((row) => !row.isDeleted && row.isActive && !row.archivedAt && row.kind === 'credit_card')) {
    const day = account.paymentDueDay;
    if (!day || !Number.isInteger(day) || day < 1 || day > 31) continue;
    const date = nextPaymentDay(day, today);
    const days = daysBetween(today, date);
    if (days > 30) continue;
    items.push({
      id: `repayment:${account.id}:${date}`, kind: 'repayment', title: `${account.name} · 还款日`, date, days,
      status: days === 0 ? 'today' : 'upcoming', statusLabel: days === 0 ? '今日还款日' : `${days} 天后`,
      detail: `${account.statementDay ? `账单日每月 ${account.statementDay} 日` : '账单日未设置'} · 日期提醒，应还金额请核对账单`,
      target: { screen: 'transactions', tab: 'accounts', id: account.id },
    });
  }
  return items.sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed')
    || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
