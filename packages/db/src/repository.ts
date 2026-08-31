/**
 * SqlLedgerStore — implements the core LedgerStore port over a SqlDriver. Every
 * mutation bumps version, stamps updatedAt, and writes an operation_log row
 * (the audit trail). Collections are generated from the table registry.
 */
import {
  D,
  newId,
  sha256Json,
  systemCategory,
  sum,
  type AuditBatch,
  type AuditSource,
  type BaseEntity,
  type Collection,
  type ConversionChain,
  type ConversionStep,
  type ChainWithSteps,
  type LedgerStore,
  type CursorPage,
  type OperationLogEntry,
  type OperationLogQuery,
  type OperationType,
  type Query,
  type SyncConflictResolution,
  syncPayload,
  wireSyncCommit,
  type SyncCommitV2,
  type SyncRevisionV2,
} from '@zichan/core';
import { createLogger, nullSink, type Logger } from '@zichan/logger';
import type { SqlDriver, SqlParam } from './driver.js';
import { AttachmentStateRepository } from './attachment-state.js';
import type {
  BusinessCompensationPayload,
  BusinessCompensationQuery,
  BusinessCompensationRecord,
  BusinessCompensationStatus,
  CompensationEntityState,
} from './business-compensation.js';
import {
  aggregateValidationKeys,
  normalizeDomainEntity,
  validateAggregateMutation,
  validateConversionAggregateSnapshot,
  validateEntityDelete,
  validateEntityWrite,
  validateReconciliationAggregateSnapshot,
  validateStoredReconciliationAggregate,
  validateTransactionAggregateSnapshot,
} from './domain-validation.js';
import { runMigrations } from './migrations.js';
import {
  aggregateKey,
  replicaKey,
  type StoredSyncCommit,
  type SyncConflictBranchRow,
  type SyncConflictGroupRow,
  type SyncGraph,
  type SyncReplicaIdentity,
  type SyncReplicaState,
} from './sync-types.js';
import {
  TABLES,
  allCols,
  entityToParams,
  rowToEntity,
  type Col,
  type TableSpec,
} from './tables.js';

const nowIso = (): string => new Date().toISOString();

export class ConcurrencyError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT';

  constructor(
    readonly entityType: string,
    readonly entityId: string,
    readonly expectedVersion: number,
    readonly actualVersion?: number,
  ) {
    super(actualVersion == null
      ? `${entityType} ${entityId} 已被删除或替换，请刷新后重试`
      : `${entityType} ${entityId} 已在其他窗口修改（当前版本 ${actualVersion}，编辑版本 ${expectedVersion}）`);
    this.name = 'ConcurrencyError';
  }
}

interface AuditContext {
  batchId?: string;
  source?: AuditSource;
  actorName?: string;
  suppressSync?: boolean;
}

interface StoreCtx {
  driver: SqlDriver;
  log: Logger;
  deviceId?: string;
  audit?: AuditContext;
  changeBus: StoreChangeBus;
  pendingChanges?: Set<string>;
  pendingReconciliationValidations?: Map<string, boolean>;
  prevalidatedAggregates?: Set<string>;
  restoreWriteKeys?: Set<string>;
  restoreDeleteKeys?: Set<string>;
  allowInactiveReferences?: boolean;
  inactiveReferenceScope?: { active: boolean };
  compensationSignal: { latestId?: string };
}

function inactiveReferencesAllowed(ctx: StoreCtx): boolean {
  return ctx.allowInactiveReferences === true && ctx.inactiveReferenceScope?.active === true;
}

async function affectedReconciliationIds(
  driver: SqlDriver,
  entityType: string,
  candidate: BaseEntity & Record<string, unknown>,
  current?: BaseEntity & Record<string, unknown>,
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (entityType === 'transaction') {
    const rows = await driver.all<{ id: string }>(
      `SELECT reconciliation_id AS id
       FROM reconciliation_items
       WHERE transaction_id = ? AND is_deleted = 0
       UNION
       SELECT id
       FROM reconciliation_sessions
       WHERE adjustment_transaction_id = ? AND is_deleted = 0`,
      [candidate.id, candidate.id],
    );
    for (const row of rows) if (row.id) ids.add(String(row.id));
  } else if (entityType === 'reconciliation_session') {
    ids.add(candidate.id);
    if (current?.id) ids.add(current.id);
  } else if (entityType === 'reconciliation_item') {
    for (const id of [candidate['reconciliationId'], current?.['reconciliationId']]) {
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

async function deferOrValidateReconciliations(
  ctx: StoreCtx,
  entityType: string,
  candidate: BaseEntity & Record<string, unknown>,
  current?: BaseEntity & Record<string, unknown>,
): Promise<void> {
  const ids = await affectedReconciliationIds(ctx.driver, entityType, candidate, current);
  if (!ids.size) return;
  const allowInactiveReferences = inactiveReferencesAllowed(ctx);
  if (ctx.pendingReconciliationValidations) {
    for (const id of ids) {
      const previous = ctx.pendingReconciliationValidations.get(id);
      ctx.pendingReconciliationValidations.set(
        id,
        previous === undefined ? allowInactiveReferences : previous && allowInactiveReferences,
      );
    }
    return;
  }
  for (const id of ids) {
    await validateStoredReconciliationAggregate(ctx.driver, id, { allowInactiveReferences });
  }
}

export interface StoreChange {
  entityTypes: string[];
}

type StoreChangeListener = (change: StoreChange) => void;

class StoreChangeBus {
  private readonly listeners = new Set<StoreChangeListener>();
  private readonly queued = new Set<string>();
  private scheduled = false;

  subscribe(listener: StoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(entityTypes: Iterable<string>): void {
    for (const entityType of entityTypes) this.queued.add(entityType);
    if (this.scheduled || this.queued.size === 0) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const change = { entityTypes: [...this.queued].sort() };
      this.queued.clear();
      for (const listener of this.listeners) listener(change);
    });
  }
}

function recordChange(ctx: StoreCtx, entityType: string): void {
  if (ctx.pendingChanges) ctx.pendingChanges.add(entityType);
  else ctx.changeBus.publish([entityType]);
}

const AUDIT_IGNORED_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'version']);

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseObjectJson(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function changedKeys(before: unknown, after: unknown): string[] {
  const a = before && typeof before === 'object' ? before as Record<string, unknown> : {};
  const b = after && typeof after === 'object' ? after as Record<string, unknown> : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const key of keys) {
    if (AUDIT_IGNORED_KEYS.has(key)) continue;
    if (stableJson(a[key]) !== stableJson(b[key])) out.push(key);
  }
  return out.sort();
}

function diffJson(before: unknown, after: unknown): string {
  const a = before && typeof before === 'object' ? before as Record<string, unknown> : {};
  const b = after && typeof after === 'object' ? after as Record<string, unknown> : {};
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of changedKeys(before, after)) {
    diff[key] = { before: a[key] ?? null, after: b[key] ?? null };
  }
  return JSON.stringify(diff);
}

async function audit(
  ctx: StoreCtx,
  op: OperationType,
  entityType: string,
  entity: { id: string; version?: number },
  payload: unknown = entity,
  beforePayload?: unknown,
): Promise<void> {
  const keys = changedKeys(beforePayload, payload);
  const auditId = newId();
  await ctx.driver.run(
    `INSERT INTO operation_log (
      id, at, device_id, entity_type, entity_id, op, version, payload,
      before_payload, after_payload, changed_keys, diff_json, batch_id, source, actor_name, summary
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      auditId,
      nowIso(),
      ctx.deviceId ?? null,
      entityType,
      entity.id,
      op,
      entity.version ?? null,
      JSON.stringify(payload),
      beforePayload === undefined ? null : JSON.stringify(beforePayload),
      payload === undefined ? null : JSON.stringify(payload),
      JSON.stringify(keys),
      diffJson(beforePayload, payload),
      ctx.audit?.batchId ?? null,
      ctx.audit?.source ?? 'local',
      ctx.audit?.actorName ?? null,
      `${op} ${entityType} ${entity.id}`,
    ],
  );
  if (ctx.audit?.source !== 'remote_sync' && !ctx.audit?.suppressSync) {
    await captureLocalSyncRevision(ctx, auditId, op, entityType, payload);
  }
}

const CATEGORY_REFERENCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  transaction: ['category'],
  transaction_split: ['category'],
  refund_allocation: ['categoryId'],
  budget_category: ['category'],
  scheduled_transaction: ['category'],
  transaction_template: ['category'],
  payee: ['defaultCategory'],
};

async function ensureSystemCategoryRow(driver: SqlDriver, id: string): Promise<void> {
  if (!id || await driver.get('SELECT id FROM categories WHERE id = ?', [id])) return;
  const category = systemCategory(id, false);
  if (!category) return;
  if (category.parentId) await ensureSystemCategoryRow(driver, category.parentId);
  const at = nowIso();
  const stored = {
    ...category,
    createdAt: at,
    updatedAt: at,
    version: 1,
    isDeleted: false,
  };
  await driver.run(
    `INSERT OR IGNORE INTO categories (${allCols(TABLES.categories).map((column) => column.col).join(', ')})
     VALUES (${allCols(TABLES.categories).map(() => '?').join(', ')})`,
    entityToParams(TABLES.categories, stored),
  );
}

async function ensureSystemCategoryReferences(
  driver: SqlDriver,
  entityType: string,
  entity: Record<string, unknown>,
): Promise<void> {
  if (entityType === 'category' && typeof entity['parentId'] === 'string') {
    await ensureSystemCategoryRow(driver, entity['parentId']);
  }
  for (const field of CATEGORY_REFERENCE_FIELDS[entityType] ?? []) {
    const id = entity[field];
    if (typeof id === 'string') await ensureSystemCategoryRow(driver, id);
  }
}

class SqlCollection<T extends BaseEntity> implements Collection<T> {
  private readonly cols: Col[];
  private readonly colByField: Map<string, Col>;

  constructor(
    private readonly ctx: StoreCtx,
    private readonly spec: TableSpec,
    private readonly entityType: string,
  ) {
    this.cols = allCols(spec);
    this.colByField = new Map(this.cols.map((c) => [c.field, c]));
  }

  async get(id: string): Promise<T | null> {
    const row = await this.ctx.driver.get(`SELECT * FROM ${this.spec.name} WHERE id = ?`, [id]);
    return row ? rowToEntity<T>(this.spec, row) : null;
  }

  async list(query: Query<T> = {}): Promise<T[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (!query.includeDeleted) clauses.push('is_deleted = 0');
    if (query.where) {
      for (const [field, value] of Object.entries(query.where)) {
        const col = this.colByField.get(field);
        if (!col) throw new Error(`unknown filter field '${field}' on ${this.spec.name}`);
        clauses.push(`${col.col} = ?`);
        params.push(col.type === 'bool' ? (value ? 1 : 0) : (value as SqlParam));
      }
    }
    if (query.cursor && query.offset !== undefined) {
      throw new Error(`cursor and offset cannot be combined on ${this.spec.name}`);
    }
    const orderField = query.orderBy ? String(query.orderBy) : query.cursor ? 'id' : undefined;
    const orderCol = orderField ? this.colByField.get(orderField) : undefined;
    if (orderField && !orderCol) throw new Error(`unknown order field '${orderField}' on ${this.spec.name}`);
    if (query.cursor) {
      if (!orderField || !orderCol) throw new Error(`cursor requires an order field on ${this.spec.name}`);
      const op = query.desc ? '<' : '>';
      if (orderField === 'id') {
        clauses.push(`${orderCol.col} ${op} ?`);
        params.push(query.cursor.id);
      } else {
        const cursorValue = orderCol.type === 'bool'
          ? (query.cursor.value ? 1 : 0)
          : query.cursor.value as SqlParam;
        clauses.push(`(${orderCol.col} ${op} ? OR (${orderCol.col} = ? AND id ${op} ?))`);
        params.push(cursorValue, cursorValue, query.cursor.id);
      }
    }
    let sql = `SELECT * FROM ${this.spec.name}`;
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    if (orderField && orderCol) {
      sql += ` ORDER BY ${orderCol.col} ${query.desc ? 'DESC' : 'ASC'}`;
      if (orderField !== 'id') sql += `, id ${query.desc ? 'DESC' : 'ASC'}`;
    }
    if (query.limit !== undefined) {
      const limit = Math.max(0, Math.trunc(Number(query.limit)));
      sql += ` LIMIT ${limit}`;
      if (query.offset !== undefined) sql += ` OFFSET ${Math.max(0, Math.trunc(Number(query.offset)))}`;
    } else if (query.offset !== undefined) {
      sql += ` LIMIT -1 OFFSET ${Math.max(0, Math.trunc(Number(query.offset)))}`;
    }
    const rows = await this.ctx.driver.all(sql, params);
    return rows.map((r) => rowToEntity<T>(this.spec, r));
  }

  async listPage(query: Omit<Query<T>, 'offset'> = {}): Promise<CursorPage<T>> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(query.limit ?? 100))));
    const orderBy = (query.orderBy ?? 'id') as keyof T;
    const fetched = await this.list({ ...query, orderBy, limit: limit + 1 });
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const last = rows.at(-1);
    const orderField = orderBy;
    const rawValue = last?.[orderField];
    const value = typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean'
      ? rawValue
      : last?.id;
    return {
      rows,
      hasMore,
      ...(hasMore && last && value !== undefined
        ? { nextCursor: { value, id: last.id } }
        : {}),
    };
  }

  async count(query: Omit<Query<T>, 'orderBy' | 'desc' | 'limit' | 'offset' | 'cursor'> = {}): Promise<number> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (!query.includeDeleted) clauses.push('is_deleted = 0');
    if (query.where) {
      for (const [field, value] of Object.entries(query.where)) {
        const col = this.colByField.get(field);
        if (!col) throw new Error(`unknown filter field '${field}' on ${this.spec.name}`);
        clauses.push(`${col.col} = ?`);
        params.push(col.type === 'bool' ? (value ? 1 : 0) : (value as SqlParam));
      }
    }
    let sql = `SELECT COUNT(*) AS count FROM ${this.spec.name}`;
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    const row = await this.ctx.driver.get<{ count: number }>(sql, params);
    return Number(row?.count ?? 0);
  }

  async put(entity: T): Promise<T> {
    const saved = await this.ctx.driver.transaction(async (driver) => {
      const ctx = { ...this.ctx, driver };
      const row = await driver.get(`SELECT * FROM ${this.spec.name} WHERE id = ?`, [entity.id]);
      const existing = row ? rowToEntity<T>(this.spec, row) : null;
      const normalized = normalizeDomainEntity(this.entityType, entity);
      await ensureSystemCategoryReferences(
        driver,
        this.entityType,
        normalized as T & Record<string, unknown>,
      );
      const entityKey = `${this.entityType}:${normalized.id}`;
      const restoreWrite = ctx.restoreWriteKeys?.has(entityKey) ?? false;
      await validateEntityWrite(
        driver,
        this.entityType,
        normalized,
        existing ?? undefined,
        {
          allowReferencedChanges: restoreWrite,
          allowInactiveReferences: inactiveReferencesAllowed(ctx),
        },
      );
      const aggregateKeys = aggregateValidationKeys(
        this.entityType,
        normalized as T & Record<string, unknown>,
        existing as (T & Record<string, unknown>) | undefined,
      );
      const reconciliationValidationDeferred = !!ctx.pendingReconciliationValidations
        && aggregateKeys.some((key) => key.startsWith('reconciliation:'));
      if (!reconciliationValidationDeferred
        && aggregateKeys.some((key) => !ctx.prevalidatedAggregates?.has(key))) {
        await validateAggregateMutation(
          driver,
          this.entityType,
          normalized as T & Record<string, unknown>,
          existing as (T & Record<string, unknown>) | undefined,
          { allowInactiveReferences: inactiveReferencesAllowed(ctx) },
        );
      }
      const now = nowIso();
      const expectedVersion = existing && restoreWrite ? existing.version : Number(normalized.version);
      if (existing && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
        throw new ConcurrencyError(this.entityType, normalized.id, expectedVersion, existing.version);
      }
      const stored = {
        ...normalized,
        createdAt: existing?.createdAt || normalized.createdAt || now,
        updatedAt: now,
        version: existing ? expectedVersion + 1 : 1,
        isDeleted: normalized.isDeleted ?? false,
      } as T;
      const colNames = this.cols.map((c) => c.col).join(', ');
      const placeholders = this.cols.map(() => '?').join(', ');
      if (!existing) {
        await driver.run(
          `INSERT INTO ${this.spec.name} (${colNames}) VALUES (${placeholders})`,
          entityToParams(this.spec, stored as Record<string, unknown>),
        );
      } else {
        const mutableCols = this.cols.filter((column) => column.field !== 'id');
        const params = entityToParams(this.spec, stored as Record<string, unknown>);
        const idIndex = this.cols.findIndex((column) => column.field === 'id');
        const mutableParams = params.filter((_value, index) => index !== idIndex);
        const result = await driver.run(
          `UPDATE ${this.spec.name}
           SET ${mutableCols.map((column) => `${column.col} = ?`).join(', ')}
           WHERE id = ? AND version = ?`,
          [...mutableParams, normalized.id, expectedVersion],
        );
        if (result.changes !== 1) {
          const actual = await driver.get<{ version: number }>(`SELECT version FROM ${this.spec.name} WHERE id = ?`, [normalized.id]);
          throw new ConcurrencyError(this.entityType, normalized.id, expectedVersion, actual?.version);
        }
      }
      const op: OperationType = existing ? 'update' : 'create';
      await audit(ctx, op, this.entityType, stored, stored, existing ?? undefined);
      await deferOrValidateReconciliations(
        ctx,
        this.entityType,
        stored as T & Record<string, unknown>,
        existing as (T & Record<string, unknown>) | undefined,
      );
      ctx.log.debug('put', { table: this.spec.name, id: stored.id, op, version: stored.version });
      return stored;
    });
    recordChange(this.ctx, this.entityType);
    return saved;
  }

  async remove(id: string, expectedVersion?: number): Promise<void> {
    await this.ctx.driver.transaction(async (driver) => {
      const ctx = { ...this.ctx, driver };
      const row = await driver.get(`SELECT * FROM ${this.spec.name} WHERE id = ?`, [id]);
      const existing = row ? rowToEntity<T>(this.spec, row) : null;
      if (!existing) return;
      if (expectedVersion === undefined) {
        throw new ConcurrencyError(this.entityType, id, -1, existing.version);
      }
      if (!ctx.restoreDeleteKeys?.has(`${this.entityType}:${id}`)) {
        await validateEntityDelete(driver, this.entityType, existing);
      }
      const deleted = { ...existing, isDeleted: true } as T & Record<string, unknown>;
      const aggregateKeys = aggregateValidationKeys(
        this.entityType,
        deleted,
        existing as T & Record<string, unknown>,
      );
      const reconciliationValidationDeferred = !!ctx.pendingReconciliationValidations
        && aggregateKeys.some((key) => key.startsWith('reconciliation:'));
      if (!reconciliationValidationDeferred
        && aggregateKeys.some((key) => !ctx.prevalidatedAggregates?.has(key))) {
        await validateAggregateMutation(
          driver,
          this.entityType,
          deleted,
          existing as T & Record<string, unknown>,
          { allowInactiveReferences: inactiveReferencesAllowed(ctx) },
        );
      }
      const expected = expectedVersion;
      const stored = { ...existing, isDeleted: true, updatedAt: nowIso(), version: expected + 1 } as T;
      const result = await driver.run(
        `UPDATE ${this.spec.name}
         SET is_deleted = 1, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
        [stored.updatedAt, id, expected],
      );
      if (result.changes !== 1) {
        const actual = await driver.get<{ version: number }>(`SELECT version FROM ${this.spec.name} WHERE id = ?`, [id]);
        throw new ConcurrencyError(this.entityType, id, expected, actual?.version);
      }
      await audit(ctx, 'delete', this.entityType, stored, stored, existing);
      await deferOrValidateReconciliations(
        ctx,
        this.entityType,
        stored as T & Record<string, unknown>,
        existing as T & Record<string, unknown>,
      );
      ctx.log.debug('remove', { table: this.spec.name, id });
    });
    recordChange(this.ctx, this.entityType);
  }
}

