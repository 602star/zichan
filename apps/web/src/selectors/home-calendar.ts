import { addDays, calendarOccurrences, dcaOccurrenceDate, daysBetween, listScheduleOccurrences, type CalendarOccurrence, type DcaPlan } from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import type { ScreenTarget } from '../screen-target.js';

export type HomeCalendarSource = 'personal' | 'bills' | 'accounts' | 'assets' | 'dca';
export interface HomeCalendarItem {
  id: string;
  title: string;
  date: string;
  endDate: string;
  time?: string;
  detail: string;
  source: HomeCalendarSource;
  completed: boolean;
  occurrence?: CalendarOccurrence;
  target?: ScreenTarget;
}

function firstIndex(anchor: string, from: string, frequency: string): number {
  if (frequency === 'daily') return Math.max(0, daysBetween(anchor, from) - 1);
  if (frequency === 'weekly') return Math.max(0, Math.floor(daysBetween(anchor, from) / 7) - 1);
  if (frequency === 'yearly') return Math.max(0, Number(from.slice(0, 4)) - Number(anchor.slice(0, 4)) - 1);
  return Math.max(0, (Number(from.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + Number(from.slice(5, 7)) - Number(anchor.slice(5, 7)) - 1);
}

export function buildHomeCalendar(snap: Snapshot, from: string, to: string): HomeCalendarItem[] {
  const out: HomeCalendarItem[] = [];
  for (const entry of snap.calendarEntries ?? []) {
    for (const occurrence of calendarOccurrences(entry, from, to, snap.calendarOccurrenceStates)) {
      out.push({ id: occurrence.id, title: entry.title, date: occurrence.date, endDate: occurrence.endDate,
        time: entry.allDay ? undefined : entry.startTime, detail: [!entry.allDay ? entry.timezone : '', entry.calendar === 'lunar' ? `农历 ${entry.lunarMonth} 月 ${entry.lunarDay} 日` : '', entry.location, entry.description].filter(Boolean).join(' · '),
        source: 'personal', completed: occurrence.completed, occurrence });
    }
  }
  for (const schedule of snap.scheduledTransactions.filter(s => !s.isDeleted && s.status === 'active')) {
    const start = firstIndex(schedule.anchorDate, from, schedule.frequency);
    for (const occurrence of listScheduleOccurrences(schedule, { fromIndex: start, throughDate: to, max: 4000 })) {
      if (occurrence.date < from) continue;
      const execution = snap.scheduledExecutions.find(e => !e.isDeleted && e.scheduleId === schedule.id && e.occurrenceIndex === occurrence.index);
      out.push({ id: `bill:${schedule.id}:${occurrence.index}`, title: schedule.name, date: occurrence.date, endDate: occurrence.date, time: schedule.time,
        detail: `${schedule.amount} ${snap.assets.find(a => a.id === schedule.assetId)?.code ?? ''} · ${execution?.status === 'created' ? '已登记流水' : execution?.status === 'skipped' ? '已处理' : execution?.status === 'failed' ? '生成失败' : '待处理账单'}`,
        source: 'bills', completed: execution?.status === 'created' || execution?.status === 'skipped', target: { screen: 'transactions', tab: 'bills', id: schedule.id } });
    }
  }
  for (const account of snap.accounts.filter(a => !a.isDeleted && a.isActive && !a.archivedAt && a.kind === 'credit_card')) {
    let month = `${from.slice(0, 7)}-01`;
    while (month <= to) {
      for (const [day, label] of [[account.statementDay, '账单日'], [account.paymentDueDay, '还款日']] as const) {
        if (!day) continue;
        const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
        const on = `${month.slice(0, 7)}-${String(Math.min(day, date.getUTCDate())).padStart(2, '0')}`;
        if (on < from || on > to) continue;
        out.push({ id: `account:${account.id}:${label}:${on}`, title: `${account.name} · ${label}`, date: on, endDate: on,
          detail: '账户日期提醒，应还金额和处理状态请核对实际账单', source: 'accounts', completed: false, target: { screen: 'transactions', tab: 'accounts', id: account.id } });
      }
      month = addDays(`${month.slice(0, 7)}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`, 1);
    }
  }
  for (const asset of snap.fixedAssets.filter(a => !a.isDeleted && !a.archivedAt && ['active', 'stored'].includes(a.status))) {
    for (const [date, title] of [[asset.warrantyEndDate, '保修到期'], [asset.returnDeadline, '退货截止'], [asset.priceProtectionDeadline, '价保截止'], [asset.maintenanceDueDate, '保养提醒']] as const) {
      if (!date || date < from || date > to) continue;
      out.push({ id: `asset:${asset.id}:${title}`, title: `${asset.name} · ${title}`, date, endDate: date, detail: '物品日期提醒', source: 'assets', completed: false, target: { screen: 'fixed', id: asset.id } });
    }
  }
  for (const plan of snap.dcaPlans.filter(p => !p.isDeleted && p.status === 'active' && p.frequency !== 'manual')) {
    const first = firstIndex(plan.anchorDate, from, plan.frequency);
    for (let index = first; index < first + 4000; index++) {
      const date = dcaOccurrenceDate(plan as DcaPlan, index); if (date > to) break; if (date < from) continue;
      const execution = snap.dcaExecutions.find(e => !e.isDeleted && e.planId === plan.id && e.occurrenceIndex === index);
      out.push({ id: `dca:${plan.id}:${index}`, title: plan.name, date, endDate: date, detail: `${plan.plannedAmount} · 定投计划`, source: 'dca', completed: !!execution, target: { screen: 'convert', id: plan.id } });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id));
}
