import { describe, expect, it } from 'vitest';
import {
  CATEGORY_PACKS,
  DEFAULT_ENABLED_CATEGORY_IDS,
  SYSTEM_CATEGORY_CATALOG,
  allCategories,
  categoryLabel,
  categoryOptions,
  systemCategory,
} from '../src/index.js';

describe('system category catalog', () => {
  it('keeps optional categories out of the enabled list while making them searchable', () => {
    const enabled = allCategories();
    const complete = allCategories([], { includeCatalog: true });
    expect(enabled.length).toBe(DEFAULT_ENABLED_CATEGORY_IDS.size);
    expect(enabled.length).toBeLessThan(complete.length);
    expect(enabled.some((row) => row.id === 'pet_medical')).toBe(false);

    const optional = categoryOptions([], 'expense', {
      leafOnly: true,
      includeHidden: true,
      includeCatalog: true,
    }).find((row) => row.value === 'pet_medical');
    expect(optional).toMatchObject({ hidden: true, catalogOnly: true });
  });

  it('only references real catalog rows from every optional pack', () => {
    const ids = new Set(SYSTEM_CATEGORY_CATALOG.map((row) => row.id));
    const missing = CATEGORY_PACKS.flatMap((pack) =>
      pack.categoryIds.filter((categoryId) => !ids.has(categoryId)).map((categoryId) => `${pack.id}:${categoryId}`),
    );
    expect(missing).toEqual([]);
  });

  it('keeps a disabled system category out of new-entry options while retaining its historical label', () => {
    const disabled = {
      ...systemCategory('pet_medical', false)!,
      isActive: false,
      isHidden: true,
      archivedAt: '2026-09-01T00:00:00.000Z',
      archiveReason: '系统分类包停用',
    };

    expect(categoryOptions([disabled], 'expense', { leafOnly: true, includeHidden: true })
      .some((option) => option.value === 'pet_medical')).toBe(false);
    expect(categoryLabel('pet_medical', [disabled])).toBe('居家生活 / 宠物医疗');
  });
});
