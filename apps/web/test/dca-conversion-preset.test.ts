import type { Asset, DcaPlan } from '@zichan/core';
import { describe, expect, it } from 'vitest';
import { buildDcaConversionPreset } from '../src/dca-conversion-preset.js';

const entity = { createdAt: '', updatedAt: '', version: 1, isDeleted: false };
const assets: Asset[] = [
  { ...entity, id: 'gbp', code: 'GBP', name: '英镑', type: 'fiat', decimals: 2, isActive: true },
  { ...entity, id: 'usdt', code: 'USDT', name: 'USDT', type: 'stablecoin', decimals: 6, isActive: true },
  { ...entity, id: 'btc', code: 'BTC', name: '比特币', type: 'crypto', decimals: 8, isActive: true },
];
const plan: DcaPlan = {
  ...entity,
  id: 'plan',
  name: '每月买 BTC',
  targetAssetId: 'btc',
  baseCurrencyAssetId: 'gbp',
  defaultPath: 'GBP → USDT → BTC',
  anchorDate: '2026-01-01',
  anchorMode: 'calendar_day',
  timezone: 'Asia/Shanghai',
  frequency: 'monthly',
  plannedAmount: '100',
  status: 'active',
};

describe('DCA conversion preset', () => {
  it('resolves a unique default path and prefills the planned source amount', () => {
    expect(buildDcaConversionPreset(plan, assets)).toMatchObject({
      planId: 'plan',
      bookCurrencyAssetId: 'gbp',
      plannedAmount: '100',
      assetPathIds: ['gbp', 'usdt', 'btc'],
      pathWarning: undefined,
    });
  });

  it('falls back to one step when codes are ambiguous or endpoints are wrong', () => {
    const duplicate = { ...assets[1]!, id: 'usdt-duplicate' };
    const ambiguous = buildDcaConversionPreset(plan, [...assets, duplicate]);
    expect(ambiguous.assetPathIds).toEqual(['gbp', 'btc']);
    expect(ambiguous.pathWarning).toContain('安全回退');

    const wrongEndpoints = buildDcaConversionPreset({ ...plan, defaultPath: 'USDT → BTC' }, assets);
    expect(wrongEndpoints.assetPathIds).toEqual(['gbp', 'btc']);
  });
});
