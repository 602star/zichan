import {
  newId,
  type Asset,
  type LedgerKind,
  type LedgerMode,
  type Setting,
} from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import { DEFAULT_FIXED_ASSET_CATEGORIES } from '../fixedAssetCategories.js';
import {
  DEFAULT_ENABLED_CATEGORY_IDS,
  SYSTEM_CATEGORY_CATALOG,
  storedCategory,
} from '../transactionMeta.js';
import { seedDemoLedger } from './seed.js';

export interface BaseCurrencyChoice {
  code: 'CNY' | 'USD' | 'EUR' | 'GBP';
  name: string;
  symbol: string;
  decimals: number;
}

export const BASE_CURRENCY_CHOICES: readonly BaseCurrencyChoice[] = [
  { code: 'CNY', name: '人民币', symbol: '¥', decimals: 2 },
  { code: 'USD', name: '美元', symbol: '$', decimals: 2 },
  { code: 'EUR', name: '欧元', symbol: '€', decimals: 2 },
  { code: 'GBP', name: '英镑', symbol: '£', decimals: 2 },
];

export interface EmptyLedgerOptions {
  baseCurrencyCode: BaseCurrencyChoice['code'];
  ledgerMode: LedgerMode;
  initializedAt?: string;
}

function baseFields(id = newId()) {
  return { id, createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

function isInitialized(setting: Setting): boolean {
  return (setting.ledgerKind === 'personal' || setting.ledgerKind === 'demo')
    && typeof setting.initializedAt === 'string'
    && !Number.isNaN(Date.parse(setting.initializedAt));
}

/** Return the one initialized ledger setting, or null for a genuinely empty database. */
export async function initializedLedgerSetting(store: SqlLedgerStore): Promise<Setting | null> {
  const settings = await store.settings.list();
  if (settings.length > 1) throw new Error('数据库包含多个活动账本设置，无法安全继续初始化');
  const setting = settings[0];
  if (setting && isInitialized(setting)) return setting;
  const [assets, categories, fixedCategories] = await Promise.all([
    store.assets.count(),
    store.categories.count(),
    store.fixedAssetCategories.count(),
  ]);
  if (setting || assets || categories || fixedCategories) {
    throw new Error('数据库存在未完成的初始化数据，请重置开发数据或从外部备份恢复');
  }
  return null;
}

/** Create the minimal personal ledger in one transaction. */
export async function initializeEmptyLedger(
  store: SqlLedgerStore,
  options: EmptyLedgerOptions,
): Promise<Setting> {
  const currency = BASE_CURRENCY_CHOICES.find((row) => row.code === options.baseCurrencyCode);
  if (!currency) throw new Error(`不支持的基础币种：${options.baseCurrencyCode}`);
  if (!(['spending', 'accounts', 'assets'] as LedgerMode[]).includes(options.ledgerMode)) {
    throw new Error(`不支持的账本模式：${options.ledgerMode}`);
  }
  const initializedAt = options.initializedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(initializedAt))) throw new Error('初始化时间必须是有效的 ISO 时间');
  return store.runInAuditBatch('创建空账本', async (transaction) => {
    const existing = await initializedLedgerSetting(transaction);
    if (existing) throw new Error('账本已经初始化，不能重复创建');

    const asset = await transaction.assets.put({
      ...baseFields(),
      code: currency.code,
      name: currency.name,
      type: 'fiat',
      decimals: currency.decimals,
      symbol: currency.symbol,
      isActive: true,
    } as Asset);

    const setting = await transaction.settings.put({
      ...baseFields(),
      baseCurrencyAssetId: asset.id,
      transactionDefaultAssetId: asset.id,
      investmentCostAssetId: asset.id,
      fixedAssetDefaultCurrencyAssetId: asset.id,
      gameDefaultSettlementAssetId: asset.id,
      categoryPickerDefaultScope: 'frequent',
      refundAttributionMode: 'original_date',
      ledgerMode: options.ledgerMode,
      ledgerKind: 'personal',
      initializedAt,
      defaultLotMethod: 'fifo',
      asOfDate: new Date().toLocaleDateString('en-CA'),
    } as Setting);

    for (const category of SYSTEM_CATEGORY_CATALOG.filter((row) => DEFAULT_ENABLED_CATEGORY_IDS.has(row.id))) {
      await transaction.categories.put({ ...baseFields(), ...storedCategory(category) } as never);
    }
    for (const category of DEFAULT_FIXED_ASSET_CATEGORIES) {
      await transaction.fixedAssetCategories.put({ ...baseFields(), ...category } as never);
    }
    return setting;
  }, 'system', { undoable: false });
}

export async function initializeDemoLedger(store: SqlLedgerStore): Promise<Setting> {
  await seedDemoLedger(store);
  const setting = await initializedLedgerSetting(store);
  if (!setting || setting.ledgerKind !== 'demo') throw new Error('演示账本初始化没有完整提交');
  return setting;
}

export function importedLedgerKind(setting: Setting | undefined): LedgerKind {
  return setting?.ledgerKind === 'demo' ? 'demo' : 'personal';
}