// ─────────────────────── conversion step mapping ───────────────────────

const STEP_COLS = [
  'id', 'chain_id', 'step_order', 'from_asset_id', 'from_amount', 'to_asset_id', 'to_amount',
  'source_amount_mode', 'target_amount_mode', 'fees_json', 'reference_rate', 'platform',
  'account_from_id', 'account_to_id', 'note',
] as const;

function stepToParams(s: ConversionStep): SqlParam[] {
  return [
    s.id, s.chainId, s.order, s.fromAssetId, s.fromAmount, s.toAssetId, s.toAmount,
    s.sourceAmountMode ?? 'trade_principal', s.targetAmountMode ?? 'trade_gross',
    JSON.stringify(s.fees ?? []), s.referenceRate ?? null,
    s.platform ?? null, s.accountFromId ?? null, s.accountToId ?? null, s.note ?? null,
  ];
}

function rowToStep(r: Record<string, unknown>): ConversionStep {
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));
  const step: ConversionStep = {
    id: String(r['id']),
    chainId: String(r['chain_id']),
    order: Number(r['step_order']),
    fromAssetId: String(r['from_asset_id']),
    fromAmount: String(r['from_amount']),
    toAssetId: String(r['to_asset_id']),
    toAmount: String(r['to_amount']),
  };
  const sourceMode = str(r['source_amount_mode']);
  if (sourceMode === 'account_debit' || sourceMode === 'trade_principal') step.sourceAmountMode = sourceMode;
  const targetMode = str(r['target_amount_mode']);
  if (targetMode === 'account_credit' || targetMode === 'trade_gross') step.targetAmountMode = targetMode;
  const feesJson = str(r['fees_json']);
  if (feesJson) {
    try {
      const fees = JSON.parse(feesJson) as unknown;
      if (Array.isArray(fees)) step.fees = fees as ConversionStep['fees'];
    } catch {
      step.fees = [];
    }
  }
  const rate = str(r['reference_rate']); if (rate !== undefined) step.referenceRate = rate;
  const plat = str(r['platform']); if (plat !== undefined) step.platform = plat;
  const af = str(r['account_from_id']); if (af !== undefined) step.accountFromId = af;
  const at = str(r['account_to_id']); if (at !== undefined) step.accountToId = at;
  const note = str(r['note']); if (note !== undefined) step.note = note;
  return step;
}

/** aggregate type -> table spec, used when applying a synced aggregate revision. */
const EVENT_SPECS: Record<string, TableSpec> = {
  asset: TABLES.assets, account: TABLES.accounts, setting: TABLES.settings,
  conversion_chain: TABLES.conversionChains, lot: TABLES.lots, lot_consumption: TABLES.lotConsumptions,
  price_mark: TABLES.priceMarks, dca_plan: TABLES.dcaPlans, dca_execution: TABLES.dcaExecutions,
  game: TABLES.games, game_account: TABLES.gameAccounts, game_season: TABLES.gameSeasons,
  game_record: TABLES.gameRecords, game_cashflow_link: TABLES.gameCashflowLinks,
  fixed_asset: TABLES.fixedAssets, fixed_asset_event: TABLES.fixedAssetEvents,
  fixed_asset_cashflow_link: TABLES.fixedAssetCashflowLinks,
  fixed_asset_category: TABLES.fixedAssetCategories,
  fixed_asset_usage_metric: TABLES.fixedAssetUsageMetrics,
  fixed_asset_usage_log: TABLES.fixedAssetUsageLogs,
  fixed_asset_consumable: TABLES.fixedAssetConsumables,
  fixed_asset_goal: TABLES.fixedAssetGoals,
  attachment: TABLES.attachments, category: TABLES.categories, payee: TABLES.payees,
  transaction_tag: TABLES.transactionTags, transaction_location: TABLES.transactionLocations,
  transaction_template: TABLES.transactionTemplates, transaction_saved_view: TABLES.transactionSavedViews,
  transaction: TABLES.transactions, transaction_split: TABLES.transactionSplits,
  refund_allocation: TABLES.refundAllocations,
  budget_category: TABLES.budgetCategories, scheduled_transaction: TABLES.scheduledTransactions,
  scheduled_execution: TABLES.scheduledExecutions,
};

