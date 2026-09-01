import { describe, expect, it } from 'vitest';
import type { Transaction } from '@zichan/core';
import { defaultQuickExpenseCategory, latestExpenseCategory } from '../src/ui/QuickExpenseModal.js';

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
});
