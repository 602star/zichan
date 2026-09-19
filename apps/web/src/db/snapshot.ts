import { useEffect, useState } from 'react';
import type {
  Account, Asset, Attachment, BaseEntity, BudgetCategory, Category, ChainWithSteps, Collection, DcaExecution, DcaPlan,
  FixedAsset, FixedAssetCategory, FixedAssetConsumable, FixedAssetEvent, FixedAssetGoal,
  FixedAssetCashflowLink, FixedAssetUsageLog, FixedAssetUsageMetric, Game, GameAccount, GameCashflowLink, GameRecord, GameSeason, Lot, LotConsumption, Payee, PriceMark,
  RefundAllocation,
  ReconciliationItem, ReconciliationSession, ScheduledExecution, ScheduledTransaction, Setting, Transaction, TransactionLocation,
  TransactionSavedView, TransactionSplit, TransactionTag, TransactionTemplate, Query,
} from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import { useStore } from './store.js';

export type SnapshotScope =
  | 'all'
  | 'shell'
  | 'dashboard'
  | 'transactions'
  | 'convert'
  | 'fixed'
  | 'game'
  | 'reports'
  | 'settings'
  | 'manage'
  | 'history'
  | 'sync';

/** Page-specific read model. Fields outside the requested scope are empty. */
export interface Snapshot {
  assets: Asset[];
  accounts: Account[];
  setting?: Setting;
  chains: ChainWithSteps[];
  lots: Lot[];
  lotConsumptions: LotConsumption[];
  priceMarks: PriceMark[];
  dcaPlans: DcaPlan[];
  dcaExecutions: DcaExecution[];
  games: Game[];
  gameAccounts: GameAccount[];
  seasons: GameSeason[];
  gameRecords: GameRecord[];
  gameCashflowLinks: GameCashflowLink[];
  fixedAssets: FixedAsset[];
  fixedAssetCategories: FixedAssetCategory[];
  fixedEvents: FixedAssetEvent[];
  fixedCashflowLinks: FixedAssetCashflowLink[];
  fixedUsageMetrics: FixedAssetUsageMetric[];
  fixedUsageLogs: FixedAssetUsageLog[];
  fixedConsumables: FixedAssetConsumable[];
  fixedGoals: FixedAssetGoal[];
  attachments: Attachment[];
  categories: Category[];
  transactionTags: TransactionTag[];
  transactionLocations: TransactionLocation[];
  transactionTemplates: TransactionTemplate[];
  transactionSavedViews: TransactionSavedView[];
  payees: Payee[];
  transactions: Transaction[];
  transactionSplits: TransactionSplit[];
  refundAllocations: RefundAllocation[];
  budgetCategories: BudgetCategory[];
  scheduledTransactions: ScheduledTransaction[];
  scheduledExecutions: ScheduledExecution[];
  reconciliationSessions: ReconciliationSession[];
  reconciliationItems: ReconciliationItem[];
  /** Exact SQL counts for collections loaded by this page. */
  rowCounts?: Partial<Record<SnapshotField, number>>;
}

type SnapshotField = Exclude<keyof Snapshot, 'setting' | 'chains' | 'rowCounts'> | 'settings' | 'chains';

const ALL_FIELDS: SnapshotField[] = [
  'assets', 'accounts', 'settings', 'chains', 'lots', 'lotConsumptions', 'priceMarks', 'dcaPlans', 'dcaExecutions',
  'games', 'gameAccounts', 'seasons', 'gameRecords', 'gameCashflowLinks', 'fixedAssets', 'fixedAssetCategories', 'fixedEvents',
  'fixedCashflowLinks', 'fixedUsageMetrics', 'fixedUsageLogs', 'fixedConsumables', 'fixedGoals', 'attachments',
  'categories', 'transactionTags', 'transactionLocations', 'transactionTemplates', 'transactionSavedViews',
  'payees', 'transactions', 'transactionSplits', 'refundAllocations', 'budgetCategories', 'scheduledTransactions',
  'scheduledExecutions', 'reconciliationSessions', 'reconciliationItems',
];

