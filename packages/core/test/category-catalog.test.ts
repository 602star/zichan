import { describe, expect, it } from 'vitest';
import {
  CATEGORY_PACKS,
  DEFAULT_ENABLED_CATEGORY_IDS,
  EXTENSION_CATEGORY_IDS,
  SHARED_PACK_CATEGORY_IDS,
  SYSTEM_CATEGORY_CATALOG,
  allCategories,
  availableExtensionCategories,
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

  it('offers every extension category that no pack covers through the browse list', () => {
    const covered = new Set(CATEGORY_PACKS.flatMap((pack) => pack.categoryIds as readonly string[]));
    const available = availableExtensionCategories().map((row) => row.id);

    // 扩展包只收录“会被同一类人成组需要”的分类；剩下的细分项靠浏览入口逐项添加。
    // 两者必须合起来盖完整个目录，否则目录里会存在用户根本无法启用的分类。
    expect(new Set([...covered, ...available])).toEqual(EXTENSION_CATEGORY_IDS);
    expect(available.length).toBe(EXTENSION_CATEGORY_IDS.size);
    for (const id of available) expect(DEFAULT_ENABLED_CATEGORY_IDS.has(id)).toBe(false);
  });

  it('lets a pack member be added on its own without enabling the whole pack', () => {
    // 只想要「宠物医疗」而不想开整包 养宠 时，浏览入口应当也能拿到它。
    const pet = CATEGORY_PACKS.find((pack) => pack.id === 'pet')!;
    const available = new Set(availableExtensionCategories().map((row) => row.id));
    for (const id of pet.categoryIds) expect(available.has(id)).toBe(true);

    // 一旦这一项已经落库（无论启用与否），就不再作为“可添加”重复提供。
    const persisted = pet.categoryIds.map((id) => ({ ...systemCategory(id, false)!, isActive: true, isHidden: false }));
    const remaining = new Set(availableExtensionCategories(persisted).map((row) => row.id));
    for (const id of pet.categoryIds) expect(remaining.has(id)).toBe(false);
    expect(remaining.size).toBe(EXTENSION_CATEGORY_IDS.size - pet.categoryIds.length);
  });

  it('never offers a category the ledger already holds, archived ones included', () => {
    const persisted: Category[] = [
      { ...systemCategory('pet_medical', false)!, isActive: true, isHidden: false },
      // 已归档的成员要走「归档/恢复」；再把它当成“可添加”会写出一份重复分类。
      {
        ...systemCategory('pet_grooming', false)!,
        isActive: false,
        isHidden: true,
        archivedAt: '2026-09-02T00:00:00.000Z',
        archiveReason: '用户归档',
      },
    ];
    const available = availableExtensionCategories(persisted).map((row) => row.id);

    expect(available).not.toContain('pet_medical');
    expect(available).not.toContain('pet_grooming');
    expect(availableExtensionCategories().length - available.length).toBe(2);
  });
});
