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

  it('returns disabled categories only when asked, flagged as inactive', () => {
    const disabled = {
      ...systemCategory('pet_medical', false)!,
      isActive: false,
      isHidden: true,
      archivedAt: '2026-09-01T00:00:00.000Z',
      archiveReason: '系统分类包停用',
    };
    const readPath = { leafOnly: true, includeHidden: true, includeCatalog: false, includeInactive: true } as const;

    // 读路径（筛选 / 高级查询）拿得到，并且带得上徒标，而不是伪装成普通选项。
    const option = categoryOptions([disabled], 'expense', readPath).find((o) => o.value === 'pet_medical');
    expect(option).toMatchObject({ label: '居家生活 / 宠物医疗', inactive: true });

    // 没有 includeInactive 的调用方（记账、模板、预算）行为不变：只能看到标签，选不到。
    for (const opts of [
      { leafOnly: true, includeHidden: true },
      { leafOnly: true, includeHidden: true, includeCatalog: false },
      { leafOnly: true, includeHidden: true, includeCatalog: false, includeInactive: false },
    ]) {
      expect(categoryOptions([disabled], 'expense', opts).some((o) => o.value === 'pet_medical')).toBe(false);
    }

    // 活跃分类不会被误标成停用。
    const active = allCategories().find((c) => c.id === 'food')!;
    expect(categoryOptions([active], 'expense', readPath).find((o) => o.value === 'food')?.inactive).toBeUndefined();
  });

  it('offers a general-purpose fine that covers non-traffic penalties', () => {
    const fine = allCategories().find((row) => row.id === 'fine');
    expect(fine).toMatchObject({ name: '罚款', type: 'expense', parentId: 'expense_misc' });

    // 罚款是跨场景的通用支出（行政/平台/民事处罚），不属于任何场景扩展包，
    // 因此默认可用。交通违法另在车主扩展包里提供专门的「违章罚款」。
    expect(DEFAULT_ENABLED_CATEGORY_IDS.has('fine')).toBe(true);
    expect(CATEGORY_PACKS.some((pack) => pack.categoryIds.includes('fine'))).toBe(false);
    expect(EXTENSION_CATEGORY_IDS.has('fine')).toBe(false);
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

/*
 * 选项过去只给一个拼好的 `label`（「一级 / 二级」）。谁想在面板里把两级分开显示
 * （左栏选一级、右栏列二级），就只能拿 `label` 反解——而分类名是自由文本，
 * 叶子名本身可能带斜杠（目录里的「打车/网约车」），按分隔符反解必然切错。
 * 所以两级名字必须各自给出来，别让读侧去猜。
 */
describe('category option structure', () => {
  const custom = (over: Partial<Category> & Pick<Category, 'id' | 'name'>): Category => ({
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    isDeleted: false,
    type: 'expense',
    isActive: true,
    ...over,
  });

  it('carries the parent and leaf names as separate fields', () => {
    const options = categoryOptions([], undefined, { includeHidden: true, includeCatalog: true });
    const taxi = options.find((row) => row.value === 'taxi_ride');
    expect(taxi).toMatchObject({
      label: '交通出行 / 打车/网约车',
      name: '打车/网约车',
      parentName: '交通出行',
    });

    // 没有父级时不写空串：调用方要能区分「没有父级」和「父级叫空名字」。
    const top = categoryOptions([], 'expense', { parentsOnly: true }).find((row) => row.value === 'expense_transport');
    expect(top).toMatchObject({ name: '交通出行', label: '交通出行' });
    expect(top?.parentName).toBeUndefined();
  });

  it('keeps every built-in option described the same way as its label', () => {
    const options = categoryOptions([], undefined, { includeHidden: true, includeCatalog: true });
    const catalog = allCategories([], { includeCatalog: true });
    const byId = new Map(catalog.map((row) => [row.id, row]));
    expect(options.length).toBeGreaterThan(0);

    for (const option of options) {
      const row = byId.get(option.value)!;
      const parent = row.parentId ? byId.get(row.parentId) : undefined;
      expect(option.name).toBe(row.name);
      expect(option.parentName).toBe(parent?.name);
      expect(option.label).toBe(parent ? `${parent.name} / ${row.name}` : row.name);
    }

    // 目录里确实有带斜杠的叶子名，否则这条测试只是个空循环。
    expect(options.filter((option) => option.name?.includes('/')).map((option) => option.value))
      .toEqual(expect.arrayContaining(['taxi_ride']));
  });

  it('keeps a self-made parent name that contains a slash in one piece', () => {
    const parent = custom({ id: 'c_learn', name: '学习/培训' });
    const child = custom({ id: 'c_book', name: '教材', parentId: 'c_learn' });
    const option = categoryOptions([parent, child], 'expense', { leafOnly: true, includeHidden: true })
      .find((row) => row.value === 'c_book');

    expect(option).toMatchObject({ name: '教材', parentName: '学习/培训', label: '学习/培训 / 教材' });
  });

  it('keeps each option label identical to what categoryLabel returns on its own', () => {
    const disabled = {
      ...systemCategory('pet_medical', false)!,
      isActive: false,
      isHidden: true,
    } as Category;
    const rows: Category[] = [
      disabled,
      custom({ id: 'c_learn', name: '学习/培训', sortOrder: 900 }),
      custom({ id: 'c_book', name: '教材', parentId: 'c_learn', sortOrder: 901 }),
    ];

    for (const opts of [
      {},
      { leafOnly: true, includeHidden: true },
      { leafOnly: true, includeHidden: true, includeCatalog: false },
      { parentsOnly: true, includeHidden: true },
      { includeHidden: true, includeCatalog: true, includeInactive: true },
    ]) {
      const options = categoryOptions(rows, undefined, opts);
      expect(options.length).toBeGreaterThan(0);
      // 结构字段和 label 必须描述同一条路径，否则面板左栏和标签会各说各话。
      for (const option of options) expect(option.label).toBe(categoryLabel(option.value, rows));
    }
  });
});
