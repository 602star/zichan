import { describe, expect, it } from 'vitest';
import { assertCalendarEntry, calendarDayInfo, calendarOccurrences, calendarWeekStart, exportCalendarIcs, importCalendarIcs, type CalendarEntry, type CalendarOccurrenceState } from '../src/index.js';

const entry = (patch: Partial<CalendarEntry> = {}): CalendarEntry => ({ id: 'calendar-1', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
  title: '测试安排', kind: 'event', startDate: '2026-01-31', endDate: '2026-01-31', allDay: true, timezone: 'Asia/Shanghai', calendar: 'solar',
  leapPolicy: 'regular', missingDayPolicy: 'last_day', repeat: 'monthly', interval: 1, reminderMinutes: [0], ...patch });

describe('offline calendar dates and recurrence', () => {
  it('keeps a selected Sunday inside its week for either week-start preference', () => {
    expect(calendarWeekStart('2026-11-22', 0)).toBe('2026-11-22');
    expect(calendarWeekStart('2026-11-22', 1)).toBe('2026-11-16');
    expect(calendarWeekStart('2026-11-23', 0)).toBe('2026-11-22');
  });
  it('separates festivals, lunar dates and actual holiday adjustments', () => {
    const spring = calendarDayInfo('2026-02-17');
    expect(spring.festivals).toContain('春节'); expect(spring.lunar).toBe('正月');
    expect(spring.holiday?.off).toBe(true);
    expect(calendarDayInfo('2026-10-10').holiday?.off).toBe(false);
    expect(calendarDayInfo('2030-10-01').festivals).toContain('国庆节');
    expect(calendarDayInfo('2030-10-01').holidayCovered).toBe(false);
    expect(calendarDayInfo('2030-10-01').holiday).toBeUndefined();
  });
  it('keeps monthly anchors stable after short months', () => {
    expect(calendarOccurrences(entry(), '2026-01-01', '2026-04-30').map(o => o.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });
  it('counts real leap-day occurrences when missing years are skipped', () => {
    const birthday = entry({ startDate: '2024-02-29', endDate: '2024-02-29', repeat: 'yearly', missingDayPolicy: 'skip', repeatCount: 2 });
    expect(calendarOccurrences(birthday, '2024-01-01', '2032-12-31').map(o => o.date)).toEqual(['2024-02-29', '2028-02-29']);
  });
  it('converts lunar birthdays each year and handles regular, leap and both months explicitly', () => {
    const birthday = entry({ startDate: '2025-06-25', endDate: '2025-06-25', calendar: 'lunar', repeat: 'yearly', lunarMonth: 6, lunarDay: 1 });
    expect(calendarOccurrences(birthday, '2025-01-01', '2025-12-31').map(o => o.date)).toEqual(['2025-06-25']);
    expect(calendarOccurrences({ ...birthday, leapPolicy: 'both' }, '2025-01-01', '2025-12-31').map(o => o.date)).toEqual(['2025-06-25', '2025-07-25']);
    expect(calendarOccurrences({ ...birthday, leapPolicy: 'leap' }, '2026-01-01', '2026-12-31')).toEqual([]);
    const spring = entry({ startDate: '2026-02-17', endDate: '2026-02-17', calendar: 'lunar', lunarMonth: 1, lunarDay: 1, repeat: 'yearly' });
    expect(calendarOccurrences(spring, '2027-01-01', '2027-12-31')[0]?.date).toBe('2027-02-06');
  });
  it('keeps multi-day occurrences visible across month boundaries and never loses a completed instance', () => {
    const trip = entry({ startDate: '2026-01-30', endDate: '2026-02-02', repeat: 'none' });
    const state: CalendarOccurrenceState = { id: 'state', createdAt: '', updatedAt: '', version: 1, isDeleted: false, entryId: trip.id, occurrenceDate: trip.startDate, status: 'completed' };
    expect(calendarOccurrences(trip, '2026-02-01', '2026-02-28', [state])[0]).toMatchObject({ date: '2026-01-30', endDate: '2026-02-02', completed: true });
    expect(calendarOccurrences(trip, '2026-02-01', '2026-02-28', [{ ...state, status: 'skipped' }])).toEqual([]);
  });
  it('supports several weekly weekdays, bounded counts and repeat-until', () => {
    const weekly = entry({ startDate: '2026-11-11', endDate: '2026-11-11', repeat: 'weekly', weekdays: [1, 3, 5], repeatCount: 4 });
    expect(calendarOccurrences(weekly, '2026-11-01', '2026-11-30').map(o => o.date)).toEqual(['2026-11-11', '2026-11-13', '2026-11-16', '2026-11-18']);
    expect(calendarOccurrences({ ...weekly, untilDate: '2026-11-16' }, '2026-11-01', '2026-11-30')).toHaveLength(3);
  });
  it('validates dates, time order and recurrence before persistence', () => {
    expect(() => assertCalendarEntry(entry({ startDate: '2026-02-30' }))).toThrow();
    expect(() => assertCalendarEntry(entry({ allDay: false, startTime: '12:00', endTime: '11:00' }))).toThrow();
    expect(() => assertCalendarEntry(entry({ repeat: 'weekly', weekdays: [] }))).toThrow();
  });
});

describe('calendar exchange', () => {
  it('round-trips Chinese text, multiline descriptions, lunar rules and reminder offsets', () => {
    const original = entry({ title: '家人生日；一起吃饭', description: '第一行\n第二行, 备注', calendar: 'lunar', lunarMonth: 6, lunarDay: 1, repeat: 'yearly', reminderMinutes: [1440, 0] });
    const text = exportCalendarIcs([original]);
    expect(text.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75)).toBe(true);
    expect(importCalendarIcs(text, 'Asia/Shanghai')[0]).toMatchObject({ title: original.title, description: original.description, calendar: 'lunar', lunarMonth: 6, reminderMinutes: [1440, 0] });
  });
  it('reads exclusive all-day ends and converts UTC into the selected zone', () => {
    const allDay = importCalendarIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:trip\r\nSUMMARY:旅行\r\nDTSTART;VALUE=DATE:20261116\r\nDTEND;VALUE=DATE:20261119\r\nEND:VEVENT\r\nEND:VCALENDAR', 'Asia/Shanghai')[0];
    expect(allDay).toMatchObject({ startDate: '2026-11-16', endDate: '2026-11-18', allDay: true });
    const utc = importCalendarIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:通话\nDTSTART:20261116T160000Z\nDTEND:20261116T170000Z\nEND:VEVENT\nEND:VCALENDAR', 'Asia/Shanghai')[0];
    expect(utc).toMatchObject({ startDate: '2026-11-17', startTime: '00:00', endTime: '01:00' });
  });
  it('rejects unsupported recurrence exceptions instead of silently dropping dates', () => {
    expect(() => importCalendarIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261116\nEXDATE;VALUE=DATE:20261117\nEND:VEVENT\nEND:VCALENDAR', 'Asia/Shanghai')).toThrow(/例外/);
  });
});
