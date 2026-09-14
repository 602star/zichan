import { addDays, addMonths, endOfMonth, isValidDay, localToday, startOfMonth } from './dates.js';
import { D } from './decimal.js';
import type {
  DcaExecution,
  DcaPlan,
  ScheduledAnchorMode,
  ScheduledExecution,
  ScheduledTransaction,
} from './types.js';

export interface ScheduleOccurrence {
  index: number;
  date: string;
}

export interface ZonedCalendarNow {
  date: string;
  time: string;
}

function monthEndAt(anchor: string, months: number): string {
  return endOfMonth(addMonths(startOfMonth(anchor), months));
}

export interface CalendarRecurrenceRule {
  anchorDate: string;
  anchorMode: ScheduledAnchorMode;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
}

export function assertDcaPlanShape(plan: DcaPlan): void {
  if (!['daily', 'weekly', 'monthly', 'manual'].includes(plan.frequency)) throw new Error(`定投频率无效：${String(plan.frequency)}`);
  if (!['calendar_day', 'month_end'].includes(plan.anchorMode)) throw new Error(`定投月度锚点无效：${String(plan.anchorMode)}`);
  if (!['active', 'paused', 'ended'].includes(plan.status)) throw new Error(`定投状态无效：${String(plan.status)}`);
  if (!isValidDay(plan.anchorDate)) throw new Error('定投计划起始日期无效');
  if (!D(plan.plannedAmount).gt(0)) throw new Error('定投计划金额必须大于 0');
  if (plan.reminderDaysBefore !== undefined
    && (!Number.isSafeInteger(plan.reminderDaysBefore) || plan.reminderDaysBefore < 0)) {
    throw new Error('定投提前提醒天数无效');
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: plan.timezone }).format(new Date());
  } catch {
    throw new Error(`定投计划时区无效：${String(plan.timezone)}`);
  }
}

export function assertDcaExecutionShape(execution: DcaExecution): void {
  if (!Number.isSafeInteger(execution.occurrenceIndex) || execution.occurrenceIndex < 0) throw new Error('定投执行期次无效');
  if (!isValidDay(execution.scheduledDate)) throw new Error('定投计划执行日期无效');
  if (!isValidDay(execution.date)) throw new Error('定投实际执行日期无效');
  if (!D(execution.plannedAmount).gt(0)) throw new Error('定投计划执行金额必须大于 0');
  if (!D(execution.actualBaseCost).gte(0) || !D(execution.finalAmount).gt(0) || !D(execution.totalFeeInBase).gte(0)) {
    throw new Error('定投执行金额无效');
  }
}

export function assertScheduledExecutionShape(execution: ScheduledExecution): void {
  if (!Number.isSafeInteger(execution.occurrenceIndex) || execution.occurrenceIndex < 0) {
    throw new Error('定期交易执行期次无效');
  }
  if (!isValidDay(execution.occurrenceDate)) throw new Error('定期交易执行日期无效');
  if (!['created', 'skipped', 'failed'].includes(execution.status)) {
    throw new Error(`定期交易执行状态无效：${String(execution.status)}`);
  }
  if (execution.status === 'created' && !execution.transactionId) throw new Error('已生成的定期交易缺少流水引用');
  if (execution.status !== 'created' && execution.transactionId) throw new Error('未生成的定期交易不能引用流水');
  if (execution.status === 'failed' && !execution.lastError?.trim()) throw new Error('失败执行缺少错误信息');
  if (execution.retryCount !== undefined
    && (!Number.isSafeInteger(execution.retryCount) || execution.retryCount < 0)) {
    throw new Error('定期交易重试次数无效');
  }
}

export function recurrenceOccurrenceDate(rule: CalendarRecurrenceRule, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('定期交易序号无效');
  if (!isValidDay(rule.anchorDate)) throw new Error('定期交易开始日期无效');
  if (rule.frequency === 'daily') return addDays(rule.anchorDate, index);
  if (rule.frequency === 'weekly') return addDays(rule.anchorDate, index * 7);
  const months = rule.frequency === 'monthly' ? index : index * 12;
  return rule.anchorMode === 'month_end'
    ? monthEndAt(rule.anchorDate, months)
    : addMonths(rule.anchorDate, months);
}

export function scheduleOccurrenceDate(schedule: Pick<ScheduledTransaction, 'anchorDate' | 'anchorMode' | 'frequency'>, index: number): string {
  return recurrenceOccurrenceDate(schedule, index);
}

