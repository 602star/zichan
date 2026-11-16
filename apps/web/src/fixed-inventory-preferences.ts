import { defaultFixedFilters, type FixedInventoryFilters } from '@zichan/core';
import { accountLocalStorage, accountSessionStorage } from './account-storage.js';

const filterKey = (ledgerId: string) => `zichan.fixed.filters.${ledgerId}`;
const displayKey = (ledgerId: string) => `zichan.fixed.display.${ledgerId}`;

/** Search stays in this tab; the presentation choice survives closing the app. */
export function loadFixedInventoryFilters(ledgerId: string, initialAttention = false): FixedInventoryFilters {
  let filters = defaultFixedFilters();
  try { filters = { ...filters, ...JSON.parse(accountSessionStorage.getItem(filterKey(ledgerId)) ?? '{}') }; } catch { /* Use defaults when storage is unavailable. */ }
  let display: FixedInventoryFilters['display'] = 'cards';
  try {
    const saved = accountLocalStorage.getItem(displayKey(ledgerId));
    if (saved === 'cards' || saved === 'list') display = saved;
  } catch { /* A private browser can deny persistent storage. */ }
  return { ...filters, display, ...(initialAttention ? { attentionOnly: true } : {}) };
}

export function saveFixedInventoryFilters(ledgerId: string, filters: FixedInventoryFilters, rememberDisplay: boolean): void {
  try { accountSessionStorage.setItem(filterKey(ledgerId), JSON.stringify(filters)); } catch { /* The current view remains usable. */ }
  if (rememberDisplay) {
    try { accountLocalStorage.setItem(displayKey(ledgerId), filters.display); } catch { /* The current view remains usable. */ }
  }
}
