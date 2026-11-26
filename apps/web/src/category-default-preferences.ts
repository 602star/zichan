import { useSyncExternalStore } from 'react';
import { accountLocalStorage, accountStorageKey } from './account-storage.js';
import { DEFAULT_CATEGORY_PREFERENCES, timeMinutes, type CategoryDefaultPreferences } from './category-defaults.js';

const KEY = 'zichan.category-defaults.v1';
const EVENT = 'zichan:category-defaults-changed';
let cachedRaw: string | null | undefined;
let cachedScope = '';
let cached = DEFAULT_CATEGORY_PREFERENCES;

export function readCategoryDefaultPreferences(): CategoryDefaultPreferences {
  let raw: string | null = null;
  try { raw = accountLocalStorage.getItem(KEY); } catch { /* Defaults remain available when storage is blocked. */ }
  const scope = accountStorageKey(KEY);
  if (cachedRaw === raw && cachedScope === scope) return cached;
  cachedRaw = raw; cachedScope = scope;
  cached = DEFAULT_CATEGORY_PREFERENCES;
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<CategoryDefaultPreferences> | null;
    if (value && typeof value.enabled === 'boolean' && typeof value.fixedCategory === 'string' && Array.isArray(value.rules)) {
      cached = { enabled: value.enabled, fixedCategory: value.fixedCategory, rules: value.rules.filter((row) => row && typeof row.id === 'string' && typeof row.category === 'string'
        && timeMinutes(row.from) !== null && timeMinutes(row.to) !== null && row.from !== row.to).slice(0, 24) };
    }
  } catch { /* Invalid preferences must not prevent bookkeeping. */ }
  return cached;
}
export function writeCategoryDefaultPreferences(value: CategoryDefaultPreferences): void {
  accountLocalStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(callback: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === accountStorageKey(KEY)) callback(); };
  window.addEventListener(EVENT, callback); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener('storage', storage); };
}
export function useCategoryDefaultPreferences() {
  return useSyncExternalStore(subscribe, readCategoryDefaultPreferences, () => DEFAULT_CATEGORY_PREFERENCES);
}
