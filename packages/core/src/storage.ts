/**
 * Storage port. The core defines *what* persistence looks like; `@zichan/db`
 * and app-specific drivers implement it. Apps depend on this interface, so
 * business logic never touches SQL. Dependency direction: db → core, apps → core.
 */
import type {
  Asset,
  Account,
  Attachment,
  BaseEntity,
  BudgetCategory,
  Category,
  ChainWithSteps,
  ConversionChain,
  ConversionStep,
  DcaExecution,
  DcaPlan,
  FixedAsset,
  FixedAssetCategory,
  FixedAssetConsumable,
  FixedAssetEvent,
  FixedAssetCashflowLink,
  FixedAssetGoal,
  FixedAssetUsageLog,
  FixedAssetUsageMetric,
  Game,
  GameAccount,
  GameCashflowLink,
  GameRecord,
  GameSeason,
  Lot,
  LotConsumption,
  Payee,
  PriceMark,
  ReconciliationSession,
  ReconciliationItem,
  RefundAllocation,
  ScheduledExecution,
  ScheduledTransaction,
  Setting,
  Transaction,
  TransactionLocation,
  TransactionSavedView,
  TransactionSplit,
  TransactionTag,
  TransactionTemplate,
} from './types.js';

/** Simple equality filter on indexed columns, plus ordering. */
export interface Query<T> {
  where?: Partial<Record<keyof T, string | number | boolean>>;
  includeDeleted?: boolean;
  orderBy?: keyof T;
  desc?: boolean;
  limit?: number;
  offset?: number;
  cursor?: QueryCursor;
}

export interface QueryCursor {
  value: string | number | boolean;
  id: string;
}

export interface CursorPage<T> {
  rows: T[];
  nextCursor?: QueryCursor;
  hasMore: boolean;
}

/** A CRUD collection over one entity type. All mutations are audited (§0.7). */
export interface Collection<T extends BaseEntity> {
  get(id: string): Promise<T | null>;
  list(query?: Query<T>): Promise<T[]>;
  listPage(query?: Omit<Query<T>, 'offset'>): Promise<CursorPage<T>>;
  count(query?: Omit<Query<T>, 'orderBy' | 'desc' | 'limit' | 'offset' | 'cursor'>): Promise<number>;
  /** Create or CAS-update using `entity.version` as the expected stored version. */
  put(entity: T): Promise<T>;
  /** Soft delete with an optional caller-observed version. */
  remove(id: string, expectedVersion: number): Promise<void>;
}

export type OperationType = 'create' | 'update' | 'delete';
export type AuditSource = 'local' | 'remote_sync' | 'import' | 'system' | 'conflict_resolution';

/** One durable audit row. Sync commits are recorded separately from this history. */
export interface OperationLogEntry {
  id: string;
  at: string; // ISO-8601 UTC
  deviceId?: string;
  entityType: string;
  entityId: string;
  op: OperationType;
  version: number;
  /** Full entity snapshot after the change (JSON). */
  payload?: string;
  beforePayload?: string;
  afterPayload?: string;
  changedKeys?: string[];
  diffJson?: string;
  batchId?: string;
  source?: AuditSource;
  actorName?: string;
  /** Short human summary, e.g. "put asset BTC". */
  summary?: string;
}

export interface OperationLogQuery {
  entityType?: string;
  entityId?: string;
  op?: OperationType;
  batchId?: string;
  source?: AuditSource;
  since?: string; // ISO time, inclusive
  until?: string; // ISO time, exclusive
  limit?: number;
  desc?: boolean;
}

export interface AuditBatch {
  id: string;
  type: 'user' | 'bulk_update' | 'import' | 'sync' | 'conflict_resolution' | 'system';
  label: string;
  startedAt: string;
  finishedAt?: string;
  deviceId?: string;
  actorName?: string;
  entityCount: number;
  summary?: string;
  sourceCommitId?: string;
  sourceServerId?: string;
  sourceReplicaKey?: string;
  appliedCount?: number;
  skippedCount?: number;
  conflictCount?: number;
  outcome?: 'applied' | 'partial' | 'conflict' | 'invalid' | 'duplicate';
}