const SYNC_DERIVED_TYPES = new Set(['lot', 'lot_consumption']);
const ENTITY_TYPE_BY_TABLE = new Map<string, string>(
  Object.entries(EVENT_SPECS).map(([entityType, spec]) => [spec.name, entityType]),
);
ENTITY_TYPE_BY_TABLE.set(TABLES.reconciliationSessions.name, 'reconciliation_session');
ENTITY_TYPE_BY_TABLE.set(TABLES.reconciliationItems.name, 'reconciliation_item');
const CONVERSION_CACHE_FIELDS = new Set([
  'finalAssetId', 'finalAmount', 'totalBaseCost', 'totalBaseProceeds',
  'totalFeesInBase', 'realizedGainLoss',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertSyncAggregateIdentity(
  type: string,
  id: string,
  payload: Record<string, unknown> | null,
): void {
  if (!payload) return;
  const assertOwner = (value: unknown, idField: string, label: string) => {
    const row = asRecord(value);
    if (!row || row[idField] !== id) throw new Error(`${label}与同步聚合 ${type}:${id} 不一致`);
  };
  const assertChildren = (value: unknown, ownerField: string, label: string) => {
    if (!Array.isArray(value)) throw new Error(`${label} 同步快照必须是数组`);
    for (const child of value) assertOwner(child, ownerField, label);
  };
  if (type === 'conversion') {
    if (payload['chain'] === undefined) return;
    assertOwner(payload['chain'], 'id', '资产转换');
    assertChildren(payload['steps'], 'chainId', '资产转换步骤');
    return;
  }
  if (type === 'transaction') {
    if (payload['transaction'] === undefined) return;
    assertOwner(payload['transaction'], 'id', '日常流水');
    assertChildren(payload['splits'], 'transactionId', '流水拆分');
    assertChildren(payload['refundAllocations'], 'refundTransactionId', '退款分配');
    return;
  }
  if (type === 'reconciliation') {
    if (payload['session'] === undefined) return;
    assertOwner(payload['session'], 'id', '对账批次');
    assertChildren(payload['items'], 'reconciliationId', '对账项目');
    return;
  }
  assertOwner(payload, 'id', '实体');
}

function projectEntity(value: Record<string, unknown>): Record<string, unknown> {
  const projected = syncPayload(value);
  if ('dataSafetyStateJson' in projected) delete projected['dataSafetyStateJson'];
  return projected;
}

function projectConversionChain(value: Record<string, unknown>): Record<string, unknown> {
  const projected = projectEntity(value);
  for (const field of CONVERSION_CACHE_FIELDS) delete projected[field];
  return projected;
}

async function aggregateSnapshot(
  driver: SqlDriver,
  entityType: string,
  payload: unknown,
): Promise<{ aggregateType: string; aggregateId: string; op: 'put' | 'delete'; payload: Record<string, unknown> | null } | null> {
  if (SYNC_DERIVED_TYPES.has(entityType)) return null;
  const row = asRecord(payload);

  if (entityType === 'conversion_chain' || entityType === 'conversion_chain_steps') {
    const chainId = entityType === 'conversion_chain' ? String(row?.['id'] ?? '') : String(row?.['chainId'] ?? row?.['id'] ?? '');
    if (!chainId) return null;
    const chainRow = await driver.get<Record<string, unknown>>('SELECT * FROM conversion_chains WHERE id = ?', [chainId]);
    if (!chainRow) return null;
    const chain = rowToEntity<ConversionChain>(TABLES.conversionChains, chainRow) as unknown as Record<string, unknown>;
    const stepRows = await driver.all<Record<string, unknown>>('SELECT * FROM conversion_steps WHERE chain_id = ? ORDER BY step_order', [chainId]);
    const aggregate = {
      chain: projectConversionChain(chain),
      steps: stepRows.map((step) => syncPayload(rowToStep(step) as unknown as Record<string, unknown>)),
    };
    return { aggregateType: 'conversion', aggregateId: chainId, op: chain['isDeleted'] === true ? 'delete' : 'put', payload: aggregate };
  }

  if (entityType === 'transaction' || entityType === 'transaction_split' || entityType === 'refund_allocation') {
    const transactionId = entityType === 'transaction'
      ? String(row?.['id'] ?? '')
      : entityType === 'refund_allocation'
        ? String(row?.['refundTransactionId'] ?? '')
        : String(row?.['transactionId'] ?? '');
    if (!transactionId) return null;
    const transactionRow = await driver.get<Record<string, unknown>>('SELECT * FROM transactions WHERE id = ?', [transactionId]);
    if (!transactionRow) return null;
    const transaction = rowToEntity(TABLES.transactions, transactionRow) as unknown as Record<string, unknown>;
    const splitRows = await driver.all<Record<string, unknown>>(
      'SELECT * FROM transaction_splits WHERE transaction_id = ? AND is_deleted = 0 ORDER BY rowid',
      [transactionId],
    );
    const allocationRows = await driver.all<Record<string, unknown>>(
      'SELECT * FROM refund_allocations WHERE refund_transaction_id = ? AND is_deleted = 0 ORDER BY rowid',
      [transactionId],
    );
    const aggregate = {
      transaction: projectEntity(transaction),
      splits: splitRows.map((split) => projectEntity(rowToEntity(TABLES.transactionSplits, split) as unknown as Record<string, unknown>)),
      refundAllocations: allocationRows.map((allocation) => projectEntity(rowToEntity(TABLES.refundAllocations, allocation) as unknown as Record<string, unknown>)),
    };
    return { aggregateType: 'transaction', aggregateId: transactionId, op: transaction['isDeleted'] === true ? 'delete' : 'put', payload: aggregate };
  }

  if (entityType === 'reconciliation_session' || entityType === 'reconciliation_item') {
    const reconciliationId = entityType === 'reconciliation_session'
      ? String(row?.['id'] ?? '')
      : String(row?.['reconciliationId'] ?? '');
    if (!reconciliationId) return null;
    const sessionRow = await driver.get<Record<string, unknown>>('SELECT * FROM reconciliation_sessions WHERE id = ?', [reconciliationId]);
    if (!sessionRow) return null;
    const session = rowToEntity(TABLES.reconciliationSessions, sessionRow) as unknown as Record<string, unknown>;
    const itemRows = await driver.all<Record<string, unknown>>(
      'SELECT * FROM reconciliation_items WHERE reconciliation_id = ? AND is_deleted = 0 ORDER BY selected_at, id',
      [reconciliationId],
    );
    const aggregate = {
      session: projectEntity(session),
      items: itemRows.map((item) => projectEntity(rowToEntity(TABLES.reconciliationItems, item) as unknown as Record<string, unknown>)),
    };
    return {
      aggregateType: 'reconciliation',
      aggregateId: reconciliationId,
      op: session['isDeleted'] === true ? 'delete' : 'put',
      payload: aggregate,
    };
  }

  const spec = EVENT_SPECS[entityType];
  if (!spec || !row || typeof row['id'] !== 'string') return null;
  const projected = projectEntity(row);
  return {
    aggregateType: entityType,
    aggregateId: String(row['id']),
    op: row['isDeleted'] === true ? 'delete' : 'put',
    payload: projected,
  };
}

async function ensureLedgerId(driver: SqlDriver): Promise<string> {
  const existing = await driver.get<{ ledger_id: string }>('SELECT ledger_id FROM ledger_meta WHERE id = ?', ['current']);
  if (existing?.ledger_id) return existing.ledger_id;
  const ledgerId = newId();
  await driver.run(
    'INSERT OR IGNORE INTO ledger_meta (id, ledger_id, protocol_version, created_at) VALUES (?, ?, 2, ?)',
    ['current', ledgerId, nowIso()],
  );
  const saved = await driver.get<{ ledger_id: string }>('SELECT ledger_id FROM ledger_meta WHERE id = ?', ['current']);
  return saved?.ledger_id ?? ledgerId;
}

async function captureLocalSyncRevision(
  ctx: StoreCtx,
  auditId: string,
  _op: OperationType,
  entityType: string,
  payload: unknown,
): Promise<void> {
  const aggregate = await aggregateSnapshot(ctx.driver, entityType, payload);
  if (!aggregate) return;

  const commitId = ctx.audit?.batchId ?? auditId;
  const existingRevision = await ctx.driver.get<{ revision_id: string; sealed: number }>(
    `SELECT r.revision_id, c.sealed
     FROM sync_revisions r JOIN sync_commits c ON c.commit_id = r.commit_id
     WHERE r.commit_id = ? AND r.aggregate_type = ? AND r.aggregate_id = ?`,
    [commitId, aggregate.aggregateType, aggregate.aggregateId],
  );
  if (existingRevision) {
    if (existingRevision.sealed === 1) throw new Error(`同步批次 ${commitId} 已封口，不能继续追加修改`);
    await ctx.driver.run(
      'UPDATE sync_revisions SET op = ?, payload = ? WHERE revision_id = ?',
      [aggregate.op, JSON.stringify(aggregate.payload), existingRevision.revision_id],
    );
    return;
  }

  const headRows = await ctx.driver.all<{ revision_id: string }>(
    'SELECT revision_id FROM sync_entity_heads WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY revision_id',
    [aggregate.aggregateType, aggregate.aggregateId],
  );
  if (headRows.length === 1) {
    const current = await ctx.driver.get<{ op: string; payload: string | null }>(
      'SELECT op, payload FROM sync_revisions WHERE revision_id = ?',
      [headRows[0]!.revision_id],
    );
    const currentPayload = current?.payload ? JSON.parse(current.payload) : null;
    if (current?.op === aggregate.op && stableJson(currentPayload) === stableJson(aggregate.payload)) return;
  }

  const ledgerId = await ensureLedgerId(ctx.driver);
  const existingCommit = await ctx.driver.get<{ commit_id: string; sealed: number }>('SELECT commit_id, sealed FROM sync_commits WHERE commit_id = ?', [commitId]);
  if (existingCommit?.sealed === 1) throw new Error(`同步批次 ${commitId} 已封口，不能继续追加修改`);
  if (!existingCommit) {
    const parentRows = await ctx.driver.all<{ commit_id: string }>('SELECT commit_id FROM sync_ledger_heads ORDER BY commit_id');
    await ctx.driver.run(
      `INSERT INTO sync_commits
       (commit_id, ledger_id, origin_device_id, origin_device_name, created_at, parent_commit_ids, resolves_conflict_commit_ids,
        source, source_replica_key, sealed, state, content_hash, received_at, error)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'local', NULL, ?, 'applied', NULL, NULL, NULL)`,
      [commitId, ledgerId, ctx.deviceId ?? 'unknown-device', null, nowIso(), JSON.stringify(parentRows.map((head) => head.commit_id)), ctx.audit?.batchId ? 0 : 1],
    );
    await ctx.driver.run('DELETE FROM sync_ledger_heads');
    await ctx.driver.run('INSERT INTO sync_ledger_heads (commit_id) VALUES (?)', [commitId]);
  }

  const revisionId = newId();
  const parentRevisionIds = headRows.map((head) => head.revision_id);
  await ctx.driver.run(
    `INSERT INTO sync_revisions
     (revision_id, commit_id, aggregate_type, aggregate_id, parent_revision_ids, op, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [revisionId, commitId, aggregate.aggregateType, aggregate.aggregateId, JSON.stringify(parentRevisionIds), aggregate.op, JSON.stringify(aggregate.payload)],
  );
  await ctx.driver.run('DELETE FROM sync_entity_heads WHERE aggregate_type = ? AND aggregate_id = ?', [aggregate.aggregateType, aggregate.aggregateId]);
  await ctx.driver.run(
    'INSERT INTO sync_entity_heads (aggregate_type, aggregate_id, revision_id) VALUES (?, ?, ?)',
    [aggregate.aggregateType, aggregate.aggregateId, revisionId],
  );
}

function jsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function rowToSyncRevision(row: Record<string, unknown>): SyncRevisionV2 {
  return {
    revisionId: String(row['revision_id']),
    aggregateType: String(row['aggregate_type']),
    aggregateId: String(row['aggregate_id']),
    parentRevisionIds: jsonArray(row['parent_revision_ids']),
    op: row['op'] === 'delete' ? 'delete' : 'put',
    payload: row['payload'] == null ? null : JSON.parse(String(row['payload'])) as Record<string, unknown>,
  };
}

function rowToStoredSyncCommit(row: Record<string, unknown>, revisions: SyncRevisionV2[]): StoredSyncCommit {
  const commit: StoredSyncCommit = {
    protocol: 2,
    ledgerId: String(row['ledger_id']),
    commitId: String(row['commit_id']),
    originDeviceId: String(row['origin_device_id']),
    createdAt: String(row['created_at']),
    parentCommitIds: jsonArray(row['parent_commit_ids']),
    revisions,
    source: row['source'] === 'remote' ? 'remote' : 'local',
    sealed: Number(row['sealed']) === 1,
    state: String(row['state']) as StoredSyncCommit['state'],
  };
  const resolvesConflictCommitIds = jsonArray(row['resolves_conflict_commit_ids']);
  if (resolvesConflictCommitIds.length) commit.resolvesConflictCommitIds = resolvesConflictCommitIds;
  if (row['origin_device_name'] != null) commit.originDeviceName = String(row['origin_device_name']);
  if (row['source_replica_key'] != null) commit.sourceReplicaKey = String(row['source_replica_key']);
  if (row['content_hash'] != null) commit.contentHash = String(row['content_hash']);
  if (row['received_at'] != null) commit.receivedAt = String(row['received_at']);
  if (row['error'] != null) commit.error = String(row['error']);
  return commit;
}

// ─────────────────────────── the store ───────────────────────────

export interface StoreOptions {
  logger?: Logger;
  deviceId?: string;
}

export interface DeviceRecoveryState {
  version: 1;
  tables: Record<string, Record<string, unknown>[]>;
}

const DEVICE_RECOVERY_TABLES = [
  'ledger_meta',
  'sync_commits', 'sync_revisions', 'sync_entity_heads', 'sync_ledger_heads',
  'sync_replica_state', 'sync_replica_acks',
  'sync_conflict_groups', 'sync_conflict_branches', 'sync_conflict_resolutions',
  'audit_batches', 'operation_log', 'business_compensations',
  'attachment_blobs', 'attachment_file_ops', 'attachment_replica_blobs',
] as const;

const DEVICE_RECOVERY_DELETE_ORDER = [
  'business_compensations', 'operation_log', 'audit_batches',
  'sync_conflict_resolutions', 'sync_conflict_branches', 'sync_conflict_groups',
  'sync_replica_acks', 'sync_replica_state', 'sync_entity_heads', 'sync_ledger_heads',
  'sync_revisions', 'sync_commits', 'ledger_meta',
  'attachment_replica_blobs', 'attachment_file_ops', 'attachment_blobs',
] as const;

function normalizedRecoveryRows(
  table: (typeof DEVICE_RECOVERY_TABLES)[number],
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (table === 'attachment_file_ops') return [];
  if (table === 'attachment_blobs') {
    return rows.map((row) => ({
      ...row,
      state: 'missing',
      verified_at: null,
      trash_after: null,
      error: '完整设备恢复后等待正文校验',
    }));
  }
  if (table === 'attachment_replica_blobs') {
    return rows.map((row) => {
      const state = String(row['state'] ?? '');
      if (!['uploading', 'downloading', 'deleting'].includes(state)) return row;
      return {
        ...row,
        state: 'queued',
        upload_id: null,
        uploaded_chunks_json: '[]',
        retry_at: null,
        error: '完整设备恢复后重新排队',
      };
    });
  }
  return rows;
}

export interface TombstonePurgeCandidate {
  tableName: string;
  entityType: string;
  entityId: string;
  updatedAt: string;
}

export interface BlockedTombstone extends TombstonePurgeCandidate {
  reason: 'sync_commit_missing' | 'sync_commit_not_ready' | 'awaiting_replicas';
  commitId?: string;
  waitingReplicaKeys: string[];
}

export interface TombstonePurgePreview {
  cutoffIso: string;
  activeReplicaCount: number;
  candidates: number;
  eligible: TombstonePurgeCandidate[];
  blocked: BlockedTombstone[];
}

export interface TombstonePurgeResult {
  purged: number;
  blocked: number;
  activeReplicaCount: number;
}

export interface TransactionReportPage {
  transactions: import('@zichan/core').Transaction[];
  transactionSplits: import('@zichan/core').TransactionSplit[];
  refundAllocations: import('@zichan/core').RefundAllocation[];
  hasMore: boolean;
  nextCursor?: import('@zichan/core').QueryCursor;
}

/** Bounded read model used by the Settings maintenance command. */
export interface TestTransactionCleanupPage {
  transactions: import('@zichan/core').Transaction[];
  attachments: import('@zichan/core').Attachment[];
  hasMore: boolean;
  nextCursor?: import('@zichan/core').QueryCursor;
}

export interface TransactionReportAggregateRow {
  reportDate: string;
  reportAssetId: string;
  direction: 'income' | 'expense';
  category: string;
  amounts: string[];
  count: number;
}

export type TransactionBrowseField =
  | 'date' | 'time' | 'type' | 'category' | 'parentCategory' | 'amount'
  | 'assetId' | 'accountId' | 'payeeId' | 'merchant' | 'description' | 'note'
  | 'tagId' | 'locationId' | 'status' | 'hasAttachment';

export type TransactionBrowseOperator =
  | 'eq' | 'neq' | 'contains' | 'not_contains'
  | 'gte' | 'lte' | 'between' | 'in' | 'empty' | 'not_empty';

export interface TransactionBrowseCondition {
  field: TransactionBrowseField;
  op: TransactionBrowseOperator;
  value?: string;
  value2?: string;
}

export interface TransactionBrowseInput {
  from?: string;
  to?: string;
  type?: import('@zichan/core').TransactionType;
  excludeTypes?: import('@zichan/core').TransactionType[];
  category?: string;
  accountId?: string;
  payeeId?: string;
  tagId?: string;
  status?: import('@zichan/core').TransactionStatus | 'partially_reconciled' | 'reconciled';
  amountMin?: string;
  amountMax?: string;
  search?: string;
  advanced?: { groups: { conditions: TransactionBrowseCondition[] }[] };
  recordState?: 'active' | 'voided' | 'all';
  cursor?: import('@zichan/core').QueryCursor;
  limit?: number;
}

export interface TransactionBrowsePage extends TransactionReportPage {
  attachments: import('@zichan/core').Attachment[];
  reconciliationItems: import('@zichan/core').ReconciliationItem[];
  reconciliationSessions: import('@zichan/core').ReconciliationSession[];
  refundAppliedAmounts: Record<string, string[]>;
  totalCount: number;
}

export interface AccountBalanceAggregateRow {
  accountId: string;
  assetId: string;
  amounts: string[];
}

export interface DashboardTransactionBalanceAggregateRow {
  assetId: string;
  amounts: string[];
}

/** Transaction-only slice of the dashboard read model.
 *
 * Amounts remain decimal strings so the caller can sum and convert them with
 * @zichan/core instead of losing precision in SQLite or JavaScript numbers.
 */
export interface DashboardTransactionReadModel {
  balanceAggregates: DashboardTransactionBalanceAggregateRow[];
  reportAggregates: TransactionReportAggregateRow[];
  recentTransactions: import('@zichan/core').Transaction[];
}

export interface AccountLedgerReadRow {
  transaction: import('@zichan/core').Transaction;
  assetId: string;
  postingAmount: string;
  balance: string;
  reconciliationStatus: import('@zichan/core').TransactionStatus | 'partially_reconciled' | 'reconciled';
}

export interface AccountLedgerPage {
  rows: AccountLedgerReadRow[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: import('@zichan/core').QueryCursor;
  nextStartingBalances: Record<string, string>;
}

export interface ScheduledExecutionClaimInput {
  id: string;
  scheduleId: string;
  occurrenceIndex: number;
  occurrenceDate: string;
  transactionId: string;
  createdAt: string;
  attemptedAt: string;
  leaseUntil: string;
  forceRetry?: boolean;
}

export type ScheduledExecutionClaimResult =
  | { state: 'claimed'; execution: import('@zichan/core').ScheduledExecution; token: string }
  | { state: 'created' | 'skipped' | 'busy' | 'retry_wait'; execution: import('@zichan/core').ScheduledExecution };

const SCHEDULED_EXECUTION_CLAIM_PREFIX = '__zichan_scheduled_execution_claim__:';

function scheduledExecutionClaimMarker(token: string): string {
  return `${SCHEDULED_EXECUTION_CLAIM_PREFIX}${token}`;
}

function isScheduledExecutionClaimMarker(value: string | undefined): boolean {
  return value?.startsWith(SCHEDULED_EXECUTION_CLAIM_PREFIX) ?? false;
}

export function isScheduledExecutionClaim(
  execution: import('@zichan/core').ScheduledExecution | null | undefined,
): boolean {
  return !!execution
    && !execution.isDeleted
    && execution.status === 'failed'
    && isScheduledExecutionClaimMarker(execution.lastError);
}

function sqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:SQLITE_)?BUSY\b|database is locked/i.test(message);
}

async function retryAfterContention(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, 5 * (2 ** attempt))));
}

interface SqlFilter {
  clauses: string[];
  params: SqlParam[];
}

interface DecimalComparisonKey {
  sign: -1 | 0 | 1;
  /** Digits to the left of the decimal point after leading zeroes are removed. */
  adjustedExponent: string;
  /** Significant digits with both insignificant leading and trailing zeroes removed. */
  significantDigits: string;
}

const SQLITE_INTEGER_MIN = -9_223_372_036_854_775_808n;
const SQLITE_INTEGER_MAX = 9_223_372_036_854_775_807n;

/**
 * Build a comparison key without ever coercing a financial value through a JS
 * number. The exponent is kept as a decimal string until SQLite parses it as a
 * signed 64-bit INTEGER; values outside that explicit range are rejected rather
 * than silently saturating. decimal.js's finite exponent range is narrower, but
 * the additional guard documents and protects the storage-engine boundary.
 */
function decimalComparisonKey(value: string): DecimalComparisonKey {
  let decimal;
  try {
    decimal = D(value);
  } catch {
    throw new Error(`金额筛选值不是有效数字：${value}`);
  }
  if (!decimal.isFinite()) throw new Error(`金额筛选值不是有限数字：${value}`);
  if (decimal.isZero()) return { sign: 0, adjustedExponent: '0', significantDigits: '0' };

  const scientific = decimal.abs().toExponential();
  const match = /^(\d)(?:\.(\d+))?e([+-]?\d+)$/.exec(scientific);
  if (!match) throw new Error(`金额筛选值无法标准化：${value}`);
  const significantDigits = `${match[1]}${match[2] ?? ''}`.replace(/0+$/, '') || '0';
  const adjustedExponent = BigInt(match[3]!) + 1n;
  if (adjustedExponent < SQLITE_INTEGER_MIN || adjustedExponent > SQLITE_INTEGER_MAX) {
    throw new Error(`金额筛选值指数超出 SQLite 精确比较范围：${value}`);
  }
  return {
    sign: decimal.isNegative() ? -1 : 1,
    adjustedExponent: adjustedExponent.toString(),
    significantDigits,
  };
}

/**
 * SQLite has no built-in arbitrary-precision decimal type. Amounts are valid,
 * positive decimal strings, so compare their exact scientific representation as
 * `(adjusted exponent, significant digits)`. This works for fixed and exponent
 * notation and uses only SQLite text/integer functions shared by node:sqlite,
 * sql.js and Tauri SQLite.
 */
function positiveDecimalSqlParts(expression: string): {
  adjustedExponent: string;
  significantDigits: string;
} {
  const raw = `LOWER(TRIM(COALESCE(${expression}, '0')))`;
  const unsigned = `CASE WHEN SUBSTR(${raw}, 1, 1) = '+' THEN SUBSTR(${raw}, 2) ELSE ${raw} END`;
  const exponentPosition = `INSTR(${unsigned}, 'e')`;
  const mantissa = `CASE WHEN ${exponentPosition} > 0 THEN SUBSTR(${unsigned}, 1, ${exponentPosition} - 1) ELSE ${unsigned} END`;
  const exponent = `CASE WHEN ${exponentPosition} > 0 THEN CAST(SUBSTR(${unsigned}, ${exponentPosition} + 1) AS INTEGER) ELSE 0 END`;
  const decimalPosition = `INSTR(${mantissa}, '.')`;
  const integerDigits = `CASE WHEN ${decimalPosition} > 0 THEN ${decimalPosition} - 1 ELSE LENGTH(${mantissa}) END`;
  const digits = `REPLACE(${mantissa}, '.', '')`;
  const withoutLeadingZeroes = `LTRIM(${digits}, '0')`;
  const leadingZeroes = `(LENGTH(${digits}) - LENGTH(${withoutLeadingZeroes}))`;
  const canonicalDigits = `RTRIM(${withoutLeadingZeroes}, '0')`;
  return {
    adjustedExponent: `(${integerDigits} + ${exponent} - ${leadingZeroes})`,
    significantDigits: `CASE WHEN ${canonicalDigits} = '' THEN '0' ELSE ${canonicalDigits} END`,
  };
}

function exactPositiveDecimalPredicate(
  expression: string,
  operator: '=' | '>=' | '<=',
  value: string,
  params: SqlParam[],
): string {
  const key = decimalComparisonKey(value);
  // Persisted transaction amounts are strictly positive. Handling non-positive
  // filter bounds here keeps zero separate from the scientific magnitude tuple.
  if (key.sign <= 0) {
    if (operator === '>=') return '1 = 1';
    return '0 = 1';
  }
  const stored = positiveDecimalSqlParts(expression);
  params.push(key.adjustedExponent, key.significantDigits);
  return `((${stored.adjustedExponent}, ${stored.significantDigits}) ${operator} (CAST(? AS INTEGER), ?))`;
}

const TRANSACTION_REPORT_DATE_SQL =
  "CASE WHEN t.type = 'refund' THEN COALESCE(t.refund_effect_date, t.date) ELSE t.date END";

const TRANSACTION_POSTINGS_CTE = `postings AS (
  SELECT t.id AS transaction_id, '0' AS posting_side, t.date AS posting_date, t.asset_id AS asset_id,
         t.account_id AS account_id,
         CASE
           WHEN t.type IN ('income', 'refund') THEN t.amount
           WHEN t.type = 'adjustment' AND t.adjustment_direction <> 'decrease' THEN t.amount
           ELSE CASE WHEN substr(t.amount, 1, 1) = '-' THEN t.amount ELSE '-' || t.amount END
         END AS posting_amount
  FROM transactions t
  WHERE t.is_deleted = 0 AND COALESCE(t.record_state, 'active') = 'active'
    AND t.account_id IS NOT NULL
  UNION ALL
  SELECT t.id AS transaction_id, '1' AS posting_side, t.date AS posting_date,
         COALESCE(t.transfer_asset_id, t.asset_id) AS asset_id,
         t.transfer_account_id AS account_id,
         COALESCE(t.transfer_amount, t.amount) AS posting_amount
  FROM transactions t
  WHERE t.is_deleted = 0 AND COALESCE(t.record_state, 'active') = 'active'
    AND t.type = 'transfer' AND t.transfer_account_id IS NOT NULL
)`;

/** Dashboard balances include account-less postings but exclude the special
 * equity/opening accounts, matching apps/web's financialPostings contract. */
const DASHBOARD_TRANSACTION_POSTINGS_CTE = `dashboard_postings AS (
  SELECT t.asset_id AS asset_id,
         CASE
           WHEN t.type IN ('income', 'refund') THEN t.amount
           WHEN t.type = 'adjustment' AND t.adjustment_direction <> 'decrease' THEN t.amount
           ELSE CASE WHEN substr(t.amount, 1, 1) = '-' THEN t.amount ELSE '-' || t.amount END
         END AS posting_amount
  FROM transactions t
  WHERE t.is_deleted = 0 AND COALESCE(t.record_state, 'active') = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.id = t.account_id AND a.is_deleted = 0 AND a.kind = 'other'
    )
  UNION ALL
  SELECT COALESCE(t.transfer_asset_id, t.asset_id) AS asset_id,
         COALESCE(t.transfer_amount, t.amount) AS posting_amount
  FROM transactions t
  WHERE t.is_deleted = 0 AND COALESCE(t.record_state, 'active') = 'active'
    AND t.type = 'transfer'
    AND NOT EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.id = t.transfer_account_id AND a.is_deleted = 0 AND a.kind = 'other'
    )
)`;

const TRANSACTION_RECONCILIATION_STATUS_SQL = `CASE
  WHEN EXISTS (
    SELECT 1
    FROM reconciliation_items ri
    JOIN reconciliation_sessions rs ON rs.id = ri.reconciliation_id
    WHERE ri.transaction_id = t.id AND ri.is_deleted = 0
      AND rs.is_deleted = 0 AND rs.status = 'closed'
  ) THEN CASE
    WHEN t.type = 'transfer'
      AND t.transfer_account_id IS NOT NULL
      AND (
        COALESCE(t.account_id, '') <> COALESCE(t.transfer_account_id, '')
        OR COALESCE(t.asset_id, '') <> COALESCE(t.transfer_asset_id, t.asset_id, '')
      )
      AND NOT (
        EXISTS (
          SELECT 1 FROM reconciliation_items ri
          JOIN reconciliation_sessions rs ON rs.id = ri.reconciliation_id
          WHERE ri.transaction_id = t.id AND ri.is_deleted = 0
            AND rs.is_deleted = 0 AND rs.status = 'closed'
            AND ri.account_id = t.account_id AND ri.asset_id = t.asset_id
        )
        AND EXISTS (
          SELECT 1 FROM reconciliation_items ri
          JOIN reconciliation_sessions rs ON rs.id = ri.reconciliation_id
          WHERE ri.transaction_id = t.id AND ri.is_deleted = 0
            AND rs.is_deleted = 0 AND rs.status = 'closed'
            AND ri.account_id = t.transfer_account_id
            AND ri.asset_id = COALESCE(t.transfer_asset_id, t.asset_id)
        )
      )
      THEN 'partially_reconciled'
    ELSE 'reconciled'
  END
  ELSE COALESCE(t.status, 'cleared')
END`;

function transactionValueSetSql(field: TransactionBrowseField): string {
  if (field === 'date') return 'SELECT t.date AS value';
  if (field === 'time') return 'SELECT t.time AS value';
  if (field === 'type') {
    return `SELECT t.type AS value UNION ALL SELECT CASE t.type
      WHEN 'income' THEN '收入' WHEN 'expense' THEN '支出' WHEN 'transfer' THEN '转账'
      WHEN 'refund' THEN '退款' WHEN 'adjustment' THEN '余额调整' END`;
  }
  if (field === 'category') {
    return `SELECT t.category AS value
      UNION ALL SELECT s.category FROM transaction_splits s
        WHERE s.transaction_id = t.id AND s.is_deleted = 0
      UNION ALL SELECT a.category_id FROM refund_allocations a
        WHERE a.refund_transaction_id = t.id AND a.is_deleted = 0
      UNION ALL SELECT c.name FROM categories c
        WHERE c.is_deleted = 0 AND (
          c.id = t.category
          OR c.id IN (SELECT s.category FROM transaction_splits s WHERE s.transaction_id = t.id AND s.is_deleted = 0)
          OR c.id IN (SELECT a.category_id FROM refund_allocations a WHERE a.refund_transaction_id = t.id AND a.is_deleted = 0)
        )`;
  }
  if (field === 'parentCategory') {
    return `SELECT c.parent_id AS value FROM categories c
      WHERE c.is_deleted = 0 AND c.parent_id IS NOT NULL AND (
        c.id = t.category
        OR c.id IN (SELECT s.category FROM transaction_splits s WHERE s.transaction_id = t.id AND s.is_deleted = 0)
        OR c.id IN (SELECT a.category_id FROM refund_allocations a WHERE a.refund_transaction_id = t.id AND a.is_deleted = 0)
      )`;
  }
  if (field === 'amount') return 'SELECT t.amount AS value';
  if (field === 'assetId') {
    return `SELECT t.asset_id AS value
      UNION ALL SELECT a.code FROM assets a WHERE a.id = t.asset_id AND a.is_deleted = 0`;
  }
  if (field === 'accountId') {
    return `SELECT t.account_id AS value
      UNION ALL SELECT t.transfer_account_id
      UNION ALL SELECT a.name FROM accounts a
        WHERE a.is_deleted = 0 AND a.id IN (t.account_id, t.transfer_account_id)`;
  }
  if (field === 'payeeId') {
    return `SELECT t.payee_id AS value
      UNION ALL SELECT COALESCE(p.name, t.merchant) FROM (SELECT 1) seed
        LEFT JOIN payees p ON p.id = t.payee_id AND p.is_deleted = 0`;
  }
  if (field === 'merchant') {
    return `SELECT t.merchant AS value
      UNION ALL SELECT COALESCE(p.name, t.merchant) FROM (SELECT 1) seed
        LEFT JOIN payees p ON p.id = t.payee_id AND p.is_deleted = 0`;
  }
  if (field === 'description') return 'SELECT t.description AS value';
  if (field === 'note') return 'SELECT t.note AS value';
  if (field === 'tagId') {
    return `SELECT j.value AS value FROM json_each(COALESCE(t.tag_ids, '[]')) j
      UNION ALL SELECT TRIM(COALESCE(tag.group_name || ' ', '') || tag.name)
        FROM json_each(COALESCE(t.tag_ids, '[]')) j
        JOIN transaction_tags tag ON tag.id = j.value AND tag.is_deleted = 0`;
  }
  if (field === 'locationId') {
    return `SELECT t.location_id AS value
      UNION ALL SELECT t.location_name
      UNION ALL SELECT l.name FROM transaction_locations l WHERE l.id = t.location_id AND l.is_deleted = 0
      UNION ALL SELECT l.address FROM transaction_locations l WHERE l.id = t.location_id AND l.is_deleted = 0`;
  }
  if (field === 'status') {
    return `SELECT ${TRANSACTION_RECONCILIATION_STATUS_SQL} AS value
      UNION ALL SELECT CASE ${TRANSACTION_RECONCILIATION_STATUS_SQL}
        WHEN 'pending' THEN '待确认' WHEN 'cleared' THEN '已清算'
        WHEN 'partially_reconciled' THEN '部分对账' WHEN 'reconciled' THEN '已对账' END`;
  }
  return `SELECT CASE WHEN EXISTS (
    SELECT 1 FROM attachments a
    WHERE a.entity_type = 'transaction' AND a.entity_id = t.id AND a.is_deleted = 0
  ) THEN 'true' ELSE 'false' END AS value`;
}

function transactionConditionSql(
  condition: TransactionBrowseCondition,
  params: SqlParam[],
): string {
  const value = condition.value?.trim() ?? '';
  const value2 = condition.value2?.trim() ?? '';
  const set = transactionValueSetSql(condition.field);
  const nonEmpty = `TRIM(COALESCE(CAST(v.value AS TEXT), '')) <> ''`;
  if (condition.op === 'empty') return `NOT EXISTS (SELECT 1 FROM (${set}) v WHERE ${nonEmpty})`;
  if (condition.op === 'not_empty') return `EXISTS (SELECT 1 FROM (${set}) v WHERE ${nonEmpty})`;
  if (!value && condition.op !== 'between') return '1 = 1';
  if (condition.op === 'in') {
    const values = value.split(/[\n,，]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (!values.length) return '1 = 1';
    if (condition.field === 'amount') {
      const predicates = values.map((item) => exactPositiveDecimalPredicate('v.value', '=', item, params));
      return `EXISTS (SELECT 1 FROM (${set}) v WHERE ${predicates.map((item) => `(${item})`).join(' OR ')})`;
    }
    params.push(...values);
    return `EXISTS (SELECT 1 FROM (${set}) v
      WHERE LOWER(TRIM(COALESCE(CAST(v.value AS TEXT), ''))) IN (${values.map(() => '?').join(', ')}))`;
  }
  if (condition.op === 'eq' || condition.op === 'neq') {
    const predicate = condition.field === 'amount'
      ? exactPositiveDecimalPredicate('v.value', '=', value, params)
      : (() => {
        params.push(value.toLowerCase());
        return "LOWER(TRIM(COALESCE(CAST(v.value AS TEXT), ''))) = ?";
      })();
    const exists = `EXISTS (SELECT 1 FROM (${set}) v WHERE ${predicate})`;
    return condition.op === 'neq' ? `NOT ${exists}` : exists;
  }
  if (condition.op === 'contains' || condition.op === 'not_contains') {
    params.push(value.toLowerCase());
    const exists = `EXISTS (SELECT 1 FROM (${set}) v
      WHERE INSTR(LOWER(COALESCE(CAST(v.value AS TEXT), '')), ?) > 0)`;
    return condition.op === 'not_contains' ? `NOT ${exists}` : exists;
  }
  if (condition.op === 'between' && (!value || !value2)) return '1 = 1';
  const numeric = condition.field === 'amount';
  const comparable = "TRIM(COALESCE(CAST(v.value AS TEXT), ''))";
  if (condition.op === 'gte' || condition.op === 'lte') {
    if (numeric) {
      const predicate = exactPositiveDecimalPredicate(
        'v.value',
        condition.op === 'gte' ? '>=' : '<=',
        value,
        params,
      );
      return `EXISTS (SELECT 1 FROM (${set}) v WHERE ${predicate})`;
    }
    params.push(value);
    return `EXISTS (SELECT 1 FROM (${set}) v WHERE ${comparable} ${condition.op === 'gte' ? '>=' : '<='} ?)`;
  }
  if (numeric) {
    const lower = exactPositiveDecimalPredicate('v.value', '>=', value, params);
    const upper = exactPositiveDecimalPredicate('v.value', '<=', value2, params);
    return `EXISTS (SELECT 1 FROM (${set}) v WHERE ${lower} AND ${upper})`;
  }
  params.push(value, value2);
  return `EXISTS (SELECT 1 FROM (${set}) v WHERE ${comparable} >= ? AND ${comparable} <= ?)`;
}

function transactionBrowseFilter(input: TransactionBrowseInput, includeCursor: boolean): SqlFilter {
  const clauses = ['t.is_deleted = 0'];
  const params: SqlParam[] = [];
  if (input.recordState !== 'all') {
    clauses.push("COALESCE(t.record_state, 'active') = ?");
    params.push(input.recordState ?? 'active');
  }
  if (input.from) {
    clauses.push(`${TRANSACTION_REPORT_DATE_SQL} >= ?`);
    params.push(input.from);
  }
  if (input.to) {
    clauses.push(`${TRANSACTION_REPORT_DATE_SQL} <= ?`);
    params.push(input.to);
  }
  if (input.type) {
    clauses.push('t.type = ?');
    params.push(input.type);
  }
  if (input.excludeTypes?.length) {
    clauses.push(`t.type NOT IN (${input.excludeTypes.map(() => '?').join(', ')})`);
    params.push(...input.excludeTypes);
  }
  if (input.category) {
    clauses.push(`EXISTS (SELECT 1 FROM (${transactionValueSetSql('category')}) cv
      WHERE cv.value = ?)`);
    params.push(input.category);
  }
  if (input.accountId) {
    clauses.push('(t.account_id = ? OR t.transfer_account_id = ?)');
    params.push(input.accountId, input.accountId);
  }
  if (input.payeeId) {
    clauses.push('t.payee_id = ?');
    params.push(input.payeeId);
  }
  if (input.tagId) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(t.tag_ids, '[]')) tag WHERE tag.value = ?)`);
    params.push(input.tagId);
  }
  if (input.status) {
    clauses.push(`${TRANSACTION_RECONCILIATION_STATUS_SQL} = ?`);
    params.push(input.status);
  }
  if (input.amountMin?.trim()) {
    clauses.push(exactPositiveDecimalPredicate('t.amount', '>=', input.amountMin.trim(), params));
  }
  if (input.amountMax?.trim()) {
    clauses.push(exactPositiveDecimalPredicate('t.amount', '<=', input.amountMax.trim(), params));
  }
  const search = input.search?.trim().toLowerCase();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push(`(
      LOWER(COALESCE(t.description, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(t.merchant, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(t.note, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM payees p WHERE p.id = t.payee_id AND p.is_deleted = 0 AND LOWER(p.name) LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM transaction_locations l WHERE l.id = t.location_id AND l.is_deleted = 0
        AND (LOWER(l.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(l.address, '')) LIKE ? ESCAPE '\\'))
      OR EXISTS (
        SELECT 1 FROM json_each(COALESCE(t.tag_ids, '[]')) j
        JOIN transaction_tags tag ON tag.id = j.value AND tag.is_deleted = 0
        WHERE LOWER(COALESCE(tag.group_name || ' ', '') || tag.name) LIKE ? ESCAPE '\\'
      )
    )`);
    params.push(like, like, like, like, like, like, like);
  }
  const groups = input.advanced?.groups
    .map((group) => group.conditions.filter((condition) => condition.field && condition.op))
    .filter((conditions) => conditions.length);
  if (groups?.length) {
    const groupSql = groups.map((conditions) =>
      `(${conditions.map((condition) => transactionConditionSql(condition, params)).join(' AND ')})`);
    clauses.push(`(${groupSql.join(' OR ')})`);
  }
  if (includeCursor && input.cursor) {
    clauses.push(`(${TRANSACTION_REPORT_DATE_SQL} < ? OR (${TRANSACTION_REPORT_DATE_SQL} = ? AND t.id < ?))`);
    params.push(input.cursor.value as SqlParam, input.cursor.value as SqlParam, input.cursor.id);
  }
  return { clauses, params };
}

