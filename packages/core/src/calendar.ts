import { Lunar, LunarYear, Solar } from 'lunar-typescript';
import { addDays, addMonths, daysBetween, isValidDay, parseDay, startOfWeek } from './dates.js';
import type { BaseEntity } from './types.js';
import { HOLIDAY_DAYS, HOLIDAY_YEARS } from './calendar-holidays.js';

export type CalendarKind = 'event' | 'todo' | 'birthday' | 'anniversary' | 'note';
export type CalendarRepeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

export interface CalendarEntry extends BaseEntity {
  title: string;
  kind: CalendarKind;
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime?: string;
  endTime?: string;
  timezone: string;
  location?: string;
  description?: string;
  calendar: 'solar' | 'lunar';
  lunarMonth?: number;
  lunarDay?: number;
  leapPolicy: 'regular' | 'leap' | 'both';
  missingDayPolicy: 'last_day' | 'skip';
  repeat: CalendarRepeat;
  interval: number;
  weekdays?: number[];
  untilDate?: string;
  repeatCount?: number;
  reminderMinutes?: number[];
  transactionIds?: string[];
  sourceUid?: string;
  birthYear?: number;
}

export interface CalendarOccurrenceState extends BaseEntity {
  entryId: string;
  occurrenceDate: string;
  status: 'completed' | 'skipped' | 'open';
  completedAt?: string;
  snoozedUntil?: string;
}

export interface CalendarOccurrence {
  id: string;
  entry: CalendarEntry;
  date: string;
  endDate: string;
  index: number;
  completed: boolean;
  state?: CalendarOccurrenceState;
}

const holidays = new Map(HOLIDAY_DAYS.map(([date, name, off]) => [date, { name, off }]));
const dayCache = new Map<string, CalendarDayInfo>();
export interface CalendarDayInfo {
  date: string;
  lunar: string;
  lunarFull: string;
  lunarMonth?: number;
  lunarDay?: number;
  lunarYear?: number;
  festivals: string[];
  term: string;
  holiday?: { name: string; off: boolean };
  holidayCovered: boolean;
  weekend: boolean;
}

/** All computations use civil dates, never the host machine's UTC offset. */
export function calendarDayInfo(date: string): CalendarDayInfo {
  const cached = dayCache.get(date);
  if (cached) return cached;
  const [year, month, day] = date.split('-').map(Number);
  parseDay(date);
  const supported = year! >= 1901 && year! <= 2099;
  const solar = supported ? Solar.fromYmd(year!, month!, day!) : undefined;
  const lunar = solar?.getLunar();
  const info: CalendarDayInfo = {
    date, lunar: lunar ? lunar.getDay() === 1 ? `${lunar.getMonthInChinese()}月` : lunar.getDayInChinese() : '',
    lunarFull: lunar ? `${lunar.getYear()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}` : '',
    lunarYear: lunar?.getYear(), lunarMonth: lunar?.getMonth(), lunarDay: lunar?.getDay(),
    festivals: [...new Set([...(solar?.getFestivals() ?? []), ...(lunar?.getFestivals() ?? [])])],
    term: lunar?.getJieQi() ?? '', holiday: holidays.get(date),
    holidayCovered: HOLIDAY_YEARS.includes(year!), weekend: [0, 6].includes(new Date(parseDay(date)).getUTCDay()),
  };
  if (dayCache.size > 1500) dayCache.clear();
  dayCache.set(date, info);
  return info;
}

