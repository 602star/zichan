export interface CalendarPreferences {
  showLunar: boolean;
  showFestivals: boolean;
  showHolidays: boolean;
  firstDay: 0 | 1;
  defaultView: 'month' | 'week' | 'day' | 'year' | 'agenda';
}
export const DEFAULT_CALENDAR_PREFERENCES: CalendarPreferences = { showLunar: true, showFestivals: true, showHolidays: true, firstDay: 1, defaultView: 'month' };
export function parseCalendarPreferences(value?: string): CalendarPreferences {
  if (!value) return { ...DEFAULT_CALENDAR_PREFERENCES };
  const raw: unknown = JSON.parse(value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('日历显示设置无效');
  const out = { ...DEFAULT_CALENDAR_PREFERENCES, ...raw };
  if (typeof out.showLunar !== 'boolean' || typeof out.showFestivals !== 'boolean' || typeof out.showHolidays !== 'boolean'
    || ![0, 1].includes(out.firstDay) || !['month', 'week', 'day', 'year', 'agenda'].includes(out.defaultView)) throw new Error('日历显示设置无效');
  return out;
}
