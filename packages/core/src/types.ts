/**
 * Data model v1 (redesigned). See docs/data-model.md for the rationale and the
 * conventions (§0) these types encode. Amounts are decimal strings.
 */

/** Fields every stored entity carries — soft delete + sync metadata (§0.7). */
export interface BaseEntity {
  id: string;
  createdAt: string; // ISO-8601 UTC
  updatedAt: string; // ISO-8601 UTC
  version: number; // bumped on every mutation (per-entity conflict detection)
  isDeleted: boolean;
}

// ─────────────────────────── Asset & Account ───────────────────────────

export type AssetType =
  | 'fiat'
  | 'stablecoin'
  | 'crypto'
  | 'stock'
  | 'fund'
  | 'bond'
  | 'precious_metal'
  | 'game'
  | 'fixed';

export function isLotTrackedAssetType(type: AssetType): boolean {
  return type === 'crypto'
    || type === 'stock'
    || type === 'fund'
    || type === 'bond'
    || type === 'precious_metal';
}

export interface Asset extends BaseEntity {
  code: string; // GBP, USD, USDT, BTC, ETH, 初火, ...
  name: string;
  type: AssetType;
  /** Display/rounding precision. fiat=2, USDT=6, BTC=8, game currency as needed. */
  decimals: number;
  /** Currency symbol for fiat (e.g. £, $). Optional. */
  symbol?: string;
  isActive: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export type AccountKind =
  | 'bank'
  | 'cash'
  | 'exchange'
  | 'wallet'
  | 'credit_card'
  | 'loan'
  | 'game_platform'
  | 'other';

export interface Account extends BaseEntity {
  name: string;
  kind: AccountKind;
  /** Platform/venue label, e.g. "Binance", "Kraken", "Steam". */
  platform?: string;
  /** Credit-card statement day and payment due day, 1-31. */
  statementDay?: number;
  paymentDueDay?: number;
  creditLimit?: string;
  /** Optional loan terms; balances still come from normalized ledger postings. */
  loanPrincipal?: string;
  annualInterestRate?: string;
  loanStartDate?: string;
  loanEndDate?: string;
  isActive: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export type LedgerMode = 'spending' | 'accounts' | 'assets';

/** Global config. There is one active Setting row. */
export interface Setting extends BaseEntity {
  /** Global reporting currency. Existing records are never rewritten when it changes. */
  baseCurrencyAssetId: string;
  /** Defaults used only when creating new records; undefined inherits the global currency. */
  transactionDefaultAssetId?: string;
  investmentCostAssetId?: string;
  fixedAssetDefaultCurrencyAssetId?: string;
  gameDefaultSettlementAssetId?: string;
  /** Daily ledger depth: lightweight spending, account ledger, or full asset ledger. */
  ledgerMode?: LedgerMode;
  /** Default lot-matching method for sells. */
  defaultLotMethod: LotMethod;
  /** As-of date used by valuation, holding period, and season calculations. */
  asOfDate?: string;
  /** Comma-separated optional fields shown in the daily transaction form. */
  transactionFormOptionalFields?: string;
  /** Default category picker scope; users can still toggle it for the current picker session. */
  categoryPickerDefaultScope?: 'frequent' | 'all';
  /** Which period receives the spending offset created by a refund. */
  refundAttributionMode?: 'original_date' | 'refund_date';
  /** JSON payload for backup/check/rehearsal health status. */
  dataSafetyStateJson?: string;
}

// ─────────────────────────── Conversion chains ───────────────────────────

export type ConversionType =
  | 'buy'
  | 'sell'
  | 'exchange'
  | 'dca'
  | 'deposit'
  | 'withdraw';

/** A single conversion event = one chain with N ordered steps (unifies §7 & §27.7). */
export interface ConversionChain extends BaseEntity {
  date: string; // YYYY-MM-DD
  time?: string; // HH:mm[:ss]
  timezone?: string;
  timePrecision?: TimePrecision;
  occurredAtUtc?: string;
  utcOffsetMinutes?: number;
  timeDisambiguation?: TimeDisambiguation;
  type: ConversionType;
  title?: string;
  baseCurrencyAssetId: string;
  /** Manual book value snapshot when the book currency is not moved by the chain. */
  bookValueInBase?: string;
  /** Set when this chain realizes a DCA execution. */
  relatedDcaExecutionId?: string;
  /** Frozen sell matching policy so edits and every device replay identically. */
  lotMethod?: LotMethod;
  manualLotIds?: string[];
  recordState?: 'active' | 'voided';
  voidedAt?: string;
  voidReason?: string;
  note?: string;

