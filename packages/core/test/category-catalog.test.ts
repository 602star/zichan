import { describe, expect, it } from 'vitest';
import {
  CATEGORY_PACKS,
  DEFAULT_ENABLED_CATEGORY_IDS,
  EXTENSION_CATEGORY_IDS,
  SHARED_PACK_CATEGORY_IDS,
  SYSTEM_CATEGORY_CATALOG,
  allCategories,
  categoryLabel,
  categoryOptions,
  categoryPackMemberState,
  categoryPackState,
  categoryPacksContaining,
  systemCategory,
  type Category,
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

  it('keeps default categories out of every extension pack', () => {
    for (const pack of CATEGORY_PACKS) {
      expect(new Set(pack.categoryIds).size).toBe(pack.categoryIds.length);
      for (const categoryId of pack.categoryIds) {
        // 扩展包只装默认没有的可选分类。把默认分类放进包里，会让“停用扩展包”
        // 连带关掉用户日常在用的分类（例如 加油/充电、住宿、教材）。
        expect(DEFAULT_ENABLED_CATEGORY_IDS.has(categoryId)).toBe(false);
        expect(EXTENSION_CATEGORY_IDS.has(categoryId)).toBe(true);
        const row = SYSTEM_CATEGORY_CATALOG.find((candidate) => candidate.id === categoryId);
        expect(row?.hidden).toBe(true);
        expect(row?.parentId).toBeTruthy();
        // 成员的父分类必须默认就启用，否则启用扩展包会被迫顺带启用一个默认分类。
        expect(DEFAULT_ENABLED_CATEGORY_IDS.has(row!.parentId!)).toBe(true);
      }
    }
  });

  it('tracks categories shared by more than one extension pack', () => {
    expect([...SHARED_PACK_CATEGORY_IDS]).toEqual(['car_rental']);
    expect(categoryPacksContaining('car_rental').map((pack) => pack.id).sort()).toEqual(['travel', 'vehicle']);
    expect(categoryPacksContaining('fuel')).toEqual([]);
  });

  it('derives extension pack state from persisted ledger rows', () => {
    const pack = CATEGORY_PACKS.find((candidate) => candidate.id === 'pet')!;
    expect(categoryPackState(pack)).toMatchObject({
      status: 'disabled',
      enabledCount: 0,
      missingIds: [...pack.categoryIds],
    });
    const rows = pack.categoryIds.map((id) => ({
      ...systemCategory(id, false)!,
      isActive: true,
      isHidden: false,
    } as Category));
    expect(categoryPackState(pack, rows)).toMatchObject({
      status: 'enabled',
      enabledCount: pack.categoryIds.length,
      disabledCount: 0,
      missingIds: [],
    });
    const partial = rows.map((row, index) => (index === 0 ? { ...row, isActive: false, isHidden: true } : row));
    expect(categoryPackState(pack, partial)).toMatchObject({
      status: 'partial',
      enabledCount: pack.categoryIds.length - 1,
      disabledCount: 1,
    });
  });

  it('separates a user-hidden member from a pack-disabled one', () => {
    const active = { ...systemCategory('pet_medical', false)!, isActive: true, isHidden: true } as Category;
    // 用户自己在「快捷显示与排序」里隐藏：仍然可选可搜索，所以计入可用。
    expect(categoryPackMemberState('pet_medical', [active])).toBe('hidden');
    expect(categoryPackState(CATEGORY_PACKS.find((p) => p.id === 'pet')!, [active]).enabledCount).toBe(1);
    expect(categoryPackMemberState('pet_medical', [{ ...active, isActive: false, isHidden: true }])).toBe('disabled');
    expect(categoryPackMemberState('pet_medical', [])).toBe('missing');
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
