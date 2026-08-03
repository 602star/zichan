/** Test fixtures — build a small but representative Snapshot for selector tests. */
import { newId } from '@zichan/core';
import type {
  Asset, Account, BudgetCategory, Category, Setting, ConversionChain, ConversionStep, Lot, Payee, PriceMark,
  FixedAsset, FixedAssetCategory, FixedAssetEvent, Game, GameSeason, GameRecord, ReconciliationItem, ReconciliationSession,
  ScheduledExecution, ScheduledTransaction, Transaction, TransactionLocation, TransactionSavedView, TransactionSplit, TransactionTag, TransactionTemplate,
} from '@zichan/core';
import type { Snapshot } from '../src/db/snapshot.js';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

export function makeSnapshot(): Snapshot & { ids: Record<string, string> } {
  const gbp: Asset = { ...base(), code: 'GBP', name: '英镑', type: 'fiat', decimals: 2, symbol: '£', isActive: true } as Asset;
  const btc: Asset = { ...base(), code: 'BTC', name: '比特币', type: 'crypto', decimals: 8, isActive: true } as Asset;

  const external: Account = { ...base(), name: '外部/入金', kind: 'other' } as Account;
  const bank: Account = { ...base(), name: '银行', kind: 'bank' } as Account;
  const cash: Account = { ...base(), name: '现金', kind: 'cash' } as Account;
  const foodParent: Category = { ...base(), id: 'food_parent', name: '餐饮', type: 'expense', isActive: true, budgetable: true, sortOrder: 5 } as Category;
  const food: Category = { ...base(), id: 'food', name: '餐饮/正餐', type: 'expense', parentId: foodParent.id, isActive: true, budgetable: true, sortOrder: 10 } as Category;
  const transport: Category = { ...base(), id: 'transport', name: '交通', type: 'expense', isActive: true, budgetable: true, sortOrder: 20 } as Category;
  const salary: Category = { ...base(), id: 'salary', name: '工资', type: 'income', isActive: true, budgetable: false, sortOrder: 100 } as Category;
  const shopping: Category = { ...base(), id: 'shopping', name: '购物', type: 'expense', isActive: true, budgetable: true, sortOrder: 30 } as Category;
  const cafe: Payee = { ...base(), name: 'Cafe', defaultCategory: 'food', defaultAccountId: bank.id, isActive: true } as Payee;
  const reimbursable: TransactionTag = { ...base(), id: 'tag-reimburse', name: '待报销', groupName: '报销', isActive: true, sortOrder: 10 } as TransactionTag;
  const office: TransactionLocation = { ...base(), id: 'loc-office', name: '公司附近', isActive: true } as TransactionLocation;
  const lunchTpl: TransactionTemplate = { ...base(), id: 'tpl-lunch', name: '午餐', type: 'expense', category: 'food', amount: '10', assetId: gbp.id, tagIds: [reimbursable.id], locationId: office.id, isActive: true, sortOrder: 10 } as TransactionTemplate;

  const setting: Setting = { ...base(), baseCurrencyAssetId: gbp.id, transactionDefaultAssetId: gbp.id, investmentCostAssetId: gbp.id, fixedAssetDefaultCurrencyAssetId: gbp.id, gameDefaultSettlementAssetId: gbp.id, categoryPickerDefaultScope: 'frequent', ledgerMode: 'spending', defaultLotMethod: 'fifo', asOfDate: '2026-03-04' } as Setting;

  // deposit £1000 external → bank
  const depChain: ConversionChain = { ...base(), date: '2026-01-01', type: 'deposit', baseCurrencyAssetId: gbp.id } as ConversionChain;
  const depStep: ConversionStep = {
    id: newId(), chainId: depChain.id, order: 1,
    fromAssetId: gbp.id, fromAmount: '1000', toAssetId: gbp.id, toAmount: '1000',
    accountFromId: external.id, accountToId: bank.id,
  };

  // buy £600 → 0.01 BTC
  const buyChain: ConversionChain = {
    ...base(), date: '2026-02-01', type: 'dca', baseCurrencyAssetId: gbp.id,
    finalAssetId: btc.id, finalAmount: '0.01', totalBaseCost: '600', totalFeesInBase: '0',
  } as ConversionChain;
  const buyStep: ConversionStep = {
    id: newId(), chainId: buyChain.id, order: 1,
    fromAssetId: gbp.id, fromAmount: '600', toAssetId: btc.id, toAmount: '0.01',
  };

  const lot: Lot = {
    ...base(), assetId: btc.id, sourceChainId: buyChain.id, acquiredDate: '2026-02-01',
    originalAmount: '0.01', baseCost: '600', baseCurrencyAssetId: gbp.id, remainingAmount: '0.01', status: 'open',
  } as Lot;

  const mark: PriceMark = { ...base(), assetId: btc.id, quoteAssetId: gbp.id, price: '70000', date: '2026-03-01', source: 'manual' } as PriceMark;

  const fixedParent: FixedAssetCategory = { ...base(), id: 'fixed-electronics', name: '数码电子', isActive: true, sortOrder: 10 } as FixedAssetCategory;
  const fixedCategory: FixedAssetCategory = { ...base(), id: 'fixed-computer', name: '电脑', parentId: fixedParent.id, isActive: true, sortOrder: 10 } as FixedAssetCategory;
  const fixed: FixedAsset = { ...base(), name: '笔记本', categoryId: fixedCategory.id, tag: '工作机', status: 'active', purchaseDate: '2025-01-01', baseCurrencyAssetId: gbp.id } as FixedAsset;
  const fe1: FixedAssetEvent = { ...base(), fixedAssetId: fixed.id, type: 'purchase', date: '2025-01-01', amountBase: '500', cashflowMode: 'record_only' } as FixedAssetEvent;
  const fe2: FixedAssetEvent = { ...base(), fixedAssetId: fixed.id, type: 'residual_update', date: '2026-03-01', amountBase: '300', valueMode: 'residual', enteredAmount: '300' } as FixedAssetEvent;

  const game: Game = { ...base(), name: '测试游戏', platform: 'PC', enableSeason: true } as Game;
  const season: GameSeason = { ...base(), gameId: game.id, name: 'S1', status: 'active', startDate: '2026-01-01', hours: '10' } as GameSeason;
  const rec: GameRecord = { ...base(), date: '2026-02-01', gameId: game.id, seasonId: season.id, recordType: 'sell_currency', settlementAssetId: gbp.id, settlementAmount: '50' } as GameRecord;

  const snap: Snapshot = {
    assets: [gbp, btc], accounts: [external, bank, cash], setting,
    chains: [{ chain: buyChain, steps: [buyStep] }, { chain: depChain, steps: [depStep] }],
    lots: [lot], priceMarks: [mark], dcaPlans: [], dcaExecutions: [],
    games: [game], gameAccounts: [], seasons: [season], gameRecords: [rec],
    fixedAssets: [fixed], fixedAssetCategories: [fixedParent, fixedCategory], fixedEvents: [fe1, fe2], fixedCashflowLinks: [],
    fixedUsageMetrics: [], fixedUsageLogs: [], fixedConsumables: [], fixedGoals: [], attachments: [],
    categories: [foodParent, food, transport, salary, shopping], transactionTags: [reimbursable],
    transactionLocations: [office], transactionTemplates: [lunchTpl],
    transactionSavedViews: [] as TransactionSavedView[],
    payees: [cafe], transactions: [],
    transactionSplits: [] as TransactionSplit[], refundAllocations: [],
    budgetCategories: [] as BudgetCategory[],
    scheduledTransactions: [] as ScheduledTransaction[],
    scheduledExecutions: [] as ScheduledExecution[],
    reconciliationSessions: [] as ReconciliationSession[],
    reconciliationItems: [] as ReconciliationItem[],
  };
  return Object.assign(snap, { ids: { gbp: gbp.id, btc: btc.id, external: external.id, bank: bank.id, cash: cash.id, game: game.id, cafe: cafe.id } });
}

export function makeTransaction(overrides: Partial<Transaction>): Transaction {
  return {
    ...base(),
    date: '2026-03-02',
    type: 'expense',
    category: 'food',
    amount: '10',
    assetId: '',
    ...overrides,
  } as Transaction;
}
