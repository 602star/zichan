import { describe, expect, it } from 'vitest';
import type { Category } from '@zichan/core';
import { SYSTEM_CATEGORY_CATALOG, categoryOptions } from '../src/transactionMeta.js';
import { splitCategoryLabel } from '../src/ui/EntityFormModal.js';

/*
 * 分类选择器把面板分成左「一级」右「二级」两栏，所以它必须知道一个选项的两级各自
 * 叫什么。过去它只有 `label` 这一个拼好的字符串，于是按 `/` 反解——叶子名自带斜杠
 * 时（目录里的「打车/网约车」）就被切成三段，还把切出来的片段用「 / 」重拼，
 * 面板里就显示成「打车 / 网约车」。名字是用户可编辑的自由文本，任何分隔符都可能
 * 出现在名字里，所以这里断言的是：只要选项给出了结构，就一个字符都不许被改写。
 */

const custom = (over: Partial<Category> & Pick<Category, 'id' | 'name'>): Category => ({
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  version: 1,
  isDeleted: false,
  type: 'expense',
  isActive: true,
  ...over,
});

const builtInOptions = () => categoryOptions([], 'expense', { leafOnly: true, includeHidden: true });

describe('category picker label split', () => {
  it('reads 打车/网约车 as one leaf name instead of two levels', () => {
    const option = builtInOptions().find((row) => row.value === 'taxi_ride')!;
    expect(splitCategoryLabel(option)).toEqual({ parent: '交通出行', child: '打车/网约车' });
  });

  it('shows every built-in leaf name exactly as the catalog spells it', () => {
    const names = new Map(SYSTEM_CATEGORY_CATALOG.map((row) => [row.id, row.name]));
    const options = builtInOptions();
    expect(options.length).toBeGreaterThan(50);

    for (const option of options) {
      expect(names.has(option.value)).toBe(true);
      expect(splitCategoryLabel(option).child).toBe(names.get(option.value));
    }

    // 这条测试要在「名字里带斜杠」这件事上真的是活的。
    const slashed = options.filter((option) => names.get(option.value)!.includes('/'));
    expect(slashed.map((option) => option.value)).toEqual(expect.arrayContaining(['taxi_ride', 'fuel']));
  });

  it('keeps a self-made parent name that contains a slash whole', () => {
    const rows = [
      custom({ id: 'c_learn', name: '学习/培训' }),
      custom({ id: 'c_book', name: '教材', parentId: 'c_learn' }),
    ];
    const option = categoryOptions(rows, 'expense', { leafOnly: true, includeHidden: true })
      .find((row) => row.value === 'c_book')!;

    expect(splitCategoryLabel(option)).toEqual({ parent: '学习/培训', child: '教材' });
  });

  it('keeps a parentless category in the catch-all column under its own name', () => {
    const solo = custom({ id: 'c_solo', name: '其他/杂项' });
    const option = categoryOptions([solo], 'expense', { leafOnly: true, includeHidden: true })
      .find((row) => row.value === 'c_solo')!;

    expect(splitCategoryLabel(option)).toEqual({ parent: '其他', child: '其他/杂项' });
  });

  /*
   * 手搓出来的选项（模板、筛选、生命周期候选这些不走 categoryOptions 的调用点）
   * 没有结构字段，这时才退回按分隔符解析。
   */
  it('still splits a plain label that carries no structure', () => {
    expect(splitCategoryLabel({ value: 'a', label: '食品餐饮 / 堂食餐饮' }))
      .toEqual({ parent: '食品餐饮', child: '堂食餐饮' });
    expect(splitCategoryLabel({ value: 'b', label: '待分类' }))
      .toEqual({ parent: '其他', child: '待分类' });
  });
});
