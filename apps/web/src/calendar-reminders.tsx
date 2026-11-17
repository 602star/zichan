import { useEffect } from 'react';
import { addDays, calendarOccurrences, normalizeOccurrence, todayIn, type CalendarEntry, type CalendarOccurrenceState } from '@zichan/core';
import { accountLocalStorage } from './account-storage.js';
import { useSnapshot } from './db/snapshot.js';
import { useStore } from './db/store.js';
import { withSharedBrowserTaskLock } from './db/shared-browser-driver.js';
import { sendDeviceNotification } from './device-capabilities.js';

export interface DueCalendarReminder { key: string; title: string; date: string; at: number }
/** Notifications use event-local wall time; state changes never alter financial records. */
export function dueCalendarReminders(entries: readonly CalendarEntry[], states: readonly CalendarOccurrenceState[], now: Date): DueCalendarReminder[] {
  const result: DueCalendarReminder[] = [];
  for (const entry of entries.filter(e => !e.isDeleted && e.reminderMinutes?.length)) {
    const today = todayIn(entry.timezone, now);
    const before = addDays(today, -1);
    const after = addDays(today, Math.ceil(Math.max(...entry.reminderMinutes!) / 1440) + 1);
    const occurrences = calendarOccurrences(entry, before, after, states);
    for (const state of states.filter(s => !s.isDeleted && s.entryId === entry.id && s.snoozedUntil && s.occurrenceDate < before)) {
      occurrences.push(...calendarOccurrences(entry, state.occurrenceDate, state.occurrenceDate, [state]));
    }
    for (const occurrence of occurrences) {
      if (occurrence.completed) continue;
      let starts: number;
      try {
        starts = Date.parse(normalizeOccurrence({ date: occurrence.date, time: entry.allDay ? '09:00' : entry.startTime,
          timezone: entry.timezone, timePrecision: 'minute', timeDisambiguation: 'earlier' }).occurredAtUtc!);
      } catch { continue; }
      const snooze = occurrence.state?.snoozedUntil;
      for (const offset of snooze ? [0] : entry.reminderMinutes!) {
        const at = snooze ? Date.parse(snooze) : starts - offset * 60_000;
        if (at <= now.getTime() && at > now.getTime() - 86400_000) result.push({
          key: `${occurrence.id}:${entry.version}:${snooze || offset}`, title: entry.title, date: occurrence.date, at,
        });
      }
    }
  }
  return result.sort((a, b) => a.at - b.at);
}

export function CalendarReminderDelivery() {
  const snap = useSnapshot('calendar');
  const { preview } = useStore();
  useEffect(() => {
    if (!snap || preview) return;
    let cancelled = false;
    const deliver = async () => {
      if (cancelled || !('Notification' in window) || Notification.permission !== 'granted'
        || accountLocalStorage.getItem('zichan.calendar-notifications.v1') !== 'true') return;
      await withSharedBrowserTaskLock('calendar-notifications', async () => {
        if (cancelled) return;
        const key = 'zichan.calendar-notifications.delivered.v1';
        let delivered: Record<string, number> = {};
        try { delivered = JSON.parse(accountLocalStorage.getItem(key) ?? '{}') as Record<string, number>; } catch { /* Rebuild local delivery metadata. */ }
        const now = new Date();
        for (const [token, at] of Object.entries(delivered)) if (now.getTime() - at > 7 * 86400_000) delete delivered[token];
        const due = dueCalendarReminders(snap.calendarEntries ?? [], snap.calendarOccurrenceStates ?? [], now).filter(item => !delivered[item.key]);
        for (const reminder of due.slice(0, 5)) {
          if (cancelled) break;
          const sent = await sendDeviceNotification('有本 · 日历提醒', `${reminder.title} · ${reminder.date}`);
          if (sent) delivered[reminder.key] = now.getTime();
        }
        accountLocalStorage.setItem(key, JSON.stringify(delivered));
      });
    };
    const check = () => { void deliver().catch(() => { /* In-app calendar remains available when OS delivery fails. */ }); };
    check(); const timer = window.setInterval(check, 30_000);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [snap, preview]);
  return null;
}