export function scheduleExecutionId(scheduleId: string, index: number): string {
  return `schedule-execution-${scheduleId}-${index}`;
}

export function scheduledTransactionId(scheduleId: string, index: number): string {
  return `scheduled-transaction-${scheduleId}-${index}`;
}

export function zonedCalendarNow(now: Date, timezone: string): ZonedCalendarNow {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
    const date = `${value('year')}-${value('month')}-${value('day')}`;
    const time = `${value('hour')}:${value('minute')}`;
    if (isValidDay(date) && /^\d{2}:\d{2}$/.test(time)) return { date, time };
  } catch {
    // Invalid time zones fall back to the machine calendar so execution remains available.
  }
  return {
    date: localToday(now),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  };
}

export function scheduleOccurrenceIsDue(schedule: ScheduledTransaction, occurrence: ScheduleOccurrence, now = new Date()): boolean {
  const local = zonedCalendarNow(now, schedule.timezone);
  if (occurrence.date !== local.date) return occurrence.date < local.date;
  return (schedule.time ?? '00:00') <= local.time;
}

export function listScheduleOccurrences(
  schedule: ScheduledTransaction,
  options: { fromIndex?: number; throughDate?: string; max?: number } = {},
): ScheduleOccurrence[] {
  const fromIndex = Math.max(0, options.fromIndex ?? 0);
  const max = Math.max(1, Math.min(options.max ?? 1000, 10_000));
  const rows: ScheduleOccurrence[] = [];
  for (let index = fromIndex; rows.length < max; index += 1) {
    const date = scheduleOccurrenceDate(schedule, index);
    if (schedule.endDate && date > schedule.endDate) break;
    if (options.throughDate && date > options.throughDate) break;
    rows.push({ index, date });
  }
  return rows;
}

export function nextUnhandledScheduleOccurrence(
  schedule: ScheduledTransaction,
  executions: Pick<ScheduledExecution, 'scheduleId' | 'occurrenceIndex' | 'status' | 'isDeleted'>[],
): ScheduleOccurrence | undefined {
  const handled = new Set(executions
    .filter((row) => !row.isDeleted
      && row.scheduleId === schedule.id
      && (row.status === 'created' || row.status === 'skipped'))
    .map((row) => row.occurrenceIndex));
  const maxHandled = handled.size ? Math.max(...handled) : -1;
  const searchLimit = Math.min(Math.max(maxHandled + 2, 64), 10_000);
  // 从 0 找最早未处理期次;handled 稠密时 searchLimit 本身也要被检查,
  // 否则已执行满 searchLimit 期后会错误地返回 undefined(视为"没有待执行期次")。
  for (let index = 0; index <= searchLimit; index += 1) {
    if (handled.has(index)) continue;
    const date = scheduleOccurrenceDate(schedule, index);
    if (schedule.endDate && date > schedule.endDate) return undefined;
    return { index, date };
  }
  throw new Error(`定期交易 ${schedule.name} 的执行记录过多，请缩短有效期`);
}

export function dcaOccurrenceDate(plan: DcaPlan, index: number): string {
  assertDcaPlanShape(plan);
  if (plan.frequency === 'manual') throw new Error('手动定投没有计划期次');
  return recurrenceOccurrenceDate({
    anchorDate: plan.anchorDate,
    anchorMode: plan.anchorMode,
    frequency: plan.frequency,
  }, index);
}

export function nextUnhandledDcaOccurrence(
  plan: DcaPlan,
  executions: Pick<DcaExecution, 'planId' | 'occurrenceIndex' | 'isDeleted'>[],
): ScheduleOccurrence | undefined {
  if (plan.frequency === 'manual') return undefined;
  const handled = new Set(executions
    .filter((row) => !row.isDeleted && row.planId === plan.id)
    .map((row) => row.occurrenceIndex));
  const maxHandled = handled.size ? Math.max(...handled) : -1;
  const searchLimit = Math.min(Math.max(maxHandled + 2, 64), 10_000);
  for (let index = 0; index <= searchLimit; index += 1) {
    if (!handled.has(index)) return { index, date: dcaOccurrenceDate(plan, index) };
  }
  throw new Error(`定投计划 ${plan.name} 的执行记录过多，请归档旧计划`);
}
