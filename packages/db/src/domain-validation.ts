import { duplicateMasterData, DuplicateMasterDataError } from './master-data-identity.js';
import {
  D, isValidEntityIcon, assertCostBasisOpening, assertCostQuoteSnapshot, transactionCostFingerprint,
  isDefaultAccount, accountBalanceTiming, accountTransactionPostings,
  assertConversionShape,
  assertDcaExecutionShape,
  assertDcaPlanShape,
  assertScheduledExecutionShape,
  assertTransactionShape,
  isValidDay,
  normalizeOccurrence,
  type Account,
  type Asset,
  type BaseEntity,
  type BudgetCategory,
  type Category,
  type ConversionChain,
  type ConversionStep,
  type FixedAssetCategory,
  type Payee,
  type ReconciliationItem,
  type ReconciliationSession,
  type ScheduledTransaction,
  type Transaction,
  type TransactionSplit,
  type RefundAllocation,
} from '@zichan/core';
import type { SqlDriver } from './driver.js';
import { DomainValidationError } from './domain-errors.js';
import { TABLES, rowToEntity, type TableSpec } from './tables.js';

export interface DomainValidationIssue {
  field?: string;
  message: string;
}

const ASSET_TYPES = new Set([
  'fiat', 'stablecoin', 'crypto', 'stock', 'fund', 'bond', 'precious_metal', 'game', 'fixed',
]);
const ACCOUNT_KINDS = new Set([
  'bank', 'cash', 'exchange', 'wallet', 'credit_card', 'loan', 'game_platform', 'other',
]);
const SCHEDULE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);
const SCHEDULE_STATUSES = new Set(['active', 'paused']);
const SCHEDULE_ANCHORS = new Set(['calendar_day', 'month_end']);
const SCHEDULE_CATCH_UP = new Set(['all', 'latest']);
const LOT_STATUSES = new Set(['open', 'closed']);
const GAME_ACCOUNT_STATUSES = new Set(['active', 'inactive', 'sold', 'banned']);
const GAME_SEASON_STATUSES = new Set(['upcoming', 'active', 'ended']);
const GAME_RECORD_TYPES = new Set([
  'buy_currency', 'sell_currency', 'produce', 'consume', 'sell_equipment', 'sell_material',
  'topup', 'withdraw', 'fee', 'account_cost', 'boosting_cost', 'other_expense', 'other_income',
]);
const FIXED_ASSET_STATUSES = new Set(['active', 'stored', 'sold', 'scrapped', 'retired', 'gifted']);
const FIXED_EVENT_TYPES = new Set([
  'purchase', 'activate', 'repair', 'upgrade', 'residual_update',
  'warranty_expire', 'sale', 'scrap', 'retire', 'gift',
]);

function fail(message: string, field?: string): never {
  throw new DomainValidationError(message, field);
}

