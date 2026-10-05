import { describe, expect, it } from 'vitest';
import type { Category, FixedAssetCategory } from '@zichan/core';
import { fixedAssetForm, fixedConsumableForm, fixedEventForm, fixedUpgradeConversionForm } from '../src/forms.js';
import { makeSnapshot } from './fixtures.js';

describe('fixed asset cashflow category', () => {
  const category = (id: string): Category => ({
    id, name: id, type: 'expense', parentId: 'expense_shopping', isActive: true,
    isDeleted: false, budgetable: true, sortOrder: 1, createdAt: '', updatedAt: '', version: 1,
  });

  it('suggests a matching expense when creating an asset or changing its classification', () => {
    const snap = makeSnapshot();
    snap.categories.push(category('digital_goods'), category('furniture_appliance'), category('other_shopping'));
    snap.fixedAssetCategories.push({
      ...snap.fixedAssetCategories[1]!, id: 'fixed-appliance-fridge', parentId: 'fixed-appliance',
    } as FixedAssetCategory);
    const spec = fixedAssetForm(snap);
    const cashflowField = spec.fields.find((field) => field.key === 'cashflowCategory');

    expect(cashflowField?.defaultValue).toBe('digital_goods');
    expect(spec.onFieldChange?.({ categoryId: 'fixed-appliance-fridge', cashflowCategory: 'digital_goods' }, 'categoryId', new Set()).cashflowCategory).toBe('furniture_appliance');
    expect(spec.onFieldChange?.({ categoryId: 'fixed-appliance-fridge', cashflowCategory: 'digital_goods' }, 'categoryId', new Set(['cashflowCategory'])).cashflowCategory).toBe('digital_goods');
    expect(spec.onFieldChange?.({ categoryId: 'fixed-appliance-fridge', cashflowMode: 'create_transaction', cashflowCategory: '' }, 'cashflowMode', new Set()).cashflowCategory).toBe('furniture_appliance');
  });

  it('uses other shopping for an unclassified item', () => {
    const snap = makeSnapshot();
    const spec = fixedAssetForm(snap);
    expect(spec.onFieldChange?.({ categoryId: 'fixed-other-unclassified' }, 'categoryId', new Set()).cashflowCategory).toBe('other_shopping');
  });
});

describe('fixed asset event cashflow category', () => {
  it('suggests repair and sale categories when the event type changes', () => {
    const snap = makeSnapshot();
    snap.fixedAssetCategories[1] = { ...snap.fixedAssetCategories[1]!, id: 'fixed-electronics-computer' };
    snap.fixedAssets[0] = { ...snap.fixedAssets[0]!, categoryId: 'fixed-electronics-computer' };
    const spec = fixedEventForm(snap, snap.fixedAssets[0]!.id);
    const change = spec.onFieldChange!;

    expect(change({ type: 'repair', cashflowCategory: '' }, 'type', new Set()).cashflowCategory).toBe('');
    expect(change({ type: 'upgrade', cashflowCategory: '' }, 'type', new Set()).cashflowCategory).toBe('computer_accessories');
    expect(change({ type: 'upgrade', cashflowMode: 'create_transaction', cashflowCategory: '' }, 'cashflowMode', new Set()).cashflowCategory).toBe('computer_accessories');
    expect(change({ type: 'sale', cashflowCategory: 'computer_accessories' }, 'type', new Set(['cashflowCategory'])).cashflowCategory).toBe('sale_income');
    expect(change({ type: 'sale', cashflowCategory: 'sale_income' }, 'type', new Set(['cashflowCategory'])).cashflowCategory).toBe('sale_income');
    const types = spec.fields.find((field) => field.key === 'type')?.options;
    expect(types).not.toEqual(expect.arrayContaining([expect.objectContaining({ value: 'install' })]));
    expect(types).not.toEqual(expect.arrayContaining([expect.objectContaining({ value: 'detach' })]));
  });

  it('prefers a component category matching the host for upgrade conversion', () => {
    const snap = makeSnapshot();
    snap.fixedAssetCategories.push(
      { ...snap.fixedAssetCategories[1]!, id: 'fixed-electronics-component', parentId: 'fixed-electronics', isActive: true },
      { ...snap.fixedAssetCategories[1]!, id: 'fixed-other-component', parentId: 'fixed-other', isActive: true },
    );
    const host = snap.fixedAssets[0]!;
    const upgrade = { ...snap.fixedEvents[0]!, type: 'upgrade' as const, amountBase: '2000' };
    expect(fixedUpgradeConversionForm(snap, host, upgrade).fields.find((field) => field.key === 'categoryId')?.defaultValue)
      .toBe('fixed-electronics-component');
    expect(fixedUpgradeConversionForm(snap, { ...host, categoryId: 'fixed-other-item' }, upgrade)
      .fields.find((field) => field.key === 'categoryId')?.defaultValue).toBe('fixed-other-component');
  });
});

describe('consumable cashflow category', () => {
  it('suggests an expense based on the host item instead of an unrelated food category', () => {
    const snap = makeSnapshot();
    const category = (id: string): Category => ({
      id, name: id, type: 'expense', parentId: 'expense_shopping', isActive: true,
      isDeleted: false, budgetable: true, sortOrder: 1, createdAt: '', updatedAt: '', version: 1,
    });
    snap.categories.push(category('computer_accessories'), category('other_shopping'));
    snap.fixedAssetCategories[1] = { ...snap.fixedAssetCategories[1]!, id: 'fixed-electronics-computer' };
    snap.fixedAssets[0] = { ...snap.fixedAssets[0]!, categoryId: 'fixed-electronics-computer' };
    const spec = fixedConsumableForm(snap, snap.fixedAssets[0]!.id, []);
    expect(spec.fields.find((field) => field.key === 'cashflowCategory')?.defaultValue).toBe('computer_accessories');
    expect(spec.onFieldChange?.({ cashflowMode: 'create_transaction', cashflowCategory: '' }, 'cashflowMode', new Set()).cashflowCategory)
      .toBe('computer_accessories');
    expect(spec.onFieldChange?.({ cashflowMode: 'create_transaction', cashflowCategory: 'food' }, 'cashflowMode', new Set(['cashflowCategory'])).cashflowCategory)
      .toBe('food');
  });
});
