import { assertCalendarEntry, calendarOccurrences, newId, type CalendarEntry, type CalendarOccurrenceState } from '@zichan/core';
import type { SqlLedgerStore } from './repository.js';

export function newCalendarEntry(date: string, timezone: string): CalendarEntry {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false, title: '', kind: 'event',
    startDate: date, endDate: date, allDay: true, timezone, calendar: 'solar', leapPolicy: 'regular', missingDayPolicy: 'last_day',
    repeat: 'none', interval: 1, reminderMinutes: [0] };
}

export async function setCalendarOccurrenceStatus(store: SqlLedgerStore, entryId: string, date: string, status: CalendarOccurrenceState['status'], snoozedUntil?: string): Promise<CalendarOccurrenceState> {
  return store.transaction(async scoped => {
    const entry = await scoped.calendarEntries.get(entryId);
    if (!entry || !calendarOccurrences(entry, date, date).length) throw new Error('该日历事项已变化，请刷新后重试');
    const candidates = await scoped.calendarOccurrenceStates.list({ where: { entryId, occurrenceDate: date }, includeDeleted: true });
    const current = candidates.find(row => !row.isDeleted) ?? candidates[0];
    return scoped.calendarOccurrenceStates.put({ ...(current ?? { id: `calendar-state-${entryId}-${date}`, createdAt: '', updatedAt: '', version: 1 }),
      isDeleted: false, entryId, occurrenceDate: date, status, completedAt: status === 'completed' ? new Date().toISOString() : undefined, snoozedUntil });
  });
}

/** Editing only one repeated occurrence creates an independent item and skips its source atomically. */
export async function saveCalendarEntry(store: SqlLedgerStore, entry: CalendarEntry, replaceOccurrence?: { entryId: string; date: string; version: number }): Promise<CalendarEntry> {
  assertCalendarEntry(entry);
  return store.transaction(async scoped => {
    if (replaceOccurrence) {
      const original = await scoped.calendarEntries.get(replaceOccurrence.entryId);
      if (!original || original.isDeleted || original.version !== replaceOccurrence.version) throw new Error('原重复事项已被修改，请重新打开');
      await setCalendarOccurrenceStatus(scoped, original.id, replaceOccurrence.date, 'skipped');
    }
    return scoped.calendarEntries.put({ ...entry, title: entry.title.trim() });
  });
}