function requireText(value: unknown, label: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}不能为空`, field);
  return value.trim();
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function decimal(value: unknown, label: string, field: string) {
  let parsed;
  try {
    parsed = D(String(value));
  } catch {
    fail(`${label}不是有效数字`, field);
  }
  if (!parsed.isFinite()) fail(`${label}必须是有限数字`, field);
  return parsed;
}

function decimalPlaces(value: unknown): number {
  try {
    return D(String(value)).decimalPlaces();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isActive(row: BaseEntity & { isActive?: boolean; mergedIntoId?: string }): boolean {
  return !row.isDeleted && row.isActive !== false && !row.mergedIntoId;
}

function isAllowedReference<T extends BaseEntity & { isActive?: boolean; mergedIntoId?: string }>(
  row: T | undefined,
  allowInactiveReferences: boolean,
): row is T {
  return !!row && !row.isDeleted && (allowInactiveReferences || isActive(row));
}

async function getEntity<T extends BaseEntity>(
  driver: SqlDriver,
  spec: TableSpec,
  id: string,
): Promise<T | undefined> {
  const row = await driver.get<Record<string, unknown>>(`SELECT * FROM ${spec.name} WHERE id = ?`, [id]);
  return row ? rowToEntity<T>(spec, row) : undefined;
}

async function listEntities<T extends BaseEntity>(driver: SqlDriver, spec: TableSpec): Promise<T[]> {
  const rows = await driver.all<Record<string, unknown>>(`SELECT * FROM ${spec.name} WHERE is_deleted = 0`);
  return rows.map((row) => rowToEntity<T>(spec, row));
}

async function scalarCount(driver: SqlDriver, sql: string, params: string[]): Promise<number> {
  const row = await driver.get<{ count: number }>(sql, params);
  return Number(row?.count ?? 0);
}

async function activeCount(
  driver: SqlDriver,
  table: string,
  predicate: string,
  params: string[],
): Promise<number> {
  return scalarCount(driver, `SELECT COUNT(*) AS count FROM ${table} WHERE is_deleted = 0 AND (${predicate})`, params);
}

async function attachmentReferenceCount(driver: SqlDriver, entityType: string, id: string): Promise<number> {
  return activeCount(driver, 'attachments', 'entity_type = ? AND entity_id = ?', [entityType, id]);
}

async function arrayReferenceCount(
  driver: SqlDriver,
  spec: TableSpec,
  field: string,
  id: string,
): Promise<number> {
  const rows = await listEntities<BaseEntity & Record<string, unknown>>(driver, spec);
  return rows.filter((row) => !row.isDeleted && Array.isArray(row[field]) && row[field].includes(id)).length;
}

async function activeAsset(
  driver: SqlDriver,
  id: string,
  field: string,
  allowInactiveReferences = false,
): Promise<Asset> {
  const asset = await getEntity<Asset>(driver, TABLES.assets, id);
  if (!isAllowedReference(asset, allowInactiveReferences)) fail(`引用的资产不存在或已停用：${id}`, field);
  return asset;
}

async function activeAccount(
  driver: SqlDriver,
  id: string,
  field: string,
  allowInactiveReferences = false,
): Promise<Account> {
  const account = await getEntity<Account>(driver, TABLES.accounts, id);
  if (!isAllowedReference(account, allowInactiveReferences)) fail(`引用的账户不存在或已归档：${id}`, field);
  return account;
}

async function leafCategory(
  driver: SqlDriver,
  id: string,
  expectedType: Category['type'],
  field: string,
  allowInactiveReferences = false,
): Promise<Category> {
  const category = await getEntity<Category>(driver, TABLES.categories, id);
  if (!isAllowedReference(category, allowInactiveReferences)) fail(`分类不存在或已归档：${id}`, field);
  if (!category.parentId) fail('请选择二级分类，不能直接选择一级分类', field);
  if (category.type !== expectedType) fail('分类与收支类型不匹配', field);
  const parent = await getEntity<Category>(driver, TABLES.categories, category.parentId);
  if (!isAllowedReference(parent, allowInactiveReferences) || parent.parentId || parent.type !== expectedType) {
    fail('二级分类的一级分类无效或类型不一致', field);
  }
  const children = await listEntities<Category>(driver, TABLES.categories);
  if (children.some((row) => isActive(row) && row.parentId === category.id)) {
    fail('流水分类必须是分类树的叶子节点', field);
  }
  return category;
}

async function categoryReferenceCount(driver: SqlDriver, id: string): Promise<number> {
  return scalarCount(driver, `
    SELECT
      (SELECT COUNT(*) FROM categories WHERE parent_id = ? AND is_deleted = 0)
      + (SELECT COUNT(*) FROM transactions WHERE category = ? AND is_deleted = 0)
      + (SELECT COUNT(*) FROM transaction_splits WHERE category = ? AND is_deleted = 0)
      + (SELECT COUNT(*) FROM refund_allocations WHERE category_id = ? AND is_deleted = 0)
      + (SELECT COUNT(*) FROM budget_categories WHERE category = ? AND is_deleted = 0)
      + (SELECT COUNT(*) FROM scheduled_transactions WHERE category = ? AND is_deleted = 0)
      + (SELECT COUNT(*) FROM transaction_templates WHERE category = ? AND is_deleted = 0)
      + (SELECT COUNT(*) FROM payees WHERE default_category = ? AND is_deleted = 0)
      AS count
  `, [id, id, id, id, id, id, id, id]);
}

async function assetReferenceCount(driver: SqlDriver, id: string): Promise<number> {
  const counts = await Promise.all([
    activeCount(driver, 'settings', `
      base_currency_asset_id = ? OR transaction_default_asset_id = ? OR investment_cost_asset_id = ?
      OR fixed_asset_default_currency_asset_id = ? OR game_default_settlement_asset_id = ?
    `, [id, id, id, id, id]),
    activeCount(driver, 'transactions', 'asset_id = ? OR transfer_asset_id = ? OR refund_applied_asset_id = ?', [id, id, id]),
    activeCount(driver, 'conversion_chains', 'base_currency_asset_id = ? OR final_asset_id = ?', [id, id]),
    scalarCount(driver, `
      SELECT COUNT(*) AS count
      FROM conversion_steps s
      JOIN conversion_chains c ON c.id = s.chain_id
      WHERE c.is_deleted = 0 AND (s.from_asset_id = ? OR s.to_asset_id = ?)
    `, [id, id]),
    activeCount(driver, 'lots', 'asset_id = ? OR base_currency_asset_id = ? OR native_cost_asset_id = ?', [id, id, id]),
    activeCount(driver, 'price_marks', 'asset_id = ? OR quote_asset_id = ?', [id, id]),
    activeCount(driver, 'dca_plans', 'target_asset_id = ? OR base_currency_asset_id = ?', [id, id]),
    activeCount(driver, 'dca_executions', 'base_currency_asset_id = ? OR final_asset_id = ?', [id, id]),
    activeCount(driver, 'game_records', 'settlement_asset_id = ? OR fee_asset_id = ?', [id, id]),
    activeCount(driver, 'game_cashflow_links', 'source_asset_id = ?', [id]),
    activeCount(driver, 'fixed_assets', 'base_currency_asset_id = ?', [id]),
    activeCount(driver, 'fixed_asset_cashflow_links', 'source_asset_id = ? OR base_asset_id = ?', [id, id]),
    activeCount(driver, 'budget_categories', 'asset_id = ?', [id]),
    activeCount(driver, 'scheduled_transactions', 'asset_id = ? OR transfer_asset_id = ?', [id, id]),
    activeCount(driver, 'accounts', 'opening_asset_id = ?', [id]),
    activeCount(driver, 'transaction_templates', 'asset_id = ?', [id]),
    activeCount(driver, 'reconciliation_sessions', 'asset_id = ?', [id]),
    activeCount(driver, 'reconciliation_items', 'asset_id = ?', [id]),
    attachmentReferenceCount(driver, 'asset', id),
  ]);
  const feeRows = await driver.all<{ fees_json?: string }>(`
    SELECT s.fees_json
    FROM conversion_steps s
    JOIN conversion_chains c ON c.id = s.chain_id
    WHERE c.is_deleted = 0 AND s.fees_json IS NOT NULL
  `);
  const feeReferences = feeRows.reduce((total, row) => {
    try {
      const fees = JSON.parse(String(row.fees_json ?? '[]')) as { assetId?: string }[];
      return total + fees.filter((fee) => fee.assetId === id).length;
    } catch {
      return total;
    }
  }, 0);
  return counts.reduce((total, value) => total + value, feeReferences);
}

async function accountReferenceCount(driver: SqlDriver, id: string): Promise<number> {
  const counts = await Promise.all([
    activeCount(driver, 'settings', 'expense_default_account_id = ? OR income_default_account_id = ?', [id, id]),
    activeCount(driver, 'transactions', 'account_id = ? OR transfer_account_id = ?', [id, id]),
    scalarCount(driver, `
      SELECT COUNT(*) AS count
      FROM conversion_steps s
      JOIN conversion_chains c ON c.id = s.chain_id
      WHERE c.is_deleted = 0 AND (s.account_from_id = ? OR s.account_to_id = ?)
    `, [id, id]),
    activeCount(driver, 'payees', 'default_account_id = ?', [id]),
    activeCount(driver, 'transaction_templates', 'account_id = ?', [id]),
    activeCount(driver, 'scheduled_transactions', 'account_id = ? OR transfer_account_id = ?', [id, id]),
    activeCount(driver, 'reconciliation_sessions', 'account_id = ?', [id]),
    activeCount(driver, 'reconciliation_items', 'account_id = ?', [id]),
    activeCount(driver, 'game_cashflow_links', 'account_id = ?', [id]),
    attachmentReferenceCount(driver, 'account', id),
  ]);
  const feeRows = await driver.all<{ fees_json?: string }>(`
    SELECT s.fees_json
    FROM conversion_steps s
    JOIN conversion_chains c ON c.id = s.chain_id
    WHERE c.is_deleted = 0 AND s.fees_json IS NOT NULL
  `);
  const feeReferences = feeRows.reduce((total, row) => {
    try {
      const fees = JSON.parse(String(row.fees_json ?? '[]')) as { accountId?: string }[];
      return total + fees.filter((fee) => fee.accountId === id).length;
    } catch {
      return total;
    }
  }, 0);
  return counts.reduce((total, value) => total + value, feeReferences);
}

async function fixedCategoryReferenceCount(driver: SqlDriver, id: string): Promise<number> {
  return scalarCount(driver, `
    SELECT
      (SELECT COUNT(*) FROM fixed_assets WHERE category_id = ? AND is_deleted = 0)
      + (SELECT COUNT(*) FROM fixed_asset_categories WHERE parent_id = ? AND is_deleted = 0)
      AS count
  `, [id, id]);
}

async function entityReferenceCount(driver: SqlDriver, entityType: string, id: string): Promise<number> {
  switch (entityType) {
    case 'category':
      return categoryReferenceCount(driver, id);
    case 'asset':
      return assetReferenceCount(driver, id);
    case 'account':
      return accountReferenceCount(driver, id);
    case 'fixed_asset_category':
      return fixedCategoryReferenceCount(driver, id);
    case 'transaction_tag':
      return (await arrayReferenceCount(driver, TABLES.transactions, 'tagIds', id))
        + (await arrayReferenceCount(driver, TABLES.transactionTemplates, 'tagIds', id));
    case 'transaction_location':
      return (await activeCount(driver, 'transactions', 'location_id = ?', [id]))
        + (await activeCount(driver, 'transaction_templates', 'location_id = ?', [id]));
    case 'payee':
      return (await activeCount(driver, 'transactions', 'payee_id = ?', [id]))
        + (await activeCount(driver, 'scheduled_transactions', 'payee_id = ?', [id]))
        + (await activeCount(driver, 'transaction_templates', 'payee_id = ?', [id]));
    case 'transaction':
      return (await activeCount(driver, 'transactions', 'refund_for_id = ?', [id]))
        + (await activeCount(driver, 'refund_allocations', 'source_transaction_id = ? OR refund_transaction_id = ?', [id, id]))
        + (await activeCount(driver, 'scheduled_executions', 'transaction_id = ?', [id]))
        + (await activeCount(driver, 'reconciliation_items', 'transaction_id = ?', [id]))
        + (await activeCount(driver, 'game_cashflow_links', 'transaction_id = ?', [id]))
        + (await activeCount(driver, 'fixed_asset_cashflow_links', 'transaction_id = ?', [id]))
        + (await activeCount(driver, 'reconciliation_sessions', 'adjustment_transaction_id = ?', [id]))
        + (await attachmentReferenceCount(driver, 'transaction', id));
    case 'conversion_chain':
      return (await activeCount(driver, 'lots', 'source_chain_id = ?', [id]))
        + (await activeCount(driver, 'lot_consumptions', 'sell_chain_id = ?', [id]))
        + (await activeCount(driver, 'dca_executions', 'chain_id = ?', [id]))
        + (await attachmentReferenceCount(driver, 'conversion_chain', id));
    case 'lot':
      return activeCount(driver, 'lot_consumptions', 'lot_id = ?', [id]);
    case 'dca_plan':
      return activeCount(driver, 'dca_executions', 'plan_id = ?', [id]);
    case 'dca_execution':
      return (await activeCount(driver, 'conversion_chains', 'related_dca_execution_id = ?', [id]))
        + (await activeCount(driver, 'lots', 'source_dca_execution_id = ?', [id]));
    case 'game':
      return (await activeCount(driver, 'game_accounts', 'game_id = ?', [id]))
        + (await activeCount(driver, 'game_seasons', 'game_id = ?', [id]))
        + (await activeCount(driver, 'game_records', 'game_id = ?', [id]))
        + (await attachmentReferenceCount(driver, 'game', id));
    case 'game_account':
      return (await activeCount(driver, 'game_records', 'game_account_id = ?', [id]))
        + (await attachmentReferenceCount(driver, 'game_account', id));
    case 'game_season':
      return activeCount(driver, 'game_records', 'season_id = ?', [id]);
    case 'game_record':
      return (await activeCount(driver, 'game_cashflow_links', 'game_record_id = ?', [id]))
        + (await attachmentReferenceCount(driver, 'game_record', id));
    case 'fixed_asset':
      return (await activeCount(driver, 'fixed_asset_events', 'fixed_asset_id = ?', [id]))
        + (await activeCount(driver, 'fixed_asset_cashflow_links', 'fixed_asset_id = ?', [id]))
        + (await activeCount(driver, 'fixed_asset_usage_metrics', 'fixed_asset_id = ?', [id]))
        + (await activeCount(driver, 'fixed_asset_usage_logs', 'fixed_asset_id = ?', [id]))
        + (await activeCount(driver, 'fixed_asset_consumables', 'fixed_asset_id = ?', [id]))
        + (await activeCount(driver, 'fixed_asset_goals', 'fixed_asset_id = ?', [id]))
        + (await attachmentReferenceCount(driver, 'fixed_asset', id));
    case 'fixed_asset_event':
      return (await activeCount(driver, 'fixed_asset_cashflow_links', "source_type = 'event' AND source_id = ?", [id]))
        + (await attachmentReferenceCount(driver, 'fixed_asset_event', id));
    case 'fixed_asset_consumable':
      return (await activeCount(driver, 'fixed_asset_cashflow_links', "source_type = 'consumable' AND source_id = ?", [id]))
        + (await attachmentReferenceCount(driver, 'fixed_asset_consumable', id));
    case 'fixed_asset_usage_metric':
      return (await activeCount(driver, 'fixed_asset_usage_logs', 'metric_id = ?', [id]))
        + (await activeCount(driver, 'fixed_asset_consumables', 'usage_metric_id = ?', [id]))
        + (await activeCount(driver, 'fixed_asset_goals', 'metric_id = ?', [id]));
    case 'fixed_asset_usage_log':
      return attachmentReferenceCount(driver, 'fixed_asset_usage_log', id);
    case 'price_mark':
      return attachmentReferenceCount(driver, 'price_mark', id);
    case 'scheduled_transaction':
      return activeCount(driver, 'scheduled_executions', 'schedule_id = ?', [id]);
    case 'scheduled_execution':
      return activeCount(driver, 'transactions', 'scheduled_execution_id = ?', [id]);
    case 'reconciliation_session':
      return activeCount(
        driver,
        'transactions',
        "reconciliation_session_id = ? AND (record_state IS NULL OR record_state != 'voided')",
        [id],
      );
    case 'setting':
      return 1;
    default:
      return 0;
  }
}

function entityDeleteLabel(entityType: string): string {
  const labels: Record<string, string> = {
    category: '分类',
    asset: '资产',
    account: '账户',
    fixed_asset_category: '物品分类',
    transaction_tag: '标签',
    transaction_location: '地点',
    payee: '商户',
    transaction: '流水',
    conversion_chain: '资产转换',
    lot: '持仓批次',
    dca_plan: '定投计划',
    dca_execution: '定投执行',
    game: '游戏',
    game_account: '游戏账号',
    game_season: '赛季',
    game_record: '游戏记录',
    fixed_asset: '物品资产',
    fixed_asset_event: '物品事件',
    fixed_asset_consumable: '耗材记录',
    fixed_asset_usage_metric: '使用指标',
    fixed_asset_usage_log: '使用记录',
    price_mark: '价格记录',
    scheduled_transaction: '定期交易',
    scheduled_execution: '定期执行',
    reconciliation_session: '对账批次',
    setting: '账本设置',
  };
  return labels[entityType] ?? entityType;
}

export function validateCategoryHierarchySnapshot(
  categories: Category[],
  candidate: Category,
  current: Category | undefined,
  referenceCount: number,
  allowInactiveReferences = false,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];
  const activeRows = categories
    .filter((row) => row.id !== candidate.id && isActive(row))
    .concat(isActive(candidate) ? [candidate] : []);
  const referenceRows = allowInactiveReferences
    ? categories.filter((row) => row.id !== candidate.id && !row.isDeleted).concat(!candidate.isDeleted ? [candidate] : [])
    : activeRows;
  const parent = candidate.parentId ? referenceRows.find((row) => row.id === candidate.parentId) : undefined;
  const children = activeRows.filter((row) => row.parentId === candidate.id);

  if (!candidate.name.trim()) issues.push({ field: 'name', message: '分类名称不能为空' });
  if (candidate.type !== 'income' && candidate.type !== 'expense') {
    issues.push({ field: 'type', message: '分类类型无效' });
  }
  if (candidate.parentId === candidate.id) issues.push({ field: 'parentId', message: '分类不能把自己设为父级' });
  if (candidate.parentId && !parent) issues.push({ field: 'parentId', message: '父级分类不存在或已归档' });
  if (parent?.parentId) issues.push({ field: 'parentId', message: '分类最多支持一级和二级两层' });
  if (parent && parent.type !== candidate.type) issues.push({ field: 'parentId', message: '父子分类的收支类型必须一致' });
  if (candidate.parentId && children.length) issues.push({ field: 'parentId', message: '包含子分类的一级分类不能再设为二级分类' });
  if (children.some((row) => row.type !== candidate.type)) {
    issues.push({ field: 'type', message: '一级分类类型必须与全部二级分类一致' });
  }
  if (activeRows.some((row) => row.id !== candidate.id
    && row.type === candidate.type
    && (row.parentId ?? '') === (candidate.parentId ?? '')
    && normalizedName(row.name) === normalizedName(candidate.name))) {
    issues.push({ field: 'name', message: '同一父级下已经存在同名分类' });
  }
  if (current && referenceCount > 0 && current.type !== candidate.type) {
    issues.push({ field: 'type', message: '已被引用的分类不能修改收入/支出类型，请使用合并迁移' });
  }
  if (current && referenceCount > 0 && (current.parentId ?? '') !== (candidate.parentId ?? '')) {
    issues.push({ field: 'parentId', message: '已被引用的分类不能移动层级，请使用合并迁移' });
  }
  return issues;
}

export function validateAssetMutationSnapshot(
  candidate: Asset,
  current: Asset | undefined,
  referenceCount: number,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];
  if (!candidate.code.trim()) issues.push({ field: 'code', message: '资产代码不能为空' });
  if (!candidate.name.trim()) issues.push({ field: 'name', message: '资产名称不能为空' });
  if (!ASSET_TYPES.has(candidate.type)) issues.push({ field: 'type', message: '资产类型无效' });
  if (!Number.isSafeInteger(candidate.decimals) || candidate.decimals < 0 || candidate.decimals > 24) {
    issues.push({ field: 'decimals', message: '资产精度必须是 0 到 24 的整数' });
  }
  if (current && referenceCount > 0 && normalizedName(current.code) !== normalizedName(candidate.code)) {
    issues.push({ field: 'code', message: '已被引用的资产不能修改代码，请新建资产后迁移' });
  }
  if (current && referenceCount > 0 && current.type !== candidate.type) {
    issues.push({ field: 'type', message: '已被引用的资产不能修改类型，请新建资产后迁移' });
  }
  if (current && referenceCount > 0 && candidate.decimals < current.decimals) {
    issues.push({ field: 'decimals', message: '已被引用的资产不能降低精度' });
  }
  return issues;
}

function throwIssues(issues: DomainValidationIssue[]): void {
  const issue = issues[0];
  if (issue) fail(issue.message, issue.field);
}

function normalizedOccurrenceEntity<T extends Record<string, unknown>>(entity: T): T {
  let normalized;
  try {
    normalized = normalizeOccurrence({
      date: String(entity['date'] ?? ''),
      time: typeof entity['time'] === 'string' ? entity['time'] : undefined,
      timezone: typeof entity['timezone'] === 'string' ? entity['timezone'] : undefined,
      timePrecision: entity['timePrecision'] as 'day' | 'minute' | 'second' | undefined,
      timeDisambiguation: entity['timeDisambiguation'] as 'earlier' | 'later' | undefined,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : '日期时间无效', 'date');
  }
  for (const key of ['timezone', 'timePrecision', 'occurredAtUtc', 'utcOffsetMinutes', 'timeDisambiguation'] as const) {
    const supplied = entity[key];
    const expected = normalized[key];
    if (supplied !== undefined && supplied !== expected) fail(`日期时间快照字段 ${key} 与本地时间不一致`, key);
  }
  return { ...entity, ...normalized };
}

export function normalizeDomainEntity<T extends BaseEntity>(entityType: string, entity: T): T {
  if (entityType !== 'transaction' && entityType !== 'conversion_chain') return entity;
  return normalizedOccurrenceEntity(entity as unknown as Record<string, unknown>) as unknown as T;
}

async function validateCategoryWrite(
  driver: SqlDriver,
  candidate: Category,
  current?: Category,
  allowReferencedChanges = false,
  allowInactiveReferences = false,
): Promise<void> {
  if (!isValidEntityIcon(candidate.icon)) fail('图标格式无效或图片过大', 'icon');
  const categories = await listEntities<Category>(driver, TABLES.categories);
  const refs = current && !allowReferencedChanges ? await categoryReferenceCount(driver, current.id) : 0;
  throwIssues(validateCategoryHierarchySnapshot(categories, candidate, current, refs, allowInactiveReferences));
}

async function validateFixedCategoryWrite(
  driver: SqlDriver,
  candidate: FixedAssetCategory,
  current?: FixedAssetCategory,
  allowReferencedChanges = false,
  allowInactiveReferences = false,
): Promise<void> {
  requireText(candidate.name, '物品分类名称', 'name');
  const categories = await listEntities<FixedAssetCategory>(driver, TABLES.fixedAssetCategories);
  const activeRows = categories.filter((row) => row.id !== candidate.id && isActive(row));
  const referenceRows = allowInactiveReferences
    ? categories.filter((row) => row.id !== candidate.id && !row.isDeleted)
    : activeRows;
  const parent = candidate.parentId ? referenceRows.find((row) => row.id === candidate.parentId) : undefined;
  const children = activeRows.filter((row) => row.parentId === candidate.id);
  if (candidate.parentId === candidate.id) fail('分类不能把自己设为父级', 'parentId');
  if (candidate.parentId && !parent) fail('父级物品分类不存在或已归档', 'parentId');
  if (parent?.parentId) fail('物品分类最多支持一级和二级两层', 'parentId');
  if (candidate.parentId && children.length) fail('包含子分类的一级分类不能再设为二级分类', 'parentId');
  if (activeRows.some((row) => (row.parentId ?? '') === (candidate.parentId ?? '')
    && normalizedName(row.name) === normalizedName(candidate.name))) {
    fail('同一父级下已经存在同名物品分类', 'name');
  }
  if (current && !allowReferencedChanges && await fixedCategoryReferenceCount(driver, current.id) > 0
    && (current.parentId ?? '') !== (candidate.parentId ?? '')) {
    fail('已被引用的物品分类不能移动层级，请使用合并迁移', 'parentId');
  }
}

async function fixedLeafCategory(
  driver: SqlDriver,
  id: string,
  field: string,
  allowInactiveReferences = false,
): Promise<FixedAssetCategory> {
  const category = await getEntity<FixedAssetCategory>(driver, TABLES.fixedAssetCategories, id);
  if (!isAllowedReference(category, allowInactiveReferences)) fail('物品二级分类不存在或已归档', field);
  if (!category.parentId) fail('物品必须选择二级分类', field);
  const parent = await getEntity<FixedAssetCategory>(driver, TABLES.fixedAssetCategories, category.parentId);
  if (!isAllowedReference(parent, allowInactiveReferences) || parent.parentId) fail('物品二级分类的一级分类无效', field);
  const categories = await listEntities<FixedAssetCategory>(driver, TABLES.fixedAssetCategories);
  if (categories.some((row) => isActive(row) && row.parentId === category.id)) {
    fail('物品必须选择分类树的叶子节点', field);
  }
  return category;
}

async function validateAssetWrite(
  driver: SqlDriver,
  candidate: Asset,
  current?: Asset,
  allowReferencedChanges = false,
): Promise<void> {
  const refs = current && !allowReferencedChanges ? await assetReferenceCount(driver, current.id) : 0;
  throwIssues(validateAssetMutationSnapshot(candidate, current, refs));
  const assets = await listEntities<Asset>(driver, TABLES.assets);
  if (assets.some((row) => row.id !== candidate.id && isActive(row)
    && normalizedName(row.code) === normalizedName(candidate.code))) {
    fail('已经存在相同代码的资产', 'code');
  }
}

async function validateAccountWrite(
  driver: SqlDriver,
  candidate: Account,
  current?: Account,
  allowReferencedChanges = false,
): Promise<void> {
  requireText(candidate.name, '账户名称', 'name');
  if (candidate.purpose && !['funds', 'default_expense', 'default_income'].includes(candidate.purpose)) fail('账户用途无效', 'purpose');
  if (current && current.purpose !== candidate.purpose) fail('账户用途不能直接修改', 'purpose');
  if (isDefaultAccount(candidate)) {
    const duplicates = await listEntities<Account>(driver, TABLES.accounts);
    if (duplicates.some((a) => a.id !== candidate.id && !a.isDeleted && a.purpose === candidate.purpose)) fail('默认收支账户已经存在', 'purpose');
    if (candidate.openingBalance !== undefined || candidate.balanceStartAt) fail('默认收支账户不填写资金余额', 'openingBalance');
    if (candidate.isActive === false) fail('默认收支账户需要保留以承接记账', 'isActive');
  }
  if ([candidate.openingBalance, candidate.openingAssetId, candidate.balanceStartAt, candidate.balanceStartDate].some((v) => v !== undefined)) {
    if (candidate.openingBalance === undefined || !candidate.openingAssetId || !candidate.balanceStartAt || !candidate.balanceStartDate) fail('请完整填写余额、币种及余额起点', 'openingBalance');
    const asset = await activeAsset(driver, candidate.openingAssetId, 'openingAssetId');
    decimal(candidate.openingBalance, '起始余额', 'openingBalance');
    if (decimalPlaces(candidate.openingBalance) > asset.decimals) fail('起始余额超过币种精度', 'openingBalance');
    if (!Number.isFinite(Date.parse(candidate.balanceStartAt)) || new Date(candidate.balanceStartAt).toISOString() !== candidate.balanceStartAt || !isValidDay(candidate.balanceStartDate)) fail('余额起点无效', 'balanceStartAt');
  }
  if (candidate.balanceCheckpoints) {
    if (!Array.isArray(candidate.balanceCheckpoints)) fail('余额核对参照无效', 'balanceCheckpoints');
    for (const point of candidate.balanceCheckpoints) {
      if (!point || !Number.isFinite(Date.parse(point.at)) || !isValidDay(point.date)) fail('余额核对参照时间无效', 'balanceCheckpoints');
      await activeAsset(driver, point.assetId, 'balanceCheckpoints', true);
      decimal(point.balance, '参照余额', 'balanceCheckpoints');
    }
  }
  if (current && !allowReferencedChanges && await accountReferenceCount(driver, current.id) > 0) {
    for (const key of ['openingBalance', 'openingAssetId', 'balanceStartAt', 'balanceStartDate'] as const) {
      if (candidate[key] !== current[key]) fail('已有流水的余额起点请通过核对流程调整', key);
    }
  }
  if (!ACCOUNT_KINDS.has(candidate.kind)) fail('账户类型无效', 'kind');
  if (current && !allowReferencedChanges && await accountReferenceCount(driver, current.id) > 0 && current.kind !== candidate.kind) {
    fail('已被引用的账户不能修改类型，请新建账户后迁移', 'kind');
  }
  const validMonthDay = (value: number | undefined) =>
    value === undefined || (Number.isInteger(value) && value >= 1 && value <= 31);
  if (!validMonthDay(candidate.statementDay)) fail('账单日必须是 1-31', 'statementDay');
  if (!validMonthDay(candidate.paymentDueDay)) fail('还款日必须是 1-31', 'paymentDueDay');
  if (candidate.kind === 'credit_card') {
    if (candidate.statementDay === undefined) fail('信用卡必须填写账单日', 'statementDay');
    if (candidate.paymentDueDay === undefined) fail('信用卡必须填写还款日', 'paymentDueDay');
    if (candidate.creditLimit !== undefined && !decimal(candidate.creditLimit, '信用额度', 'creditLimit').gt(0)) {
      fail('信用额度必须大于 0', 'creditLimit');
    }
  } else if (candidate.statementDay !== undefined || candidate.paymentDueDay !== undefined || candidate.creditLimit !== undefined) {
    fail('只有信用卡账户可以填写账单日、还款日和信用额度', 'kind');
  }
  if (candidate.kind === 'loan') {
    if (candidate.loanPrincipal !== undefined && !decimal(candidate.loanPrincipal, '贷款本金', 'loanPrincipal').gt(0)) {
      fail('贷款本金必须大于 0', 'loanPrincipal');
    }
    if (candidate.annualInterestRate !== undefined) {
      const rate = decimal(candidate.annualInterestRate, '年利率', 'annualInterestRate');
      if (rate.lt(0) || rate.gt(100)) fail('年利率必须在 0-100 之间', 'annualInterestRate');
    }
    if (candidate.loanStartDate && !isValidDay(candidate.loanStartDate)) fail('贷款开始日期无效', 'loanStartDate');
    if (candidate.loanEndDate && !isValidDay(candidate.loanEndDate)) fail('贷款结束日期无效', 'loanEndDate');
    if (candidate.loanStartDate && candidate.loanEndDate && candidate.loanEndDate < candidate.loanStartDate) {
      fail('贷款结束日期不能早于开始日期', 'loanEndDate');
    }
  } else if (
    candidate.loanPrincipal !== undefined
    || candidate.annualInterestRate !== undefined
    || candidate.loanStartDate !== undefined
    || candidate.loanEndDate !== undefined
  ) {
    fail('只有贷款账户可以填写贷款条款', 'kind');
  }
}

async function validatePayeeWrite(
  driver: SqlDriver,
  candidate: Payee,
  allowInactiveReferences = false,
): Promise<void> {
  requireText(candidate.name, '商户名称', 'name');
  if (!isValidEntityIcon(candidate.icon)) fail('图标格式无效或图片过大', 'icon');
  if (candidate.defaultCategory) {
    const category = await getEntity<Category>(driver, TABLES.categories, candidate.defaultCategory);
    if (!isAllowedReference(category, allowInactiveReferences) || !category.parentId) {
      fail('商户默认分类必须是启用的二级分类', 'defaultCategory');
    }
  }
  if (candidate.defaultAccountId) {
    await activeAccount(driver, candidate.defaultAccountId, 'defaultAccountId', allowInactiveReferences);
  }
}

async function validateTransactionWrite(
  driver: SqlDriver,
  transaction: Transaction,
  allowReferencedChanges = false,
  allowInactiveReferences = false,
): Promise<void> {
  try {
    assertTransactionShape(transaction);
    if (transaction.costQuote) {
      assertCostQuoteSnapshot(transaction.costQuote);
      if (transaction.costQuote.dependencyFingerprint !== transactionCostFingerprint(transaction, transaction.costQuote.baseCurrencyAssetId)) {
        fail('数量、币种或时间已变化，请重新确认折算价值，或清除后以未知成本保存', 'costQuote');
      }
      if (transaction.costQuote.quoteDate && transaction.costQuote.quoteDate > transaction.date) fail('不能采用交易日期之后的行情', 'costQuote');
      await activeAsset(driver, transaction.costQuote.baseCurrencyAssetId, 'costQuote.baseCurrencyAssetId', allowInactiveReferences);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : '流水结构无效');
  }
  const amount = decimal(transaction.amount, '金额', 'amount');
  if (!amount.gt(0)) fail('金额必须大于 0', 'amount');
  const asset = await activeAsset(driver, transaction.assetId, 'assetId', allowInactiveReferences);
  if (decimalPlaces(transaction.amount) > asset.decimals) fail(`金额最多支持 ${asset.decimals} 位小数`, 'amount');
  const setting = await driver.get<{ ledger_mode?: string }>('SELECT ledger_mode FROM settings WHERE is_deleted = 0 ORDER BY rowid LIMIT 1');
  const accountRequired = (setting?.ledger_mode ?? 'spending') !== 'spending';

  for (const id of [transaction.accountId, transaction.transferAccountId].filter(Boolean) as string[]) {
    const account = await getEntity<Account>(driver, TABLES.accounts, id);
    if (!account) continue;
    if (transaction.balanceTiming && transaction.balanceTimingAccountId === account.id) {
      const derivedTiming = accountBalanceTiming(account, { ...transaction, balanceTiming: undefined, balanceTimingAccountId: undefined });
      if (derivedTiming !== 'unknown' && derivedTiming !== transaction.balanceTiming) fail('起点先后选择与交易日期时间不一致，请重新确认', 'balanceTiming');
    }
    if (isDefaultAccount(account)) {
      if (transaction.type === 'transfer' || transaction.type === 'adjustment') fail('转账和对账需要选择银行卡或钱包', 'accountId');
      if ((transaction.type === 'income') !== (account.purpose === 'default_income')) fail('请选择与收支方向相符的默认账户', 'accountId');
    } else if ((!account.openingAssetId || account.openingAssetId === (id === transaction.transferAccountId ? transaction.transferAssetId ?? transaction.assetId : transaction.assetId)) && accountBalanceTiming(account, transaction) === 'unknown') {
      fail('请确认这笔收支发生在余额起点之前还是之后', 'balanceTiming');
    }
  }
  if (transaction.balanceTiming && (!['before', 'after'].includes(transaction.balanceTiming) || transaction.balanceTimingAccountId !== transaction.accountId)) fail('余额起点归属选择无效', 'balanceTiming');
  if (transaction.type === 'transfer') {
    if (!transaction.accountId || !transaction.transferAccountId) fail('转账必须填写转出和转入账户', 'accountId');
    await activeAccount(driver, transaction.accountId, 'accountId', allowInactiveReferences);
    await activeAccount(driver, transaction.transferAccountId, 'transferAccountId', allowInactiveReferences);
    if (transaction.accountId === transaction.transferAccountId) fail('转出和转入账户不能相同', 'transferAccountId');
    const target = await activeAsset(driver, transaction.transferAssetId ?? '', 'transferAssetId', allowInactiveReferences);
    const transferAmount = decimal(transaction.transferAmount, '转入金额', 'transferAmount');
    if (!transferAmount.gt(0)) fail('转入金额必须大于 0', 'transferAmount');
    if (decimalPlaces(transaction.transferAmount) > target.decimals) {
      fail(`转入金额最多支持 ${target.decimals} 位小数`, 'transferAmount');
    }
  } else if (transaction.accountId) {
    await activeAccount(driver, transaction.accountId, 'accountId', allowInactiveReferences);
  } else if (accountRequired || transaction.type === 'adjustment') {
    fail('当前账本模式必须选择账户', 'accountId');
  }

  if (transaction.type === 'income' || transaction.type === 'expense') {
    await leafCategory(driver, transaction.category, transaction.type, 'category', allowInactiveReferences);
  } else if (transaction.type === 'refund') {
    await leafCategory(driver, transaction.category, 'expense', 'category', allowInactiveReferences);
    const original = transaction.refundForId
      ? await getEntity<Transaction>(driver, TABLES.transactions, transaction.refundForId)
      : undefined;
    if (!original || original.isDeleted || original.recordState === 'voided' || original.type !== 'expense') {
      fail('退款只能关联有效的原支出', 'refundForId');
    }
    if (transaction.refundAppliedAssetId !== original.assetId) fail('退款冻结币种必须与原支出一致', 'refundAppliedAssetId');
    if (transaction.category !== original.category) fail('退款分类必须继承原支出分类', 'category');
    if (transaction.originalDateSnapshot !== original.date || transaction.originalAmountSnapshot !== original.amount) {
      fail('退款缺少有效的原支出日期或金额快照', 'originalDateSnapshot');
    }
    const refunds = await listEntities<Transaction>(driver, TABLES.transactions);
    const alreadyApplied = refunds
      .filter((row) => row.id !== transaction.id
        && !row.isDeleted
        && row.recordState !== 'voided'
        && row.type === 'refund'
        && row.refundForId === original.id)
      .reduce((total, row) => total.plus(row.refundAppliedAmount ?? row.amount), D(0));
    if (alreadyApplied.plus(transaction.refundAppliedAmount ?? transaction.amount).gt(original.amount)) {
      fail(`退款冲减超过原支出，最多还可冲减 ${D(original.amount).minus(alreadyApplied).toString()}`, 'refundAppliedAmount');
    }
  } else if (transaction.type === 'adjustment') {
    if (!transaction.reconciliationSessionId || !transaction.adjustmentDirection) {
      fail('余额调整必须关联对账批次和调整方向');
    }
  }

  if (transaction.type === 'expense') {
    const refunds = await listEntities<Transaction>(driver, TABLES.transactions);
    const linkedRefunds = refunds.filter((row) => !row.isDeleted
      && row.recordState !== 'voided'
      && row.type === 'refund'
      && row.refundForId === transaction.id);
    const applied = linkedRefunds
      .reduce((total, row) => total.plus(row.refundAppliedAmount ?? row.amount), D(0));
    if (applied.gt(transaction.amount)) fail(`支出金额不能低于已退款金额 ${applied.toString()}`, 'amount');
    if (!allowReferencedChanges && linkedRefunds.some((refund) => refund.refundAppliedAssetId !== transaction.assetId)) {
      fail('已有退款的支出不能修改币种，请先作废关联退款', 'assetId');
    }
  }

  if (transaction.payeeId) {
    const payee = await getEntity<Payee>(driver, TABLES.payees, transaction.payeeId);
    if (!isAllowedReference(payee, allowInactiveReferences)) fail('商户不存在或已归档', 'payeeId');
  }
  if (transaction.locationId) {
    const location = await driver.get<{ is_deleted: number; is_active: number }>(
      'SELECT is_deleted, is_active FROM transaction_locations WHERE id = ?',
      [transaction.locationId],
    );
    if (!location || location.is_deleted || (!allowInactiveReferences && !location.is_active)) {
      fail('地点不存在或已停用', 'locationId');
    }
  }
  for (const tagId of transaction.tagIds ?? []) {
    const tag = await driver.get<{ is_deleted: number; is_active: number }>(
      'SELECT is_deleted, is_active FROM transaction_tags WHERE id = ?',
      [tagId],
    );
    if (!tag || tag.is_deleted || (!allowInactiveReferences && !tag.is_active)) {
      fail(`标签不存在或已停用：${tagId}`, 'tagIds');
    }
  }
}

async function validateBudgetWrite(
  driver: SqlDriver,
  budget: BudgetCategory,
  allowInactiveReferences = false,
): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(budget.month)) fail('预算月份必须使用 YYYY-MM', 'month');
  await leafCategory(driver, budget.category, 'expense', 'category', allowInactiveReferences);
  const asset = await activeAsset(driver, budget.assetId, 'assetId', allowInactiveReferences);
  const amount = decimal(budget.plannedAmount, '预算金额', 'plannedAmount');
  if (amount.lt(0)) fail('预算金额不能小于 0', 'plannedAmount');
  if (decimalPlaces(budget.plannedAmount) > asset.decimals) fail('预算金额超过币种精度', 'plannedAmount');
}

async function validateScheduledWrite(
  driver: SqlDriver,
  row: ScheduledTransaction,
  allowInactiveReferences = false,
): Promise<void> {
  requireText(row.name, '定期交易名称', 'name');
  if (!SCHEDULE_FREQUENCIES.has(row.frequency)) fail('定期交易频率无效', 'frequency');
  if (!SCHEDULE_STATUSES.has(row.status)) fail('定期交易状态无效', 'status');
  if (!SCHEDULE_ANCHORS.has(row.anchorMode)) fail('定期交易月末规则无效', 'anchorMode');
  if (!SCHEDULE_CATCH_UP.has(row.catchUpPolicy)) fail('定期交易补齐策略无效', 'catchUpPolicy');
  normalizeOccurrence({ date: row.anchorDate, time: row.time, timezone: row.timezone, timePrecision: row.time ? 'minute' : 'day' });
  const asset = await activeAsset(driver, row.assetId, 'assetId', allowInactiveReferences);
  if (!decimal(row.amount, '定期金额', 'amount').gt(0)) fail('定期金额必须大于 0', 'amount');
  if (decimalPlaces(row.amount) > asset.decimals) fail('定期金额超过币种精度', 'amount');
  if (row.type === 'transfer') {
    if (!row.accountId || !row.transferAccountId) fail('定期转账必须填写双方账户', 'accountId');
    await activeAccount(driver, row.accountId, 'accountId', allowInactiveReferences);
    await activeAccount(driver, row.transferAccountId, 'transferAccountId', allowInactiveReferences);
    if (row.accountId === row.transferAccountId) fail('转出和转入账户不能相同', 'transferAccountId');
    await activeAsset(driver, row.transferAssetId ?? '', 'transferAssetId', allowInactiveReferences);
  } else if (row.type === 'income' || row.type === 'expense') {
    await leafCategory(driver, row.category, row.type, 'category', allowInactiveReferences);
    if (row.accountId) await activeAccount(driver, row.accountId, 'accountId', allowInactiveReferences);
  } else {
    fail('定期交易只支持收入、支出或转账', 'type');
  }
  if (row.payeeId) {
    const payee = await getEntity<Payee>(driver, TABLES.payees, row.payeeId);
    if (!isAllowedReference(payee, allowInactiveReferences)) fail('定期交易商户不存在或已归档', 'payeeId');
  }
}

async function validateReferenceEntity(
  driver: SqlDriver,
  entityType: string,
  row: Record<string, unknown>,
  allowInactiveReferences = false,
): Promise<void> {
  const ref = async (spec: TableSpec, id: unknown, field: string, label: string) => {
    if (typeof id !== 'string' || !id) fail(`${label}不能为空`, field);
    const target = await getEntity<BaseEntity>(driver, spec, id);
    if (!target || target.isDeleted) fail(`${label}不存在`, field);
  };
  switch (entityType) {
    case 'cost_basis_opening': {
      const opening = row as unknown as import('@zichan/core').CostBasisOpening;
      assertCostBasisOpening(opening);
      await activeAsset(driver, opening.baseCurrencyAssetId, 'baseCurrencyAssetId', allowInactiveReferences);
      for (const item of opening.items) {
        const asset = await activeAsset(driver, item.assetId, 'items.assetId', true);
        if (asset.type === 'game' || asset.type === 'fixed') fail('游戏和物品资产不使用金融成本起点', 'items.assetId');
      }
      break;
    }
    case 'conversion_operation':
      if (!Array.isArray(row['chainIds']) || row['chainIds'].length === 0 || new Set(row['chainIds']).size !== row['chainIds'].length
        || row['chainIds'].some((id) => typeof id !== 'string' || !id)) fail('连续转换需要不重复的有序子记录', 'chainIds');
      if (row['recordState'] !== undefined && row['recordState'] !== 'active' && row['recordState'] !== 'voided') fail('连续转换状态无效', 'recordState');
      break;
    case 'setting':
      for (const [field, forbidden] of [['expenseDefaultAccountId', 'default_income'], ['incomeDefaultAccountId', 'default_expense']] as const) {
        if (!row[field]) continue;
        const account = await getEntity<Account>(driver, TABLES.accounts, String(row[field]));
        if (!account || account.isDeleted || (!allowInactiveReferences && account.isActive === false) || account.kind === 'other' || account.purpose === forbidden) fail('请选择对应方向的默认账户或资金账户', field);
      }
      await activeAsset(driver, String(row['baseCurrencyAssetId'] ?? ''), 'baseCurrencyAssetId', allowInactiveReferences);
      for (const field of ['transactionDefaultAssetId', 'investmentCostAssetId', 'fixedAssetDefaultCurrencyAssetId', 'gameDefaultSettlementAssetId']) {
        if (row[field]) await activeAsset(driver, String(row[field]), field, allowInactiveReferences);
      }
      if (row['ledgerKind'] !== undefined && row['ledgerKind'] !== 'personal' && row['ledgerKind'] !== 'demo') {
        fail('账本类型无效', 'ledgerKind');
      }
      if (row['initializedAt'] !== undefined
        && (typeof row['initializedAt'] !== 'string' || Number.isNaN(Date.parse(row['initializedAt'])))) {
        fail('账本初始化时间无效', 'initializedAt');
      }
      break;
    case 'price_mark':
      await activeAsset(driver, String(row['assetId'] ?? ''), 'assetId', allowInactiveReferences);
      await activeAsset(driver, String(row['quoteAssetId'] ?? ''), 'quoteAssetId', allowInactiveReferences);
      if (!decimal(row['price'], '价格', 'price').gt(0)) fail('价格必须大于 0', 'price');
      break;
    case 'lot': {
      const asset = await activeAsset(driver, String(row['assetId'] ?? ''), 'assetId', allowInactiveReferences);
      await activeAsset(driver, String(row['baseCurrencyAssetId'] ?? ''), 'baseCurrencyAssetId', allowInactiveReferences);
      if (row['nativeCostAssetId']) {
        await activeAsset(driver, String(row['nativeCostAssetId']), 'nativeCostAssetId', allowInactiveReferences);
      }
      if (row['sourceChainId']) await ref(TABLES.conversionChains, row['sourceChainId'], 'sourceChainId', '来源转换');
      if (row['sourceDcaExecutionId']) await ref(TABLES.dcaExecutions, row['sourceDcaExecutionId'], 'sourceDcaExecutionId', '定投执行');
      const original = decimal(row['originalAmount'], '批次数量', 'originalAmount');
      const remaining = decimal(row['remainingAmount'], '剩余数量', 'remainingAmount');
      if (!original.gt(0) || remaining.lt(0) || remaining.gt(original)) fail('批次数量或剩余数量无效', 'remainingAmount');
      if (decimalPlaces(row['originalAmount']) > asset.decimals || decimalPlaces(row['remainingAmount']) > asset.decimals) {
        fail('批次数量超过资产精度', 'remainingAmount');
      }
      if (decimal(row['baseCost'], '批次成本', 'baseCost').lt(0)) fail('批次成本不能小于 0', 'baseCost');
      if (!LOT_STATUSES.has(String(row['status']))) fail('批次状态无效', 'status');
      break;
    }
    case 'lot_consumption': {
      await ref(TABLES.lots, row['lotId'], 'lotId', '持仓批次');
      await ref(TABLES.conversionChains, row['sellChainId'], 'sellChainId', '卖出转换');
      if (!decimal(row['consumedAmount'], '消耗数量', 'consumedAmount').gt(0)) fail('消耗数量必须大于 0', 'consumedAmount');
      const cost = decimal(row['allocatedCostBase'], '分配成本', 'allocatedCostBase');
      const proceeds = decimal(row['proceedsBase'], '分配收入', 'proceedsBase');
      if (cost.lt(0) || proceeds.lt(0)) fail('分配成本和收入不能小于 0');
      if (!proceeds.minus(cost).eq(String(row['realizedPnlBase'] ?? ''))) {
        fail('已实现盈亏必须等于收入减成本', 'realizedPnlBase');
      }
      break;
    }
    case 'dca_plan':
      try {
        assertDcaPlanShape(row as unknown as Parameters<typeof assertDcaPlanShape>[0]);
      } catch (error) {
        fail(error instanceof Error ? error.message : '定投计划无效');
      }
      await activeAsset(driver, String(row['targetAssetId'] ?? ''), 'targetAssetId', allowInactiveReferences);
      await activeAsset(driver, String(row['baseCurrencyAssetId'] ?? ''), 'baseCurrencyAssetId', allowInactiveReferences);
      break;
    case 'dca_execution':
      try {
        assertDcaExecutionShape(row as unknown as Parameters<typeof assertDcaExecutionShape>[0]);
      } catch (error) {
        fail(error instanceof Error ? error.message : '定投执行无效');
      }
      await ref(TABLES.dcaPlans, row['planId'], 'planId', '定投计划');
      break;
    case 'scheduled_execution':
      try {
        assertScheduledExecutionShape(row as unknown as Parameters<typeof assertScheduledExecutionShape>[0]);
      } catch (error) {
        fail(error instanceof Error ? error.message : '定期执行无效');
      }
      await ref(TABLES.scheduledTransactions, row['scheduleId'], 'scheduleId', '定期交易');
      break;
    case 'fixed_asset':
      await fixedLeafCategory(driver, String(row['categoryId'] ?? ''), 'categoryId', allowInactiveReferences);
      await activeAsset(driver, String(row['baseCurrencyAssetId'] ?? ''), 'baseCurrencyAssetId', allowInactiveReferences);
      requireText(row['name'], '物品名称', 'name');
      if (!FIXED_ASSET_STATUSES.has(String(row['status']))) fail('物品状态无效', 'status');
      normalizeOccurrence({ date: String(row['purchaseDate'] ?? ''), timePrecision: 'day' });
      break;
    case 'fixed_asset_event':
      await ref(TABLES.fixedAssets, row['fixedAssetId'], 'fixedAssetId', '物品资产');
      if (!FIXED_EVENT_TYPES.has(String(row['type']))) fail('物品事件类型无效', 'type');
      normalizeOccurrence({ date: String(row['date'] ?? ''), timePrecision: 'day' });
      if (decimal(row['amountBase'], '事件金额', 'amountBase').lt(0)) fail('事件金额不能小于 0', 'amountBase');
      break;
    case 'fixed_asset_usage_metric':
      await ref(TABLES.fixedAssets, row['fixedAssetId'], 'fixedAssetId', '物品资产');
      requireText(row['name'], '使用指标名称', 'name');
      decimal(row['startValue'], '起始用量', 'startValue');
      break;
    case 'fixed_asset_usage_log': {
      await ref(TABLES.fixedAssets, row['fixedAssetId'], 'fixedAssetId', '物品资产');
      await ref(TABLES.fixedAssetUsageMetrics, row['metricId'], 'metricId', '使用指标');
      const metric = await getEntity<Record<string, unknown> & BaseEntity>(
        driver,
        TABLES.fixedAssetUsageMetrics,
        String(row['metricId']),
      );
      if (metric?.['fixedAssetId'] !== row['fixedAssetId']) fail('使用指标不属于当前物品', 'metricId');
      normalizeOccurrence({ date: String(row['date'] ?? ''), timePrecision: 'day' });
      decimal(row['value'], '用量', 'value');
      break;
    }
    case 'fixed_asset_consumable':
    case 'fixed_asset_goal': {
      await ref(TABLES.fixedAssets, row['fixedAssetId'], 'fixedAssetId', '物品资产');
      const metricId = row[entityType === 'fixed_asset_consumable' ? 'usageMetricId' : 'metricId'];
      if (metricId) {
        await ref(TABLES.fixedAssetUsageMetrics, metricId, 'metricId', '使用指标');
        const metric = await getEntity<Record<string, unknown> & BaseEntity>(
          driver,
          TABLES.fixedAssetUsageMetrics,
          String(metricId),
        );
        if (metric?.['fixedAssetId'] !== row['fixedAssetId']) fail('使用指标不属于当前物品', 'metricId');
      }
      break;
    }
    case 'game_account':
      await ref(TABLES.games, row['gameId'], 'gameId', '游戏');
      requireText(row['accountName'], '游戏账号名称', 'accountName');
      if (!GAME_ACCOUNT_STATUSES.has(String(row['status']))) fail('游戏账号状态无效', 'status');
      break;
    case 'game_season':
      await ref(TABLES.games, row['gameId'], 'gameId', '游戏');
      requireText(row['name'], '赛季名称', 'name');
      if (!GAME_SEASON_STATUSES.has(String(row['status']))) fail('赛季状态无效', 'status');
      break;
    case 'game_record': {
      await ref(TABLES.games, row['gameId'], 'gameId', '游戏');
      if (!GAME_RECORD_TYPES.has(String(row['recordType']))) fail('游戏记录类型无效', 'recordType');
      normalizeOccurrence({ date: String(row['date'] ?? ''), timePrecision: 'day' });
      if (row['seasonId']) {
        await ref(TABLES.gameSeasons, row['seasonId'], 'seasonId', '赛季');
        const season = await getEntity<Record<string, unknown> & BaseEntity>(driver, TABLES.gameSeasons, String(row['seasonId']));
        if (season?.['gameId'] !== row['gameId']) fail('赛季不属于所选游戏', 'seasonId');
      }
      if (row['gameAccountId']) {
        await ref(TABLES.gameAccounts, row['gameAccountId'], 'gameAccountId', '游戏账号');
        const account = await getEntity<Record<string, unknown> & BaseEntity>(driver, TABLES.gameAccounts, String(row['gameAccountId']));
        if (account?.['gameId'] !== row['gameId']) fail('游戏账号不属于所选游戏', 'gameAccountId');
      }
      if (row['settlementAssetId']) {
        await activeAsset(driver, String(row['settlementAssetId']), 'settlementAssetId', allowInactiveReferences);
      }
      if (row['feeAssetId']) {
        await activeAsset(driver, String(row['feeAssetId']), 'feeAssetId', allowInactiveReferences);
      }
      if (row['settlementAmount'] && !decimal(row['settlementAmount'], '结算金额', 'settlementAmount').gt(0)) {
        fail('结算金额必须大于 0', 'settlementAmount');
      }
      if (row['feeAmount'] && !decimal(row['feeAmount'], '手续费', 'feeAmount').gt(0)) fail('手续费必须大于 0', 'feeAmount');
      break;
    }
    case 'game_cashflow_link':
      await ref(TABLES.gameRecords, row['gameRecordId'], 'gameRecordId', '游戏记录');
      await ref(TABLES.transactions, row['transactionId'], 'transactionId', '资金流水');
      await activeAsset(driver, String(row['sourceAssetId'] ?? ''), 'sourceAssetId', allowInactiveReferences);
      if (row['accountId']) await activeAccount(driver, String(row['accountId']), 'accountId', allowInactiveReferences);
      if (!['settlement', 'fee'].includes(String(row['role']))) fail('游戏资金角色无效', 'role');
      if (!['inflow', 'outflow'].includes(String(row['direction']))) fail('游戏资金方向无效', 'direction');
      if (!['linked', 'created'].includes(String(row['ownership']))) fail('游戏资金归属无效', 'ownership');
      if (!decimal(row['sourceAmount'], '游戏资金金额', 'sourceAmount').gt(0)) fail('游戏资金金额必须大于 0', 'sourceAmount');
      break;
    case 'fixed_asset_cashflow_link': {
      await ref(TABLES.fixedAssets, row['fixedAssetId'], 'fixedAssetId', '物品资产');
      const sourceType = String(row['sourceType']);
      if (sourceType !== 'event' && sourceType !== 'consumable') fail('物品资金来源类型无效', 'sourceType');
      await ref(sourceType === 'event' ? TABLES.fixedAssetEvents : TABLES.fixedAssetConsumables, row['sourceId'], 'sourceId', '物品资金来源');
      await ref(TABLES.transactions, row['transactionId'], 'transactionId', '资金流水');
      await activeAsset(driver, String(row['sourceAssetId'] ?? ''), 'sourceAssetId', allowInactiveReferences);
      await activeAsset(driver, String(row['baseAssetId'] ?? ''), 'baseAssetId', allowInactiveReferences);
      if (!decimal(row['sourceAmount'], '来源金额', 'sourceAmount').gt(0)
        || !decimal(row['amountBase'], '记账金额', 'amountBase').gt(0)) {
        fail('物品资金金额必须大于 0');
      }
      if (row['fxRateSnapshot'] && !decimal(row['fxRateSnapshot'], '冻结汇率', 'fxRateSnapshot').gt(0)) {
        fail('冻结汇率必须大于 0', 'fxRateSnapshot');
      }
      break;
    }
    case 'transaction_template': {
      const type = String(row['type']);
      if (type === 'income' || type === 'expense') {
        await leafCategory(driver, String(row['category'] ?? ''), type, 'category', allowInactiveReferences);
      }
      else if (type !== 'transfer') fail('交易模板类型无效', 'type');
      if (row['assetId']) await activeAsset(driver, String(row['assetId']), 'assetId', allowInactiveReferences);
      if (row['accountId']) await activeAccount(driver, String(row['accountId']), 'accountId', allowInactiveReferences);
      if (row['payeeId']) await ref(TABLES.payees, row['payeeId'], 'payeeId', '商户');
      if (row['locationId']) await ref(TABLES.transactionLocations, row['locationId'], 'locationId', '地点');
      for (const tagId of Array.isArray(row['tagIds']) ? row['tagIds'] : []) {
        await ref(TABLES.transactionTags, tagId, 'tagIds', '标签');
      }
      break;
    }
    case 'transaction_split': {
      const transaction = await getEntity<Transaction>(driver, TABLES.transactions, String(row['transactionId'] ?? ''));
      if (!transaction || transaction.isDeleted) fail('拆分引用的流水不存在', 'transactionId');
      if (transaction.type !== 'income' && transaction.type !== 'expense') fail('只有收入或支出可以拆分', 'transactionId');
      await leafCategory(driver, String(row['category'] ?? ''), transaction.type, 'category', allowInactiveReferences);
      if (!decimal(row['amount'], '拆分金额', 'amount').gt(0)) fail('拆分金额必须大于 0', 'amount');
      break;
    }
    case 'attachment': {
      const targets: Record<string, TableSpec> = {
        transaction: TABLES.transactions,
        conversion_chain: TABLES.conversionChains,
        game_record: TABLES.gameRecords,
        fixed_asset: TABLES.fixedAssets,
        fixed_asset_event: TABLES.fixedAssetEvents,
        fixed_asset_consumable: TABLES.fixedAssetConsumables,
        game: TABLES.games,
        game_account: TABLES.gameAccounts,
        fixed_asset_usage_log: TABLES.fixedAssetUsageLogs,
        price_mark: TABLES.priceMarks,
        asset: TABLES.assets,
        account: TABLES.accounts,
      };
      const target = targets[String(row['entityType'] ?? '')];
      if (!target) fail('附件关联类型无效', 'entityType');
      await ref(target, row['entityId'], 'entityId', '附件关联对象');
      if (!/^[0-9a-f]{64}$/i.test(String(row['sha256'] ?? ''))) fail('附件 SHA-256 无效', 'sha256');
      break;
    }
  }
}

export async function validateEntityWrite<T extends BaseEntity>(
  driver: SqlDriver,
  entityType: string,
  candidate: T,
  current?: T,
  options: { allowReferencedChanges?: boolean; allowInactiveReferences?: boolean } = {},
): Promise<void> {
  if (!candidate.id) fail('实体 ID 不能为空', 'id');
  if (candidate.isDeleted && current && !current.isDeleted) {
    if (!options.allowReferencedChanges) await validateEntityDelete(driver, entityType, current);
    return;
  }
  if (!options.allowReferencedChanges && !candidate.isDeleted) {
    const identityTable = entityType === 'game_account' ? TABLES.gameAccounts : entityType === 'game_season' ? TABLES.gameSeasons
      : entityType === 'transaction_tag' ? TABLES.transactionTags : entityType === 'payee' ? TABLES.payees : undefined;
    if (identityTable) {
      const matches = duplicateMasterData(entityType, candidate as BaseEntity & Record<string, unknown>,
        await listEntities<BaseEntity & Record<string, unknown>>(driver, identityTable), current as (BaseEntity & Record<string, unknown>) | undefined);
      if (matches.length) throw new DuplicateMasterDataError(entityType, matches);
    }
  }
  switch (entityType) {
    case 'category':
      await validateCategoryWrite(
        driver,
        candidate as unknown as Category,
        current as unknown as Category | undefined,
        options.allowReferencedChanges,
        options.allowInactiveReferences,
      );
      return;
    case 'fixed_asset_category':
      await validateFixedCategoryWrite(
        driver,
        candidate as unknown as FixedAssetCategory,
        current as unknown as FixedAssetCategory | undefined,
        options.allowReferencedChanges,
        options.allowInactiveReferences,
      );
      return;
    case 'asset':
      await validateAssetWrite(
        driver,
        candidate as unknown as Asset,
        current as unknown as Asset | undefined,
        options.allowReferencedChanges,
      );
      return;
    case 'account':
      await validateAccountWrite(
        driver,
        candidate as unknown as Account,
        current as unknown as Account | undefined,
        options.allowReferencedChanges,
      );
      return;
    case 'payee':
      await validatePayeeWrite(driver, candidate as unknown as Payee, options.allowInactiveReferences);
      return;
    case 'transaction':
      await validateTransactionWrite(
        driver,
        candidate as unknown as Transaction,
        options.allowReferencedChanges,
        options.allowInactiveReferences,
      );
      return;
    case 'budget_category':
      await validateBudgetWrite(driver, candidate as unknown as BudgetCategory, options.allowInactiveReferences);
      return;
    case 'scheduled_transaction':
      await validateScheduledWrite(driver, candidate as unknown as ScheduledTransaction, options.allowInactiveReferences);
      return;
    case 'transaction_tag':
    case 'transaction_location':
    case 'transaction_saved_view':
    case 'game':
      requireText((candidate as unknown as Record<string, unknown>)['name'], '名称', 'name');
      return;
    default:
      await validateReferenceEntity(
        driver,
        entityType,
        candidate as unknown as Record<string, unknown>,
        options.allowInactiveReferences,
      );
  }
}

export async function validateEntityDelete<T extends BaseEntity>(
  driver: SqlDriver,
  entityType: string,
  current: T,
): Promise<void> {
  if (entityType === 'account' && isDefaultAccount(current as unknown as Account)) fail('默认收支账户需要保留，不能删除');
  const references = await entityReferenceCount(driver, entityType, current.id);
  if (references > 0) {
    fail(`该${entityDeleteLabel(entityType)}仍有 ${references} 项引用，请使用归档、合并或迁移`);
  }
}

function activeReplacement<T extends BaseEntity>(rows: T[], candidate: T): T[] {
  const next = rows.filter((row) => row.id !== candidate.id);
  if (!candidate.isDeleted) next.push(candidate);
  return next;
}

async function transactionAggregateFromDriver(
  driver: SqlDriver,
  transactionId: string,
  mutation?: { entityType: string; candidate: BaseEntity },
): Promise<TransactionAggregateSnapshot | undefined> {
  let transaction = await getEntity<Transaction>(driver, TABLES.transactions, transactionId);
  let splits = (await listEntities<TransactionSplit>(driver, TABLES.transactionSplits))
    .filter((row) => row.transactionId === transactionId);
  let allocations = (await listEntities<RefundAllocation>(driver, TABLES.refundAllocations))
    .filter((row) => row.refundTransactionId === transactionId);
  if (mutation?.entityType === 'transaction') transaction = mutation.candidate as Transaction;
  if (mutation?.entityType === 'transaction_split') {
    splits = activeReplacement(splits, mutation.candidate as TransactionSplit);
  }
  if (mutation?.entityType === 'refund_allocation') {
    allocations = activeReplacement(allocations, mutation.candidate as RefundAllocation);
  }
  if (!transaction || transaction.isDeleted) {
    if (splits.some((row) => !row.isDeleted) || allocations.some((row) => !row.isDeleted)) {
      fail('删除流水前必须在同一聚合命令中删除拆分和退款分配');
    }
    return undefined;
  }
  return { transaction, splits, refundAllocations: allocations };
}

async function reconciliationAggregateFromDriver(
  driver: SqlDriver,
  reconciliationId: string,
  mutation?: { entityType: string; candidate: BaseEntity },
): Promise<{ session: ReconciliationSession; items: ReconciliationItem[] } | undefined> {
  let session = await getEntity<ReconciliationSession>(driver, TABLES.reconciliationSessions, reconciliationId);
  let items = (await listEntities<ReconciliationItem>(driver, TABLES.reconciliationItems))
    .filter((row) => row.reconciliationId === reconciliationId);
  if (mutation?.entityType === 'reconciliation_session') session = mutation.candidate as ReconciliationSession;
  if (mutation?.entityType === 'reconciliation_item') {
    items = activeReplacement(items, mutation.candidate as ReconciliationItem);
  }
  if (!session || session.isDeleted) {
    if (items.some((row) => !row.isDeleted)) fail('删除对账批次前必须在同一聚合命令中删除对账项目');
    return undefined;
  }
  return { session, items };
}

export function aggregateValidationKeys(
  entityType: string,
  candidate: BaseEntity & Record<string, unknown>,
  current?: BaseEntity & Record<string, unknown>,
): string[] {
  if (entityType === 'transaction') return [`transaction:${candidate.id}`];
  if (entityType === 'transaction_split') {
    return [...new Set([candidate['transactionId'], current?.['transactionId']]
      .filter((id): id is string => typeof id === 'string' && Boolean(id))
      .map((id) => `transaction:${id}`))];
  }
  if (entityType === 'refund_allocation') {
    return [...new Set([candidate['refundTransactionId'], current?.['refundTransactionId']]
      .filter((id): id is string => typeof id === 'string' && Boolean(id))
      .map((id) => `transaction:${id}`))];
  }
  if (entityType === 'reconciliation_session') return [`reconciliation:${candidate.id}`];
  if (entityType === 'reconciliation_item') {
    return [...new Set([candidate['reconciliationId'], current?.['reconciliationId']]
      .filter((id): id is string => typeof id === 'string' && Boolean(id))
      .map((id) => `reconciliation:${id}`))];
  }
  return [];
}

export async function validateAggregateMutation(
  driver: SqlDriver,
  entityType: string,
  candidate: BaseEntity & Record<string, unknown>,
  current?: BaseEntity & Record<string, unknown>,
  options: { allowInactiveReferences?: boolean } = {},
): Promise<void> {
  const mutation = { entityType, candidate };
  for (const key of aggregateValidationKeys(entityType, candidate, current)) {
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (kind === 'transaction') {
      const snapshot = await transactionAggregateFromDriver(driver, id, mutation);
      if (snapshot) await validateTransactionAggregateSnapshot(driver, snapshot, options);
    } else if (kind === 'reconciliation') {
      const snapshot = await reconciliationAggregateFromDriver(driver, id, mutation);
      if (snapshot) await validateReconciliationAggregateSnapshot(driver, snapshot.session, snapshot.items, options);
    }
  }
}

export interface TransactionAggregateSnapshot {
  transaction: Transaction;
  splits: TransactionSplit[];
  refundAllocations: RefundAllocation[];
}

export async function validateTransactionAggregateSnapshot(
  driver: SqlDriver,
  snapshot: TransactionAggregateSnapshot,
  options: { allowInactiveReferences?: boolean } = {},
): Promise<void> {
  await validateTransactionWrite(driver, snapshot.transaction, false, options.allowInactiveReferences);
  const activeSplits = snapshot.splits.filter((row) => !row.isDeleted);
  const activeAllocations = snapshot.refundAllocations.filter((row) => !row.isDeleted);
  if (snapshot.transaction.type === 'transfer' || snapshot.transaction.type === 'adjustment' || snapshot.transaction.type === 'refund') {
    if (activeSplits.length) fail('转账、调整和退款不能保存普通拆分', 'splits');
  } else if (activeSplits.length) {
    const ids = new Set<string>();
    let total = D(0);
    let remainders = 0;
    for (const split of activeSplits) {
      if (split.transactionId !== snapshot.transaction.id) fail('拆分不属于当前流水', 'splits');
      if (ids.has(split.id)) fail('拆分项目 ID 重复', 'splits');
      ids.add(split.id);
      await leafCategory(driver, split.category, snapshot.transaction.type, 'splits', options.allowInactiveReferences);
      const value = decimal(split.amount, '拆分金额', 'splits');
      if (!value.gt(0)) fail('拆分金额必须大于 0', 'splits');
      total = total.plus(value);
      if (split.isRemainder) remainders += 1;
    }
    if (!total.eq(snapshot.transaction.amount)) fail('拆分金额合计必须精确等于流水金额', 'splits');
    if (remainders > 1) fail('同一流水最多只能有一个未拆分余项', 'splits');
  }

  if (snapshot.transaction.type !== 'refund') {
    if (activeAllocations.length) fail('非退款流水不能保存退款冻结分配', 'refundAllocations');
    return;
  }
  const original = await getEntity<Transaction>(driver, TABLES.transactions, snapshot.transaction.refundForId ?? '');
  if (!original || original.isDeleted || original.type !== 'expense') fail('退款原支出不存在', 'refundForId');
  const sourceSplits = await listEntities<TransactionSplit>(driver, TABLES.transactionSplits);
  const sourceSplitById = new Map(sourceSplits.filter((row) => !row.isDeleted && row.transactionId === original.id).map((row) => [row.id, row]));
  let total = D(0);
  const ids = new Set<string>();
  for (const allocation of activeAllocations) {
    if (allocation.refundTransactionId !== snapshot.transaction.id || allocation.sourceTransactionId !== original.id) {
      fail('退款分配与退款流水或原支出不一致', 'refundAllocations');
    }
    if (ids.has(allocation.id)) fail('退款分配 ID 重复', 'refundAllocations');
    ids.add(allocation.id);
    if (allocation.sourceSplitId && !sourceSplitById.has(allocation.sourceSplitId)) {
      fail('退款分配引用的拆分不属于原支出', 'refundAllocations');
    }
    if (allocation.assetId !== original.assetId) fail('退款分配冻结币种与原支出不一致', 'refundAllocations');
    if (!allocation.categoryPathSnapshot.trim()) fail('退款分配缺少冻结分类路径', 'refundAllocations');
    const category = await getEntity<Category>(driver, TABLES.categories, allocation.categoryId);
    if (!category || category.isDeleted) fail('退款分配引用的冻结分类不存在', 'refundAllocations');
    const value = decimal(allocation.amount, '退款分配金额', 'refundAllocations');
    if (!value.gt(0)) fail('退款分配金额必须大于 0', 'refundAllocations');
    total = total.plus(value);
  }
  if (!total.eq(snapshot.transaction.refundAppliedAmount ?? snapshot.transaction.amount)) {
    fail('退款分配合计必须等于退款冲减金额', 'refundAllocations');
  }
}

export async function validateConversionAggregateSnapshot(
  driver: SqlDriver,
  chain: ConversionChain,
  steps: ConversionStep[],
  options: { allowInactiveReferences?: boolean } = {},
): Promise<ConversionChain> {
  const normalized = normalizeDomainEntity('conversion_chain', chain);
  const previous = await getEntity<ConversionChain>(driver, TABLES.conversionChains, chain.id);
  const oldSteps = previous ? await driver.all<Record<string, unknown>>('SELECT * FROM conversion_steps WHERE chain_id = ?', [chain.id]) : [];
  try {
    assertConversionShape(normalized, steps);
  } catch (error) {
    fail(error instanceof Error ? error.message : '资产转换链路无效', 'steps');
  }
  await activeAsset(driver, normalized.baseCurrencyAssetId, 'baseCurrencyAssetId', options.allowInactiveReferences || previous?.baseCurrencyAssetId === normalized.baseCurrencyAssetId);
  const referencedIds = new Set(steps.flatMap((s) => [s.accountFromId, s.accountToId, ...(s.fees ?? []).map((f) => f.accountId)]).filter(Boolean));
  for (const id of referencedIds) {
    const account = await getEntity<Account>(driver, TABLES.accounts, id!);
    if (account && isDefaultAccount(account)) fail('资产转换请选择资金账户，默认收支账户不能用于转账', 'steps');
    if (account && steps.some((s) => (s.accountFromId === id && s.fromAssetId === account.openingAssetId) || (s.accountToId === id && s.toAssetId === account.openingAssetId) || (s.fees ?? []).some((f) => f.accountId === id && f.assetId === account.openingAssetId)) && accountBalanceTiming(account, normalized) === 'unknown') fail('请补充准确的转换时间，以确认与账户余额起点的先后顺序', 'time');
  }
  const orderedSteps = [...steps].sort((left, right) => left.order - right.order);
  for (const [index, step] of orderedSteps.entries()) {
    const old = oldSteps.find((row) => row['id'] === step.id);
    const from = await activeAsset(driver, step.fromAssetId, `steps.${index}.fromAssetId`, options.allowInactiveReferences || old?.['from_asset_id'] === step.fromAssetId);
    const to = await activeAsset(driver, step.toAssetId, `steps.${index}.toAssetId`, options.allowInactiveReferences || old?.['to_asset_id'] === step.toAssetId);
    if (decimalPlaces(step.fromAmount) > from.decimals || decimalPlaces(step.toAmount) > to.decimals) {
      fail(`步骤 ${index + 1} 的金额精度超过资产限制`, 'steps');
    }
    if (step.accountFromId) {
      await activeAccount(driver, step.accountFromId, `steps.${index}.accountFromId`, options.allowInactiveReferences || old?.['account_from_id'] === step.accountFromId);
    }
    if (step.accountToId) {
      await activeAccount(driver, step.accountToId, `steps.${index}.accountToId`, options.allowInactiveReferences || old?.['account_to_id'] === step.accountToId);
    }
    for (const fee of step.fees ?? []) {
      const oldFees = JSON.parse(String(old?.['fees_json'] ?? '[]')) as NonNullable<ConversionStep['fees']>;
      const oldFee = oldFees.find((row) => row.id === fee.id);
      const asset = await activeAsset(driver, fee.assetId, `steps.${index}.fees`, options.allowInactiveReferences || oldFee?.assetId === fee.assetId);
      if (!decimal(fee.amount, '手续费', `steps.${index}.fees`).gt(0) || decimalPlaces(fee.amount) > asset.decimals) {
        fail(`步骤 ${index + 1} 手续费金额无效`, `steps.${index}.fees`);
      }
      if (fee.accountId) {
        await activeAccount(driver, fee.accountId, `steps.${index}.fees.accountId`, options.allowInactiveReferences || oldFee?.accountId === fee.accountId);
      }
    }
  }
  return normalized;
}

export async function validateReconciliationAggregateSnapshot(
  driver: SqlDriver,
  session: ReconciliationSession,
  items: ReconciliationItem[],
  options: { allowInactiveReferences?: boolean } = {},
): Promise<void> {
  const account = await activeAccount(driver, session.accountId, 'accountId', options.allowInactiveReferences);
  if (isDefaultAccount(account)) fail('默认收支账户不参与资金对账', 'accountId');
  const asset = await activeAsset(driver, session.assetId, 'assetId', options.allowInactiveReferences);
  normalizeOccurrence({ date: session.statementDate, timePrecision: 'day' });
  for (const field of ['statementBalance', 'openingBalance', 'selectedTotal', 'clearedBalance', 'difference'] as const) {
    decimal(session[field], '对账金额', field);
    if (decimalPlaces(session[field]) > asset.decimals) fail('对账金额超过币种精度', field);
  }
  if (session.conversionTotal !== undefined) {
    decimal(session.conversionTotal, '资产转换对账金额', 'conversionTotal');
    if (decimalPlaces(session.conversionTotal) > asset.decimals) fail('资产转换对账金额超过币种精度', 'conversionTotal');
  }
  if (session.status !== 'open' && session.status !== 'closed') fail('对账状态无效', 'status');
  if (session.status === 'closed' && !session.closedAt) fail('已关闭对账缺少关闭时间', 'closedAt');
  const seen = new Set<string>();
  let selectedTotal = D(0);
  let hasAdjustment = false;
  const activeItems = items.filter((row) => !row.isDeleted);
  for (const item of activeItems) {
    if (item.reconciliationId !== session.id || item.accountId !== session.accountId || item.assetId !== session.assetId) {
      fail('对账项目与对账批次的账户或币种不一致', 'items');
    }
    if (seen.has(item.transactionId)) fail('同一流水不能重复加入对账', 'items');
    seen.add(item.transactionId);
    if (item.previousStatus !== 'pending' && item.previousStatus !== 'cleared') {
      fail('对账项目的原流水状态无效', 'items');
    }
    const itemAmount = decimal(item.postingAmount, '对账项目金额', 'items');
    if (decimalPlaces(item.postingAmount) > asset.decimals) fail('对账项目金额超过币种精度', 'items');
    const transaction = await getEntity<Transaction>(driver, TABLES.transactions, item.transactionId);
    if (!transaction || transaction.isDeleted || transaction.recordState === 'voided') fail('对账项目引用的流水不存在或已作废', 'items');
    if (transaction.date > session.statementDate) fail('对账项目日期晚于账单截止日', 'items');
    const actualPosting = accountTransactionPostings(transaction, [account])
      .filter((posting) => posting.accountId === session.accountId && posting.assetId === session.assetId)
      .reduce((total, posting) => total.plus(posting.amount), D(0));
    if (!itemAmount.eq(actualPosting)) fail('对账项目金额与流水实际过账金额不一致', 'items');
    if (item.transactionId === session.adjustmentTransactionId) {
      hasAdjustment = true;
      if (transaction.type !== 'adjustment' || transaction.reconciliationSessionId !== session.id) {
        fail('对账调整流水与对账批次不一致', 'adjustmentTransactionId');
      }
    }
    selectedTotal = selectedTotal.plus(itemAmount);
  }
  if (session.adjustmentTransactionId && !hasAdjustment) fail('对账批次缺少对应的调整项目', 'adjustmentTransactionId');
  selectedTotal = selectedTotal.plus(session.conversionTotal ?? 0);
  if (!selectedTotal.eq(session.selectedTotal)) fail('已选流水合计（含资产转换）与对账项目不一致', 'selectedTotal');
  const expectedCleared = D(session.openingBalance).plus(selectedTotal);
  if (!expectedCleared.eq(session.clearedBalance)) fail('清算余额必须等于期初余额加已选流水合计', 'clearedBalance');
  const expectedDifference = D(session.statementBalance).minus(expectedCleared);
  if (!expectedDifference.eq(session.difference)) fail('对账差额必须等于账单余额减清算余额', 'difference');
  if (session.status === 'closed' && !expectedDifference.isZero()) fail('差额不为零时不能关闭对账', 'difference');
}

/** Validate one reconciliation from the database's current (final) state. */
export async function validateStoredReconciliationAggregate(
  driver: SqlDriver,
  reconciliationId: string,
  options: { allowInactiveReferences?: boolean } = {},
): Promise<void> {
  const snapshot = await reconciliationAggregateFromDriver(driver, reconciliationId);
  if (snapshot) {
    await validateReconciliationAggregateSnapshot(driver, snapshot.session, snapshot.items, options);
  }
}

export function syncAggregateApplyPriority(type: string, op: 'put' | 'delete'): number {
  const order: Record<string, number> = {
    asset: 10,
    account: 11,
    category: 12,
    fixed_asset_category: 12,
    transaction_tag: 13,
    transaction_location: 13,
    payee: 14,
    game: 14,
    cost_basis_opening: 15,
    transaction: 20,
    conversion: 20,
    conversion_operation: 20,
    fixed_asset: 20,
    game_account: 21,
    game_season: 21,
    reconciliation: 22,
    price_mark: 25,
    dca_plan: 25,
    transaction_template: 25,
    budget_category: 25,
    scheduled_transaction: 25,
    attachment: 40,
  };
  const priority = order[type] ?? 30;
  return op === 'delete' ? 100 - priority : priority;
}