const SCOPE_FIELDS: Record<Exclude<SnapshotScope, 'all'>, SnapshotField[]> = {
  shell: ['assets', 'settings'],
  dashboard: [
    'assets', 'accounts', 'settings', 'chains', 'lots', 'priceMarks', 'dcaPlans', 'dcaExecutions',
    'games', 'gameAccounts', 'seasons', 'gameRecords', 'gameCashflowLinks', 'fixedAssets', 'fixedAssetCategories', 'fixedEvents',
    'fixedCashflowLinks', 'fixedUsageMetrics', 'fixedUsageLogs', 'fixedConsumables', 'fixedGoals',
    'categories', 'scheduledTransactions', 'scheduledExecutions',
  ],
  transactions: [
    'assets', 'accounts', 'settings', 'priceMarks', 'categories', 'transactionTags',
    'transactionLocations', 'transactionTemplates', 'transactionSavedViews', 'payees',
    'budgetCategories', 'scheduledTransactions', 'scheduledExecutions', 'reconciliationSessions',
  ],
  convert: [
    'assets', 'accounts', 'settings', 'chains', 'lots', 'lotConsumptions', 'priceMarks', 'dcaPlans', 'dcaExecutions',
  ],
  fixed: [
    'assets', 'accounts', 'settings', 'priceMarks', 'fixedAssets', 'fixedAssetCategories', 'fixedEvents',
    'fixedCashflowLinks', 'fixedUsageMetrics', 'fixedUsageLogs', 'fixedConsumables', 'fixedGoals',
    'attachments', 'categories', 'payees', 'transactions', 'transactionSplits', 'refundAllocations',
  ],
  game: [
    'assets', 'accounts', 'settings', 'priceMarks', 'games', 'gameAccounts', 'seasons', 'gameRecords', 'gameCashflowLinks',
    'categories', 'payees', 'transactions', 'transactionSplits', 'refundAllocations',
  ],
  reports: [
    'assets', 'accounts', 'settings', 'chains', 'priceMarks', 'dcaExecutions', 'games', 'gameAccounts', 'seasons',
    'gameRecords', 'gameCashflowLinks', 'fixedAssets', 'fixedAssetCategories', 'fixedEvents', 'fixedCashflowLinks',
    'fixedUsageMetrics', 'fixedUsageLogs', 'fixedConsumables', 'fixedGoals', 'categories', 'payees',
    'budgetCategories',
  ],
  settings: ['assets', 'accounts', 'settings', 'categories'],
  manage: [
    'assets', 'accounts', 'settings', 'priceMarks', 'dcaPlans', 'games', 'gameAccounts', 'seasons',
    'fixedAssetCategories', 'attachments', 'categories', 'transactionTags', 'transactionLocations',
    'transactionTemplates', 'payees', 'budgetCategories', 'scheduledTransactions', 'scheduledExecutions',
  ],
  history: [
    'assets', 'accounts', 'settings', 'games', 'seasons', 'fixedAssets', 'fixedAssetCategories',
    'categories', 'transactionTags', 'transactionLocations', 'payees',
  ],
  sync: [
    'assets', 'accounts', 'settings', 'games', 'seasons', 'fixedAssets', 'categories',
    'transactionTags', 'transactionLocations', 'payees', 'attachments',
  ],
};