export function assertCalendarEntry(entry: CalendarEntry): void {
  const fail = (message: string): never => { throw new Error(message); };
  if (!entry.title?.trim() || entry.title.length > 200) fail('请填写 1 至 200 字的标题');
  if (!['event', 'todo', 'birthday', 'anniversary', 'note'].includes(entry.kind)) fail('日历事项类型无效');
  if (!isValidDay(entry.startDate) || !isValidDay(entry.endDate) || entry.startDate > entry.endDate) fail('请选择有效且有先后顺序的起止日期');
  if (daysBetween(entry.startDate, entry.endDate) > 366) fail('单个事项最多跨 366 天');
  if (typeof entry.allDay !== 'boolean') fail('全天设置无效');
  if (!entry.allDay && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.startTime ?? '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.endTime ?? ''))) fail('请填写有效的开始和结束时分');
  if (!entry.allDay && entry.startDate === entry.endDate && entry.startTime! >= entry.endTime!) fail('结束时间必须晚于开始时间');
  try { new Intl.DateTimeFormat('en', { timeZone: entry.timezone }).format(); } catch { fail('请选择有效时区'); }
  if (!entry.timezone) fail('请填写时区');
  if (!['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(entry.repeat)) fail('重复方式无效');
  if (!Number.isInteger(entry.interval) || entry.interval < 1 || entry.interval > 999) fail('重复间隔应为 1 至 999');
  if (!['regular', 'leap', 'both'].includes(entry.leapPolicy) || !['last_day', 'skip'].includes(entry.missingDayPolicy)) fail('特殊日期规则无效');
  if (!['solar', 'lunar'].includes(entry.calendar)) fail('历法无效');
  if (entry.calendar === 'lunar') {
    if (entry.repeat !== 'yearly' || !Number.isInteger(entry.lunarMonth) || entry.lunarMonth! < 1 || entry.lunarMonth! > 12
      || !Number.isInteger(entry.lunarDay) || entry.lunarDay! < 1 || entry.lunarDay! > 30) fail('农历事项需要有效的农历月日并按年重复');
    if (entry.startDate < '1901-01-01' || entry.startDate > '2099-12-31') fail('农历日期支持 1901 至 2099 年');
  }
  if (entry.untilDate && (!isValidDay(entry.untilDate) || entry.untilDate < entry.startDate)) fail('重复结束日期不能早于首次日期');
  if (entry.repeatCount !== undefined && (!Number.isInteger(entry.repeatCount) || entry.repeatCount < 1 || entry.repeatCount > 10000)) fail('重复次数应为 1 至 10000');
  if (entry.repeat === 'weekly' && entry.weekdays?.length === 0) fail('每周重复至少选择一天');
  for (const [values, max, name] of [[entry.weekdays, 6, '星期'], [entry.reminderMinutes, 525600, '提醒提前量']] as const) {
    if (values !== undefined && (!Array.isArray(values) || values.length > 14 || values.some((v) => !Number.isInteger(v) || v < 0 || v > max))) fail(`${name}设置无效`);
  }
  if (entry.description && entry.description.length > 20000) fail('说明不能超过 20000 字');
  if (entry.birthYear !== undefined && (!Number.isInteger(entry.birthYear) || entry.birthYear < 1 || entry.birthYear > Number(entry.startDate.slice(0, 4)))) fail('出生年份无效');
  if (entry.location && entry.location.length > 500) fail('地点不能超过 500 字');
  if (entry.transactionIds && (!Array.isArray(entry.transactionIds) || entry.transactionIds.length > 100 || entry.transactionIds.some(id => typeof id !== 'string' || !id))) fail('关联流水无效');
}

function solarYearDay(year: number, month: number, day: number, policy: CalendarEntry['missingDayPolicy']): string | null {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last && policy === 'skip') return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Query a bounded visible range; recurrence is always anchored to the original date. */
export function calendarOccurrences(entry: CalendarEntry, from: string, to: string, states: readonly CalendarOccurrenceState[] = []): CalendarOccurrence[] {
  if (entry.isDeleted) return [];
  assertCalendarEntry(entry);
  if (!isValidDay(from) || !isValidDay(to) || from > to || daysBetween(from, to) > 3700) throw new Error('日历查询范围无效或超过十年');
  const duration = daysBetween(entry.startDate, entry.endDate);
  const lower = addDays(from, -duration);
  const upper = entry.untilDate && entry.untilDate < to ? entry.untilDate : to;
  const byDate = new Map(states.filter(s => !s.isDeleted && s.entryId === entry.id).map(s => [s.occurrenceDate, s]));
  const out: CalendarOccurrence[] = [];
  const push = (date: string | null, index: number) => {
    if (!date || date < entry.startDate || date < lower || date > upper || (entry.repeatCount !== undefined && index >= entry.repeatCount)) return;
    const state = byDate.get(date);
    if (state?.status === 'skipped') return;
    out.push({ id: `${entry.id}:${date}`, entry, date, endDate: addDays(date, duration), index, completed: state?.status === 'completed', state });
  };
  const anchor = entry.startDate;
  const [anchorYear, anchorMonth, anchorDay] = anchor.split('-').map(Number);
  if (entry.repeat === 'none') push(anchor, 0);
  else if (entry.calendar === 'lunar') {
    const first = calendarDayInfo(anchor).lunarYear!;
    let index = 0;
    for (let year = first; year <= Math.min(2099, Number(upper.slice(0, 4))); year++) {
      if ((year - first) % entry.interval) continue;
      const months = LunarYear.fromYear(year);
      const choices = entry.leapPolicy === 'both' ? [entry.lunarMonth!, -entry.lunarMonth!] : [entry.leapPolicy === 'leap' ? -entry.lunarMonth! : entry.lunarMonth!];
      for (const month of choices) {
        const target = months.getMonth(month);
        if (!target || (target.getDayCount() < entry.lunarDay! && entry.missingDayPolicy === 'skip')) continue;
        const date = Lunar.fromYmd(year, month, Math.min(entry.lunarDay!, target.getDayCount())).getSolar().toYmd();
        if (date >= anchor) push(date, index++);
      }
    }
  } else if (entry.repeat === 'daily') {
    const first = Math.max(0, Math.ceil(daysBetween(anchor, lower) / entry.interval));
    for (let index = first; ; index++) { const date = addDays(anchor, index * entry.interval); if (date > upper) break; push(date, index); }
  } else if (entry.repeat === 'weekly' || entry.repeat === 'weekdays') {
    const week = startOfWeek(anchor);
    const mask = entry.repeat === 'weekdays' ? [1, 2, 3, 4, 5] : [...new Set(entry.weekdays?.length ? entry.weekdays : [new Date(parseDay(anchor)).getUTCDay()])];
    const offsets = mask.map(day => (day + 6) % 7).sort((a, b) => a - b);
    const initialCount = offsets.filter(offset => addDays(week, offset) >= anchor).length;
    const interval = entry.repeat === 'weekdays' ? 1 : entry.interval;
    const first = Math.max(0, Math.floor(daysBetween(week, lower) / (7 * interval)));
    for (let cycle = first; ; cycle++) {
      const start = addDays(week, cycle * 7 * interval); if (start > upper) break;
      let index = cycle === 0 ? 0 : initialCount + (cycle - 1) * offsets.length;
      for (const offset of offsets) { const date = addDays(start, offset); if (date < anchor) continue; push(date, index++); }
    }
  } else if (entry.repeat === 'monthly') {
    let index = 0;
    for (let cycle = 0; ; cycle++) {
      const month = addMonths(`${anchor.slice(0, 7)}-01`, cycle * entry.interval);
      if (month > upper) break;
      const target = solarYearDay(Number(month.slice(0, 4)), Number(month.slice(5, 7)), anchorDay!, entry.missingDayPolicy);
      if (target) push(target, index++);
    }
  } else {
    let index = 0;
    for (let cycle = 0; ; cycle++) {
      const year = anchorYear! + cycle * entry.interval; if (year > Number(upper.slice(0, 4))) break;
      const target = solarYearDay(year, anchorMonth!, anchorDay!, entry.missingDayPolicy);
      if (target) push(target, index++);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const CALENDAR_KIND_LABELS: Record<CalendarKind, string> = { event: '日程', todo: '提醒事项', birthday: '生日', anniversary: '纪念日', note: '随记' };
export const CALENDAR_REPEAT_LABELS: Record<CalendarRepeat, string> = { none: '不重复', daily: '每天', weekdays: '工作周（周一至周五）', weekly: '每周', monthly: '每月', yearly: '每年' };

export function calendarWeekStart(date: string, firstDay: 0 | 1): string {
  const offset = (new Date(parseDay(date)).getUTCDay() - firstDay + 7) % 7;
  return addDays(date, -offset);
}

export function lunarCalendarDate(year: number, month: number, day: number, leap = false, missing: 'last_day' | 'skip' = 'last_day'): string | null {
  if (year < 1901 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 30) return null;
  const target = LunarYear.fromYear(year).getMonth(leap ? -month : month);
  if (!target || (missing === 'skip' && target.getDayCount() < day)) return null;
  return Lunar.fromYmd(year, leap ? -month : month, Math.min(day, target.getDayCount())).getSolar().toYmd();
}
