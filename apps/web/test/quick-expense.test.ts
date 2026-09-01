import { describe, expect, it } from 'vitest';
import type { Transaction } from '@zichan/core';
import {
  defaultQuickExpenseCategory,
  latestExpenseCategory,
  quickExpenseRecommendationCategories,
  recommendQuickExpense,
} from '../src/ui/QuickExpenseModal.js';

function transaction(overrides: Partial<Transaction>): Transaction {
  return {
    id: crypto.randomUUID(),
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    date: '2026-08-31',
    type: 'expense',
    category: 'food',
    amount: '20',
    assetId: 'cny',
    ...overrides,
  } as Transaction;
}

describe('quick expense defaults', () => {
  it('uses uncategorized for a first expense instead of silently choosing the first category', () => {
    expect(defaultQuickExpenseCategory([], [
      { value: 'groceries', label: '食品餐饮 / 买菜食材' },
      { value: 'uncategorized', label: '其他支出 / 待分类' },
    ])).toBe('uncategorized');
  });

  it('reuses the most recent valid expense category', () => {
    const rows = [
      transaction({ date: '2026-08-30', time: '18:00', category: 'groceries' }),
      transaction({ date: '2026-08-31', time: '12:30', category: 'food' }),
      transaction({ date: '2026-08-31', time: '13:00', type: 'income', category: 'salary' }),
    ];
    expect(latestExpenseCategory(rows, new Set(['food', 'groceries']))).toBe('food');
    expect(defaultQuickExpenseCategory(rows, [
      { value: 'groceries', label: '买菜食材' },
      { value: 'food', label: '堂食餐饮' },
      { value: 'uncategorized', label: '待分类' },
    ])).toBe('food');
  });

  it('ignores voided, deleted, and unavailable categories', () => {
    const rows = [
      transaction({ time: '14:00', category: 'food', recordState: 'voided' }),
      transaction({ time: '13:00', category: 'takeaway', isDeleted: true }),
      transaction({ time: '12:00', category: 'hidden-custom' }),
    ];
    expect(defaultQuickExpenseCategory(rows, [
      { value: 'uncategorized', label: '待分类' },
    ])).toBe('uncategorized');
  });

  it('shows hidden and catalog categories in the shared picker without using them as automatic recommendations', () => {
    expect(quickExpenseRecommendationCategories([
      { value: 'food', label: '食品餐饮 / 堂食餐饮' },
      { value: 'breakfast', label: '食品餐饮 / 早餐', hidden: true },
      { value: 'pet_food', label: '宠物 / 宠物食品', catalogOnly: true },
    ])).toEqual([
      { value: 'food', label: '食品餐饮 / 堂食餐饮' },
    ]);
  });

  it.each([
    [new Date(2026, 7, 31, 7, 30), '早餐'],
    [new Date(2026, 7, 31, 12, 15), '午餐'],
    [new Date(2026, 7, 31, 18, 40), '晚餐'],
    [new Date(2026, 7, 31, 23, 10), '夜宵'],
  ])('recommends a meal from the current local time at %s', (now, label) => {
    expect(recommendQuickExpense([], [
      { value: 'food', label: '食品餐饮 / 堂食餐饮' },
      { value: 'uncategorized', label: '其他支出 / 待分类' },
    ], now)).toMatchObject({
      category: 'food',
      description: label,
      label,
      source: 'time',
    });
  });

  it('uses an enabled meal-specific category without requiring it for new users', () => {
    expect(recommendQuickExpense([], [
      { value: 'breakfast', label: '食品餐饮 / 早餐' },
      { value: 'food', label: '食品餐饮 / 堂食餐饮' },
    ], new Date(2026, 7, 31, 8, 0))).toMatchObject({
      category: 'breakfast',
      description: '早餐',
      source: 'time',
    });
  });

  it('lets a proven same-period habit override the built-in meal rule', () => {
    const rows = [
      transaction({ date: '2026-08-24', time: '08:05', category: 'transport' }),
      transaction({ date: '2026-08-25', time: '07:50', category: 'transport' }),
      transaction({ date: '2026-08-26', time: '08:15', category: 'transport' }),
      transaction({ date: '2026-08-27', time: '08:20', category: 'food' }),
    ];

    expect(recommendQuickExpense(rows, [
      { value: 'food', label: '食品餐饮 / 堂食餐饮' },
      { value: 'transport', label: '交通出行 / 公交地铁' },
      { value: 'uncategorized', label: '其他支出 / 待分类' },
    ], new Date(2026, 7, 31, 8, 0))).toMatchObject({
      category: 'transport',
      label: '公交地铁',
      source: 'personal',
    });
  });

  it('does not infer a personal habit from fewer than three matching records', () => {
    const rows = [
      transaction({ date: '2026-08-24', time: '12:05', category: 'transport' }),
      transaction({ date: '2026-08-25', time: '12:10', category: 'transport' }),
    ];

    expect(recommendQuickExpense(rows, [
      { value: 'food', label: '食品餐饮 / 堂食餐饮' },
      { value: 'transport', label: '交通出行 / 公交地铁' },
    ], new Date(2026, 7, 31, 12, 0))).toMatchObject({ category: 'food', source: 'time' });
  });
});
