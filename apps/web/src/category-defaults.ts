import { addDays, isValidDay, type Transaction } from '@zichan/core';

export interface DefaultCategoryOption {
  value: string;
  label: string;
  name?: string;
  hidden?: boolean;
  catalogOnly?: boolean;
  inactive?: boolean;
}
export interface CategoryTimeRule { id: string; from: string; to: string; category: string }
export interface CategoryDefaultPreferences {
  enabled: boolean;
  fixedCategory: string;
  rules: CategoryTimeRule[];
}
export interface CategoryHistoryRow {
  date: string;
  time?: string;
  timePrecision?: Transaction['timePrecision'];
  category: string;
  count?: number;
  type?: Transaction['type'];
  isDeleted?: boolean;
  recordState?: Transaction['recordState'];
}
export interface CategoryRecommendation {
  category: string;
  label: string;
  description?: string;
  source: 'rule' | 'personal' | 'time' | 'fixed' | 'recent' | 'fallback';
  reason: string;
}
export const DEFAULT_CATEGORY_PREFERENCES: CategoryDefaultPreferences = { enabled: true, fixedCategory: 'uncategorized', rules: [] };

export function timeMinutes(value?: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::([0-5]\d))?$/.exec(value ?? '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
function dayNumber(value: string): number | null {
  return isValidDay(value) ? Date.parse(`${value}T00:00:00Z`) / 86_400_000 : null;
}
export function categoryHistoryRange(date: string): { from: string; to: string } | null {
  const day = dayNumber(date);
  return day === null ? null : { from: addDays(date, -60), to: date };
}
function inTimeRange(minutes: number, from: number, to: number): boolean {
  return from < to ? minutes >= from && minutes < to : from > to && (minutes >= from || minutes < to);
}
export function recommendationCategories<T extends DefaultCategoryOption>(categories: readonly T[]): T[] {
  return categories.filter((row) => !row.hidden && !row.catalogOnly && !row.inactive);
}
export function recommendExpenseCategory(
  history: readonly CategoryHistoryRow[],
  categories: readonly DefaultCategoryOption[],
  context: { date: string; time?: string },
  preferences: CategoryDefaultPreferences = DEFAULT_CATEGORY_PREFERENCES,
): CategoryRecommendation {
  const available = recommendationCategories(categories);
  const allowed = new Map(available.map((row) => [row.value, row]));
  const result = (category: string, source: CategoryRecommendation['source'], reason: string, description?: string): CategoryRecommendation => ({
    category, source, reason, description,
    label: allowed.get(category)?.name ?? allowed.get(category)?.label.split(' / ').at(-1) ?? '待分类',
  });
  const fixed = allowed.has(preferences.fixedCategory) ? preferences.fixedCategory : undefined;
  const fallback = () => result(fixed ?? (allowed.has('uncategorized') ? 'uncategorized' : available[0]?.value ?? ''), fixed && fixed !== 'uncategorized' ? 'fixed' : 'fallback', '使用默认支出分类');
  if (!preferences.enabled) return fallback();
  const targetDay = dayNumber(context.date);
  const minutes = timeMinutes(context.time);
  if (targetDay === null) return fallback();
  if (minutes !== null) {
    const explicit = preferences.rules.find((row) => {
      const from = timeMinutes(row.from), to = timeMinutes(row.to);
      return allowed.has(row.category) && from !== null && to !== null && inTimeRange(minutes, from, to);
    });
    if (explicit) return result(explicit.category, 'rule', `按你的 ${explicit.from}–${explicit.to} 时段规则预选`);
  }
  const valid = history.filter((row) => {
    const day = dayNumber(row.date);
    return !row.isDeleted && row.recordState !== 'voided' && (!row.type || row.type === 'expense')
      && allowed.has(row.category) && day !== null && day <= targetDay && targetDay - day <= 60;
  });
  if (minutes !== null) {
    const weekend = (day: number) => [0, 6].includes(new Date(day * 86_400_000).getUTCDay());
    const counts = new Map<string, number>();
    let total = 0;
    for (const row of valid) {
      const at = timeMinutes(row.time);
      if (at === null || row.timePrecision === 'day' || weekend(dayNumber(row.date)!) !== weekend(targetDay)) continue;
      const distance = Math.abs(at - minutes);
      if (Math.min(distance, 1440 - distance) > 90) continue;
      const count = Number.isSafeInteger(row.count ?? 1) && (row.count ?? 1) > 0 ? row.count ?? 1 : 0;
      counts.set(row.category, (counts.get(row.category) ?? 0) + count);
      total += count;
    }
    const [top, second] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (total >= 5 && top && top[1] >= 3 && top[1] / total >= 0.6 && top[1] - (second?.[1] ?? 0) >= 2) {
      return result(top[0], 'personal', `按你近 60 天同时段的 ${top[1]} 笔记录预选`);
    }
    const meal = minutes >= 660 && minutes < 840 ? { name: '午餐', ids: ['takeaway', 'lunch_work_meal', 'food'] }
      : minutes >= 300 && minutes < 600 ? { name: '早餐', ids: ['breakfast', 'food'] }
        : minutes >= 1020 && minutes < 1260 ? { name: '晚餐', ids: ['dinner', 'takeaway', 'food'] }
          : minutes >= 1260 || minutes < 120 ? { name: '夜宵', ids: ['late_night_snack', 'takeaway', 'food'] } : undefined;
    const category = meal?.ids.find((id) => allowed.has(id));
    if (meal && category) return result(category, 'time', `按${meal.name === '午餐' ? '午间' : meal.name}时段预选`, meal.name);
  }
  if (fixed && fixed !== 'uncategorized') return result(fixed, 'fixed', '使用你设置的默认分类');
  const recent = [...valid].sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? '').localeCompare(a.time ?? ''))[0];
  return recent ? result(recent.category, 'recent', '沿用最近一次有效支出分类') : fallback();
}
