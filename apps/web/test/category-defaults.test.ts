import { describe, expect, it, vi } from 'vitest';
import { categoryHistoryRange, DEFAULT_CATEGORY_PREFERENCES, recommendExpenseCategory, timeMinutes, type CategoryHistoryRow } from '../src/category-defaults.js';
import { transactionForm } from '../src/forms.js';
import { makeSnapshot, makeTransaction } from './fixtures.js';

const categories = [
  { value: 'takeaway', label: '餐饮 / 外卖' }, { value: 'food', label: '餐饮 / 堂食' },
  { value: 'transport', label: '交通 / 地铁' }, { value: 'uncategorized', label: '其他支出 / 待分类' },
];
const context = { date: '2026-11-24', time: '12:00' };
const recommend = (rows: CategoryHistoryRow[] = [], time = '12:00') => recommendExpenseCategory(rows, categories, { ...context, time });

describe('contextual expense category defaults', () => {
  it('selects takeaway at noon without any description or history, including both time boundaries', () => {
    expect(recommend()).toMatchObject({ category: 'takeaway', source: 'time' });
    expect(recommend([], '11:00').category).toBe('takeaway');
    expect(recommend([], '13:59:59').category).toBe('takeaway');
    expect(recommend([], '14:00').category).toBe('uncategorized');
  });
  it('uses the same initial noon default in the complete transaction form', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-24T12:00:00+08:00'));
    try {
      const snapshot = makeSnapshot();
      snapshot.categories.push({ ...snapshot.categories[0]!, id: 'takeaway', name: '外卖', type: 'expense', parentId: 'food_parent', isActive: true, isHidden: false });
      const spec = transactionForm(snapshot);
      expect(spec.fields.find((field) => field.key === 'category')?.defaultValue).toBe('takeaway');
      expect(spec.expenseCategoryDefaults).toBe(true);
      expect(transactionForm(makeSnapshot(), { refundMode: true }).expenseCategoryDefaults).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('learns stable same-period habits but requires five samples and a clear lead', () => {
    const row = { date: '2026-11-23', time: '12:15', category: 'food', count: 4 };
    expect(recommend([row]).category).toBe('takeaway');
    expect(recommend([{ ...row, count: 5 }])).toMatchObject({ category: 'food', source: 'personal' });
    expect(recommend([{ ...row, count: 3 }, { ...row, category: 'transport', count: 2 }]).category).toBe('takeaway');
  });
  it('replaces an automatic expense default with the original category when switching to refund', () => {
    const snapshot = makeSnapshot();
    snapshot.transactions = [makeTransaction({ id: 'original-expense', category: 'food' })];
    const spec = transactionForm(snapshot);
    expect(spec.onFieldChange?.({ type: 'refund', category: 'takeaway' }, 'type', new Set())).toMatchObject({ category: 'uncategorized' });
    expect(spec.onFieldChange?.({ type: 'refund', category: 'uncategorized', refundForId: 'original-expense' }, 'refundForId', new Set())).toMatchObject({ category: 'food' });
    expect(spec.onFieldChange?.({ type: 'refund', category: 'transport', refundForId: 'original-expense' }, 'refundForId', new Set(['category']))).toMatchObject({ category: 'transport' });
  });
  it('does not learn from weekends, future, invalid, date-only, refunded or inactive records', () => {
    for (const patch of [
      { date: '2026-11-22' }, { date: '2026-11-25' }, { date: '2026-02-30' }, { date: '2026-01-01' },
      { timePrecision: 'day' as const }, { type: 'refund' as const }, { isDeleted: true }, { recordState: 'voided' as const },
      { time: '25:00' }, { time: '12:00wrong' },
    ]) expect(recommend([{ date: '2026-11-23', time: '12:00', category: 'food', count: 20, ...patch }]).category).toBe('takeaway');
  });
  it('handles midnight distance and explicit cross-midnight rules', () => {
    expect(recommend([{ date: '2026-11-23', time: '23:50', category: 'transport', count: 5 }], '00:10')).toMatchObject({ category: 'transport', source: 'personal' });
    const preferences = { ...DEFAULT_CATEGORY_PREFERENCES, rules: [{ id: 'night', from: '23:00', to: '01:00', category: 'food' }] };
    expect(recommendExpenseCategory([], categories, { ...context, time: '00:10' }, preferences)).toMatchObject({ category: 'food', source: 'rule' });
    expect(recommendExpenseCategory([], categories, { ...context, time: '01:00' }, preferences).source).not.toBe('rule');
  });
  it('does not infer the current meal for historical entries without a valid time', () => {
    expect(recommend([], '').category).toBe('uncategorized');
    expect(recommend([], 'invalid').category).toBe('uncategorized');
    expect(categoryHistoryRange('2026-02-30')).toBeNull();
    expect(timeMinutes('00:00')).toBe(0);
  });
  it('protects category availability and honors disabled smart defaults', () => {
    const options = categories.map((row) => row.value === 'takeaway' ? { ...row, hidden: true } : row);
    expect(recommendExpenseCategory([], options, context).category).toBe('food');
    expect(recommendExpenseCategory([], categories, context, { ...DEFAULT_CATEGORY_PREFERENCES, enabled: false, fixedCategory: 'transport' })).toMatchObject({ category: 'transport', source: 'fixed' });
    expect(recommendExpenseCategory([], categories.map((row) => ({ ...row, inactive: true })), context).category).toBe('');
  });
});
