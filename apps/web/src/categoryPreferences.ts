import type { Category } from '@zichan/core';
import { SYSTEM_CATEGORY_CATALOG, storedCategory } from './transactionMeta.js';

export function sortCategorySiblings(categories: Category[]): Category[] {
  return [...categories].sort((a, b) =>
    (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.name.localeCompare(b.name),
  );
}

export function reorderCategoryIds(categories: Category[], orderedIds: string[]): Category[] {
  const order = new Map(orderedIds.map((id, index) => [id, (index + 1) * 10]));
  return categories.map((category) => {
    const sortOrder = order.get(category.id);
    return sortOrder === undefined || category.sortOrder === sortOrder
      ? category
      : { ...category, sortOrder };
  });
}

export function moveCategoryId(ids: string[], id: string, action: 'up' | 'down' | 'top'): string[] {
  const index = ids.indexOf(id);
  if (index < 0) return ids;
  const target = action === 'top' ? 0 : action === 'up' ? Math.max(0, index - 1) : Math.min(ids.length - 1, index + 1);
  if (target === index) return ids;
  const next = [...ids];
  next.splice(index, 1);
  next.splice(target, 0, id);
  return next;
}

export function moveCategoryBefore(ids: string[], movingId: string, targetId: string): string[] {
  if (movingId === targetId || !ids.includes(movingId) || !ids.includes(targetId)) return ids;
  const next = ids.filter((id) => id !== movingId);
  next.splice(next.indexOf(targetId), 0, movingId);
  return next;
}

export function resetCategoryPreferences(categories: Category[], parentId?: string): Category[] {
  const defaults = new Map(SYSTEM_CATEGORY_CATALOG.map((category) => {
    const stored = storedCategory(category);
    return [stored.id, stored] as const;
  }));
  return categories.map((category) => {
    if (parentId !== undefined && category.parentId !== parentId) return category;
    const defaultCategory = defaults.get(category.id);
    if (!defaultCategory) return category;
    return {
      ...category,
      isHidden: defaultCategory.isHidden,
      sortOrder: defaultCategory.sortOrder,
    };
  });
}

export function categoryPreferenceUpdates(original: Category[], draft: Category[]): Category[] {
  const originalById = new Map(original.map((category) => [category.id, category]));
  return draft.filter((category) => {
    const before = originalById.get(category.id);
    return !before || before.isHidden !== category.isHidden || before.sortOrder !== category.sortOrder;
  });
}
