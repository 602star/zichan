import { useSyncExternalStore } from 'react';
import { DEFAULT_CALENDAR_PREFERENCES, parseCalendarPreferences, type CalendarPreferences } from '@zichan/core';
import { accountLocalStorage } from './account-storage.js';

const key = 'zichan.calendar-display.v1';
const eventName = 'zichan:calendar-display';
function read(): string {
  try { return accountLocalStorage.getItem(key) ?? ''; } catch { return ''; }
}
function subscribe(listener: () => void) {
  window.addEventListener(eventName, listener); window.addEventListener('storage', listener);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener('storage', listener); };
}
export function cacheCalendarDisplay(preferences: CalendarPreferences): void {
  const value = JSON.stringify(preferences);
  if (read() === value) return;
  try { accountLocalStorage.setItem(key, value); } catch { /* Display can still use the ledger setting. */ }
  window.dispatchEvent(new Event(eventName));
}
export function useCalendarDisplay(): CalendarPreferences {
  const raw = useSyncExternalStore(subscribe, read, () => '');
  try { return parseCalendarPreferences(raw); } catch { return DEFAULT_CALENDAR_PREFERENCES; }
}
