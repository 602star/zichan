import { useEffect, useState } from 'react';
import { useStore } from './db/store.js';
import { categoryHistoryRange, recommendExpenseCategory, type CategoryHistoryRow, type DefaultCategoryOption } from './category-defaults.js';
import { useCategoryDefaultPreferences } from './category-default-preferences.js';

export function useCategoryDefault(date: string, time: string, categories: readonly DefaultCategoryOption[], enabled = true) {
  const { store, rev } = useStore();
  const preferences = useCategoryDefaultPreferences();
  const [history, setHistory] = useState<{ key: string; rows: CategoryHistoryRow[] }>();
  const key = `${date}:${rev}`;
  useEffect(() => {
    const range = categoryHistoryRange(date);
    if (!enabled || !preferences.enabled || !range) return;
    let cancelled = false;
    void store.expenseCategoryHistory(range).then((rows) => {
      if (!cancelled) setHistory({ key, rows });
    }).catch(() => { if (!cancelled) setHistory({ key, rows: [] }); });
    return () => { cancelled = true; };
  }, [date, key, store, enabled, preferences.enabled]);
  return recommendExpenseCategory(history?.key === key ? history.rows : [], categories, { date, time }, preferences);
}
