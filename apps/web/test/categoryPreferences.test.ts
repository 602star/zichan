import { describe, expect, it } from 'vitest';
import type { Category } from '@zichan/core';
import {
  categoryPreferenceUpdates,
  moveCategoryBefore,
  moveCategoryId,
  reorderCategoryIds,
  resetCategoryPreferences,
} from '../src/categoryPreferences.js';
import { categoryWithBuiltInDefaults } from '../src/db/maintenance.js';
import { SYSTEM_CATEGORY_CATALOG, categoryOptions, storedCategory } from '../src/transactionMeta.js';

const category = (id: string, name: string, overrides: Partial<Category> = {}): Category => ({
  id,
  name,
  type: 'expense',
  createdAt: '',
  updatedAt: '',
  version: 1,
  isDeleted: false,
  isActive: true,
  ...overrides,
});

describe('category preferences', () => {
  it('reorders one sibling group without changing unrelated categories', () => {
    const rows = [category('a', 'A', { sortOrder: 10 }), category('b', 'B', { sortOrder: 20 }), category('other', 'Other', { sortOrder: 77 })];
    const reordered = reorderCategoryIds(rows, ['b', 'a']);
    expect(reordered.find((row) => row.id === 'b')?.sortOrder).toBe(10);
    expect(reordered.find((row) => row.id === 'a')?.sortOrder).toBe(20);
    expect(reordered.find((row) => row.id === 'other')?.sortOrder).toBe(77);
    expect(moveCategoryId(['a', 'b', 'c'], 'c', 'top')).toEqual(['c', 'a', 'b']);
    expect(moveCategoryBefore(['a', 'b', 'c'], 'c', 'b')).toEqual(['a', 'c', 'b']);
  });

  it('restores built-in visibility and order while retaining custom categories', () => {
    const rows = [
      category('pet_medical', '宠物医疗', { parentId: 'expense_home', isHidden: false, sortOrder: 1 }),
      category('custom', '自定义', { parentId: 'expense_home', isHidden: true, sortOrder: 2 }),
    ];
    const reset = resetCategoryPreferences(rows, 'expense_home');
    expect(reset.find((row) => row.id === 'pet_medical')).toMatchObject({ isHidden: true, sortOrder: 149 });
    expect(reset.find((row) => row.id === 'custom')).toMatchObject({ isHidden: true, sortOrder: 2 });
  });

  it('reports only changed preference rows', () => {
    const original = [category('a', 'A', { isHidden: false, sortOrder: 10 }), category('b', 'B', { isHidden: true, sortOrder: 20 })];
    const draft = [{ ...original[0]!, sortOrder: 20 }, { ...original[1]! }];
    expect(categoryPreferenceUpdates(original, draft).map((row) => row.id)).toEqual(['a']);
  });

  it('keeps user visibility and sort order during built-in maintenance', () => {
    const defaults = storedCategory(SYSTEM_CATEGORY_CATALOG.find((row) => row.id === 'pet_medical')!);
    const current = category('pet_medical', '旧名称', { parentId: 'expense_home', isHidden: false, sortOrder: 10 });
    expect(categoryWithBuiltInDefaults(current, defaults)).toMatchObject({
      name: '旧名称',
      isHidden: false,
      sortOrder: 10,
    });
  });

  it('sorts picker options by parent order, frequent state and child order', () => {
    const rows = [
      category('expense_home', '居家生活', { sortOrder: 1 }),
      category('expense_food', '食品餐饮', { sortOrder: 2 }),
      category('pet_medical', '宠物医疗', { parentId: 'expense_home', isHidden: false, sortOrder: 20 }),
      category('pet_food', '宠物食品', { parentId: 'expense_home', isHidden: false, sortOrder: 10 }),
      category('groceries', '买菜食材', { parentId: 'expense_food', isHidden: false, sortOrder: 20 }),
      category('takeaway', '外卖', { parentId: 'expense_food', isHidden: true, sortOrder: 1 }),
    ];
    const ids = categoryOptions(rows, 'expense', { leafOnly: true, includeHidden: true }).map((row) => row.value);
    expect(ids.indexOf('pet_food')).toBeLessThan(ids.indexOf('pet_medical'));
    expect(ids.indexOf('pet_medical')).toBeLessThan(ids.indexOf('groceries'));
    expect(ids.indexOf('groceries')).toBeLessThan(ids.indexOf('takeaway'));
  });
});
