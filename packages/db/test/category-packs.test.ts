import { describe, expect, it } from 'vitest';
import { CATEGORY_PACKS, type Category } from '@zichan/core';
import {
  disableSystemCategories,
  enableSystemCategories,
  restoreMisdisabledDefaultCategories,
} from '../src/index.js';
import { openLedger } from '../src/node.js';

const packOf = (id: string) => CATEGORY_PACKS.find((candidate) => candidate.id === id)!;

describe('extension packs', () => {
  it('never disables a default category, even when the given list contains one', async () => {
    const store = await openLedger();
    const result = await disableSystemCategories(store, ['pet', 'fuel', 'pet_food']);
    expect(result.retainedDefaultIds).toEqual(['pet', 'fuel']);
    expect(result.disabledIds).toEqual([]);
    // Disabling must not materialize the default category just to archive it.
    expect(await store.categories.get('pet')).toBeNull();
    expect(await store.categories.get('fuel')).toBeNull();
    await store.close();
  });

  it('skips members missing from the ledger instead of creating them to disable them', async () => {
    const store = await openLedger();
    const pack = packOf('student');
    await enableSystemCategories(store, ['canteen']);

    const result = await disableSystemCategories(store, pack.categoryIds);
    expect(result.disabledIds).toEqual(['canteen']);
    expect(result.missingIds).toEqual(pack.categoryIds.filter((id) => id !== 'canteen'));
    expect(await store.categories.get('tuition')).toBeNull();
    await store.close();
  });

  it('keeps a member that another enabled extension pack still owns', async () => {
    const store = await openLedger();
    const vehicle = packOf('vehicle');
    await enableSystemCategories(store, vehicle.categoryIds);

    const result = await disableSystemCategories(store, vehicle.categoryIds, { retainIds: ['car_rental'] });
    expect(result.retainedSharedIds).toEqual(['car_rental']);
    expect(await store.categories.get('car_rental')).toMatchObject({ isActive: true, isHidden: false });
    expect(await store.categories.get('car_wash')).toMatchObject({ isActive: false, isHidden: true });
    expect(result.disabledIds).not.toContain('car_rental');
    await store.close();
  });

  it('restores only what the pack disabled, leaving a user-hidden member hidden', async () => {
    const store = await openLedger();
    await enableSystemCategories(store, ['pet_food']);
    const enabled = (await store.categories.get('pet_food'))!;

    // The user removed it from the quick list; enabling the pack must respect that.
    await store.categories.put({ ...enabled, isHidden: true } as Category);
    await enableSystemCategories(store, ['pet_food']);
    expect(await store.categories.get('pet_food')).toMatchObject({ isActive: true, isHidden: true });

    // A row this pack disabled itself is restored to usable.
    await disableSystemCategories(store, ['pet_food']);
    expect(await store.categories.get('pet_food')).toMatchObject({ isActive: false, isHidden: true });
    await enableSystemCategories(store, ['pet_food']);
    expect(await store.categories.get('pet_food')).toMatchObject({ isActive: true, isHidden: false });
    await store.close();
  });

  it('repairs default categories an older pack version disabled, and leaves the rest alone', async () => {
    const store = await openLedger();
    const packDisabled = { isActive: false, isHidden: true, archivedAt: '2026-08-01T00:00:00.000Z', archiveReason: '系统分类包停用' } as const;

    // 旧版分类包造成的历史损坏：默认分类与扩展分类被同一个原因停用。
    await enableSystemCategories(store, ['fuel', 'pet_food', 'parking', 'car_wash']);
    await store.categories.put({ ...(await store.categories.get('fuel'))!, ...packDisabled } as Category);
    await store.categories.put({ ...(await store.categories.get('pet_food'))!, ...packDisabled } as Category);
    // 用户自己归档的默认分类，不能因为是默认分类就擅自恢复。
    await store.categories.put({
      ...(await store.categories.get('parking'))!,
      isActive: false,
      isHidden: true,
      archivedAt: '2026-08-02T00:00:00.000Z',
      archiveReason: '用户归档',
    } as Category);
    // 已合并的分类同理，不属于本次修复范围。
    await store.categories.put({
      ...(await store.categories.get('car_wash'))!,
      ...packDisabled,
      mergedIntoId: 'car_repair',
    } as Category);

    expect(await restoreMisdisabledDefaultCategories(store)).toEqual(['fuel']);
    expect(await store.categories.get('fuel')).toMatchObject({ isActive: true, isHidden: false });
    expect((await store.categories.get('fuel'))?.archiveReason).toBeUndefined();
    expect(await store.categories.get('pet_food')).toMatchObject({ isActive: false, isHidden: true });
    expect(await store.categories.get('parking')).toMatchObject({ isActive: false, isHidden: true, archiveReason: '用户归档' });
    expect(await store.categories.get('car_wash')).toMatchObject({ isActive: false, mergedIntoId: 'car_repair' });

    // 幂等：再开一次账本不会反复写。
    expect(await restoreMisdisabledDefaultCategories(store)).toEqual([]);
    await store.close();
  });
});
