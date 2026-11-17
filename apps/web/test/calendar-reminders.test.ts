import { describe, expect, it } from 'vitest';
import type { CalendarEntry, CalendarOccurrenceState } from '@zichan/core';
import { dueCalendarReminders } from '../src/calendar-reminders.js';
const entry: CalendarEntry = { id: 'event', title: '准备材料', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
  kind: 'todo', startDate: '2026-11-16', endDate: '2026-11-16', allDay: false, startTime: '09:00', endTime: '10:00', timezone: 'Asia/Shanghai',
  calendar: 'solar', leapPolicy: 'regular', missingDayPolicy: 'last_day', repeat: 'none', interval: 1, reminderMinutes: [15] };
describe('calendar reminders', () => {
  it('fires at the event timezone and includes a bounded missed reminder on reopening', () => {
    expect(dueCalendarReminders([entry], [], new Date('2026-11-16T00:44:00Z'))).toEqual([]);
    expect(dueCalendarReminders([entry], [], new Date('2026-11-16T00:45:00Z'))).toHaveLength(1);
    expect(dueCalendarReminders([entry], [], new Date('2026-11-18T00:45:00Z'))).toEqual([]);
  });
  it('respects completion, skipping and snoozing', () => {
    const state: CalendarOccurrenceState = { id: 'state', createdAt: '', updatedAt: '', version: 1, isDeleted: false, entryId: entry.id, occurrenceDate: entry.startDate, status: 'completed' };
    const now = new Date('2026-11-16T01:00:00Z');
    expect(dueCalendarReminders([entry], [state], now)).toEqual([]);
    expect(dueCalendarReminders([entry], [{ ...state, status: 'skipped' }], now)).toEqual([]);
    expect(dueCalendarReminders([entry], [{ ...state, status: 'open', snoozedUntil: '2026-11-16T01:10:00Z' }], now)).toEqual([]);
    expect(dueCalendarReminders([entry], [{ ...state, status: 'open', snoozedUntil: '2026-11-16T01:10:00Z' }], new Date('2026-11-16T01:10:00Z'))).toHaveLength(1);
  });
});
