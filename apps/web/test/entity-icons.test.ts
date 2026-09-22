import { describe, expect, it } from 'vitest';
import { categoryOptions, type Category } from '@zichan/core';
import { categoryIconValue, categoryOptionIcon } from '../src/ui/EntityIcon.js';
import { categoryForm, payeeForm } from '../src/forms.js';
import { makeSnapshot } from './fixtures.js';
import { readEntityIcon } from '../src/entity-icon-upload.js';

describe('entity icon defaults and edits', () => {
  it('rejects unsupported formats and oversized uploads before decoding', async () => {
    await expect(readEntityIcon(new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' }))).rejects.toThrow('PNG');
    await expect(readEntityIcon(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))).rejects.toThrow('2 MB');
  });
  it('keeps overrides through renamed categories and inherits custom parent icons', () => {
    const parent = { id: 'custom-parent', name: '自建父级', type: 'expense', icon: 'lucide:coffee', isActive: true } as Category;
    const child = { id: 'custom-child', name: '改名后的分类', parentId: parent.id, type: 'expense', isActive: true } as Category;
    expect(categoryIconValue(child.id, [parent, child])).toBe('lucide:coffee');
    expect(categoryOptionIcon(categoryOptions([parent, child], 'expense', { leafOnly: true }).find((option) => option.value === child.id)!)).toBe('lucide:coffee');
    expect(categoryIconValue('coffee_drinks')).toBe('lucide:coffee');
    expect(categoryIconValue('unknown')).toBe('lucide:other');
  });
  it('preserves saved icons through unrelated form edits and explicitly clears them on reset', () => {
    const snapshot = makeSnapshot();
    const category = { ...snapshot.categories[0]!, icon: 'lucide:coffee' };
    const categorySpec = categoryForm(snapshot);
    expect(categorySpec.fromValues(categorySpec.toValues(category), category).icon).toBe(category.icon);
    const payee = { ...category, name: '商家', icon: 'lucide:store', isActive: true };
    const spec = payeeForm(snapshot);
    expect(spec.fromValues(spec.toValues(payee), payee).icon).toBe(payee.icon);
    expect(spec.fromValues({ ...spec.toValues(payee), icon: '' }, payee).icon).toBe('');
  });
});