export interface SyncConflictResolution {
  id: string;
  groupId: string;
  resolvedAt: string;
  resolverDeviceId?: string;
  action: 'keep_local' | 'keep_branch' | 'manual_merge' | 'accept_remote_merge' | 'export_only';
  resolvedCommitId?: string;
  detailJson?: string;
  note?: string;
}

/** The full ledger store: a typed collection per entity + a few relational helpers. */
export interface LedgerStore {
  readonly conversionOperations: Collection<import('./types.js').ConversionOperation>;
  readonly costBasisOpenings: Collection<import('./asset-cost.js').CostBasisOpening>;
  readonly assets: Collection<Asset>;
  readonly accounts: Collection<Account>;
  readonly settings: Collection<Setting>;
  readonly conversionChains: Collection<ConversionChain>;
  readonly lots: Collection<Lot>;
  readonly lotConsumptions: Collection<LotConsumption>;
  readonly priceMarks: Collection<PriceMark>;
  readonly dcaPlans: Collection<DcaPlan>;
  readonly dcaExecutions: Collection<DcaExecution>;
  readonly games: Collection<Game>;
  readonly gameAccounts: Collection<GameAccount>;
  readonly gameSeasons: Collection<GameSeason>;
  readonly gameRecords: Collection<GameRecord>;
  readonly gameCashflowLinks: Collection<GameCashflowLink>;
  readonly fixedAssets: Collection<FixedAsset>;
  readonly fixedAssetCategories: Collection<FixedAssetCategory>;
  readonly fixedAssetEvents: Collection<FixedAssetEvent>;
  readonly fixedAssetCashflowLinks: Collection<FixedAssetCashflowLink>;
  readonly fixedAssetUsageMetrics: Collection<FixedAssetUsageMetric>;
  readonly fixedAssetUsageLogs: Collection<FixedAssetUsageLog>;
  readonly fixedAssetConsumables: Collection<FixedAssetConsumable>;
  readonly fixedAssetGoals: Collection<FixedAssetGoal>;
  readonly attachments: Collection<Attachment>;
  readonly categories: Collection<Category>;
  readonly transactionTags: Collection<TransactionTag>;
  readonly transactionLocations: Collection<TransactionLocation>;
  readonly transactionTemplates: Collection<TransactionTemplate>;
  readonly transactionSavedViews: Collection<TransactionSavedView>;
  readonly payees: Collection<Payee>;
  readonly transactions: Collection<Transaction>;
  readonly transactionSplits: Collection<TransactionSplit>;
  readonly refundAllocations: Collection<RefundAllocation>;
  readonly budgetCategories: Collection<BudgetCategory>;
  readonly scheduledTransactions: Collection<ScheduledTransaction>;
  readonly scheduledExecutions: Collection<ScheduledExecution>;
  readonly reconciliationSessions: Collection<ReconciliationSession>;
  readonly reconciliationItems: Collection<ReconciliationItem>;

  // ── conversion steps are managed together with their chain ──
  listStepsByChain(chainId: string): Promise<ConversionStep[]>;
  getChainWithSteps(chainId: string): Promise<ChainWithSteps | null>;
  /** Upsert a chain and replace its steps atomically. */
  saveChainWithSteps(chain: ConversionChain, steps: ConversionStep[]): Promise<ChainWithSteps>;

  // ── audit / maintenance ──
  operationLog(query?: OperationLogQuery): Promise<OperationLogEntry[]>;
  /** Run `fn` as one atomic unit using the supplied transaction-bound store. */
  transaction<T>(fn: (store: this) => Promise<T>): Promise<T>;
  /** Create or verify the current development schema baseline. Safe to call repeatedly. */
  migrate(): Promise<void>;
  /** Close underlying resources. */
  close(): Promise<void>;
}
