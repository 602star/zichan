/**
 * Declarative table specs. Each BaseEntity table = the 5 common columns
 * (id/created_at/updated_at/version/is_deleted) + a compact list of typed
 * columns. DDL, INSERT/SELECT, and row⇄entity mapping are all derived from these,
 * so adding a field is a one-line change. Column names are snake_case of the
 * entity field. See docs/db.md.
 */
import type { BaseEntity } from '@zichan/core';

export type ColType = 'text' | 'int' | 'real' | 'bool';

export interface Col {
  field: string; // camelCase entity key
  col: string; // snake_case sql column
  type: ColType;
}

export interface TableSpec {
  name: string;
  /** Columns beyond the common BaseEntity ones. */
  cols: Col[];
  /** Extra indexes: index name -> columns. */
  indexes?: { name: string; cols: string[]; unique?: boolean; where?: string }[];
}

export function snake(field: string): string {
  return field.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}

/** Shorthand column definition. */
function c(field: string, type: ColType = 'text'): Col {
  return { field, col: snake(field), type };
}

/** The 5 columns every BaseEntity table carries. */
export const BASE_COLS: Col[] = [
  { field: 'id', col: 'id', type: 'text' },
  { field: 'createdAt', col: 'created_at', type: 'text' },
  { field: 'updatedAt', col: 'updated_at', type: 'text' },
  { field: 'version', col: 'version', type: 'int' },
  { field: 'isDeleted', col: 'is_deleted', type: 'bool' },
];

export function allCols(spec: TableSpec): Col[] {
  // id first, then entity cols, then the audit/sync tail.
  return [BASE_COLS[0]!, ...spec.cols, ...BASE_COLS.slice(1)];
}

// ─────────────────────────── Registry ───────────────────────────

