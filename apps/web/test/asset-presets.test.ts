import { describe, expect, it } from 'vitest';
import { openLedger } from '@zichan/db/node';
import { DEFAULT_FIXED_ASSET_CATEGORIES } from '../src/fixedAssetCategories.js';
import {
  ASSET_PRESETS,
  FIXED_ASSET_QUICK_PRESETS,
  ensureAssetPreset,
  fixedAssetPresetCategoryId,
} from '../src/assetPresets.js';

describe('zero-configuration asset presets', () => {
  it('creates only an asset definition and reuses it on the next selection', async () => {
    const store = await openLedger({ deviceId: 'asset-preset' });
    try {
      const first = await ensureAssetPreset(store, 'BTC');
      const second = await ensureAssetPreset(store, 'BTC');

      expect(first).toMatchObject({ change: 'created', asset: { code: 'BTC', type: 'crypto', decimals: 8 } });
      expect(second).toMatchObject({ change: 'existing', asset: { id: first.asset.id } });
      expect(await store.assets.count()).toBe(1);
      expect(await store.accounts.count()).toBe(0);
      expect(await store.conversionChains.count()).toBe(0);
      expect(await store.lots.count()).toBe(0);
      expect(await store.priceMarks.count()).toBe(0);
      expect(await store.transactions.count()).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('reactivates a matching archived definition instead of duplicating it', async () => {
    const store = await openLedger({ deviceId: 'asset-preset-reactivate' });
    try {
      const archived = await store.assets.put({
        id: 'archived-usd', createdAt: '', updatedAt: '', version: 1, isDeleted: true,
        code: 'usd', name: '旧美元', type: 'fiat', decimals: 2, isActive: false,
        archivedAt: '2026-08-01T00:00:00.000Z', archiveReason: '测试归档',
      });

      const result = await ensureAssetPreset(store, 'USD');
      expect(result).toMatchObject({
        change: 'reactivated',
        asset: { id: archived.id, code: 'USD', name: '美元', isDeleted: false, isActive: true },
      });
      expect(result.asset.archivedAt).toBeUndefined();
      expect(await store.assets.count()).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('maps every fixed-asset quick card to an existing leaf category', () => {
    expect(ASSET_PRESETS.map((preset) => preset.code)).toEqual(['USD', 'HKD', 'EUR', 'JPY', 'USDT', 'BTC', 'ETH']);
    expect(FIXED_ASSET_QUICK_PRESETS.map((preset) => [
      preset.label,
      fixedAssetPresetCategoryId(preset, DEFAULT_FIXED_ASSET_CATEGORIES as never),
    ])).toEqual([
      ['手机', 'fixed-electronics-phone'],
      ['电脑', 'fixed-electronics-computer'],
      ['家电', 'fixed-appliance-kitchen'],
      ['车辆', 'fixed-vehicle-car'],
    ]);
  });
});