const FIELD_ENTITY_TYPES: Record<SnapshotField, string[]> = {
  assets: ['asset'],
  accounts: ['account'],
  settings: ['setting'],
  chains: ['conversion_chain', 'conversion_chain_steps'],
  lots: ['lot'],
  lotConsumptions: ['lot_consumption'],
  priceMarks: ['price_mark'],
  dcaPlans: ['dca_plan'],
  dcaExecutions: ['dca_execution'],
  games: ['game'],
  gameAccounts: ['game_account'],
  seasons: ['game_season'],
  gameRecords: ['game_record'],
  gameCashflowLinks: ['game_cashflow_link'],
  fixedAssets: ['fixed_asset'],
  fixedAssetCategories: ['fixed_asset_category'],
  fixedEvents: ['fixed_asset_event'],
  fixedCashflowLinks: ['fixed_asset_cashflow_link'],
  fixedUsageMetrics: ['fixed_asset_usage_metric'],
  fixedUsageLogs: ['fixed_asset_usage_log'],
  fixedConsumables: ['fixed_asset_consumable'],
  fixedGoals: ['fixed_asset_goal'],
  attachments: ['attachment'],
  categories: ['category'],
  transactionTags: ['transaction_tag'],
  transactionLocations: ['transaction_location'],
  transactionTemplates: ['transaction_template'],
  transactionSavedViews: ['transaction_saved_view'],
  payees: ['payee'],
  transactions: ['transaction'],
  transactionSplits: ['transaction_split'],
  refundAllocations: ['refund_allocation'],
  budgetCategories: ['budget_category'],
  scheduledTransactions: ['scheduled_transaction'],
  scheduledExecutions: ['scheduled_execution'],
  reconciliationSessions: ['reconciliation_session'],
  reconciliationItems: ['reconciliation_item'],
};

function fieldsFor(scope: SnapshotScope): Set<SnapshotField> {
  return new Set(scope === 'all' ? ALL_FIELDS : SCOPE_FIELDS[scope]);
}

const PAGE_SIZE = 400;