export const TABLES = {
  assets: {
    name: 'assets',
    cols: [
      c('code'), c('name'), c('type'), c('decimals', 'int'), c('symbol'), c('isActive', 'bool'),
      c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [{ name: 'idx_assets_type', cols: ['type'] }],
  },
  accounts: {
    name: 'accounts',
    cols: [
      c('purpose'), c('openingBalance'), c('openingAssetId'), c('balanceStartAt'), c('balanceStartDate'), c('balanceCheckpoints'),
      c('name'), c('kind'), c('platform'), c('statementDay', 'int'), c('paymentDueDay', 'int'),
      c('creditLimit'), c('loanPrincipal'), c('annualInterestRate'), c('loanStartDate'), c('loanEndDate'),
      c('isActive', 'bool'), c('archivedAt'),
      c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
  },
  settings: {
    name: 'settings',
    cols: [
      c('baseCurrencyAssetId'), c('transactionDefaultAssetId'), c('investmentCostAssetId'),
      c('fixedAssetDefaultCurrencyAssetId'), c('gameDefaultSettlementAssetId'),
      c('ledgerMode'), c('ledgerKind'), c('initializedAt'), c('defaultLotMethod'), c('asOfDate'), c('timezone'),
      c('expenseDefaultAccountId'), c('incomeDefaultAccountId'), c('asOfMode'),
      c('transactionFormOptionalFields'), c('categoryPickerDefaultScope'), c('navigationLayoutJson'), c('refundAttributionMode'), c('dataSafetyStateJson'), c('syncServersJson'),
    ],
    indexes: [
      { name: 'idx_settings_single_active', cols: ['is_deleted'], unique: true, where: 'is_deleted = 0' },
    ],
  },
  conversionChains: {
    name: 'conversion_chains',
    cols: [
      c('date'), c('time'), c('timezone'), c('timePrecision'), c('occurredAtUtc'), c('utcOffsetMinutes', 'int'), c('timeDisambiguation'),
      c('type'), c('title'), c('baseCurrencyAssetId'), c('bookValueInBase'),
      c('relatedDcaExecutionId'), c('lotMethod'), c('manualLotIds'), c('recordState'), c('voidedAt'), c('voidReason'), c('note'),
      c('finalAssetId'), c('finalAmount'), c('totalBaseCost'), c('totalBaseProceeds'),
      c('totalFeesInBase'), c('realizedGainLoss'),
    ],
    indexes: [{ name: 'idx_chains_date', cols: ['date'] }],
  },
  lots: {
    name: 'lots',
    cols: [
      c('assetId'), c('sourceChainId'), c('sourceDcaExecutionId'), c('acquiredDate'),
      c('originalAmount'), c('baseCost'), c('baseCurrencyAssetId'), c('nativeCostAssetId'), c('nativeCostAmount'),
      c('remainingAmount'), c('status'),
    ],
    indexes: [{ name: 'idx_lots_asset', cols: ['asset_id'] }],
  },
  lotConsumptions: {
    name: 'lot_consumptions',
    cols: [c('lotId'), c('sellChainId'), c('consumedAmount'), c('allocatedCostBase'), c('proceedsBase'), c('realizedPnlBase')],
    indexes: [
      { name: 'idx_consumptions_lot', cols: ['lot_id'] },
      { name: 'idx_consumptions_sell', cols: ['sell_chain_id'] },
    ],
  },
  priceMarks: {
    name: 'price_marks',
    cols: [c('assetId'), c('quoteAssetId'), c('price'), c('date'), c('source'), c('note')],
    indexes: [{ name: 'idx_marks_asset', cols: ['asset_id'] }],
  },
  dcaPlans: {
    name: 'dca_plans',
    cols: [c('name'), c('targetAssetId'), c('baseCurrencyAssetId'), c('defaultPath'), c('anchorDate'), c('anchorMode'), c('timezone'), c('frequency'), c('plannedAmount'), c('reminderDaysBefore', 'int'), c('status'), c('note')],
  },
  dcaExecutions: {
    name: 'dca_executions',
    cols: [c('planId'), c('occurrenceIndex', 'int'), c('scheduledDate'), c('date'), c('plannedAmount'), c('actualBaseCost'), c('baseCurrencyAssetId'), c('finalAssetId'), c('finalAmount'), c('totalFeeInBase'), c('chainId'), c('note')],
    indexes: [
      { name: 'idx_exec_plan', cols: ['plan_id'] },
      { name: 'idx_dca_execution_unique_active', cols: ['plan_id', 'occurrence_index'], unique: true, where: 'is_deleted = 0' },
    ],
  },
  games: {
    name: 'games',
    cols: [
      c('name'), c('platform'), c('serverName'), c('enableSeason', 'bool'), c('isActive', 'bool'),
      c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
  },
  gameAccounts: {
    name: 'game_accounts',
    cols: [
      c('gameId'), c('accountName'), c('serverName'), c('characterName'), c('status'),
      c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [{ name: 'idx_gaccounts_game', cols: ['game_id'] }],
  },
  gameSeasons: {
    name: 'game_seasons',
    cols: [
      c('gameId'), c('name'), c('seasonNo'), c('startDate'), c('endDate'), c('status'), c('hours'),
      c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [{ name: 'idx_seasons_game', cols: ['game_id'] }],
  },
  gameRecords: {
    name: 'game_records',
    cols: [
      c('date'), c('gameId'), c('seasonId'), c('gameAccountId'), c('recordType'),
      c('gameCurrencyName'), c('gameCurrencyAmount'), c('settlementAssetId'), c('settlementAmount'),
      c('feeAssetId'), c('feeAmount'), c('manualRate'), c('counterparty'), c('note'),
    ],
    indexes: [
      { name: 'idx_grecords_game', cols: ['game_id'] },
      { name: 'idx_grecords_season', cols: ['season_id'] },
    ],
  },
  gameCashflowLinks: {
    name: 'game_cashflow_links',
    cols: [
      c('gameRecordId'), c('role'), c('transactionId'), c('direction'), c('ownership'),
      c('sourceAmount'), c('sourceAssetId'), c('accountId'), c('note'),
    ],
    indexes: [
      { name: 'idx_game_cashflow_record_role', cols: ['game_record_id', 'role'], unique: true, where: 'is_deleted = 0' },
      { name: 'idx_game_cashflow_transaction', cols: ['transaction_id'] },
    ],
  },
  fixedAssets: {
    name: 'fixed_assets',
    cols: [
      c('name'), c('tag'), c('categoryId'), c('status'), c('purchaseDate'), c('activatedDate'),
      c('baseCurrencyAssetId'), c('brand'), c('model'), c('serialNumber'), c('barcode'),
      c('purchaseMerchant'), c('orderNumber'), c('warrantyEndDate'), c('warrantyProvider'),
      c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [{ name: 'idx_fixed_assets_category', cols: ['category_id'] }],
  },
  fixedAssetCategories: {
    name: 'fixed_asset_categories',
    cols: [
      c('name'), c('parentId'), c('color'), c('icon'), c('sortOrder', 'int'), c('isHidden', 'bool'),
      c('isActive', 'bool'), c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [{ name: 'idx_fixed_categories_parent', cols: ['parent_id'] }],
  },
  fixedAssetEvents: {
    name: 'fixed_asset_events',
    cols: [c('fixedAssetId'), c('date'), c('type'), c('amountBase'), c('valueMode'), c('enteredAmount'), c('cashflowMode'), c('note')],
    indexes: [{ name: 'idx_fevents_asset', cols: ['fixed_asset_id'] }],
  },
  fixedAssetCashflowLinks: {
    name: 'fixed_asset_cashflow_links',
    cols: [
      c('fixedAssetId'), c('sourceType'), c('sourceId'), c('transactionId'), c('direction'), c('ownership'),
      c('sourceAmount'), c('sourceAssetId'), c('amountBase'), c('baseAssetId'), c('fxRateSnapshot'), c('note'),
    ],
    indexes: [
      { name: 'idx_fixed_cashflow_asset', cols: ['fixed_asset_id'] },
      { name: 'idx_fixed_cashflow_source', cols: ['source_type', 'source_id'], unique: true },
      { name: 'idx_fixed_cashflow_transaction', cols: ['transaction_id'] },
    ],
  },
  fixedAssetUsageMetrics: {
    name: 'fixed_asset_usage_metrics',
    cols: [
      c('fixedAssetId'), c('name'), c('unit'), c('customUnit'), c('entryMode'), c('startValue'),
      c('isPrimary', 'bool'), c('isActive', 'bool'), c('sortOrder', 'int'), c('note'),
    ],
    indexes: [{ name: 'idx_fixed_usage_metrics_asset', cols: ['fixed_asset_id'] }],
  },
  fixedAssetUsageLogs: {
    name: 'fixed_asset_usage_logs',
    cols: [c('fixedAssetId'), c('metricId'), c('date'), c('value'), c('entryMode'), c('note')],
    indexes: [
      { name: 'idx_fixed_usage_logs_asset', cols: ['fixed_asset_id'] },
      { name: 'idx_fixed_usage_logs_metric', cols: ['metric_id'] },
    ],
  },
  fixedAssetConsumables: {
    name: 'fixed_asset_consumables',
    cols: [
      c('fixedAssetId'), c('name'), c('category'), c('amountBase'), c('cashflowMode'), c('purchaseDate'), c('installedDate'),
      c('usageMetricId'), c('installedAtUsage'), c('targetLife'), c('reminderAtRemaining'),
      c('replacedDate'), c('status'), c('note'),
    ],
    indexes: [
      { name: 'idx_fixed_consumables_asset', cols: ['fixed_asset_id'] },
      { name: 'idx_fixed_consumables_metric', cols: ['usage_metric_id'] },
    ],
  },
  fixedAssetGoals: {
    name: 'fixed_asset_goals',
    cols: [
      c('fixedAssetId'), c('name'), c('metricId'), c('unit'), c('customUnit'), c('mode'),
      c('costBasisAmount'), c('targetUnitCost'), c('targetUsage'), c('startDate'), c('status'), c('note'),
    ],
    indexes: [{ name: 'idx_fixed_goals_asset', cols: ['fixed_asset_id'] }],
  },
  attachments: {
    name: 'attachments',
    cols: [
      c('entityType'), c('entityId'), c('fileName'), c('mimeType'), c('role'), c('note'),
      c('sizeBytes', 'int'), c('sha256'), c('thumbnailSha256'), c('thumbnailSizeBytes', 'int'), c('thumbnailMimeType'),
    ],
    indexes: [
      { name: 'idx_attachments_entity', cols: ['entity_type', 'entity_id'] },
      { name: 'idx_attachments_sha256', cols: ['sha256'] },
      { name: 'idx_attachments_thumbnail_sha256', cols: ['thumbnail_sha256'] },
    ],
  },
  categories: {
    name: 'categories',
    cols: [
      c('name'), c('type'), c('parentId'), c('color'), c('icon'), c('sortOrder', 'int'),
      c('budgetable', 'bool'), c('isHidden', 'bool'), c('isActive', 'bool'), c('archivedAt'),
      c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [
      { name: 'idx_categories_type', cols: ['type'] },
      { name: 'idx_categories_parent', cols: ['parent_id'] },
    ],
  },
  transactionTags: {
    name: 'transaction_tags',
    cols: [
      c('name'), c('groupName'), c('color'), c('sortOrder', 'int'), c('isActive', 'bool'),
      c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [
      { name: 'idx_tx_tags_group', cols: ['group_name'] },
      { name: 'idx_tx_tags_name', cols: ['name'] },
    ],
  },
  transactionLocations: {
    name: 'transaction_locations',
    cols: [
      c('name'), c('address'), c('latitude'), c('longitude'), c('isActive', 'bool'),
      c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [{ name: 'idx_tx_locations_name', cols: ['name'] }],
  },
  payees: {
    name: 'payees',
    cols: [
      c('name'), c('icon'), c('aliases'), c('defaultCategory'), c('defaultAccountId'), c('isActive', 'bool'),
      c('archivedAt'), c('archiveReason'), c('mergedIntoId'), c('note'),
    ],
    indexes: [{ name: 'idx_payees_name', cols: ['name'] }],
  },
  transactions: {
    name: 'transactions',
    cols: [
      c('balanceTiming'), c('balanceTimingAccountId'),
      c('date'), c('time'), c('timezone'), c('timePrecision'), c('occurredAtUtc'), c('utcOffsetMinutes', 'int'), c('timeDisambiguation'),
      c('type'), c('category'), c('amount'),
      c('assetId'), c('accountId'), c('transferAssetId'), c('transferAccountId'), c('transferAmount'),
      c('adjustmentDirection'), c('reconciliationSessionId'), c('scheduledExecutionId'),
      c('status'), c('reportingTreatment'), c('payeeId'), c('refundForId'), c('refundAppliedAmount'), c('refundAppliedAssetId'),
      c('refundAttributionMode'), c('refundEffectDate'), c('refundAllocationMode'),
      c('originalDateSnapshot'), c('originalAmountSnapshot'),
      c('recordState'), c('voidedAt'), c('voidReason'), c('tagIds'), c('locationId'), c('locationName'),
      c('latitude'), c('longitude'), c('locationAccuracyMeters'), c('description'),
      c('merchant'), c('note'),
    ],
    indexes: [
      { name: 'idx_transactions_date', cols: ['date'] },
      { name: 'idx_transactions_asset', cols: ['asset_id'] },
      { name: 'idx_transactions_category', cols: ['category'] },
      { name: 'idx_transactions_account', cols: ['account_id'] },
      { name: 'idx_transactions_account_date', cols: ['account_id', 'date', 'id'] },
      { name: 'idx_transactions_transfer_account_date', cols: ['transfer_account_id', 'date', 'id'] },
      { name: 'idx_transactions_refund_for', cols: ['refund_for_id'] },
      { name: 'idx_transactions_status', cols: ['status'] },
      { name: 'idx_transactions_location', cols: ['location_id'] },
    ],
  },
  transactionSplits: {
    name: 'transaction_splits',
    cols: [c('transactionId'), c('category'), c('amount'), c('isRemainder', 'bool'), c('note')],
    indexes: [
      { name: 'idx_splits_transaction', cols: ['transaction_id'] },
      { name: 'idx_splits_category_transaction', cols: ['category', 'transaction_id'] },
    ],
  },
  refundAllocations: {
    name: 'refund_allocations',
    cols: [
      c('refundTransactionId'), c('sourceTransactionId'), c('sourceSplitId'), c('categoryId'),
      c('categoryPathSnapshot'), c('amount'), c('assetId'),
    ],
    indexes: [
      { name: 'idx_refund_allocations_refund', cols: ['refund_transaction_id'] },
      { name: 'idx_refund_allocations_source', cols: ['source_transaction_id', 'source_split_id'] },
      { name: 'idx_refund_allocations_category_refund', cols: ['category_id', 'refund_transaction_id'] },
    ],
  },
  budgetCategories: {
    name: 'budget_categories',
    cols: [c('month'), c('category'), c('plannedAmount'), c('assetId'), c('rolloverMode'), c('note')],
    indexes: [
      { name: 'idx_budget_month', cols: ['month'] },
      { name: 'idx_budget_category', cols: ['category'] },
      { name: 'idx_budget_unique_active', cols: ['month', 'category'], unique: true, where: 'is_deleted = 0' },
    ],
  },
  scheduledTransactions: {
    name: 'scheduled_transactions',
    cols: [
      c('name'), c('type'), c('category'), c('amount'), c('assetId'), c('accountId'),
      c('transferAssetId'), c('transferAccountId'), c('transferAmount'), c('payeeId'),
      c('merchant'), c('description'), c('frequency'), c('anchorDate'), c('anchorMode'), c('time'), c('timezone'),
      c('endDate'), c('autoCreate', 'bool'), c('catchUpPolicy'), c('status'), c('note'),
    ],
    indexes: [
      { name: 'idx_scheduled_anchor', cols: ['anchor_date'] },
      { name: 'idx_scheduled_status', cols: ['status'] },
    ],
  },
  scheduledExecutions: {
    name: 'scheduled_executions',
    cols: [
      c('scheduleId'), c('occurrenceIndex', 'int'), c('occurrenceDate'), c('status'), c('transactionId'),
      c('attemptedAt'), c('completedAt'), c('retryCount', 'int'), c('lastError'), c('nextRetryAt'),
    ],
    indexes: [
      { name: 'idx_scheduled_execution_schedule', cols: ['schedule_id', 'occurrence_date'] },
      { name: 'idx_scheduled_execution_unique_active', cols: ['schedule_id', 'occurrence_index'], unique: true, where: 'is_deleted = 0' },
      { name: 'idx_scheduled_execution_transaction', cols: ['transaction_id'] },
    ],
  },
  transactionTemplates: {
    name: 'transaction_templates',
    cols: [
      c('name'), c('type'), c('category'), c('amount'), c('assetId'), c('accountId'), c('payeeId'),
      c('merchant'), c('description'), c('tagIds'), c('locationId'), c('sortOrder', 'int'),
      c('isActive', 'bool'), c('note'),
    ],
    indexes: [
      { name: 'idx_tx_templates_active', cols: ['is_active'] },
      { name: 'idx_tx_templates_category', cols: ['category'] },
    ],
  },
  transactionSavedViews: {
    name: 'transaction_saved_views',
    cols: [c('name'), c('description'), c('queryJson'), c('sortOrder', 'int'), c('isPinned', 'bool'), c('isActive', 'bool')],
    indexes: [
      { name: 'idx_tx_saved_views_active', cols: ['is_active'] },
      { name: 'idx_tx_saved_views_pinned', cols: ['is_pinned'] },
    ],
  },
  reconciliationSessions: {
    name: 'reconciliation_sessions',
    cols: [
      c('accountId'), c('assetId'), c('statementDate'), c('statementBalance'),
      c('openingBalance'), c('selectedTotal'), c('clearedBalance'), c('difference'),
      c('status'), c('adjustmentTransactionId'), c('closedAt'), c('note'),
    ],
    indexes: [
      { name: 'idx_reconcile_account', cols: ['account_id'] },
      { name: 'idx_reconcile_status', cols: ['status'] },
    ],
  },
  reconciliationItems: {
    name: 'reconciliation_items',
    cols: [
      c('reconciliationId'), c('transactionId'), c('accountId'), c('assetId'),
      c('postingAmount'), c('previousStatus'), c('selectedAt'),
    ],
    indexes: [
      { name: 'idx_reconcile_items_session', cols: ['reconciliation_id'] },
      { name: 'idx_reconcile_items_transaction', cols: ['transaction_id'] },
      { name: 'idx_reconcile_item_unique_active', cols: ['transaction_id', 'account_id', 'asset_id'], unique: true, where: 'is_deleted = 0' },
    ],
  },
} satisfies Record<string, TableSpec>;

export type TableKey = keyof typeof TABLES;

// ─────────────────────────── Row ⇄ entity mapping ───────────────────────────

function toStored(value: unknown, type: ColType): string | number | null {
  if (value === undefined || value === null) return null;
  if (type === 'bool') return value ? 1 : 0;
  if (type === 'int' || type === 'real') return Number(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function fromStored(value: unknown, type: ColType): unknown {
  if (value === null || value === undefined) return undefined;
  if (type === 'bool') return value === 1 || value === true || value === '1';
  if (type === 'int' || type === 'real') return Number(value);
  return String(value);
}

/** Serialize an entity to a positional params array aligned with allCols(spec). */
export function entityToParams(spec: TableSpec, entity: Record<string, unknown>): (string | number | null)[] {
  return allCols(spec).map((col) => toStored(entity[col.field], col.type));
}

/** Rebuild a typed entity from a DB row (undefined for NULLs, matching TS optionals). */
export function rowToEntity<T extends BaseEntity>(spec: TableSpec, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const col of allCols(spec)) {
    let v = fromStored(row[col.col], col.type);
    if ((col.field === 'tagIds' || col.field === 'aliases' || col.field === 'manualLotIds') && typeof v === 'string') {
      const rawTags = v;
      try {
        const parsed = JSON.parse(rawTags) as unknown;
        v = Array.isArray(parsed)
          ? parsed.map(String)
          : rawTags.split(',').map((x: string) => x.trim()).filter(Boolean);
      } catch {
        v = rawTags.split(',').map((x: string) => x.trim()).filter(Boolean);
      }
    }
    if (col.field === 'balanceCheckpoints' && typeof v === 'string') v = JSON.parse(v);
    if (v !== undefined) out[col.field] = v;
  }
  // isDeleted must always be a boolean even when stored 0.
  if (out['isDeleted'] === undefined) out['isDeleted'] = false;
  return out as T;
}
