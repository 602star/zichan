import { describe, expect, it } from 'vitest';
import { componentHostAt, fixedAssetAttributedCost, type FixedAsset, type FixedAssetEvent } from '../src/index.js';

const base = { createdAt: '', updatedAt: '', version: 1, isDeleted: false };
const item = (id: string, role: FixedAsset['role'] = 'item', bundledFromAssetId?: string): FixedAsset => ({
  ...base, id, name: id, role, bundledFromAssetId, categoryId: 'test', status: 'active',
  purchaseDate: '2024-01-01', baseCurrencyAssetId: 'CNY',
});
const event = (id: string, fixedAssetId: string, type: FixedAssetEvent['type'], date: string, amountBase: string, hostAssetId?: string): FixedAssetEvent => ({
  ...base, id, fixedAssetId, type, date, amountBase, hostAssetId,
});

describe('component cost attribution', () => {
  it('counts actual spending and part-sale proceeds without valuing bundled parts', () => {
    const laptop = item('laptop');
    const newRam = item('new-ram', 'component');
    const originalRam = item('original-ram', 'component', laptop.id);
    const events = [
      event('laptop-buy', laptop.id, 'purchase', '2024-01-01', '5000'),
      event('ram-buy', newRam.id, 'purchase', '2026-01-01', '2000'),
      event('ram-install', newRam.id, 'install', '2026-01-01', '0', laptop.id),
      event('original-buy', originalRam.id, 'purchase', '2024-01-01', '0'),
      event('original-sale', originalRam.id, 'sale', '2026-02-01', '400'),
    ];
    const cost = fixedAssetAttributedCost(laptop, [laptop, newRam, originalRam], events, { asOf: '2026-03-01' });
    expect(cost.investedCost).toBe('7000');
    expect(cost.recoveredCost).toBe('400');
    expect(cost.netCost).toBe('6600');
  });

  it('moves the full paid amount between hosts without another purchase', () => {
    const a = item('A');
    const b = item('B');
    const ram = item('ram', 'component');
    const events = [
      event('a-buy', a.id, 'purchase', '2024-01-01', '5000'),
      event('b-buy', b.id, 'purchase', '2024-01-01', '4000'),
      event('ram-buy', ram.id, 'purchase', '2025-01-01', '2000'),
      event('install-a', ram.id, 'install', '2025-01-02', '0', a.id),
      event('install-b', ram.id, 'install', '2026-01-02', '0', b.id),
    ];
    expect(componentHostAt(ram.id, events, '2025-06-01')).toBe(a.id);
    expect(fixedAssetAttributedCost(a, [a, b, ram], events, { asOf: '2025-06-01' }).netCost).toBe('7000');
    expect(fixedAssetAttributedCost(a, [a, b, ram], events, { asOf: '2026-06-01' }).netCost).toBe('5000');
    expect(fixedAssetAttributedCost(b, [a, b, ram], events, { asOf: '2026-06-01' }).netCost).toBe('6000');
  });
});