async function pagedList<T extends BaseEntity>(
  collection: Collection<T>,
  query: Query<T> = {},
): Promise<{ rows: T[]; count: number }> {
  const count = await collection.count({ where: query.where, includeDeleted: query.includeDeleted });
  if (count === 0) return { rows: [], count };
  const rows: T[] = [];
  let cursor: import('@zichan/core').QueryCursor | undefined;
  while (rows.length < count) {
    const page = await collection.listPage({ ...query, limit: PAGE_SIZE, cursor });
    rows.push(...page.rows);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { rows, count };
}

export async function loadSnapshot(store: SqlLedgerStore, scope: SnapshotScope = 'all'): Promise<Snapshot> {
  const fields = fieldsFor(scope);
  const rowCounts: Partial<Record<SnapshotField, number>> = {};
  const load = async <T extends BaseEntity>(
    field: SnapshotField,
    collection: Collection<T>,
    query: Query<T> = {},
  ): Promise<T[]> => {
    if (!fields.has(field)) return [];
    const result = await pagedList(collection, query);
    rowCounts[field] = result.count;
    return result.rows;
  };
  const chainsRaw = await load('chains', store.conversionChains, { orderBy: 'date', desc: true });
  const stepsByChain = await store.listStepsByChains(chainsRaw.map((chain) => chain.id));
  const chains = chainsRaw.map((chain) => ({ chain, steps: stepsByChain.get(chain.id) ?? [] }));
  const [
    assets, accounts, settings, lots, lotConsumptions, priceMarks, dcaPlans, dcaExecutions,
    games, gameAccounts, seasons, gameRecords, gameCashflowLinks, fixedAssets, fixedAssetCategories, fixedEvents, fixedCashflowLinks,
    fixedUsageMetrics, fixedUsageLogs, fixedConsumables, fixedGoals,
    attachments, categories, transactionTags, transactionLocations, transactionTemplates,
    transactionSavedViews, payees, transactions, transactionSplits, refundAllocations, budgetCategories, scheduledTransactions,
    scheduledExecutions, reconciliationSessions, reconciliationItems,
  ] = await Promise.all([
    load('assets', store.assets),
    load('accounts', store.accounts),
    load('settings', store.settings),
    load('lots', store.lots),
    load('lotConsumptions', store.lotConsumptions),
    load('priceMarks', store.priceMarks),
    load('dcaPlans', store.dcaPlans),
    load('dcaExecutions', store.dcaExecutions, { orderBy: 'date' }),
    load('games', store.games),
    load('gameAccounts', store.gameAccounts),
    load('seasons', store.gameSeasons),
    load('gameRecords', store.gameRecords, { orderBy: 'date' }),
    load('gameCashflowLinks', store.gameCashflowLinks),
    load('fixedAssets', store.fixedAssets),
    load('fixedAssetCategories', store.fixedAssetCategories, { orderBy: 'sortOrder' }),
    load('fixedEvents', store.fixedAssetEvents),
    load('fixedCashflowLinks', store.fixedAssetCashflowLinks),
    load('fixedUsageMetrics', store.fixedAssetUsageMetrics, { orderBy: 'sortOrder' }),
    load('fixedUsageLogs', store.fixedAssetUsageLogs, { orderBy: 'date' }),
    load('fixedConsumables', store.fixedAssetConsumables, { orderBy: 'purchaseDate' }),
    load('fixedGoals', store.fixedAssetGoals, { orderBy: 'startDate' }),
    load('attachments', store.attachments),
    load('categories', store.categories, { orderBy: 'sortOrder' }),
    load('transactionTags', store.transactionTags, { orderBy: 'sortOrder' }),
    load('transactionLocations', store.transactionLocations, { orderBy: 'name' }),
    load('transactionTemplates', store.transactionTemplates, { orderBy: 'sortOrder' }),
    load('transactionSavedViews', store.transactionSavedViews, { orderBy: 'sortOrder' }),
    load('payees', store.payees, { orderBy: 'name' }),
    load('transactions', store.transactions, { orderBy: 'date', desc: true }),
    load('transactionSplits', store.transactionSplits),
    load('refundAllocations', store.refundAllocations),
    load('budgetCategories', store.budgetCategories, { orderBy: 'month', desc: true }),
    load('scheduledTransactions', store.scheduledTransactions, { orderBy: 'anchorDate' }),
    load('scheduledExecutions', store.scheduledExecutions, { orderBy: 'occurrenceDate' }),
    load('reconciliationSessions', store.reconciliationSessions, { orderBy: 'statementDate', desc: true }),
    load('reconciliationItems', store.reconciliationItems, { orderBy: 'selectedAt' }),
  ]);
  return {
    assets, accounts, setting: settings[0], chains, lots, lotConsumptions, priceMarks, dcaPlans, dcaExecutions,
    games, gameAccounts, seasons, gameRecords, gameCashflowLinks, fixedAssets, fixedAssetCategories, fixedEvents, fixedCashflowLinks,
    fixedUsageMetrics, fixedUsageLogs, fixedConsumables, fixedGoals, attachments,
    categories, transactionTags, transactionLocations, transactionTemplates, transactionSavedViews,
    payees, transactions, transactionSplits, refundAllocations, budgetCategories, scheduledTransactions,
    scheduledExecutions, reconciliationSessions, reconciliationItems,
    rowCounts,
  };
}

export function useSnapshot(scope: SnapshotScope = 'all'): Snapshot | null {
  const { store } = useStore();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const entityTypes = new Set([...fieldsFor(scope)].flatMap((field) => FIELD_ENTITY_TYPES[field]));
    return store.subscribe((change) => {
      if (change.entityTypes.includes('*') || change.entityTypes.some((type) => entityTypes.has(type))) {
        setRevision((value) => value + 1);
      }
    });
  }, [scope, store]);
  useEffect(() => {
    let cancelled = false;
    void loadSnapshot(store, scope).then((s) => {
      if (!cancelled) setSnap(s);
    });
    return () => {
      cancelled = true;
    };
  }, [revision, scope, store]);
  return snap;
}