async function tombstonePurgePreview(
  driver: SqlDriver,
  cutoffIso: string,
): Promise<TombstonePurgePreview> {
  const activeReplicas = await driver.all<{ replica_key: string }>(
    'SELECT replica_key FROM sync_replica_state WHERE retired_at IS NULL ORDER BY replica_key',
  );
  const eligible: TombstonePurgeCandidate[] = [];
  const blocked: BlockedTombstone[] = [];
  let candidates = 0;
  for (const spec of Object.values(TABLES) as TableSpec[]) {
    const entityType = ENTITY_TYPE_BY_TABLE.get(spec.name);
    if (!entityType) throw new Error(`墓碑回收缺少 ${spec.name} 的实体类型映射`);
    const rows = await driver.all<{ id: string; updated_at: string }>(
      `SELECT id, updated_at FROM ${spec.name}
       WHERE is_deleted = 1 AND updated_at < ? ORDER BY updated_at, id`,
      [cutoffIso],
    );
    for (const row of rows) {
      candidates += 1;
      const candidate: TombstonePurgeCandidate = {
        tableName: spec.name,
        entityType,
        entityId: row.id,
        updatedAt: row.updated_at,
      };
      if (activeReplicas.length === 0 || SYNC_DERIVED_TYPES.has(entityType)) {
        eligible.push(candidate);
        continue;
      }
      const auditRow = await driver.get<{ commit_id: string }>(
        `SELECT COALESCE(batch_id, id) AS commit_id
         FROM operation_log
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY rowid DESC LIMIT 1`,
        [entityType, row.id],
      );
      if (!auditRow?.commit_id) {
        blocked.push({
          ...candidate,
          reason: 'sync_commit_missing',
          waitingReplicaKeys: activeReplicas.map((replica) => replica.replica_key),
        });
        continue;
      }
      const commit = await driver.get<{ sealed: number; state: string }>(
        'SELECT sealed, state FROM sync_commits WHERE commit_id = ?',
        [auditRow.commit_id],
      );
      if (!commit || Number(commit.sealed) !== 1 || commit.state === 'invalid' || commit.state === 'pending') {
        blocked.push({
          ...candidate,
          reason: commit ? 'sync_commit_not_ready' : 'sync_commit_missing',
          commitId: auditRow.commit_id,
          waitingReplicaKeys: activeReplicas.map((replica) => replica.replica_key),
        });
        continue;
      }
      const acknowledged = new Set((await driver.all<{ replica_key: string }>(
        'SELECT replica_key FROM sync_replica_acks WHERE commit_id = ?',
        [auditRow.commit_id],
      )).map((ack) => ack.replica_key));
      const waitingReplicaKeys = activeReplicas
        .map((replica) => replica.replica_key)
        .filter((key) => !acknowledged.has(key));
      if (waitingReplicaKeys.length) {
        blocked.push({
          ...candidate,
          reason: 'awaiting_replicas',
          commitId: auditRow.commit_id,
          waitingReplicaKeys,
        });
      } else {
        eligible.push(candidate);
      }
    }
  }
  return {
    cutoffIso,
    activeReplicaCount: activeReplicas.length,
    candidates,
    eligible,
    blocked,
  };
}

export class SqlLedgerStore implements LedgerStore {
  private readonly ctx: StoreCtx;
  private readonly log: Logger;

  readonly assets: Collection<import('@zichan/core').Asset>;
  readonly accounts: Collection<import('@zichan/core').Account>;
  readonly settings: Collection<import('@zichan/core').Setting>;
  readonly conversionChains: Collection<ConversionChain>;
  readonly lots: Collection<import('@zichan/core').Lot>;
  readonly lotConsumptions: Collection<import('@zichan/core').LotConsumption>;
  readonly priceMarks: Collection<import('@zichan/core').PriceMark>;
  readonly dcaPlans: Collection<import('@zichan/core').DcaPlan>;
  readonly dcaExecutions: Collection<import('@zichan/core').DcaExecution>;
  readonly games: Collection<import('@zichan/core').Game>;
  readonly gameAccounts: Collection<import('@zichan/core').GameAccount>;
  readonly gameSeasons: Collection<import('@zichan/core').GameSeason>;
  readonly gameRecords: Collection<import('@zichan/core').GameRecord>;
  readonly gameCashflowLinks: Collection<import('@zichan/core').GameCashflowLink>;
  readonly fixedAssets: Collection<import('@zichan/core').FixedAsset>;
  readonly fixedAssetCategories: Collection<import('@zichan/core').FixedAssetCategory>;
  readonly fixedAssetEvents: Collection<import('@zichan/core').FixedAssetEvent>;
  readonly fixedAssetCashflowLinks: Collection<import('@zichan/core').FixedAssetCashflowLink>;
  readonly fixedAssetUsageMetrics: Collection<import('@zichan/core').FixedAssetUsageMetric>;
  readonly fixedAssetUsageLogs: Collection<import('@zichan/core').FixedAssetUsageLog>;
  readonly fixedAssetConsumables: Collection<import('@zichan/core').FixedAssetConsumable>;
  readonly fixedAssetGoals: Collection<import('@zichan/core').FixedAssetGoal>;
  readonly attachments: Collection<import('@zichan/core').Attachment>;
  readonly categories: Collection<import('@zichan/core').Category>;
  readonly transactionTags: Collection<import('@zichan/core').TransactionTag>;
  readonly transactionLocations: Collection<import('@zichan/core').TransactionLocation>;
  readonly transactionTemplates: Collection<import('@zichan/core').TransactionTemplate>;
  readonly transactionSavedViews: Collection<import('@zichan/core').TransactionSavedView>;
  readonly payees: Collection<import('@zichan/core').Payee>;
  readonly transactions: Collection<import('@zichan/core').Transaction>;
  readonly transactionSplits: Collection<import('@zichan/core').TransactionSplit>;
  readonly refundAllocations: Collection<import('@zichan/core').RefundAllocation>;
  readonly budgetCategories: Collection<import('@zichan/core').BudgetCategory>;
  readonly scheduledTransactions: Collection<import('@zichan/core').ScheduledTransaction>;
  readonly scheduledExecutions: Collection<import('@zichan/core').ScheduledExecution>;
  readonly reconciliationSessions: Collection<import('@zichan/core').ReconciliationSession>;
  readonly reconciliationItems: Collection<import('@zichan/core').ReconciliationItem>;
  readonly attachmentState: AttachmentStateRepository;

  constructor(
    private readonly driver: SqlDriver,
    opts: StoreOptions = {},
    parentContext?: Omit<StoreCtx, 'driver'>,
  ) {
    this.log = parentContext?.log ?? (opts.logger ?? createLogger({ level: 'info', sinks: [nullSink()] })).child('db', {
      deviceId: opts.deviceId,
    });
    this.ctx = parentContext
      ? {
        driver,
        log: parentContext.log,
        deviceId: parentContext.deviceId,
        audit: parentContext.audit,
        changeBus: parentContext.changeBus,
        pendingChanges: parentContext.pendingChanges,
        pendingReconciliationValidations: parentContext.pendingReconciliationValidations,
        prevalidatedAggregates: parentContext.prevalidatedAggregates,
        restoreWriteKeys: parentContext.restoreWriteKeys,
        restoreDeleteKeys: parentContext.restoreDeleteKeys,
        allowInactiveReferences: parentContext.allowInactiveReferences,
        inactiveReferenceScope: parentContext.inactiveReferenceScope,
        compensationSignal: parentContext.compensationSignal,
      }
      : {
        driver,
        log: this.log,
        deviceId: opts.deviceId,
        changeBus: new StoreChangeBus(),
        compensationSignal: {},
      };

    const C = <T extends BaseEntity>(spec: TableSpec, type: string) =>
      new SqlCollection<T>(this.ctx, spec, type);

    this.assets = C(TABLES.assets, 'asset');
    this.accounts = C(TABLES.accounts, 'account');
    this.settings = C(TABLES.settings, 'setting');
    this.conversionChains = C(TABLES.conversionChains, 'conversion_chain');
    this.lots = C(TABLES.lots, 'lot');
    this.lotConsumptions = C(TABLES.lotConsumptions, 'lot_consumption');
    this.priceMarks = C(TABLES.priceMarks, 'price_mark');
    this.dcaPlans = C(TABLES.dcaPlans, 'dca_plan');
    this.dcaExecutions = C(TABLES.dcaExecutions, 'dca_execution');
    this.games = C(TABLES.games, 'game');
    this.gameAccounts = C(TABLES.gameAccounts, 'game_account');
    this.gameSeasons = C(TABLES.gameSeasons, 'game_season');
    this.gameRecords = C(TABLES.gameRecords, 'game_record');
    this.gameCashflowLinks = C(TABLES.gameCashflowLinks, 'game_cashflow_link');
    this.fixedAssets = C(TABLES.fixedAssets, 'fixed_asset');
    this.fixedAssetCategories = C(TABLES.fixedAssetCategories, 'fixed_asset_category');
    this.fixedAssetEvents = C(TABLES.fixedAssetEvents, 'fixed_asset_event');
    this.fixedAssetCashflowLinks = C(TABLES.fixedAssetCashflowLinks, 'fixed_asset_cashflow_link');
    this.fixedAssetUsageMetrics = C(TABLES.fixedAssetUsageMetrics, 'fixed_asset_usage_metric');
    this.fixedAssetUsageLogs = C(TABLES.fixedAssetUsageLogs, 'fixed_asset_usage_log');
    this.fixedAssetConsumables = C(TABLES.fixedAssetConsumables, 'fixed_asset_consumable');
    this.fixedAssetGoals = C(TABLES.fixedAssetGoals, 'fixed_asset_goal');
    this.attachments = C(TABLES.attachments, 'attachment');
    this.categories = C(TABLES.categories, 'category');
    this.transactionTags = C(TABLES.transactionTags, 'transaction_tag');
    this.transactionLocations = C(TABLES.transactionLocations, 'transaction_location');
    this.transactionTemplates = C(TABLES.transactionTemplates, 'transaction_template');
    this.transactionSavedViews = C(TABLES.transactionSavedViews, 'transaction_saved_view');
    this.payees = C(TABLES.payees, 'payee');
    this.transactions = C(TABLES.transactions, 'transaction');
    this.transactionSplits = C(TABLES.transactionSplits, 'transaction_split');
    this.refundAllocations = C(TABLES.refundAllocations, 'refund_allocation');
    this.budgetCategories = C(TABLES.budgetCategories, 'budget_category');
    this.scheduledTransactions = C(TABLES.scheduledTransactions, 'scheduled_transaction');
    this.scheduledExecutions = C(TABLES.scheduledExecutions, 'scheduled_execution');
    this.reconciliationSessions = C(TABLES.reconciliationSessions, 'reconciliation_session');
    this.reconciliationItems = C(TABLES.reconciliationItems, 'reconciliation_item');
    this.attachmentState = new AttachmentStateRepository(driver);
  }

