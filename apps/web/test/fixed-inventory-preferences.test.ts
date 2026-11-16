import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFixedFilters } from '@zichan/core';
import { accountLocalStorage, accountSessionStorage } from '../src/account-storage.js';
import { loadFixedInventoryFilters, saveFixedInventoryFilters } from '../src/fixed-inventory-preferences.js';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); }, clear: () => data.clear(), key: (index) => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('sessionStorage', memoryStorage()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('物品展示偏好', () => {
  it('defaults to cards, including a session that still contains the old list default', () => {
    expect(defaultFixedFilters().display).toBe('cards');
    accountSessionStorage.setItem('zichan.fixed.filters.a', JSON.stringify({ query: '厨房', display: 'list' }));
    expect(loadFixedInventoryFilters('a')).toMatchObject({ query: '厨房', display: 'cards' });
    expect(loadFixedInventoryFilters('a', true).attentionOnly).toBe(true);
  });
  it('keeps an explicit view across sessions without persisting searches or affecting another ledger', () => {
    saveFixedInventoryFilters('a', { ...defaultFixedFilters(), display: 'list', query: '咖啡机' }, true);
    sessionStorage.clear();
    expect(loadFixedInventoryFilters('a')).toMatchObject({ display: 'list', query: '' });
    expect(loadFixedInventoryFilters('b').display).toBe('cards');
    saveFixedInventoryFilters('a', { ...defaultFixedFilters(), display: 'list', attentionOnly: true }, false);
    expect(loadFixedInventoryFilters('a')).toMatchObject({ display: 'list', attentionOnly: true });
    saveFixedInventoryFilters('a', defaultFixedFilters(), true);
    sessionStorage.clear();
    expect(loadFixedInventoryFilters('a').display).toBe('cards');
  });
  it('recovers from invalid values and denied storage', () => {
    accountLocalStorage.setItem('zichan.fixed.display.a', 'unknown');
    accountSessionStorage.setItem('zichan.fixed.filters.a', '{invalid');
    expect(loadFixedInventoryFilters('a')).toEqual(defaultFixedFilters());
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(loadFixedInventoryFilters('a').display).toBe('cards');
    expect(() => saveFixedInventoryFilters('a', defaultFixedFilters(), true)).not.toThrow();
  });
});
