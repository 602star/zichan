import { describe, expect, it } from 'vitest';
import { SYSTEM_CATEGORY_CATALOG, type Category } from '@zichan/core';
import { ENTITY_ICONS, categoryIconValue, categoryOptionIcon } from '../src/ui/EntityIcon.js';

describe('category recognition', () => {
  it('gives common food and transport choices different silhouettes', () => {
    for (const ids of [
      ['groceries', 'takeaway', 'food', 'coffee_drinks', 'snacks_fruit', 'dining_out'],
      ['transport', 'taxi_ride', 'train_flight', 'flight', 'fuel', 'parking', 'car_maintenance'],
      ['salary', 'bonus', 'allowance', 'sidejob', 'project_income', 'reimbursement'],
    ]) {
      expect(new Set(ids.map((id) => categoryIconValue(id))).size).toBe(ids.length);
    }
  });

  it('renders every catalog default with a registered icon and uses the same icon in pickers', () => {
    for (const category of SYSTEM_CATEGORY_CATALOG) {
      const icon = categoryIconValue(category.id);
      expect(ENTITY_ICONS[icon.replace('lucide:', '')], category.id).toBeDefined();
      expect(categoryOptionIcon({ value: category.id, parentId: category.parentId })).toBe(icon);
    }
  });

  it('preserves custom icons and parent fallback for user categories', () => {
    const categories = [
      { id: 'expense_food', icon: 'lucide:gift' },
      { id: 'groceries', parentId: 'expense_food', icon: 'lucide:plant' },
      { id: 'my-category', parentId: 'expense_food' },
    ] as Category[];
    expect(categoryIconValue('groceries', categories)).toBe('lucide:plant');
    expect(categoryIconValue('my-category', categories)).toBe('lucide:gift');
    expect(categoryOptionIcon({ value: 'groceries', icon: 'lucide:plant', parentIcon: 'lucide:gift' })).toBe('lucide:plant');
    expect(categoryOptionIcon({ value: 'my-category', parentIcon: 'lucide:gift' })).toBe('lucide:gift');
  });
});