  /**
   * Atomically reserve one scheduled occurrence across every store/connection
   * sharing the SQLite database. The lease is deliberately stored in the
   * existing execution row and is not audited or synced; only the eventual
   * `created`, `skipped`, or real `failed` state becomes a business revision.
   */
  async claimScheduledExecution(input: ScheduledExecutionClaimInput): Promise<ScheduledExecutionClaimResult> {
    const token = newId();
    const marker = scheduledExecutionClaimMarker(token);
    const spec = TABLES.scheduledExecutions;
    const columns = allCols(spec);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.driver.transaction(async (driver) => {
          const initial: import('@zichan/core').ScheduledExecution = {
            id: input.id,
            createdAt: input.createdAt,
            updatedAt: input.attemptedAt,
            version: 1,
            isDeleted: false,
            scheduleId: input.scheduleId,
            occurrenceIndex: input.occurrenceIndex,
            occurrenceDate: input.occurrenceDate,
            status: 'failed',
            attemptedAt: input.attemptedAt,
            retryCount: 0,
            lastError: marker,
            nextRetryAt: input.leaseUntil,
          };
          // The write happens before any read. SQLite therefore serializes
          // competing claimants instead of allowing two deferred snapshots to
          // both conclude that the occurrence is absent.
          const inserted = await driver.run(
            `INSERT OR IGNORE INTO ${spec.name} (${columns.map((column) => column.col).join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`,
            entityToParams(spec, initial as unknown as Record<string, unknown>),
          );
          if (inserted.changes === 1) return { state: 'claimed', execution: initial, token };

          const activeRow = await driver.get<Record<string, unknown>>(
            `SELECT * FROM scheduled_executions
             WHERE schedule_id = ? AND occurrence_index = ? AND is_deleted = 0
             ORDER BY rowid LIMIT 1`,
            [input.scheduleId, input.occurrenceIndex],
          );
          const idRow = activeRow ?? await driver.get<Record<string, unknown>>(
            'SELECT * FROM scheduled_executions WHERE id = ?',
            [input.id],
          );
          if (!idRow) throw new Error('定期执行唯一约束冲突，但未找到冲突记录');
          const current = rowToEntity<import('@zichan/core').ScheduledExecution>(spec, idRow);
          if (current.id !== input.id) {
            // A non-deterministic historical id still owns this logical
            // occurrence. Never create a second active execution beside it.
            if (current.status === 'skipped') return { state: 'skipped', execution: current };
            if (current.status === 'created') return { state: 'created', execution: current };
            return { state: 'busy', execution: current };
          }
          if (!current.isDeleted && current.status === 'skipped') {
            return { state: 'skipped', execution: current };
          }
          if (!current.isDeleted && current.status === 'created') {
            const transaction = current.transactionId
              ? await driver.get<{ id: string }>(
                'SELECT id FROM transactions WHERE id = ? AND is_deleted = 0',
                [current.transactionId],
              )
              : undefined;
            if (transaction) return { state: 'created', execution: current };
            if (current.transactionId !== input.transactionId) {
              return { state: 'created', execution: current };
            }
            // Repair a historical orphan using the same lease/CAS path.
          } else if (!current.isDeleted && current.status === 'failed') {
            const activeClaim = isScheduledExecutionClaimMarker(current.lastError)
              && !!current.nextRetryAt
              && current.nextRetryAt > input.attemptedAt;
            if (activeClaim) return { state: 'busy', execution: current };
            const retryWaiting = !isScheduledExecutionClaimMarker(current.lastError)
              && !!current.nextRetryAt
              && current.nextRetryAt > input.attemptedAt;
            if (retryWaiting && !input.forceRetry) return { state: 'retry_wait', execution: current };
          }

          const claimed = await driver.run(
            `UPDATE scheduled_executions
             SET created_at = CASE WHEN created_at IS NULL OR created_at = '' THEN ? ELSE created_at END,
                 updated_at = ?, version = version + 1, is_deleted = 0,
                 schedule_id = ?, occurrence_index = ?, occurrence_date = ?, status = 'failed',
                 transaction_id = NULL, attempted_at = ?, completed_at = NULL,
                 retry_count = COALESCE(retry_count, 0), last_error = ?, next_retry_at = ?
             WHERE id = ? AND version = ?`,
            [
              input.createdAt,
              input.attemptedAt,
              input.scheduleId,
              input.occurrenceIndex,
              input.occurrenceDate,
              input.attemptedAt,
              marker,
              input.leaseUntil,
              current.id,
              current.version,
            ],
          );
          if (claimed.changes !== 1) {
            const latestRow = await driver.get<Record<string, unknown>>(
              'SELECT * FROM scheduled_executions WHERE id = ?',
              [current.id],
            );
            if (!latestRow) throw new Error('定期执行 claim 竞争后记录消失');
            return {
              state: 'busy',
              execution: rowToEntity<import('@zichan/core').ScheduledExecution>(spec, latestRow),
            };
          }
          const claimedRow = await driver.get<Record<string, unknown>>(
            'SELECT * FROM scheduled_executions WHERE id = ?',
            [current.id],
          );
          if (!claimedRow) throw new Error('定期执行 claim 写入后记录消失');
          return {
            state: 'claimed',
            execution: rowToEntity<import('@zichan/core').ScheduledExecution>(spec, claimedRow),
            token,
          };
        });
      } catch (error) {
        if (!sqliteBusy(error) || attempt >= 7) throw error;
        await retryAfterContention(attempt);
      }
    }
  }

  async getScheduledExecutionClaim(
    id: string,
    token: string,
  ): Promise<import('@zichan/core').ScheduledExecution | null> {
    const row = await this.scheduledExecutions.get(id);
    return row
      && !row.isDeleted
      && row.status === 'failed'
      && row.lastError === scheduledExecutionClaimMarker(token)
      ? row
      : null;
  }

  private scoped(
    driver: SqlDriver,
    audit = this.ctx.audit,
    pendingChanges = this.ctx.pendingChanges,
    prevalidatedAggregates = this.ctx.prevalidatedAggregates,
    restoreWriteKeys = this.ctx.restoreWriteKeys,
    restoreDeleteKeys = this.ctx.restoreDeleteKeys,
    allowInactiveReferences = this.ctx.allowInactiveReferences,
    pendingReconciliationValidations = this.ctx.pendingReconciliationValidations,
    inactiveReferenceScope = this.ctx.inactiveReferenceScope,
  ): SqlLedgerStore {
    return new SqlLedgerStore(driver, {}, {
      log: this.ctx.log,
      deviceId: this.ctx.deviceId,
      audit,
      changeBus: this.ctx.changeBus,
      pendingChanges,
      pendingReconciliationValidations,
      prevalidatedAggregates,
      restoreWriteKeys,
      restoreDeleteKeys,
      allowInactiveReferences,
      inactiveReferenceScope,
      compensationSignal: this.ctx.compensationSignal,
    });
  }

  subscribe(listener: StoreChangeListener): () => void {
    return this.ctx.changeBus.subscribe(listener);
  }

  invalidate(entityTypes: Iterable<string> = ['*']): void {
    this.ctx.changeBus.publish(entityTypes);
  }

  async withAuditContext<T>(meta: AuditContext, fn: (store: this) => Promise<T>): Promise<T> {
    const scoped = this.scoped(this.driver, { ...this.ctx.audit, ...meta });
    try {
      return await fn(scoped as this);
    } finally {
      if (meta.batchId && !meta.suppressSync && meta.source !== 'remote_sync') {
        // A transaction failure removes the row. Non-transactional callers may
        // have committed a partial but real change, which must remain syncable.
        await this.driver.run('UPDATE sync_commits SET sealed = 1 WHERE commit_id = ?', [meta.batchId]);
      }
    }
  }

  async createAuditBatch(input: Omit<AuditBatch, 'startedAt' | 'entityCount'> & { startedAt?: string; entityCount?: number }): Promise<AuditBatch> {
    const row: AuditBatch = {
      ...input,
      startedAt: input.startedAt ?? nowIso(),
      entityCount: input.entityCount ?? 0,
    };
    await this.driver.run(
      `INSERT OR REPLACE INTO audit_batches
       (id, type, label, started_at, finished_at, device_id, actor_name, entity_count, summary,
        source_commit_id, source_server_id, source_replica_key, applied_count, skipped_count, conflict_count, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.type, row.label, row.startedAt, row.finishedAt ?? null,
        row.deviceId ?? this.ctx.deviceId ?? null, row.actorName ?? null, row.entityCount, row.summary ?? null,
        row.sourceCommitId ?? null, row.sourceServerId ?? null, row.sourceReplicaKey ?? null,
        row.appliedCount ?? null, row.skippedCount ?? null, row.conflictCount ?? null, row.outcome ?? null,
      ],
    );
    return row;
  }

  async finishAuditBatch(
    id: string,
    patch: Partial<Pick<AuditBatch, 'finishedAt' | 'entityCount' | 'summary' | 'appliedCount' | 'skippedCount' | 'conflictCount' | 'outcome'>> = {},
  ): Promise<void> {
    await this.driver.run(
      `UPDATE audit_batches
       SET finished_at = COALESCE(?, finished_at), entity_count = COALESCE(?, entity_count),
           summary = COALESCE(?, summary), applied_count = COALESCE(?, applied_count),
           skipped_count = COALESCE(?, skipped_count), conflict_count = COALESCE(?, conflict_count),
           outcome = COALESCE(?, outcome)
       WHERE id = ?`,
      [
        patch.finishedAt ?? nowIso(), patch.entityCount ?? null, patch.summary ?? null,
        patch.appliedCount ?? null, patch.skippedCount ?? null, patch.conflictCount ?? null,
        patch.outcome ?? null, id,
      ],
    );
  }

  /** Execute one user command as a single DB transaction, audit group, and sync commit. */
  async runInAuditBatch<T>(
    label: string,
    fn: (store: this) => Promise<T>,
    type: AuditBatch['type'] = 'user',
    options: {
      undoable?: boolean;
      /** Runs immediately after the outer SQLite transaction commits. */
      onCommitted?: (result: T) => void | Promise<void>;
    } = {},
  ): Promise<T> {
    if (this.ctx.audit?.batchId) return this.transaction(fn);
    this.ctx.compensationSignal.latestId = undefined;
    const batch = await this.createAuditBatch({ id: newId(), type, label, entityCount: 0 });
    let transactionCommitted = false;
    try {
      const result = await this.withAuditContext(
        { batchId: batch.id, source: 'local' },
        async (scoped) => scoped.transaction(async (transactionStore) => {
          const value = await fn(transactionStore);
          if (options.undoable !== false) {
            await transactionStore.createBusinessCompensationForBatch(batch.id, label);
          }
          return value;
        }),
      );
      transactionCommitted = true;
      await options.onCommitted?.(result);
      const entityCount = (await this.operationLog({ batchId: batch.id })).length;
      await this.finishAuditBatch(batch.id, { entityCount, appliedCount: entityCount, outcome: 'applied' });
      return result;
    } catch (error) {
      if (!transactionCommitted) {
        try {
          await this.finishAuditBatch(batch.id, {
            entityCount: 0,
            appliedCount: 0,
            outcome: 'invalid',
            summary: error instanceof Error ? error.message : String(error),
          });
        } catch (auditError) {
          this.log.warn('failed to finalize rejected audit batch', {
            batchId: batch.id,
            error: auditError instanceof Error ? auditError.message : String(auditError),
          });
        }
      } else {
        // The business mutation can no longer be rolled back. In particular,
        // callers coordinating recoverable file staging must retain that state.
        this.log.warn('post-commit audit batch finalization failed', {
          batchId: batch.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  async listAuditBatches(query: number | { limit?: number; since?: string; until?: string } = 200): Promise<AuditBatch[]> {
    const options = typeof query === 'number' ? { limit: query } : query;
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (options.since) { clauses.push('started_at >= ?'); params.push(options.since); }
    if (options.until) { clauses.push('started_at < ?'); params.push(options.until); }
    let sql = 'SELECT * FROM audit_batches';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY started_at DESC';
    if (options.limit) { sql += ' LIMIT ?'; params.push(options.limit); }
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    return rows.map((r) => ({
      id: String(r['id']),
      type: String(r['type']) as AuditBatch['type'],
      label: String(r['label']),
      startedAt: String(r['started_at']),
      finishedAt: r['finished_at'] == null ? undefined : String(r['finished_at']),
      deviceId: r['device_id'] == null ? undefined : String(r['device_id']),
      actorName: r['actor_name'] == null ? undefined : String(r['actor_name']),
      entityCount: Number(r['entity_count'] ?? 0),
      summary: r['summary'] == null ? undefined : String(r['summary']),
      sourceCommitId: r['source_commit_id'] == null ? undefined : String(r['source_commit_id']),
      sourceServerId: r['source_server_id'] == null ? undefined : String(r['source_server_id']),
      sourceReplicaKey: r['source_replica_key'] == null ? undefined : String(r['source_replica_key']),
      appliedCount: r['applied_count'] == null ? undefined : Number(r['applied_count']),
      skippedCount: r['skipped_count'] == null ? undefined : Number(r['skipped_count']),
      conflictCount: r['conflict_count'] == null ? undefined : Number(r['conflict_count']),
      outcome: r['outcome'] == null ? undefined : String(r['outcome']) as AuditBatch['outcome'],
    }));
  }

  async listStepsByChain(chainId: string): Promise<ConversionStep[]> {
    const rows = await this.driver.all(
      'SELECT * FROM conversion_steps WHERE chain_id = ? ORDER BY step_order ASC',
      [chainId],
    );
    return rows.map(rowToStep);
  }

  async listStepsByChains(chainIds: string[]): Promise<Map<string, ConversionStep[]>> {
    const result = new Map<string, ConversionStep[]>(chainIds.map((id) => [id, []]));
    const uniqueIds = [...new Set(chainIds)];
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      const page = uniqueIds.slice(offset, offset + 500);
      if (!page.length) continue;
      const rows = await this.driver.all<Record<string, unknown>>(
        `SELECT * FROM conversion_steps
         WHERE chain_id IN (${page.map(() => '?').join(', ')})
         ORDER BY chain_id, step_order`,
        page,
      );
      for (const row of rows) {
        const chainId = String(row['chain_id']);
        const current = result.get(chainId) ?? [];
        current.push(rowToStep(row));
        result.set(chainId, current);
      }
    }
    return result;
  }

  async transactionReportPage(input: {
    from?: string;
    to?: string;
    cursor?: import('@zichan/core').QueryCursor;
    limit?: number;
  } = {}): Promise<TransactionReportPage> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(input.limit ?? 500))));
    const reportDate = "CASE WHEN type = 'refund' THEN COALESCE(refund_effect_date, date) ELSE date END";
    const clauses = [
      'is_deleted = 0',
      "COALESCE(record_state, 'active') = 'active'",
      "type NOT IN ('transfer', 'adjustment')",
    ];
    const params: SqlParam[] = [];
    if (input.from) {
      clauses.push(`${reportDate} >= ?`);
      params.push(input.from);
    }
    if (input.to) {
      clauses.push(`${reportDate} <= ?`);
      params.push(input.to);
    }
    if (input.cursor) {
      clauses.push(`(${reportDate} < ? OR (${reportDate} = ? AND id < ?))`);
      params.push(input.cursor.value as SqlParam, input.cursor.value as SqlParam, input.cursor.id);
    }
    const raw = await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM transactions
       WHERE ${clauses.join(' AND ')}
       ORDER BY ${reportDate} DESC, id DESC
       LIMIT ?`,
      [...params, limit + 1],
    );
    const hasMore = raw.length > limit;
    const pageRows = hasMore ? raw.slice(0, limit) : raw;
    const transactions = pageRows.map((row) =>
      rowToEntity<import('@zichan/core').Transaction>(TABLES.transactions, row));
    const ids = transactions.map((transaction) => transaction.id);
    const relatedRows = async <T extends BaseEntity>(
      spec: TableSpec,
      foreignKey: string,
    ): Promise<T[]> => {
      if (!ids.length) return [];
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        rows.push(...await this.driver.all<Record<string, unknown>>(
          `SELECT * FROM ${spec.name}
           WHERE is_deleted = 0 AND ${foreignKey} IN (${batch.map(() => '?').join(', ')})
           ORDER BY id`,
          batch,
        ));
      }
      return rows.map((row) => rowToEntity<T>(spec, row));
    };
    const [transactionSplits, refundAllocations] = await Promise.all([
      relatedRows<import('@zichan/core').TransactionSplit>(TABLES.transactionSplits, 'transaction_id'),
      relatedRows<import('@zichan/core').RefundAllocation>(TABLES.refundAllocations, 'refund_transaction_id'),
    ]);
    const last = transactions.at(-1);
    const lastReportDate = last
      ? (last.type === 'refund' ? last.refundEffectDate ?? last.date : last.date)
      : undefined;
    return {
      transactions,
      transactionSplits,
      refundAllocations,
      hasMore,
      ...(hasMore && last && lastReportDate
        ? { nextCursor: { value: lastReportDate, id: last.id } }
        : {}),
    };
  }

  async *iterateTransactionReport(input: {
    from?: string;
    to?: string;
    pageSize?: number;
  } = {}): AsyncGenerator<TransactionReportPage, void, void> {
    let cursor: import('@zichan/core').QueryCursor | undefined;
    do {
      const page = await this.transactionReportPage({
        from: input.from,
        to: input.to,
        cursor,
        limit: input.pageSize,
      });
      yield page;
      if (!page.hasMore || !page.nextCursor) return;
      cursor = page.nextCursor;
    } while (true);
  }

  /**
   * Find active transactions whose own free-text fields contain the explicit
   * test markers used by the Settings cleanup command. The query is keyset
   * paged so maintenance never depends on a page snapshot or a fixed row cap.
   */
  async testTransactionCleanupPage(input: {
    cursor?: import('@zichan/core').QueryCursor;
    limit?: number;
  } = {}): Promise<TestTransactionCleanupPage> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(input.limit ?? 400))));
    const clauses = [
      'is_deleted = 0',
      "COALESCE(record_state, 'active') = 'active'",
      `(
        INSTR(COALESCE(description, ''), '测试') > 0
        OR INSTR(COALESCE(merchant, ''), '测试') > 0
        OR INSTR(COALESCE(note, ''), '测试') > 0
        OR INSTR(LOWER(COALESCE(description, '')), 'test') > 0
        OR INSTR(LOWER(COALESCE(merchant, '')), 'test') > 0
        OR INSTR(LOWER(COALESCE(note, '')), 'test') > 0
      )`,
    ];
    const params: SqlParam[] = [];
    if (input.cursor) {
      clauses.push('id > ?');
      params.push(input.cursor.id);
    }
    const raw = await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM transactions
       WHERE ${clauses.join(' AND ')}
       ORDER BY id
       LIMIT ?`,
      [...params, limit + 1],
    );
    const hasMore = raw.length > limit;
    const pageRows = hasMore ? raw.slice(0, limit) : raw;
    const transactions = pageRows.map((row) =>
      rowToEntity<import('@zichan/core').Transaction>(TABLES.transactions, row));
    const ids = transactions.map((transaction) => transaction.id);
    const attachmentRows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      if (!batch.length) continue;
      attachmentRows.push(...await this.driver.all<Record<string, unknown>>(
        `SELECT * FROM attachments
         WHERE is_deleted = 0 AND entity_type = 'transaction'
           AND entity_id IN (${batch.map(() => '?').join(', ')})
         ORDER BY id`,
        batch,
      ));
    }
    const attachments = attachmentRows.map((row) =>
      rowToEntity<import('@zichan/core').Attachment>(TABLES.attachments, row));
    const last = transactions.at(-1);
    return {
      transactions,
      attachments,
      hasMore,
      ...(hasMore && last ? { nextCursor: { value: last.id, id: last.id } } : {}),
    };
  }

  async transactionBrowsePage(input: TransactionBrowseInput = {}): Promise<TransactionBrowsePage> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(input.limit ?? 100))));
    const pageFilter = transactionBrowseFilter(input, true);
    const countFilter = transactionBrowseFilter(input, false);
    const [raw, countRow] = await Promise.all([
      this.driver.all<Record<string, unknown>>(
        `SELECT t.* FROM transactions t
         WHERE ${pageFilter.clauses.join(' AND ')}
         ORDER BY ${TRANSACTION_REPORT_DATE_SQL} DESC, t.id DESC
         LIMIT ?`,
        [...pageFilter.params, limit + 1],
      ),
      this.driver.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM transactions t
         WHERE ${countFilter.clauses.join(' AND ')}`,
        countFilter.params,
      ),
    ]);
    const hasMore = raw.length > limit;
    const rows = hasMore ? raw.slice(0, limit) : raw;
    const transactions = rows.map((row) =>
      rowToEntity<import('@zichan/core').Transaction>(TABLES.transactions, row));
    const ids = transactions.map((transaction) => transaction.id);
    const loadRelated = async <T extends BaseEntity>(
      spec: TableSpec,
      foreignKey: string,
      prefix = '',
      extraParams: SqlParam[] = [],
    ): Promise<T[]> => {
      if (!ids.length) return [];
      const related: Record<string, unknown>[] = [];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        related.push(...await this.driver.all<Record<string, unknown>>(
          `SELECT * FROM ${spec.name}
           WHERE is_deleted = 0 ${prefix}
             AND ${foreignKey} IN (${batch.map(() => '?').join(', ')})
           ORDER BY id`,
          [...extraParams, ...batch],
        ));
      }
      return related.map((row) => rowToEntity<T>(spec, row));
    };
    const [transactionSplits, refundAllocations, attachments, reconciliationItems] = await Promise.all([
      loadRelated<import('@zichan/core').TransactionSplit>(TABLES.transactionSplits, 'transaction_id'),
      loadRelated<import('@zichan/core').RefundAllocation>(TABLES.refundAllocations, 'refund_transaction_id'),
      loadRelated<import('@zichan/core').Attachment>(
        TABLES.attachments,
        'entity_id',
        'AND entity_type = ?',
        ['transaction'],
      ),
      loadRelated<import('@zichan/core').ReconciliationItem>(TABLES.reconciliationItems, 'transaction_id'),
    ]);
    const sessionIds = [...new Set(reconciliationItems.map((item) => item.reconciliationId))];
    const reconciliationSessions: import('@zichan/core').ReconciliationSession[] = [];
    for (let offset = 0; offset < sessionIds.length; offset += 500) {
      const batch = sessionIds.slice(offset, offset + 500);
      const sessionRows = await this.driver.all<Record<string, unknown>>(
        `SELECT * FROM reconciliation_sessions
         WHERE is_deleted = 0 AND id IN (${batch.map(() => '?').join(', ')})`,
        batch,
      );
      reconciliationSessions.push(...sessionRows.map((row) =>
        rowToEntity<import('@zichan/core').ReconciliationSession>(TABLES.reconciliationSessions, row)));
    }
    const refundAppliedAmounts: Record<string, string[]> = {};
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      if (!batch.length) continue;
      const refundRows = await this.driver.all<{ refund_for_id: string; amounts_json: string }>(
        `SELECT refund_for_id,
                json_group_array(COALESCE(refund_applied_amount, amount)) AS amounts_json
         FROM transactions
         WHERE is_deleted = 0 AND COALESCE(record_state, 'active') = 'active'
           AND type = 'refund'
           AND refund_for_id IN (${batch.map(() => '?').join(', ')})
         GROUP BY refund_for_id`,
        batch,
      );
      for (const row of refundRows) {
        refundAppliedAmounts[row.refund_for_id] = JSON.parse(row.amounts_json) as string[];
      }
    }
    const last = transactions.at(-1);
    const lastDate = last
      ? (last.type === 'refund' ? last.refundEffectDate ?? last.date : last.date)
      : undefined;
    return {
      transactions,
      transactionSplits,
      refundAllocations,
      attachments,
      reconciliationItems,
      reconciliationSessions,
      refundAppliedAmounts,
      totalCount: Number(countRow?.count ?? 0),
      hasMore,
      ...(hasMore && last && lastDate ? { nextCursor: { value: lastDate, id: last.id } } : {}),
    };
  }

  async *iterateTransactionBrowse(input: Omit<TransactionBrowseInput, 'cursor' | 'limit'> & {
    pageSize?: number;
  } = {}): AsyncGenerator<TransactionBrowsePage, void, void> {
    let cursor: import('@zichan/core').QueryCursor | undefined;
    do {
      const page = await this.transactionBrowsePage({
        ...input,
        cursor,
        limit: input.pageSize,
      });
      yield page;
      if (!page.hasMore || !page.nextCursor) return;
      cursor = page.nextCursor;
    } while (true);
  }

  async transactionBrowseAggregate(
    input: Omit<TransactionBrowseInput, 'cursor' | 'limit'> = {},
  ): Promise<TransactionReportAggregateRow[]> {
    const filter = transactionBrowseFilter(input, false);
    const rows = await this.driver.all<Record<string, unknown>>(
      `WITH base AS (
         SELECT t.*, ${TRANSACTION_REPORT_DATE_SQL} AS report_date,
                CASE WHEN t.type = 'refund'
                  THEN COALESCE(t.refund_applied_asset_id, t.asset_id)
                  ELSE t.asset_id END AS report_asset_id
         FROM transactions t
         WHERE ${filter.clauses.join(' AND ')}
           AND t.type IN ('income', 'expense', 'refund')
           AND COALESCE(t.reporting_treatment, 'ordinary') <> 'balance_only'
       ),
       parts AS (
         SELECT b.report_date, b.report_asset_id, b.type AS direction,
                s.category AS category, s.amount AS amount
         FROM base b
         JOIN transaction_splits s ON s.transaction_id = b.id AND s.is_deleted = 0
         WHERE b.type IN ('income', 'expense')
         UNION ALL
         SELECT b.report_date, b.report_asset_id, b.type AS direction,
                b.category AS category, b.amount AS amount
         FROM base b
         WHERE b.type IN ('income', 'expense')
           AND NOT EXISTS (
             SELECT 1 FROM transaction_splits s
             WHERE s.transaction_id = b.id AND s.is_deleted = 0
           )
         UNION ALL
         SELECT b.report_date, b.report_asset_id, 'expense' AS direction,
                a.category_id AS category,
                CASE WHEN substr(a.amount, 1, 1) = '-' THEN a.amount ELSE '-' || a.amount END AS amount
         FROM base b
         JOIN refund_allocations a ON a.refund_transaction_id = b.id AND a.is_deleted = 0
         WHERE b.type = 'refund'
         UNION ALL
         SELECT b.report_date, b.report_asset_id, 'expense' AS direction,
                b.category AS category,
                CASE
                  WHEN substr(COALESCE(b.refund_applied_amount, b.amount), 1, 1) = '-'
                    THEN COALESCE(b.refund_applied_amount, b.amount)
                  ELSE '-' || COALESCE(b.refund_applied_amount, b.amount)
                END AS amount
         FROM base b
         WHERE b.type = 'refund'
           AND NOT EXISTS (
             SELECT 1 FROM refund_allocations a
             WHERE a.refund_transaction_id = b.id AND a.is_deleted = 0
           )
       )
       SELECT report_date, report_asset_id, direction, category,
              json_group_array(amount) AS amounts_json, COUNT(*) AS count
       FROM parts
       GROUP BY report_date, report_asset_id, direction, category
       ORDER BY report_date, direction, category, report_asset_id`,
      filter.params,
    );
    return rows.map((row) => ({
      reportDate: String(row['report_date']),
      reportAssetId: String(row['report_asset_id']),
      direction: row['direction'] === 'income' ? 'income' : 'expense',
      category: String(row['category']),
      amounts: JSON.parse(String(row['amounts_json'])) as string[],
      count: Number(row['count'] ?? 0),
    }));
  }

  async accountBalanceAggregates(): Promise<AccountBalanceAggregateRow[]> {
    const rows = await this.driver.all<Record<string, unknown>>(
      `WITH ${TRANSACTION_POSTINGS_CTE}
       SELECT account_id, asset_id, json_group_array(posting_amount) AS amounts_json
       FROM postings
       GROUP BY account_id, asset_id
       ORDER BY account_id, asset_id`,
    );
    return rows.map((row) => ({
      accountId: String(row['account_id']),
      assetId: String(row['asset_id']),
      amounts: JSON.parse(String(row['amounts_json'])) as string[],
    }));
  }

  async dashboardTransactionReadModel(input: {
    from?: string;
    to?: string;
    activityLimit?: number;
  } = {}): Promise<DashboardTransactionReadModel> {
    const activityLimit = Math.max(1, Math.min(100, Math.trunc(Number(input.activityLimit ?? 6))));
    const activityClauses = [
      't.is_deleted = 0',
      "COALESCE(t.record_state, 'active') = 'active'",
    ];
    const activityParams: SqlParam[] = [];
    if (input.from) {
      activityClauses.push('t.date >= ?');
      activityParams.push(input.from);
    }
    if (input.to) {
      activityClauses.push('t.date <= ?');
      activityParams.push(input.to);
    }

    const [balanceRows, reportAggregates, recentRows] = await Promise.all([
      this.driver.all<Record<string, unknown>>(
        `WITH ${DASHBOARD_TRANSACTION_POSTINGS_CTE}
         SELECT asset_id, json_group_array(posting_amount) AS amounts_json
         FROM dashboard_postings
         GROUP BY asset_id
         ORDER BY asset_id`,
      ),
      this.transactionReportAggregate({ from: input.from, to: input.to }),
      this.driver.all<Record<string, unknown>>(
        `SELECT t.* FROM transactions t
         WHERE ${activityClauses.join(' AND ')}
         ORDER BY t.date DESC, t.id DESC
         LIMIT ?`,
        [...activityParams, activityLimit],
      ),
    ]);

    return {
      balanceAggregates: balanceRows.map((row) => ({
        assetId: String(row['asset_id']),
        amounts: JSON.parse(String(row['amounts_json'])) as string[],
      })),
      reportAggregates,
      recentTransactions: recentRows.map((row) =>
        rowToEntity<import('@zichan/core').Transaction>(TABLES.transactions, row)),
    };
  }

  async accountLedgerPage(input: {
    accountId: string;
    assetId?: string;
    from?: string;
    to?: string;
    cursor?: import('@zichan/core').QueryCursor;
    limit?: number;
    startingBalances?: Record<string, string>;
  }): Promise<AccountLedgerPage> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(input.limit ?? 100))));
    const clauses = ['p.account_id = ?'];
    const params: SqlParam[] = [input.accountId];
    if (input.assetId) {
      clauses.push('p.asset_id = ?');
      params.push(input.assetId);
    }
    if (input.from) {
      clauses.push('p.posting_date >= ?');
      params.push(input.from);
    }
    if (input.to) {
      clauses.push('p.posting_date <= ?');
      params.push(input.to);
    }
    const postingKey = "(p.transaction_id || ':' || p.posting_side)";
    if (input.cursor) {
      clauses.push(`(p.posting_date < ? OR (p.posting_date = ? AND ${postingKey} < ?))`);
      params.push(input.cursor.value as SqlParam, input.cursor.value as SqlParam, input.cursor.id);
    }
    const countClauses = input.cursor ? clauses.slice(0, -1) : [...clauses];
    const countParams = input.cursor ? params.slice(0, -3) : [...params];
    const [raw, countRow] = await Promise.all([
      this.driver.all<Record<string, unknown>>(
        `WITH ${TRANSACTION_POSTINGS_CTE}
         SELECT t.*, p.posting_side, p.posting_amount,
                ${TRANSACTION_RECONCILIATION_STATUS_SQL} AS reconciliation_status
         FROM postings p
         JOIN transactions t ON t.id = p.transaction_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY p.posting_date DESC, ${postingKey} DESC
         LIMIT ?`,
        [...params, limit + 1],
      ),
      this.driver.get<{ count: number }>(
        `WITH ${TRANSACTION_POSTINGS_CTE}
         SELECT COUNT(*) AS count FROM postings p
         WHERE ${countClauses.join(' AND ')}`,
        countParams,
      ),
    ]);
    const hasMore = raw.length > limit;
    const pageRows = hasMore ? raw.slice(0, limit) : raw;
    let balances: Record<string, string>;
    if (input.startingBalances) {
      balances = { ...input.startingBalances };
    } else {
      const closingClauses = ['account_id = ?'];
      const closingParams: SqlParam[] = [input.accountId];
      if (input.assetId) {
        closingClauses.push('asset_id = ?');
        closingParams.push(input.assetId);
      }
      if (input.to) {
        closingClauses.push('posting_date <= ?');
        closingParams.push(input.to);
      }
      const closingRows = await this.driver.all<Record<string, unknown>>(
        `WITH ${TRANSACTION_POSTINGS_CTE}
         SELECT asset_id, json_group_array(posting_amount) AS amounts_json
         FROM postings
         WHERE ${closingClauses.join(' AND ')}
         GROUP BY asset_id`,
        closingParams,
      );
      balances = Object.fromEntries(closingRows.map((row) => [
        String(row['asset_id']),
        sum(JSON.parse(String(row['amounts_json'])) as string[]).toString(),
      ]));
    }
    const resultRows: AccountLedgerReadRow[] = [];
    for (const row of pageRows) {
      const transaction = rowToEntity<import('@zichan/core').Transaction>(TABLES.transactions, row);
      const assetId = transaction.type === 'transfer' && row['posting_side'] === '1'
        ? transaction.transferAssetId ?? transaction.assetId
        : transaction.assetId;
      const postingAmount = String(row['posting_amount']);
      const balance = balances[assetId] ?? '0';
      resultRows.push({
        transaction,
        assetId,
        postingAmount,
        balance,
        reconciliationStatus: String(row['reconciliation_status']) as AccountLedgerReadRow['reconciliationStatus'],
      });
      balances[assetId] = D(balance).minus(postingAmount).toString();
    }
    const last = pageRows.at(-1);
    const lastKey = last
      ? `${String(last['id'])}:${String(last['posting_side'])}`
      : undefined;
    return {
      rows: resultRows,
      totalCount: Number(countRow?.count ?? 0),
      hasMore,
      nextStartingBalances: balances,
      ...(hasMore && last && lastKey
        ? { nextCursor: { value: String(last['date']), id: lastKey } }
        : {}),
    };
  }

  async transactionReportAggregate(input: {
    from?: string;
    to?: string;
  } = {}): Promise<TransactionReportAggregateRow[]> {
    const dateExpression = "CASE WHEN type = 'refund' THEN COALESCE(refund_effect_date, date) ELSE date END";
    const assetExpression = "CASE WHEN type = 'refund' THEN COALESCE(refund_applied_asset_id, asset_id) ELSE asset_id END";
    const clauses = [
      'is_deleted = 0',
      "COALESCE(record_state, 'active') = 'active'",
      "type IN ('income', 'expense', 'refund')",
      "COALESCE(reporting_treatment, 'ordinary') <> 'balance_only'",
    ];
    const params: SqlParam[] = [];
    if (input.from) {
      clauses.push(`${dateExpression} >= ?`);
      params.push(input.from);
    }
    if (input.to) {
      clauses.push(`${dateExpression} <= ?`);
      params.push(input.to);
    }
    const rows = await this.driver.all<Record<string, unknown>>(
      `WITH base AS (
         SELECT *, ${dateExpression} AS report_date, ${assetExpression} AS report_asset_id
         FROM transactions
         WHERE ${clauses.join(' AND ')}
       ),
       parts AS (
         SELECT b.report_date, b.report_asset_id, b.type AS direction,
                s.category AS category, s.amount AS amount
         FROM base b
         JOIN transaction_splits s ON s.transaction_id = b.id AND s.is_deleted = 0
         WHERE b.type IN ('income', 'expense')
         UNION ALL
         SELECT b.report_date, b.report_asset_id, b.type AS direction,
                b.category AS category, b.amount AS amount
         FROM base b
         WHERE b.type IN ('income', 'expense')
           AND NOT EXISTS (
             SELECT 1 FROM transaction_splits s
             WHERE s.transaction_id = b.id AND s.is_deleted = 0
           )
         UNION ALL
         SELECT b.report_date, b.report_asset_id, 'expense' AS direction,
                a.category_id AS category,
                CASE WHEN substr(a.amount, 1, 1) = '-' THEN a.amount ELSE '-' || a.amount END AS amount
         FROM base b
         JOIN refund_allocations a ON a.refund_transaction_id = b.id AND a.is_deleted = 0
         WHERE b.type = 'refund'
         UNION ALL
         SELECT b.report_date, b.report_asset_id, 'expense' AS direction,
                b.category AS category,
                CASE
                  WHEN substr(COALESCE(b.refund_applied_amount, b.amount), 1, 1) = '-'
                    THEN COALESCE(b.refund_applied_amount, b.amount)
                  ELSE '-' || COALESCE(b.refund_applied_amount, b.amount)
                END AS amount
         FROM base b
         WHERE b.type = 'refund'
           AND NOT EXISTS (
             SELECT 1 FROM refund_allocations a
             WHERE a.refund_transaction_id = b.id AND a.is_deleted = 0
           )
       )
       SELECT report_date, report_asset_id, direction, category,
              json_group_array(amount) AS amounts_json, COUNT(*) AS count
       FROM parts
       GROUP BY report_date, report_asset_id, direction, category
       ORDER BY report_date, direction, category, report_asset_id`,
      params,
    );
    return rows.map((row) => ({
      reportDate: String(row['report_date']),
      reportAssetId: String(row['report_asset_id']),
      direction: row['direction'] === 'income' ? 'income' : 'expense',
      category: String(row['category']),
      amounts: JSON.parse(String(row['amounts_json'])) as string[],
      count: Number(row['count'] ?? 0),
    }));
  }

  async getChainWithSteps(chainId: string): Promise<ChainWithSteps | null> {
    const chain = await this.conversionChains.get(chainId);
    if (!chain) return null;
    return { chain, steps: await this.listStepsByChain(chainId) };
  }

  async assertTransactionAggregate(snapshot: {
    transaction: import('@zichan/core').Transaction;
    splits: import('@zichan/core').TransactionSplit[];
    refundAllocations: import('@zichan/core').RefundAllocation[];
  }): Promise<void> {
    await validateTransactionAggregateSnapshot(this.driver, snapshot, {
      allowInactiveReferences: inactiveReferencesAllowed(this.ctx),
    });
  }

  async assertConversionAggregate(
    chain: ConversionChain,
    steps: ConversionStep[],
  ): Promise<void> {
    await validateConversionAggregateSnapshot(this.driver, chain, steps, {
      allowInactiveReferences: inactiveReferencesAllowed(this.ctx),
    });
  }

  async assertReconciliationAggregate(
    session: import('@zichan/core').ReconciliationSession,
    items: import('@zichan/core').ReconciliationItem[],
  ): Promise<void> {
    await validateReconciliationAggregateSnapshot(this.driver, session, items, {
      allowInactiveReferences: inactiveReferencesAllowed(this.ctx),
    });
  }

  async withPrevalidatedAggregates<T>(keys: Iterable<string>, fn: (store: this) => Promise<T>): Promise<T> {
    const allowed = new Set(this.ctx.prevalidatedAggregates);
    for (const key of keys) allowed.add(key);
    return fn(this.scoped(this.driver, this.ctx.audit, this.ctx.pendingChanges, allowed) as this);
  }

  async withValidatedRestore<T>(
    writeKeys: Iterable<string>,
    deleteKeys: Iterable<string>,
    fn: (store: this) => Promise<T>,
  ): Promise<T> {
    const writes = new Set(this.ctx.restoreWriteKeys);
    const deletes = new Set(this.ctx.restoreDeleteKeys);
    for (const key of writeKeys) writes.add(key);
    for (const key of deleteKeys) deletes.add(key);
    return fn(this.scoped(
      this.driver,
      this.ctx.audit,
      this.ctx.pendingChanges,
      this.ctx.prevalidatedAggregates,
      writes,
      deletes,
    ) as this);
  }

  /** @internal Restrict historical-reference permission to the awaited callback lifetime. */
  async withBackupImportContext<T>(fn: (store: this) => Promise<T>): Promise<T> {
    if (inactiveReferencesAllowed(this.ctx)) return fn(this);
    const scope = { active: true };
    const historicalStore = this.scoped(
      this.driver,
      this.ctx.audit,
      this.ctx.pendingChanges,
      this.ctx.prevalidatedAggregates,
      this.ctx.restoreWriteKeys,
      this.ctx.restoreDeleteKeys,
      true,
      this.ctx.pendingReconciliationValidations,
      scope,
    ) as this;
    try {
      return await fn(historicalStore);
    } finally {
      scope.active = false;
    }
  }

  async saveChainWithSteps(
    chain: ConversionChain,
    steps: ConversionStep[],
  ): Promise<ChainWithSteps> {
    return this.transaction(async (store) => {
      const normalizedChain = await validateConversionAggregateSnapshot(store.driver, chain, steps, {
        allowInactiveReferences: inactiveReferencesAllowed(store.ctx),
      });
      const before = await store.getChainWithSteps(chain.id);
      const savedChain = await store.conversionChains.put(normalizedChain);
      await store.driver.run('DELETE FROM conversion_steps WHERE chain_id = ?', [savedChain.id]);
      const savedSteps = steps.map((s) => ({ ...s, chainId: savedChain.id }));
      const cols = STEP_COLS.join(', ');
      const ph = STEP_COLS.map(() => '?').join(', ');
      for (const s of savedSteps) {
        await store.driver.run(
          `INSERT INTO conversion_steps (${cols}) VALUES (${ph})`,
          stepToParams(s),
        );
      }
      await audit(store.ctx, 'update', 'conversion_chain_steps', savedChain, {
        chainId: savedChain.id,
        steps: savedSteps,
      }, before ? { chainId: before.chain.id, steps: before.steps } : undefined);
      recordChange(store.ctx, 'conversion_chain_steps');
      store.log.debug('saveChainWithSteps', { chainId: savedChain.id, steps: savedSteps.length });
      return { chain: savedChain, steps: savedSteps };
    });
  }

  async operationLog(query: OperationLogQuery = {}): Promise<OperationLogEntry[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (query.entityType) { clauses.push('entity_type = ?'); params.push(query.entityType); }
    if (query.entityId) { clauses.push('entity_id = ?'); params.push(query.entityId); }
    if (query.op) { clauses.push('op = ?'); params.push(query.op); }
    if (query.batchId) { clauses.push('batch_id = ?'); params.push(query.batchId); }
    if (query.source) { clauses.push('source = ?'); params.push(query.source); }
    if (query.since) { clauses.push('at >= ?'); params.push(query.since); }
    if (query.until) { clauses.push('at < ?'); params.push(query.until); }
    let sql = 'SELECT * FROM operation_log';
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ` ORDER BY at ${query.desc ? 'DESC' : 'ASC'}, rowid ${query.desc ? 'DESC' : 'ASC'}`;
    if (query.limit) sql += ` LIMIT ${Number(query.limit)}`;
    const rows = await this.driver.all(sql, params);
    return rows.map((r): OperationLogEntry => {
      const entry: OperationLogEntry = {
        id: String(r['id']),
        at: String(r['at']),
        entityType: String(r['entity_type']),
        entityId: String(r['entity_id']),
        op: String(r['op']) as OperationType,
        version: r['version'] == null ? 0 : Number(r['version']),
      };
      if (r['device_id'] != null) entry.deviceId = String(r['device_id']);
      if (r['payload'] != null) entry.payload = String(r['payload']);
      if (r['before_payload'] != null) entry.beforePayload = String(r['before_payload']);
      if (r['after_payload'] != null) entry.afterPayload = String(r['after_payload']);
      if (r['changed_keys'] != null) entry.changedKeys = JSON.parse(String(r['changed_keys'])) as string[];
      if (r['diff_json'] != null) entry.diffJson = String(r['diff_json']);
      if (r['batch_id'] != null) entry.batchId = String(r['batch_id']);
      if (r['source'] != null) entry.source = String(r['source']) as AuditSource;
      if (r['actor_name'] != null) entry.actorName = String(r['actor_name']);
      if (r['summary'] != null) entry.summary = String(r['summary']);
      return entry;
    });
  }

  async createBusinessCompensationForBatch(
    sourceBatchId: string,
    label: string,
  ): Promise<BusinessCompensationRecord | null> {
    const existing = await this.getBusinessCompensationByBatch(sourceBatchId);
    if (existing) return existing;
    const logs = (await this.operationLog({ batchId: sourceBatchId }))
      .filter((entry) => (entry.source ?? 'local') === 'local');
    if (!logs.length) return null;

    const states = new Map<string, CompensationEntityState>();
    for (const [sequence, log] of logs.entries()) {
      const key = `${log.entityType}\0${log.entityId}`;
      const before = parseObjectJson(log.beforePayload);
      const after = parseObjectJson(log.afterPayload ?? log.payload);
      const current = states.get(key);
      if (current) {
        current.after = after;
        current.sequence = sequence;
      } else {
        states.set(key, {
          entityType: log.entityType,
          entityId: log.entityId,
          sequence,
          before,
          after,
        });
      }
    }
    const payload: BusinessCompensationPayload = {
      version: 1,
      states: [...states.values()].filter((state) => stableJson(state.before) !== stableJson(state.after)),
    };
    if (!payload.states.length) return null;
    const record: BusinessCompensationRecord = {
      id: newId(),
      sourceBatchId,
      label,
      createdAt: nowIso(),
      status: 'pending',
      payload,
      affectedEntities: payload.states.map(({ entityType, entityId }) => ({ entityType, entityId })),
    };
    await this.driver.run(
      `INSERT INTO business_compensations
       (id, source_batch_id, label, created_at, status, payload_json, affected_entities_json,
        applied_at, applied_batch_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        record.id,
        record.sourceBatchId,
        record.label,
        record.createdAt,
        record.status,
        JSON.stringify(record.payload),
        JSON.stringify(record.affectedEntities),
      ],
    );
    this.ctx.compensationSignal.latestId = record.id;
    return record;
  }

  async consumeLatestBusinessCompensation(): Promise<BusinessCompensationRecord | null> {
    const id = this.ctx.compensationSignal.latestId;
    this.ctx.compensationSignal.latestId = undefined;
    return id ? this.getBusinessCompensation(id) : null;
  }

  async getBusinessCompensation(id: string): Promise<BusinessCompensationRecord | null> {
    const row = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM business_compensations WHERE id = ?',
      [id],
    );
    return row ? this.businessCompensationFromRow(row) : null;
  }

  async getBusinessCompensationByBatch(sourceBatchId: string): Promise<BusinessCompensationRecord | null> {
    const row = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM business_compensations WHERE source_batch_id = ?',
      [sourceBatchId],
    );
    return row ? this.businessCompensationFromRow(row) : null;
  }

  async listBusinessCompensations(query: BusinessCompensationQuery = {}): Promise<BusinessCompensationRecord[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (query.status) {
      clauses.push('status = ?');
      params.push(query.status);
    }
    let sql = 'SELECT * FROM business_compensations';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC, rowid DESC';
    if (query.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(Math.max(0, Math.trunc(query.limit)));
    }
    return (await this.driver.all<Record<string, unknown>>(sql, params))
      .map((row) => this.businessCompensationFromRow(row));
  }

  async markBusinessCompensation(
    id: string,
    status: BusinessCompensationStatus,
    patch: { appliedAt?: string; appliedBatchId?: string; error?: string } = {},
  ): Promise<void> {
    await this.driver.run(
      `UPDATE business_compensations
       SET status = ?, applied_at = ?, applied_batch_id = ?, error = ?
       WHERE id = ?`,
      [status, patch.appliedAt ?? null, patch.appliedBatchId ?? null, patch.error ?? null, id],
    );
  }

  private businessCompensationFromRow(row: Record<string, unknown>): BusinessCompensationRecord {
    return {
      id: String(row['id']),
      sourceBatchId: String(row['source_batch_id']),
      label: String(row['label']),
      createdAt: String(row['created_at']),
      status: String(row['status']) as BusinessCompensationStatus,
      payload: JSON.parse(String(row['payload_json'])) as BusinessCompensationPayload,
      affectedEntities: JSON.parse(String(row['affected_entities_json'])) as { entityType: string; entityId: string }[],
      appliedAt: row['applied_at'] == null ? undefined : String(row['applied_at']),
      appliedBatchId: row['applied_batch_id'] == null ? undefined : String(row['applied_batch_id']),
      error: row['error'] == null ? undefined : String(row['error']),
    };
  }

  async transaction<T>(fn: (store: this) => Promise<T>): Promise<T> {
    if (this.ctx.pendingChanges) {
      return this.driver.transaction((driver) => fn(this.scoped(driver) as this));
    }
    const pendingChanges = new Set<string>();
    const pendingReconciliationValidations = new Map<string, boolean>();
    const result = await this.driver.transaction(async (driver) => {
      const scoped = this.scoped(
        driver,
        this.ctx.audit,
        pendingChanges,
        this.ctx.prevalidatedAggregates,
        this.ctx.restoreWriteKeys,
        this.ctx.restoreDeleteKeys,
        this.ctx.allowInactiveReferences,
        pendingReconciliationValidations,
      );
      const value = await fn(scoped as this);
      for (const [reconciliationId, allowInactiveReferences] of pendingReconciliationValidations) {
        await validateStoredReconciliationAggregate(driver, reconciliationId, { allowInactiveReferences });
      }
      return value;
    });
    this.ctx.changeBus.publish(pendingChanges);
    return result;
  }

  /** Show which old tombstones are safe to compact across every active replica. */
  async previewTombstonePurge(cutoffIso: string): Promise<TombstonePurgePreview> {
    return tombstonePurgePreview(this.driver, cutoffIso);
  }

  /** Physically delete only tombstones acknowledged by every non-retired replica. */
  async purgeTombstonesBefore(cutoffIso: string): Promise<TombstonePurgeResult> {
    return this.driver.transaction(async (driver) => {
      const preview = await tombstonePurgePreview(driver, cutoffIso);
      const chainIds = preview.eligible
        .filter((row) => row.entityType === 'conversion_chain')
        .map((row) => row.entityId);
      for (const row of preview.eligible) {
        await driver.run(`DELETE FROM ${row.tableName} WHERE id = ? AND is_deleted = 1`, [row.entityId]);
      }
      // steps are owned by their chain — drop orphans of purged chains
      for (const chainId of chainIds) await driver.run('DELETE FROM conversion_steps WHERE chain_id = ?', [chainId]);
      return {
        purged: preview.eligible.length,
        blocked: preview.blocked.length,
        activeReplicaCount: preview.activeReplicaCount,
      };
    });
  }

  // ── sync protocol v2: commit DAG, replica cursors, and N-way conflicts ──

  syncDeviceId(): string {
    return this.ctx.deviceId ?? 'unknown-device';
  }

  async getLedgerId(): Promise<string> {
    return ensureLedgerId(this.driver);
  }

  async backupGeneration(): Promise<string> {
    const ledgerId = await this.getLedgerId();
    const probes = await Promise.all([
      this.driver.get<{ n: number; last: string | null }>(
        'SELECT COUNT(*) AS n, MAX(at) AS last FROM operation_log',
      ),
      this.driver.get<{ n: number; last: string | null }>(
        'SELECT COUNT(*) AS n, MAX(COALESCE(received_at, created_at)) AS last FROM sync_commits',
      ),
      this.driver.get<{ n: number; last: string | null }>(
        'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM sync_replica_state',
      ),
      this.driver.get<{ n: number; last: string | null }>(
        'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM attachment_replica_blobs',
      ),
      this.driver.get<{ n: number; last: string | null }>(
        'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM business_compensations',
      ),
    ]);
    return [
      ledgerId,
      ...probes.flatMap((probe) => [
        Number(probe?.n ?? 0).toString(36),
        Math.max(0, Date.parse(probe?.last ?? '') || 0).toString(36),
      ]),
    ].join(':');
  }

  /** Logical snapshot of device-only state excluded from a portable ledger export. */
  async exportDeviceRecoveryState(): Promise<DeviceRecoveryState> {
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of DEVICE_RECOVERY_TABLES) {
      tables[table] = normalizedRecoveryRows(
        table,
        await this.driver.all<Record<string, unknown>>(`SELECT * FROM ${table}`),
      );
    }
    return { version: 1, tables };
  }

  /** Replace audit, sync cursors/conflicts and attachment transfer state exactly. */
  async restoreDeviceRecoveryState(state: DeviceRecoveryState): Promise<void> {
    if (state.version !== 1 || !state.tables || typeof state.tables !== 'object') throw new Error('完整设备恢复状态无效');
    const allowed = new Set<string>(DEVICE_RECOVERY_TABLES);
    for (const table of Object.keys(state.tables)) if (!allowed.has(table)) throw new Error(`完整设备恢复包含未知表：${table}`);
    await this.driver.transaction(async (driver) => {
      for (const table of DEVICE_RECOVERY_DELETE_ORDER) await driver.run(`DELETE FROM ${table}`);
      for (const table of DEVICE_RECOVERY_TABLES) {
        const rows = normalizedRecoveryRows(table, state.tables[table] ?? []);
        const columns = (await driver.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((row) => row.name);
        const columnSet = new Set(columns);
        for (const row of rows) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`完整设备恢复表 ${table} 包含无效行`);
          const keys = Object.keys(row);
          if (!keys.length || keys.some((key) => !columnSet.has(key))) throw new Error(`完整设备恢复表 ${table} 的列无效`);
          await driver.run(
            `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
            keys.map((key) => row[key] == null ? null : row[key] as SqlParam),
          );
        }
      }
    });
  }

  async assertSyncReady(): Promise<void> {
    const row = await this.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_commits WHERE source = 'local' AND sealed = 0");
    if (Number(row?.n ?? 0) > 0) throw new Error('本地仍有未完成的原子批次，请等待当前操作结束后再同步');
  }

  async adoptLedgerId(ledgerId: string): Promise<void> {
    const count = await this.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_commits');
    if (Number(count?.n ?? 0) > 0) throw new Error('本地账本已经产生同步提交，不能自动更换账本 ID');
    await this.driver.run(
      `INSERT OR REPLACE INTO ledger_meta (id, ledger_id, protocol_version, created_at)
       VALUES ('current', ?, 2, ?)`,
      [ledgerId, nowIso()],
    );
  }

  /** Explicitly discard the local materialization before joining an existing remote ledger. */
  async resetToLedger(ledgerId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(ledgerId)) throw new Error('远端账本 ID 无效');
    await this.driver.transaction(async (driver) => {
      await driver.run('DELETE FROM conversion_steps');
      for (const spec of Object.values(TABLES) as TableSpec[]) await driver.run(`DELETE FROM ${spec.name}`);
      for (const table of [
        'attachment_replica_blobs',
        'operation_log', 'audit_batches', 'sync_conflict_resolutions', 'sync_conflict_branches',
        'sync_conflict_groups', 'sync_replica_acks', 'sync_replica_state', 'sync_entity_heads',
        'sync_ledger_heads', 'sync_revisions', 'sync_commits', 'ledger_meta',
      ]) await driver.run(`DELETE FROM ${table}`);
      await driver.run(
        `INSERT INTO ledger_meta (id, ledger_id, protocol_version, created_at)
         VALUES ('current', ?, 2, ?)`,
        [ledgerId, nowIso()],
      );
    });
  }

  private async commitFromRow(row: Record<string, unknown>): Promise<StoredSyncCommit> {
    const revisions = (await this.driver.all<Record<string, unknown>>(
      'SELECT * FROM sync_revisions WHERE commit_id = ? ORDER BY rowid',
      [String(row['commit_id'])],
    )).map(rowToSyncRevision);
    return rowToStoredSyncCommit(row, revisions);
  }

  async listSyncCommits(options: { state?: StoredSyncCommit['state']; includeInvalid?: boolean } = {}): Promise<StoredSyncCommit[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (options.state) { clauses.push('state = ?'); params.push(options.state); }
    if (!options.includeInvalid) clauses.push("state <> 'invalid'");
    let sql = 'SELECT * FROM sync_commits';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY created_at, rowid';
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    const commits: StoredSyncCommit[] = [];
    for (const row of rows) commits.push(await this.commitFromRow(row));
    return commits;
  }

  async commitsPendingForReplica(key: string): Promise<StoredSyncCommit[]> {
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT c.* FROM sync_commits c
       WHERE c.sealed = 1 AND c.state <> 'invalid' AND NOT EXISTS (
         SELECT 1 FROM sync_replica_acks a WHERE a.replica_key = ? AND a.commit_id = c.commit_id
       )
       ORDER BY c.created_at, c.rowid`,
      [key],
    );
    const commits: StoredSyncCommit[] = [];
    for (const row of rows) commits.push(await this.commitFromRow(row));
    return commits;
  }

  async setCommitContentHash(commitId: string, hash: string): Promise<void> {
    const current = await this.driver.get<Record<string, unknown>>('SELECT * FROM sync_commits WHERE commit_id = ?', [commitId]);
    if (!current) throw new Error(`同步提交 ${commitId} 不存在`);
    const actualHash = await sha256Json(wireSyncCommit(await this.commitFromRow(current)));
    if (actualHash !== hash || (current['content_hash'] && current['content_hash'] !== hash)) {
      throw new Error(`同步提交 ${commitId} 内容哈希不一致`);
    }
    await this.driver.run('UPDATE sync_commits SET content_hash = ? WHERE commit_id = ?', [hash, commitId]);
  }

  async storeSyncCommit(
    commit: SyncCommitV2,
    meta: { source: 'local' | 'remote'; sourceReplicaKey?: string; state?: StoredSyncCommit['state']; contentHash?: string },
  ): Promise<'inserted' | 'known'> {
    if (commit.protocol !== 2) throw new Error('仅支持同步协议 v2');
    const ledgerId = await this.getLedgerId();
    if (commit.ledgerId !== ledgerId) throw new Error(`账本 ID 不一致：本地 ${ledgerId}，远端 ${commit.ledgerId}`);
    const existing = await this.driver.get<Record<string, unknown>>('SELECT * FROM sync_commits WHERE commit_id = ?', [commit.commitId]);
    if (existing) {
      const actualHash = await sha256Json(wireSyncCommit(await this.commitFromRow(existing)));
      const storedHash = existing['content_hash'] == null ? undefined : String(existing['content_hash']);
      if ((storedHash && storedHash !== actualHash) || (meta.contentHash && meta.contentHash !== actualHash)) {
        throw new Error(`提交 ID ${commit.commitId} 对应了不同内容`);
      }
      if (!storedHash) await this.driver.run('UPDATE sync_commits SET content_hash = ? WHERE commit_id = ?', [actualHash, commit.commitId]);
      return 'known';
    }
    if (!commit.originDeviceId || !commit.commitId || !commit.createdAt) throw new Error('同步提交缺少身份或时间');
    const revisionIds = new Set<string>();
    const aggregateIds = new Set<string>();
    for (const revision of commit.revisions) {
      if (!revision.revisionId || !revision.aggregateType || !revision.aggregateId) throw new Error('同步修订缺少必要字段');
      if (revisionIds.has(revision.revisionId)) throw new Error(`提交包含重复修订 ${revision.revisionId}`);
      const key = aggregateKey(revision.aggregateType, revision.aggregateId);
      if (aggregateIds.has(key)) throw new Error(`提交重复修改聚合 ${revision.aggregateType}:${revision.aggregateId}`);
      revisionIds.add(revision.revisionId);
      aggregateIds.add(key);
    }
    await this.driver.run(
      `INSERT INTO sync_commits
       (commit_id, ledger_id, origin_device_id, origin_device_name, created_at, parent_commit_ids, resolves_conflict_commit_ids,
        source, source_replica_key, sealed, state, content_hash, received_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
      [
        commit.commitId, commit.ledgerId, commit.originDeviceId, commit.originDeviceName ?? null,
        commit.createdAt, JSON.stringify(commit.parentCommitIds), JSON.stringify(commit.resolvesConflictCommitIds ?? []),
        meta.source, meta.sourceReplicaKey ?? null,
        meta.state ?? (meta.source === 'local' ? 'applied' : 'pending'), meta.contentHash ?? null,
        meta.source === 'remote' ? nowIso() : null,
      ],
    );
    for (const revision of commit.revisions) {
      await this.driver.run(
        `INSERT INTO sync_revisions
         (revision_id, commit_id, aggregate_type, aggregate_id, parent_revision_ids, op, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          revision.revisionId, commit.commitId, revision.aggregateType, revision.aggregateId,
          JSON.stringify(revision.parentRevisionIds), revision.op,
          revision.payload == null ? null : JSON.stringify(revision.payload),
        ],
      );
    }
    return 'inserted';
  }

  async syncGraph(): Promise<SyncGraph> {
    const commits = new Map<string, StoredSyncCommit>();
    for (const commit of await this.listSyncCommits({ includeInvalid: true })) commits.set(commit.commitId, commit);
    const revisions = new Map<string, SyncRevisionV2>();
    for (const commit of commits.values()) for (const revision of commit.revisions) revisions.set(revision.revisionId, revision);
    const entityHeads = new Map<string, string[]>();
    for (const row of await this.driver.all<{ aggregate_type: string; aggregate_id: string; revision_id: string }>('SELECT * FROM sync_entity_heads ORDER BY revision_id')) {
      const key = aggregateKey(row.aggregate_type, row.aggregate_id);
      const list = entityHeads.get(key) ?? [];
      list.push(row.revision_id);
      entityHeads.set(key, list);
    }
    const ledgerHeads = (await this.driver.all<{ commit_id: string }>('SELECT commit_id FROM sync_ledger_heads ORDER BY commit_id')).map((row) => row.commit_id);
    return { commits, revisions, entityHeads, ledgerHeads };
  }

  async setSyncCommitState(commitId: string, state: StoredSyncCommit['state'], error?: string): Promise<void> {
    await this.driver.run('UPDATE sync_commits SET state = ?, error = ? WHERE commit_id = ?', [state, error ?? null, commitId]);
  }

  async setSyncEntityHeads(type: string, id: string, revisionIds: string[]): Promise<void> {
    await this.driver.run('DELETE FROM sync_entity_heads WHERE aggregate_type = ? AND aggregate_id = ?', [type, id]);
    for (const revisionId of [...new Set(revisionIds)].sort()) {
      await this.driver.run(
        'INSERT INTO sync_entity_heads (aggregate_type, aggregate_id, revision_id) VALUES (?, ?, ?)',
        [type, id, revisionId],
      );
    }
  }

  async setSyncLedgerHeads(commitIds: string[]): Promise<void> {
    await this.driver.run('DELETE FROM sync_ledger_heads');
    for (const commitId of [...new Set(commitIds)].sort()) await this.driver.run('INSERT INTO sync_ledger_heads (commit_id) VALUES (?)', [commitId]);
  }

  private syncCollection(type: string): Collection<BaseEntity> | null {
    const rows: Record<string, unknown> = {
      asset: this.assets, account: this.accounts, setting: this.settings,
      price_mark: this.priceMarks, dca_plan: this.dcaPlans, dca_execution: this.dcaExecutions,
      game: this.games, game_account: this.gameAccounts, game_season: this.gameSeasons,
      game_record: this.gameRecords, game_cashflow_link: this.gameCashflowLinks,
      fixed_asset: this.fixedAssets,
      fixed_asset_event: this.fixedAssetEvents, fixed_asset_category: this.fixedAssetCategories,
      fixed_asset_cashflow_link: this.fixedAssetCashflowLinks,
      fixed_asset_usage_metric: this.fixedAssetUsageMetrics, fixed_asset_usage_log: this.fixedAssetUsageLogs,
      fixed_asset_consumable: this.fixedAssetConsumables, fixed_asset_goal: this.fixedAssetGoals,
      attachment: this.attachments, category: this.categories, payee: this.payees,
      transaction_tag: this.transactionTags, transaction_location: this.transactionLocations,
      transaction_template: this.transactionTemplates, transaction_saved_view: this.transactionSavedViews,
      budget_category: this.budgetCategories, scheduled_transaction: this.scheduledTransactions,
      scheduled_execution: this.scheduledExecutions,
      refund_allocation: this.refundAllocations,
    };
    return (rows[type] as Collection<BaseEntity> | undefined) ?? null;
  }

  async getSyncAggregate(type: string, id: string): Promise<Record<string, unknown> | null> {
    if (type === 'conversion') return (await aggregateSnapshot(this.driver, 'conversion_chain', { id }))?.payload ?? null;
    if (type === 'transaction') return (await aggregateSnapshot(this.driver, 'transaction', { id }))?.payload ?? null;
    if (type === 'reconciliation') return (await aggregateSnapshot(this.driver, 'reconciliation_session', { id }))?.payload ?? null;
    const spec = EVENT_SPECS[type];
    if (!spec) return null;
    const row = await this.driver.get<Record<string, unknown>>(`SELECT * FROM ${spec.name} WHERE id = ?`, [id]);
    return row ? projectEntity(rowToEntity(spec, row) as unknown as Record<string, unknown>) : null;
  }

  async applySyncAggregate(type: string, id: string, payload: Record<string, unknown> | null, op: 'put' | 'delete'): Promise<void> {
    assertSyncAggregateIdentity(type, id, payload);
    // Local delete revisions may carry a final tombstone snapshot for audit and
    // conflict resolution. The operation is authoritative: trying to validate
    // that snapshot as a live aggregate fails after dependent rows were removed
    // (for example reconciliation items or refund allocations).
    if (op === 'delete') {
      if (type === 'conversion') {
        const current = await this.conversionChains.get(id);
        if (current) await this.conversionChains.remove(id, current.version);
        return;
      }
      if (type === 'transaction') {
        await this.withPrevalidatedAggregates([`transaction:${id}`], async (aggregateStore) => {
          for (const split of await aggregateStore.transactionSplits.list({ where: { transactionId: id } })) {
            await aggregateStore.transactionSplits.remove(split.id, split.version);
          }
          for (const allocation of await aggregateStore.refundAllocations.list({ where: { refundTransactionId: id } })) {
            await aggregateStore.refundAllocations.remove(allocation.id, allocation.version);
          }
          const current = await aggregateStore.transactions.get(id);
          if (current) await aggregateStore.transactions.remove(id, current.version);
        });
        return;
      }
      if (type === 'reconciliation') {
        await this.withPrevalidatedAggregates([`reconciliation:${id}`], async (aggregateStore) => {
          for (const item of await aggregateStore.reconciliationItems.list({ where: { reconciliationId: id } })) {
            await aggregateStore.reconciliationItems.remove(item.id, item.version);
          }
          const current = await aggregateStore.reconciliationSessions.get(id);
          if (current) await aggregateStore.reconciliationSessions.remove(id, current.version);
        });
        return;
      }
      const collection = this.syncCollection(type);
      if (!collection) throw new Error(`不支持的同步聚合类型 ${type}`);
      const current = await collection.get(id);
      if (current) await collection.remove(id, current.version);
      return;
    }
    if (!payload) throw new Error(`同步聚合 ${type}:${id} 缺少快照`);
    if (type === 'conversion') {
      const incomingChain = asRecord(payload['chain']);
      const incomingSteps = Array.isArray(payload['steps']) ? payload['steps'].map(asRecord).filter((row): row is Record<string, unknown> => !!row) : [];
      if (!incomingChain) throw new Error('资产转换同步快照缺少 chain');
      const current = await this.conversionChains.get(id);
      const chain = {
        ...(current ?? {}), ...incomingChain, id,
        createdAt: current?.createdAt || String(incomingChain['createdAt'] ?? ''),
        updatedAt: current?.updatedAt ?? '', version: current?.version ?? 0,
        isDeleted: incomingChain['isDeleted'] === true,
      } as ConversionChain;
      const steps = incomingSteps.map((step) => ({ ...step, chainId: id })) as unknown as ConversionStep[];
      await this.saveChainWithSteps(chain, steps);
      return;
    }
    if (type === 'transaction') {
      const incomingTransaction = asRecord(payload['transaction']);
      const incomingSplits = Array.isArray(payload['splits']) ? payload['splits'].map(asRecord).filter((row): row is Record<string, unknown> => !!row) : [];
      const incomingAllocations = Array.isArray(payload['refundAllocations'])
        ? payload['refundAllocations'].map(asRecord).filter((row): row is Record<string, unknown> => !!row)
        : [];
      if (!incomingTransaction) throw new Error('日常流水同步快照缺少 transaction');
      const current = await this.transactions.get(id);
      const transaction = {
        ...(current ?? {}), ...incomingTransaction, id,
        createdAt: current?.createdAt || String(incomingTransaction['createdAt'] ?? ''),
        updatedAt: current?.updatedAt ?? '', version: current?.version ?? 0,
        isDeleted: incomingTransaction['isDeleted'] === true,
      } as import('@zichan/core').Transaction;
      const splits = incomingSplits.map((split) => ({
        ...split,
        id: String(split['id']),
        transactionId: id,
        isDeleted: split['isDeleted'] === true,
      })) as unknown as import('@zichan/core').TransactionSplit[];
      const allocations = incomingAllocations.map((allocation) => ({
        ...allocation,
        id: String(allocation['id']),
        refundTransactionId: id,
        isDeleted: allocation['isDeleted'] === true,
      })) as unknown as import('@zichan/core').RefundAllocation[];
      await ensureSystemCategoryRow(this.driver, transaction.category);
      for (const split of splits) await ensureSystemCategoryRow(this.driver, split.category);
      for (const allocation of allocations) await ensureSystemCategoryRow(this.driver, allocation.categoryId);
      await this.assertTransactionAggregate({
        transaction: normalizeDomainEntity('transaction', transaction),
        splits,
        refundAllocations: allocations,
      });
      await this.withPrevalidatedAggregates([`transaction:${id}`], async (aggregateStore) => {
        await aggregateStore.transactions.put(transaction);
        const currentSplits = await aggregateStore.transactionSplits.list({ where: { transactionId: id }, includeDeleted: true });
        const incomingIds = new Set(incomingSplits.map((split) => String(split['id'])));
        for (const split of incomingSplits) {
          const splitId = String(split['id']);
          const before = currentSplits.find((row) => row.id === splitId);
          await aggregateStore.transactionSplits.put({
            ...(before ?? {}), ...split, id: splitId, transactionId: id,
            createdAt: before?.createdAt || String(split['createdAt'] ?? ''),
            updatedAt: before?.updatedAt ?? '', version: before?.version ?? 0,
            isDeleted: split['isDeleted'] === true,
          } as import('@zichan/core').TransactionSplit);
        }
        for (const split of currentSplits) {
          if (!split.isDeleted && !incomingIds.has(split.id)) await aggregateStore.transactionSplits.remove(split.id, split.version);
        }
        const currentAllocations = await aggregateStore.refundAllocations.list({ where: { refundTransactionId: id }, includeDeleted: true });
        const incomingAllocationIds = new Set(incomingAllocations.map((allocation) => String(allocation['id'])));
        for (const allocation of incomingAllocations) {
          const allocationId = String(allocation['id']);
          const before = currentAllocations.find((row) => row.id === allocationId);
          await aggregateStore.refundAllocations.put({
            ...(before ?? {}), ...allocation, id: allocationId, refundTransactionId: id,
            createdAt: before?.createdAt || String(allocation['createdAt'] ?? ''),
            updatedAt: before?.updatedAt ?? '', version: before?.version ?? 0,
            isDeleted: allocation['isDeleted'] === true,
          } as import('@zichan/core').RefundAllocation);
        }
        for (const allocation of currentAllocations) {
          if (!allocation.isDeleted && !incomingAllocationIds.has(allocation.id)) {
            await aggregateStore.refundAllocations.remove(allocation.id, allocation.version);
          }
        }
      });
      return;
    }
    if (type === 'reconciliation') {
      const incomingSession = asRecord(payload['session']);
      const incomingItems = Array.isArray(payload['items'])
        ? payload['items'].map(asRecord).filter((row): row is Record<string, unknown> => !!row)
        : [];
      if (!incomingSession) throw new Error('对账同步快照缺少 session');
      const current = await this.reconciliationSessions.get(id);
      const session = {
        ...(current ?? {}), ...incomingSession, id,
        createdAt: current?.createdAt || String(incomingSession['createdAt'] ?? ''),
        updatedAt: current?.updatedAt ?? '', version: current?.version ?? 0,
        isDeleted: incomingSession['isDeleted'] === true,
      } as import('@zichan/core').ReconciliationSession;
      const items = incomingItems.map((item) => ({
        ...item,
        id: String(item['id']),
        reconciliationId: id,
        isDeleted: item['isDeleted'] === true,
      })) as unknown as import('@zichan/core').ReconciliationItem[];
      await this.assertReconciliationAggregate(session, items);
      await this.withPrevalidatedAggregates([`reconciliation:${id}`], async (aggregateStore) => {
        await aggregateStore.reconciliationSessions.put(session);
        const currentItems = await aggregateStore.reconciliationItems.list({ where: { reconciliationId: id }, includeDeleted: true });
        const incomingIds = new Set(incomingItems.map((item) => String(item['id'])));
        for (const item of incomingItems) {
          const itemId = String(item['id']);
          const before = currentItems.find((row) => row.id === itemId);
          await aggregateStore.reconciliationItems.put({
            ...(before ?? {}), ...item, id: itemId, reconciliationId: id,
            createdAt: before?.createdAt || String(item['createdAt'] ?? ''),
            updatedAt: before?.updatedAt ?? '', version: before?.version ?? 0,
            isDeleted: item['isDeleted'] === true,
          } as import('@zichan/core').ReconciliationItem);
        }
        for (const item of currentItems) {
          if (!item.isDeleted && !incomingIds.has(item.id)) await aggregateStore.reconciliationItems.remove(item.id, item.version);
        }
      });
      return;
    }
    const collection = this.syncCollection(type);
    if (!collection) throw new Error(`不支持的同步聚合类型 ${type}`);
    const current = await collection.get(id);
    await collection.put({
      ...(current ?? {}), ...payload, id,
      createdAt: current?.createdAt || String(payload['createdAt'] ?? ''),
      updatedAt: current?.updatedAt ?? '', version: current?.version ?? 0,
      isDeleted: payload['isDeleted'] === true,
    });
  }

  async saveReplicaState(identity: SyncReplicaIdentity, cursor: number, headSeq: number): Promise<SyncReplicaState> {
    const key = replicaKey(identity);
    await this.driver.run(
      `INSERT OR REPLACE INTO sync_replica_state
       (replica_key, server_id, replica_id, stream_epoch, ledger_id, cursor, head_seq, updated_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [key, identity.serverId, identity.replicaId, identity.streamEpoch, identity.ledgerId, cursor, headSeq, nowIso()],
    );
    return { ...identity, replicaKey: key, cursor, headSeq, updatedAt: nowIso() };
  }

  async getReplicaState(identity: SyncReplicaIdentity): Promise<SyncReplicaState> {
    const key = replicaKey(identity);
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM sync_replica_state WHERE replica_key = ?', [key]);
    if (!row) return { ...identity, replicaKey: key, cursor: 0, headSeq: 0 };
    return {
      ...identity, replicaKey: key,
      cursor: Number(row['cursor'] ?? 0), headSeq: Number(row['head_seq'] ?? 0),
      updatedAt: row['updated_at'] == null ? undefined : String(row['updated_at']),
      retiredAt: row['retired_at'] == null ? undefined : String(row['retired_at']),
    };
  }

  async retireReplica(identity: SyncReplicaIdentity): Promise<boolean> {
    const result = await this.driver.run(
      `UPDATE sync_replica_state SET retired_at = ?, updated_at = ?
       WHERE replica_key = ? AND retired_at IS NULL`,
      [nowIso(), nowIso(), replicaKey(identity)],
    );
    return result.changes > 0;
  }

  async markCommitsAcknowledged(key: string, rows: { commitId: string; seq: number; contentHash: string }[]): Promise<void> {
    for (const row of rows) {
      await this.driver.run(
        `INSERT OR REPLACE INTO sync_replica_acks
         (replica_key, commit_id, server_seq, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [key, row.commitId, row.seq, row.contentHash, nowIso()],
      );
    }
  }

  async recordSyncConflict(input: {
    commit: StoredSyncCommit;
    localCommitIds: string[];
    changedPaths: string[];
    branches: SyncConflictBranchRow[];
  }): Promise<string> {
    const open = await this.listConflicts();
    const touched = new Set(input.branches.map((branch) => aggregateKey(branch.aggregateType, branch.aggregateId)));
    const existing = open.find((group) =>
      group.branches.some((branch) => touched.has(aggregateKey(branch.aggregateType, branch.aggregateId)))
      || group.remoteCommitIds.some((commitId) => input.commit.parentCommitIds.includes(commitId)),
    );
    const id = existing?.id ?? newId();
    const localCommitIds = [...new Set([...(existing?.localCommitIds ?? []), ...input.localCommitIds])];
    const remoteCommitIds = [...new Set([...(existing?.remoteCommitIds ?? []), input.commit.commitId])];
    const changedPaths = [...new Set([...(existing?.changedPaths ?? []), ...input.changedPaths])].sort();
    await this.driver.run(
      `INSERT OR REPLACE INTO sync_conflict_groups
       (id, ledger_id, at, status, local_commit_ids, remote_commit_ids, changed_paths, resolved_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, NULL)`,
      [id, input.commit.ledgerId, existing?.at ?? nowIso(), JSON.stringify(localCommitIds), JSON.stringify(remoteCommitIds), JSON.stringify(changedPaths)],
    );
    for (const branch of input.branches) {
      await this.driver.run(
        `INSERT OR REPLACE INTO sync_conflict_branches
         (group_id, revision_id, commit_id, aggregate_type, aggregate_id, role, origin_device_id,
          source_replica_key, parent_revision_ids, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, branch.revisionId, branch.commitId, branch.aggregateType, branch.aggregateId,
          branch.role, branch.originDeviceId, branch.sourceReplicaKey ?? null,
          JSON.stringify(branch.parentRevisionIds), branch.payload == null ? null : JSON.stringify(branch.payload),
        ],
      );
    }
    return id;
  }

  async listConflicts(): Promise<SyncConflictGroupRow[]> {
    const rows = await this.driver.all<Record<string, unknown>>("SELECT * FROM sync_conflict_groups WHERE status = 'open' ORDER BY at DESC");
    const groups: SyncConflictGroupRow[] = [];
    for (const row of rows) {
      const id = String(row['id']);
      const branchRows = await this.driver.all<Record<string, unknown>>('SELECT * FROM sync_conflict_branches WHERE group_id = ? ORDER BY role, commit_id', [id]);
      groups.push({
        id, ledgerId: String(row['ledger_id']), at: String(row['at']), status: 'open',
        localCommitIds: jsonArray(row['local_commit_ids']), remoteCommitIds: jsonArray(row['remote_commit_ids']),
        changedPaths: jsonArray(row['changed_paths']),
        resolvedAt: row['resolved_at'] == null ? undefined : String(row['resolved_at']),
        branches: branchRows.map((branch): SyncConflictBranchRow => ({
          groupId: id, revisionId: String(branch['revision_id']), commitId: String(branch['commit_id']),
          aggregateType: String(branch['aggregate_type']), aggregateId: String(branch['aggregate_id']),
          role: branch['role'] === 'local' ? 'local' : 'remote', originDeviceId: String(branch['origin_device_id']),
          sourceReplicaKey: branch['source_replica_key'] == null ? undefined : String(branch['source_replica_key']),
          parentRevisionIds: jsonArray(branch['parent_revision_ids']),
          payload: branch['payload'] == null ? null : JSON.parse(String(branch['payload'])) as Record<string, unknown>,
        })),
      });
    }
    return groups;
  }

  async finishConflictGroup(input: {
    groupId: string;
    action: SyncConflictResolution['action'];
    resolvedCommitId?: string;
    detail?: unknown;
    note?: string;
    resolverDeviceId?: string;
  }): Promise<void> {
    const at = nowIso();
    await this.driver.run('UPDATE sync_conflict_groups SET status = ?, resolved_at = ? WHERE id = ?', ['resolved', at, input.groupId]);
    await this.driver.run(
      `INSERT INTO sync_conflict_resolutions
       (id, group_id, resolved_at, resolver_device_id, action, resolved_commit_id, detail_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), input.groupId, at, input.resolverDeviceId ?? this.ctx.deviceId ?? null, input.action, input.resolvedCommitId ?? null, input.detail == null ? null : JSON.stringify(input.detail), input.note ?? null],
    );
  }

  async listConflictResolutions(query: number | { limit?: number; since?: string; until?: string } = 200): Promise<SyncConflictResolution[]> {
    const options = typeof query === 'number' ? { limit: query } : query;
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (options.since) { clauses.push('resolved_at >= ?'); params.push(options.since); }
    if (options.until) { clauses.push('resolved_at < ?'); params.push(options.until); }
    let sql = 'SELECT * FROM sync_conflict_resolutions';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY resolved_at DESC';
    if (options.limit) { sql += ' LIMIT ?'; params.push(options.limit); }
    const rows = await this.driver.all<Record<string, unknown>>(sql, params);
    return rows.map((r) => ({
      id: String(r['id']),
      groupId: String(r['group_id']),
      resolvedAt: String(r['resolved_at']),
      resolverDeviceId: r['resolver_device_id'] == null ? undefined : String(r['resolver_device_id']),
      action: String(r['action']) as SyncConflictResolution['action'],
      resolvedCommitId: r['resolved_commit_id'] == null ? undefined : String(r['resolved_commit_id']),
      detailJson: r['detail_json'] == null ? undefined : String(r['detail_json']),
      note: r['note'] == null ? undefined : String(r['note']),
    }));
  }

  async migrate(): Promise<void> {
    await runMigrations(this.driver, this.log);
    const interrupted = await this.driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_commits WHERE source = 'local' AND sealed = 0");
    const count = Number(interrupted?.n ?? 0);
    if (count > 0) {
      await this.driver.run("UPDATE sync_commits SET sealed = 1 WHERE source = 'local' AND sealed = 0");
      this.log.warn('recovered interrupted local sync commits', { count });
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

/** Build a store over a given driver and verify the current schema baseline. */
export async function createLedgerStore(
  driver: SqlDriver,
  opts: StoreOptions = {},
): Promise<SqlLedgerStore> {
  const store = new SqlLedgerStore(driver, opts);
  await store.migrate();
  return store;
}
