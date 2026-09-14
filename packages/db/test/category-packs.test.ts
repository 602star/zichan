import { describe, expect, it } from 'vitest';
import { CATEGORY_PACKS, type Category } from '@zichan/core';
import {
  disableSystemCategories,
  enableSystemCategories,
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
});
