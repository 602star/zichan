import { newId, type Asset, type AssetType, type FixedAssetCategory } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';

export interface AssetPreset {
  code: 'USD' | 'HKD' | 'EUR' | 'JPY' | 'USDT' | 'BTC' | 'ETH';
  name: string;
  type: AssetType;
  decimals: number;
  symbol?: string;
}

export type AssetPresetCode = AssetPreset['code'];

export const ASSET_PRESETS: readonly AssetPreset[] = [
  { code: 'USD', name: '美元', type: 'fiat', decimals: 2, symbol: '$' },
  { code: 'HKD', name: '港币', type: 'fiat', decimals: 2, symbol: 'HK$' },
  { code: 'EUR', name: '欧元', type: 'fiat', decimals: 2, symbol: '€' },
  { code: 'JPY', name: '日元', type: 'fiat', decimals: 0, symbol: '¥' },
  { code: 'USDT', name: '泰达币', type: 'stablecoin', decimals: 6 },
  { code: 'BTC', name: '比特币', type: 'crypto', decimals: 8 },
  { code: 'ETH', name: '以太坊', type: 'crypto', decimals: 8 },
] as const;

export function assetPreset(code: AssetPresetCode): AssetPreset {
  const preset = ASSET_PRESETS.find((row) => row.code === code);
  if (!preset) throw new Error(`不支持的常用资产：${code}`);
  return preset;
}

export function activeAssetByCode(assets: readonly Asset[], code: string): Asset | undefined {
  const normalized = code.trim().toUpperCase();
  return assets.find((row) => !row.isDeleted && row.isActive && !row.mergedIntoId && row.code.trim().toUpperCase() === normalized);
}

export interface EnsuredAssetPreset {
  asset: Asset;
  change: 'existing' | 'created' | 'reactivated';
}

/**
 * Ensure one selectable asset definition exists. This deliberately writes no
 * balance, price, lot or conversion data.
 */
export async function ensureAssetPreset(
  store: SqlLedgerStore,
  code: AssetPresetCode,
): Promise<EnsuredAssetPreset> {
  const preset = assetPreset(code);
  const currentRows = await store.assets.list({ includeDeleted: true });
  const active = activeAssetByCode(currentRows, preset.code);
  if (active) return { asset: active, change: 'existing' };

  return store.runInAuditBatch(`启用常用资产 ${preset.code}`, async (transactionStore) => {
    const rows = await transactionStore.assets.list({ includeDeleted: true });
    const concurrent = activeAssetByCode(rows, preset.code);
    if (concurrent) return { asset: concurrent, change: 'existing' } as EnsuredAssetPreset;

    const reusable = rows.find((row) => !row.mergedIntoId && row.code.trim().toUpperCase() === preset.code);
    if (reusable) {
      const asset = await transactionStore.assets.put({
        ...reusable,
        code: preset.code,
        name: preset.name,
        type: preset.type,
        decimals: preset.decimals,
        symbol: preset.symbol,
        isDeleted: false,
        isActive: true,
        archivedAt: undefined,
        archiveReason: undefined,
      });
      return { asset, change: 'reactivated' } as EnsuredAssetPreset;
    }

    const asset = await transactionStore.assets.put({
      id: newId(),
      createdAt: '',
      updatedAt: '',
      version: 1,
      isDeleted: false,
      ...preset,
      isActive: true,
    } as Asset);
    return { asset, change: 'created' } as EnsuredAssetPreset;
  });
}

export interface FixedAssetQuickPreset {
  key: 'phone' | 'computer' | 'appliance' | 'vehicle';
  label: string;
  hint: string;
  preferredCategoryId: string;
  parentCategoryId: string;
}

export const FIXED_ASSET_QUICK_PRESETS: readonly FixedAssetQuickPreset[] = [
  { key: 'phone', label: '手机', hint: '手机与移动设备', preferredCategoryId: 'fixed-electronics-phone', parentCategoryId: 'fixed-electronics' },
  { key: 'computer', label: '电脑', hint: '笔记本与台式机', preferredCategoryId: 'fixed-electronics-computer', parentCategoryId: 'fixed-electronics' },
  { key: 'appliance', label: '家电', hint: '预选厨房电器，可在表单内更改', preferredCategoryId: 'fixed-appliance-kitchen', parentCategoryId: 'fixed-appliance' },
  { key: 'vehicle', label: '车辆', hint: '汽车与日常出行车辆', preferredCategoryId: 'fixed-vehicle-car', parentCategoryId: 'fixed-vehicle' },
] as const;

export function fixedAssetPresetCategoryId(
  preset: FixedAssetQuickPreset,
  categories: readonly FixedAssetCategory[],
): string | undefined {
  const usable = (category: FixedAssetCategory) => !category.isDeleted && category.isActive && !!category.parentId;
  const preferred = categories.find((category) => category.id === preset.preferredCategoryId && usable(category));
  if (preferred) return preferred.id;
  return categories
    .filter((category) => category.parentId === preset.parentCategoryId && usable(category))
    .sort((left, right) => (left.sortOrder ?? 100) - (right.sortOrder ?? 100) || left.name.localeCompare(right.name, 'zh-CN'))[0]?.id;
}
