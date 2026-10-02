import { describe, expect, it } from 'vitest';
import { openLedger } from '@zichan/db/node';
import { DEFAULT_FIXED_ASSET_CATEGORIES } from '../src/fixedAssetCategories.js';
import { loadSnapshot } from '../src/db/snapshot.js';
import {
  ASSET_PRESETS,
  ASSET_PRESET_GROUPS,
  FEATURED_ASSET_PRESET_CODES,
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

  it('keeps archived assets visible in management while conversion selectors omit them', async () => {
    const store = await openLedger({ deviceId: 'asset-preset-management' });
    try {
      await store.assets.put({
        id: 'archived-nzd', createdAt: '', updatedAt: '', version: 1, isDeleted: true,
        code: 'NZD', name: '新西兰元', type: 'fiat', decimals: 2, isActive: false,
      });
      expect((await loadSnapshot(store, 'manage')).assets.map((asset) => asset.code)).toContain('NZD');
      expect((await loadSnapshot(store, 'convert')).assets.map((asset) => asset.code)).not.toContain('NZD');
    } finally {
      await store.close();
    }
  });

  it('keeps a unique, grouped common-currency catalog with valid featured entries', () => {
    expect(ASSET_PRESETS.map((preset) => preset.code)).toEqual([
      'CNY', 'USD', 'HKD', 'EUR', 'GBP', 'JPY', 'SGD', 'TWD', 'AUD', 'NZD', 'CAD', 'CHF',
      'USDT', 'USDC', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'SHIB', 'PEPE',
    ]);
    expect(new Set(ASSET_PRESETS.map((preset) => preset.code)).size).toBe(ASSET_PRESETS.length);
    expect(FEATURED_ASSET_PRESET_CODES.every((code) => ASSET_PRESETS.some((preset) => preset.code === code))).toBe(true);
    expect(ASSET_PRESET_GROUPS.find((group) => group.label === 'Meme 币')?.codes).toEqual(['DOGE', 'SHIB', 'PEPE']);
    expect(ASSET_PRESET_GROUPS.flatMap((group) => group.codes).sort()).toEqual(ASSET_PRESETS.map((preset) => preset.code).sort());
  });

  it('maps every fixed-asset quick card to an existing leaf category', () => {
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