  // ── derived caches (§0.5); recomputed from steps + consumptions ──
  finalAssetId?: string;
  finalAmount?: string;
  totalBaseCost?: string; // buy/dca
  totalBaseProceeds?: string; // sell
  totalFeesInBase?: string;
  realizedGainLoss?: string; // sell
}

export type ConversionSourceAmountMode = 'trade_principal' | 'account_debit';
export type ConversionTargetAmountMode = 'trade_gross' | 'account_credit';
export type ConversionFeeTreatment =
  | 'source_included'
  | 'source_extra'
  | 'target_deducted'
  | 'third_asset_extra';

export interface ConversionFee {
  id: string;
  assetId: string;
  amount: string;
  treatment: ConversionFeeTreatment;
  /** Fee value captured in the chain's book currency at entry time. */
  valueInBase?: string;
  accountId?: string;
  note?: string;
}

export interface ConversionStep {
  id: string;
  chainId: string;
  order: number; // 1-based
  fromAssetId: string;
  fromAmount: string; // normalized trade principal
  toAssetId: string;
  toAmount: string; // normalized trade gross before target deductions
  sourceAmountMode?: ConversionSourceAmountMode;
  targetAmountMode?: ConversionTargetAmountMode;
  fees?: ConversionFee[];
  /** User-entered market/reference rate; actual rates are always derived. */
  referenceRate?: string;
  platform?: string;
  accountFromId?: string;
  accountToId?: string;
  note?: string;
}

/** A chain plus its ordered steps — the unit most calculations operate on. */
export interface ChainWithSteps {
  chain: ConversionChain;
  steps: ConversionStep[];
}

// ─────────────────────────── Lots & sell matching ───────────────────────────

export type LotMethod = 'fifo' | 'lifo' | 'average' | 'manual';
export type LotStatus = 'open' | 'closed';

export interface Lot extends BaseEntity {
  assetId: string; // BTC, ETH, ...
  /** Chain that produced this lot (a buy/dca chain). */
  sourceChainId?: string;
  sourceDcaExecutionId?: string;
  acquiredDate: string; // YYYY-MM-DD
  originalAmount: string;
  /** Total cost in the base currency (principal + attributed base fees). */
  baseCost: string;
  baseCurrencyAssetId: string;
  /** Actual first-leg account outflow retained alongside the book cost. */
  nativeCostAssetId?: string;
  nativeCostAmount?: string;
  remainingAmount: string; // derived cache (§0.5)
  status: LotStatus; // derived cache
}

/** Records that a sell consumed part of a lot — the basis for realized P&L (§13). */
export interface LotConsumption extends BaseEntity {
  lotId: string;
  /** The sell chain that consumed the lot. */
  sellChainId: string;
  consumedAmount: string;
  allocatedCostBase: string; // cost basis attributed to this slice
  proceedsBase: string; // sale proceeds attributed to this slice
  realizedPnlBase: string; // proceedsBase - allocatedCostBase
}

// ─────────────────────────── Price marks (valuation) ───────────────────────────

/** A price/FX snapshot: 1 unit of assetId = price (quoteAssetId). Fixes plan gap. */
export interface PriceMark extends BaseEntity {
  assetId: string;
  quoteAssetId: string; // usually the base currency
  price: string;
  date: string; // YYYY-MM-DD
  source: 'manual' | 'api';
  note?: string;
}

// ─────────────────────────── DCA ───────────────────────────

export type DcaFrequency = 'daily' | 'weekly' | 'monthly' | 'manual';
export type DcaStatus = 'active' | 'paused' | 'ended';

export interface DcaPlan extends BaseEntity {
  name: string;
  targetAssetId: string;
  baseCurrencyAssetId: string;
  defaultPath?: string; // e.g. "GBP → USDT → BTC"
  anchorDate: string;
  anchorMode: ScheduledAnchorMode;
  timezone: string;
  frequency: DcaFrequency;
  plannedAmount: string;
  /** Notify when the next scheduled execution is within this many days. */
  reminderDaysBefore?: number;
  status: DcaStatus;
  note?: string;
}

export interface DcaExecution extends BaseEntity {
  planId: string;
  occurrenceIndex: number;
  scheduledDate: string;
  date: string; // actual YYYY-MM-DD
  plannedAmount: string;
  actualBaseCost: string; // derived from its chain
  baseCurrencyAssetId: string;
  finalAssetId: string;
  finalAmount: string;
  totalFeeInBase: string;
  /** The conversion chain that realizes this execution. */
  chainId?: string;
  note?: string;
}

// ─────────────────────────── Game ───────────────────────────

export interface Game extends BaseEntity {
  name: string;
  platform?: string;
  serverName?: string;
  enableSeason: boolean;
  isActive: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export type GameAccountStatus = 'active' | 'inactive' | 'sold' | 'banned';

export interface GameAccount extends BaseEntity {
  gameId: string;
  accountName: string;
  serverName?: string;
  characterName?: string;
  status: GameAccountStatus;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export type GameSeasonStatus = 'upcoming' | 'active' | 'ended';

export interface GameSeason extends BaseEntity {
  gameId: string;
  name: string;
  seasonNo?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  status: GameSeasonStatus;
  /** Optional logged play time for per-hour stats. */
  hours?: string;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export type GameRecordType =
  | 'buy_currency' // 买入游戏币
  | 'sell_currency' // 卖出游戏币
  | 'produce' // 游戏产出
  | 'consume' // 游戏消耗
  | 'sell_equipment' // 装备卖出
  | 'sell_material' // 材料卖出
  | 'topup' // 充值
  | 'withdraw' // 提现
  | 'fee' // 手续费
  | 'account_cost' // 账号成本
  | 'boosting_cost' // 代练成本
  | 'other_expense'
  | 'other_income';

export interface GameRecord extends BaseEntity {
  date: string; // YYYY-MM-DD
  gameId: string;
  seasonId?: string;
  gameAccountId?: string;
  recordType: GameRecordType;
  gameCurrencyName?: string;
  gameCurrencyAmount?: string; // reference only, not stock-checked (§3.3)
  settlementAssetId?: string;
  settlementAmount?: string; // magnitude; direction from recordType
  feeAssetId?: string;
  feeAmount?: string;
  manualRate?: string;
  counterparty?: string;
  note?: string;
}

export type GameCashflowRole = 'settlement' | 'fee';
export type GameCashflowMode = 'record_only' | 'linked_transaction' | 'create_transaction';
export type GameCashflowDirection = 'outflow' | 'inflow';
export type GameCashflowOwnership = 'linked' | 'created';

/** Frozen one-to-one cash-flow link for a settlement or fee leg. */
export interface GameCashflowLink extends BaseEntity {
  gameRecordId: string;
  role: GameCashflowRole;
  transactionId: string;
  direction: GameCashflowDirection;
  ownership: GameCashflowOwnership;
  sourceAmount: string;
  sourceAssetId: string;
  accountId?: string;
  note?: string;
}

// ─────────────────────────── Fixed assets ───────────────────────────

export type FixedAssetStatus = 'active' | 'stored' | 'sold' | 'scrapped' | 'retired' | 'gifted';

export interface FixedAssetCategory extends BaseEntity {
  name: string;
  parentId?: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
  isHidden?: boolean;
  isActive: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export interface FixedAsset extends BaseEntity {
  name: string;
  tag?: string; // 标签，如 主力机 / 工作机
  categoryId: string;
  status: FixedAssetStatus;
  purchaseDate: string; // YYYY-MM-DD
  activatedDate?: string;
  baseCurrencyAssetId: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  barcode?: string;
  purchaseMerchant?: string;
  orderNumber?: string;
  warrantyEndDate?: string;
  warrantyProvider?: string;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export type FixedEventType =
  | 'purchase'
  | 'activate'
  | 'repair'
  | 'upgrade'
  | 'residual_update' // user-entered current residual value
  | 'warranty_expire'
  | 'sale'
  | 'scrap'
  | 'retire'
  | 'gift';

export interface FixedAssetEvent extends BaseEntity {
  fixedAssetId: string;
  date: string; // YYYY-MM-DD
  type: FixedEventType;
  amountBase: string; // in the asset's base currency
  /** Residual updates may be entered as current residual or cumulative loss. */
  valueMode?: 'residual' | 'depreciation';
  enteredAmount?: string;
  cashflowMode?: FixedAssetCashflowMode;
  note?: string;
}

export type FixedAssetCashflowMode = 'record_only' | 'linked_transaction' | 'create_transaction';
export type FixedAssetCashflowDirection = 'outflow' | 'inflow';
export type FixedAssetCashflowOwnership = 'linked' | 'created';
export type FixedAssetCashflowSourceType = 'event' | 'consumable';

/** Frozen one-to-one cash-flow link for a lifecycle event or consumable. */
export interface FixedAssetCashflowLink extends BaseEntity {
  fixedAssetId: string;
  sourceType: FixedAssetCashflowSourceType;
  sourceId: string;
  transactionId: string;
  direction: FixedAssetCashflowDirection;
  ownership: FixedAssetCashflowOwnership;
  sourceAmount: string;
  sourceAssetId: string;
  amountBase: string;
  baseAssetId: string;
  fxRateSnapshot?: string;
  note?: string;
}

export type FixedUsageUnit = 'day' | 'count' | 'km' | 'hour' | 'custom';
export type FixedUsageEntryMode = 'increment' | 'meter';

export interface FixedAssetUsageMetric extends BaseEntity {
  fixedAssetId: string;
  name: string;
  unit: FixedUsageUnit;
  customUnit?: string;
  entryMode: FixedUsageEntryMode;
  startValue: string;
  isPrimary: boolean;
  isActive: boolean;
  sortOrder?: number;
  note?: string;
}

export interface FixedAssetUsageLog extends BaseEntity {
  fixedAssetId: string;
  metricId: string;
  date: string;
  value: string;
  entryMode: FixedUsageEntryMode;
  note?: string;
}

export type FixedConsumableStatus = 'active' | 'replaced' | 'discarded';

export interface FixedAssetConsumable extends BaseEntity {
  fixedAssetId: string;
  name: string;
  category?: string;
  amountBase: string;
  cashflowMode: FixedAssetCashflowMode;
  purchaseDate: string;
  installedDate?: string;
  usageMetricId?: string;
  installedAtUsage?: string;
  targetLife?: string;
  reminderAtRemaining?: string;
  replacedDate?: string;
  status: FixedConsumableStatus;
  note?: string;
}

export type FixedGoalMode = 'unit_cost' | 'usage';
export type FixedGoalStatus = 'active' | 'achieved' | 'cancelled';

export interface FixedAssetGoal extends BaseEntity {
  fixedAssetId: string;
  name: string;
  metricId?: string;
  unit: FixedUsageUnit;
  customUnit?: string;
  mode: FixedGoalMode;
  /** Frozen cost snapshot used when the goal was created. */
  costBasisAmount: string;
  targetUnitCost?: string;
  targetUsage: string;
  startDate: string;
  status: FixedGoalStatus;
  note?: string;
}

// ─────────────────────────── Attachments ───────────────────────────

export interface Attachment extends BaseEntity {
  entityType: string;
  entityId: string;
  fileName: string;
  mimeType?: string;
  role?: 'image' | 'invoice' | 'warranty' | 'manual' | 'other';
  note?: string;
  sizeBytes: number;
  sha256: string;
  thumbnailSha256?: string;
  thumbnailSizeBytes?: number;
  thumbnailMimeType?: string;
}

// ─────────────────────────── Daily Transactions ───────────────────────────

export type TransactionType = 'income' | 'expense' | 'transfer' | 'refund' | 'adjustment';
export type TransactionCategoryType = 'income' | 'expense';
export type TransactionStatus = 'pending' | 'cleared';
export type ScheduledTransactionFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type ScheduledTransactionStatus = 'active' | 'paused';
export type ScheduledAnchorMode = 'calendar_day' | 'month_end';
export type ScheduledCatchUpPolicy = 'all' | 'latest';
export type ScheduledExecutionStatus = 'created' | 'skipped' | 'failed';
export type ReconciliationStatus = 'open' | 'closed';
export type BudgetRolloverMode = 'none' | 'positive_only' | 'signed';

/** Category ids are strings so users can define their own hierarchy. */
export type TransactionCategory = string;

export interface Category extends BaseEntity {
  name: string;
  type: TransactionCategoryType;
  parentId?: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
  budgetable?: boolean;
  isHidden?: boolean;
  isActive: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export interface TransactionTag extends BaseEntity {
  name: string;
  groupName?: string;
  color?: string;
  sortOrder?: number;
  isActive: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export interface TransactionLocation extends BaseEntity {
  name: string;
  address?: string;
  latitude?: string;
  longitude?: string;
  isActive: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export interface Payee extends BaseEntity {
  name: string;
  aliases?: string[];
  defaultCategory?: string;
  defaultAccountId?: string;
  isActive: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
  note?: string;
}

export interface TransactionSplit extends BaseEntity {
  transactionId: string;
  category: string;
  amount: string;
  isRemainder?: boolean;
  note?: string;
}

export type RefundAllocationMode = 'proportional' | 'specified';

/** Immutable reporting attribution captured when a refund is created or edited. */
export interface RefundAllocation extends BaseEntity {
  refundTransactionId: string;
  sourceTransactionId: string;
  sourceSplitId?: string;
  categoryId: string;
  categoryPathSnapshot: string;
  amount: string;
  assetId: string;
}

export interface BudgetCategory extends BaseEntity {
  month: string; // YYYY-MM
  category: string;
  plannedAmount: string;
  assetId: string;
  rolloverMode: BudgetRolloverMode;
  note?: string;
}

export interface ScheduledTransaction extends BaseEntity {
  name: string;
  type: TransactionType;
  category: string;
  amount: string;
  assetId: string;
  accountId?: string;
  transferAssetId?: string;
  transferAccountId?: string;
  transferAmount?: string;
  payeeId?: string;
  merchant?: string;
  description?: string;
  frequency: ScheduledTransactionFrequency;
  anchorDate: string; // YYYY-MM-DD
  anchorMode: ScheduledAnchorMode;
  time?: string; // HH:mm
  timezone: string; // frozen IANA time zone
  endDate?: string;
  autoCreate: boolean;
  catchUpPolicy: ScheduledCatchUpPolicy;
  status: ScheduledTransactionStatus;
  note?: string;
}

export interface ScheduledExecution extends BaseEntity {
  scheduleId: string;
  occurrenceIndex: number;
  occurrenceDate: string;
  status: ScheduledExecutionStatus;
  transactionId?: string;
  attemptedAt?: string;
  completedAt?: string;
  retryCount?: number;
  lastError?: string;
  nextRetryAt?: string;
}

export interface TransactionTemplate extends BaseEntity {
  name: string;
  type: TransactionType;
  category: TransactionCategory;
  amount?: string;
  assetId?: string;
  accountId?: string;
  payeeId?: string;
  merchant?: string;
  description?: string;
  tagIds?: string[];
  locationId?: string;
  note?: string;
  sortOrder?: number;
  isActive: boolean;
}

export interface TransactionSavedView extends BaseEntity {
  name: string;
  description?: string;
  queryJson: string;
  sortOrder?: number;
  isPinned?: boolean;
  isActive: boolean;
}

export interface ReconciliationSession extends BaseEntity {
  accountId: string;
  assetId: string;
  statementDate: string; // YYYY-MM-DD
  statementBalance: string;
  openingBalance: string;
  selectedTotal: string;
  clearedBalance: string;
  difference: string;
  status: ReconciliationStatus;
  adjustmentTransactionId?: string;
  closedAt?: string;
  note?: string;
}

export interface ReconciliationItem extends BaseEntity {
  reconciliationId: string;
  transactionId: string;
  accountId: string;
  assetId: string;
  postingAmount: string;
  previousStatus: TransactionStatus;
  selectedAt: string;
}

/**
 * Transaction 记录日常生活收支流水(与投资无关的常规收入和支出)。
 * 与 ConversionChain 的区别: Transaction 是单边流动(单资产增减),
 * ConversionChain 是双边转换(from → to)。
 */
export interface Transaction extends BaseEntity {
  date: string; // YYYY-MM-DD
  time?: string; // HH:mm[:ss]
  timezone?: string; // IANA name or UTC offset label
  timePrecision?: TimePrecision;
  occurredAtUtc?: string;
  utcOffsetMinutes?: number;
  timeDisambiguation?: TimeDisambiguation;
  type: TransactionType;
  category: TransactionCategory;
  amount: string; // 正数存储,方向由type确定 (§0.2)
  assetId: string; // 支持所有资产(多币种)
  accountId?: string;
  transferAssetId?: string;
  transferAccountId?: string;
  transferAmount?: string;
  adjustmentDirection?: 'increase' | 'decrease';
  reconciliationSessionId?: string;
  scheduledExecutionId?: string;
  status?: TransactionStatus;
  /** Controls income/expense reporting without changing the account posting. */
  reportingTreatment?: 'ordinary' | 'balance_only';
  payeeId?: string;
  /** Refunds are real inflows that offset this original expense instead of income. */
  refundForId?: string;
  /** Amount credited back against the original expense, frozen in refundAppliedAssetId. */
  refundAppliedAmount?: string;
  refundAppliedAssetId?: string;
  refundAttributionMode?: 'original_date' | 'refund_date';
  refundEffectDate?: string;
  refundAllocationMode?: RefundAllocationMode;
  originalDateSnapshot?: string;
  originalAmountSnapshot?: string;
  recordState?: 'active' | 'voided';
  voidedAt?: string;
  voidReason?: string;
  tagIds?: string[];
  locationId?: string;
  locationName?: string;
  latitude?: string;
  longitude?: string;
  locationAccuracyMeters?: string;
  description?: string;
  merchant?: string; // 商户名称
  note?: string;
}

export type TimePrecision = 'day' | 'minute' | 'second';
export type TimeDisambiguation = 'earlier' | 'later';
