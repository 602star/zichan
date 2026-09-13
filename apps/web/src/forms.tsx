/**
 * Entity form specs — field definitions + value⇄entity mappers for the generic
 * EntityFormModal. Select options that depend on existing data take the snapshot.
 */
import {
  D, isValidDay, newId,
  type Asset, type Account, type Attachment, type BudgetCategory, type Category, type DcaPlan,
  type PriceMark, type Game, type GameAccount, type GameSeason, type GameRecord, type GameCashflowMode, type GameCashflowRole, type FixedAsset,
  type FixedAssetCashflowMode, type FixedAssetCategory, type FixedAssetConsumable, type FixedAssetEvent, type FixedAssetGoal,
  type FixedAssetUsageLog, type FixedAssetUsageMetric, type Payee, type ScheduledTransaction,
  type Transaction, type TransactionLocation, type TransactionSplit, type TransactionTag, type TransactionTemplate,
} from '@zichan/core';
import type { Snapshot } from './db/snapshot.js';
import type { EntityFormSpec, FieldDef } from './ui/EntityFormModal.js';
import { categoryLabel, categoryOptions } from './transactionMeta.js';
import { moduleCurrencyId } from './currencyPreferences.js';
import type { AttachmentDraftData } from './db/attachment-storage.js';

/** trim to undefined for optional string fields */
const S = (v?: string) => (v && v.trim() !== '' ? v.trim() : undefined);

interface BaseFields {
  id: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  isDeleted: boolean;
  archivedAt?: string;
  archiveReason?: string;
  mergedIntoId?: string;
}
function base(existing?: unknown): BaseFields {
  const e = existing as BaseFields | undefined;
  return e
    ? {
      id: e.id,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      version: e.version,
      isDeleted: e.isDeleted,
      archivedAt: e.archivedAt,
      archiveReason: e.archiveReason,
      mergedIntoId: e.mergedIntoId,
    }
    : { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

// option helpers
const assetOpts = (s: Snapshot) => s.assets.filter((a) => !a.isDeleted).map((a) => ({ value: a.id, label: a.code }));
const accountOpts = (s: Snapshot) => s.accounts.filter((a) => !a.isDeleted && a.isActive !== false).map((a) => ({ value: a.id, label: a.name }));
const payeeOpts = (s: Snapshot) => s.payees.filter((p) => !p.isDeleted && p.isActive).map((p) => ({ value: p.id, label: p.name }));
const tagOpts = (s: Snapshot) => s.transactionTags.filter((t) => !t.isDeleted && t.isActive).map((t) => ({ value: t.id, label: t.groupName ? `${t.groupName} / ${t.name}` : t.name }));
const locationOpts = (s: Snapshot) => s.transactionLocations.filter((l) => !l.isDeleted && l.isActive).map((l) => ({ value: l.id, label: l.address ? `${l.name} · ${l.address}` : l.name }));
const categoryPickerPreference = (s: Snapshot) => ({ categoryShowHiddenDefault: s.setting?.categoryPickerDefaultScope === 'all' });
/** Asset options with the settlement currency first, so new forms default to it. */
const settlementOpts = (s: Snapshot, preferredId = s.setting?.baseCurrencyAssetId) => {
  const baseId = preferredId;
  const all = s.assets.filter((a) => !a.isDeleted);
  return [...all]
    .sort((a, b) => (b.id === baseId ? 1 : 0) - (a.id === baseId ? 1 : 0))
    .map((a) => ({ value: a.id, label: a.code }));
};
const gameOpts = (s: Snapshot) => s.games.filter((g) => !g.isDeleted && g.isActive !== false && !g.mergedIntoId).map((g) => ({ value: g.id, label: g.name }));
const seasonOpts = (s: Snapshot, gameId?: string) => s.seasons.filter((x) => !x.isDeleted && !x.archivedAt && !x.mergedIntoId && (!gameId || x.gameId === gameId)).map((x) => ({ value: x.id, label: x.name }));
const gameAccountOpts = (s: Snapshot, gameId?: string) => s.gameAccounts.filter((a) => !a.isDeleted && !a.archivedAt && !a.mergedIntoId && a.status === 'active' && (!gameId || a.gameId === gameId)).map((a) => ({ value: a.id, label: a.accountName }));
const fixedCategoryOpts = (s: Snapshot, parentsOnly = false) => {
  const active = s.fixedAssetCategories.filter((category) => !category.isDeleted && category.isActive);
  const parentById = new Map(active.filter((category) => !category.parentId).map((category) => [category.id, category]));
  return active
    .filter((category) => parentsOnly ? !category.parentId : !!category.parentId)
    .map((category) => ({
      value: category.id,
      label: category.parentId ? `${parentById.get(category.parentId)?.name ?? '父级缺失'} / ${category.name}` : category.name,
      hidden: category.isHidden,
    }));
};

const ASSET_TYPES = [
  { value: 'fiat', label: '法币' }, { value: 'stablecoin', label: '稳定币' },
  { value: 'crypto', label: '加密货币' }, { value: 'stock', label: '股票' },
  { value: 'fund', label: '基金 / ETF' }, { value: 'bond', label: '债券 / 固收' },
  { value: 'precious_metal', label: '贵金属' }, { value: 'game', label: '游戏货币' },
  { value: 'fixed', label: '物品资产' },
];
const ACCOUNT_KINDS = [
  { value: 'bank', label: '银行' }, { value: 'cash', label: '现金' }, { value: 'exchange', label: '交易所' },
  { value: 'wallet', label: '钱包' }, { value: 'credit_card', label: '信用卡' }, { value: 'loan', label: '贷款' },
  { value: 'game_platform', label: '游戏平台' }, { value: 'other', label: '其他' },
];
const REC_TYPES = [
  { value: 'buy_currency', label: '买入游戏币' }, { value: 'sell_currency', label: '游戏币卖出' },
  { value: 'produce', label: '游戏产出' }, { value: 'consume', label: '游戏消耗' },
  { value: 'sell_equipment', label: '装备卖出' }, { value: 'sell_material', label: '材料卖出' },
  { value: 'topup', label: '充值' }, { value: 'withdraw', label: '提现' }, { value: 'fee', label: '手续费' },
  { value: 'account_cost', label: '账号成本' }, { value: 'boosting_cost', label: '代练成本' },
  { value: 'other_expense', label: '其他支出' }, { value: 'other_income', label: '其他收入' },
];
const FIXED_STATUS = [
  { value: 'active', label: '使用中' }, { value: 'stored', label: '闲置/库存' },
  { value: 'sold', label: '已售出' }, { value: 'scrapped', label: '已报废' },
  { value: 'retired', label: '已清退' }, { value: 'gifted', label: '已赠出' },
];
const FIXED_EVENTS = [
  { value: 'purchase', label: '购买' }, { value: 'activate', label: '启用' },
  { value: 'repair', label: '维修' }, { value: 'upgrade', label: '升级' },
  { value: 'residual_update', label: '更新现状残值' }, { value: 'warranty_expire', label: '保修到期' },
  { value: 'sale', label: '卖出' }, { value: 'scrap', label: '报废' },
  { value: 'retire', label: '清退' }, { value: 'gift', label: '赠出' },
];
const FIXED_USAGE_UNITS = [
  { value: 'count', label: '次数' }, { value: 'km', label: '公里' },
  { value: 'hour', label: '实际使用小时' }, { value: 'custom', label: '自定义单位' },
];
const FIXED_ENTRY_MODES = [{ value: 'increment', label: '每次增加量' }, { value: 'meter', label: '当前累计读数' }];
const GACC_STATUS = [{ value: 'active', label: '正常' }, { value: 'inactive', label: '停用' }, { value: 'sold', label: '出售' }, { value: 'banned', label: '封禁' }];
const SEASON_STATUS = [{ value: 'upcoming', label: '未开始' }, { value: 'active', label: '进行中' }, { value: 'ended', label: '已结束' }];
const CATEGORY_TYPES = [{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }];
const TX_TYPES_STANDARD = [{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }, { value: 'transfer', label: '转账' }];
const TX_TYPES = [...TX_TYPES_STANDARD, { value: 'refund', label: '退款' }];
const TX_TYPES_BASIC = TX_TYPES.filter((t) => t.value !== 'transfer');
const TX_STATUS = [{ value: 'cleared', label: '已清算' }, { value: 'pending', label: '待确认' }];
const SCHEDULE_FREQ = [
  { value: 'daily', label: '每日' }, { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' }, { value: 'yearly', label: '每年' },
];
const SCHEDULE_STATUS = [{ value: 'active', label: '启用' }, { value: 'paused', label: '暂停' }];
const DCA_FREQ = [
  { value: 'daily', label: '每日' }, { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' }, { value: 'manual', label: '手动' },
];
const DCA_STATUS = [{ value: 'active', label: '启用' }, { value: 'paused', label: '暂停' }, { value: 'ended', label: '结束' }];

interface LedgerFormOptions {
  usesAccounts?: boolean;
  refundMode?: boolean;
  expenseOnly?: boolean;
}

function defaultSettlementAssetId(snap: Snapshot): string {
  return moduleCurrencyId(snap.setting, 'transaction', settlementOpts(snap)[0]?.value ?? '');
}
function currentTime(): string {
  return new Date().toTimeString().slice(0, 5);
}
function currentDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
function splitList(v?: string): string[] {
  return (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
export interface AttachmentDraft extends AttachmentDraftData {}
export type TransactionFormValue = Transaction & {
  attachmentDrafts?: AttachmentDraft[];
  refundAllocationDrafts?: { sourceSplitId?: string; amount: string }[];
};
export type GameRecordFormValue = GameRecord & {
  settlementCashflowMode?: GameCashflowMode;
  settlementTransactionId?: string;
  settlementCategoryId?: string;
  settlementAccountId?: string;
  settlementMerchant?: string;
  feeCashflowMode?: GameCashflowMode;
  feeTransactionId?: string;
  feeCategoryId?: string;
  feeAccountId?: string;
  feeMerchant?: string;
};
export type FixedAssetFormValue = FixedAsset & {
  purchaseAmount?: string;
  cashflowMode?: FixedAssetCashflowMode;
  cashflowTransactionId?: string;
  cashflowSourceAmount?: string;
  cashflowCategory?: string;
  cashflowAccountId?: string;
  cashflowPayeeId?: string;
  cashflowMerchant?: string;
  cashflowDescription?: string;
  attachmentDrafts?: Array<AttachmentDraft & { role: Attachment['role'] }>;
};
export interface FixedCashflowFormFields {
  cashflowMode?: FixedAssetCashflowMode;
  cashflowTransactionId?: string;
  cashflowSourceAmount?: string;
  cashflowCategory?: string;
  cashflowAccountId?: string;
  cashflowPayeeId?: string;
  cashflowMerchant?: string;
  cashflowDescription?: string;
  cashflowReportingTreatment?: Transaction['reportingTreatment'];
}
export type FixedAssetEventFormValue = FixedAssetEvent & FixedCashflowFormFields;
export type FixedAssetConsumableFormValue = FixedAssetConsumable & FixedCashflowFormFields;
function parseAttachmentDrafts(v?: string): AttachmentDraft[] {
  try {
    const parsed = JSON.parse(v || '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is AttachmentDraft => !!x && typeof x === 'object' && typeof (x as AttachmentDraft).fileName === 'string')
      : [];
  } catch {
    return [];
  }
}
export function assetForm(): EntityFormSpec<Asset> {
  return {
    title: '资产',
    fields: [
      { key: 'code', label: '代码', type: 'text', half: true, placeholder: 'BTC', required: true },
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'type', label: '类型', type: 'select', half: true, options: ASSET_TYPES, required: true },
      { key: 'decimals', label: '精度（小数位）', type: 'number', half: true, required: true },
      { key: 'symbol', label: '符号', type: 'text', half: true, placeholder: '£' },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true },
      { key: 'note', label: '备注', type: 'text' },
    ],
    toValues: (a) => ({ code: a.code, name: a.name, type: a.type, decimals: String(a.decimals), symbol: a.symbol ?? '', isActive: a.isActive ? 'true' : 'false', note: a.note ?? '' }),
    fromValues: (v, e) => ({ ...base(e), code: v.code, name: v.name, type: v.type as Asset['type'], decimals: Number(v.decimals) || 0, symbol: S(v.symbol), isActive: v.isActive === 'true', note: S(v.note) }) as Asset,
  };
}

export function accountForm(): EntityFormSpec<Account> {
  return {
    title: '账户',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'kind', label: '类型', type: 'select', half: true, options: ACCOUNT_KINDS, required: true },
      { key: 'platform', label: '平台', type: 'text', half: true },
      { key: 'statementDay', label: '账单日（1-31）', type: 'number', half: true, visibleWhen: (v) => v.kind === 'credit_card', required: true },
      { key: 'paymentDueDay', label: '还款日（1-31）', type: 'number', half: true, visibleWhen: (v) => v.kind === 'credit_card', required: true },
      { key: 'creditLimit', label: '信用额度', type: 'number', half: true, visibleWhen: (v) => v.kind === 'credit_card' },
      { key: 'loanPrincipal', label: '贷款本金', type: 'number', half: true, visibleWhen: (v) => v.kind === 'loan' },
      { key: 'annualInterestRate', label: '年利率（%）', type: 'number', half: true, visibleWhen: (v) => v.kind === 'loan' },
      { key: 'loanStartDate', label: '开始日期', type: 'date', half: true, visibleWhen: (v) => v.kind === 'loan' },
      { key: 'loanEndDate', label: '结束日期', type: 'date', half: true, visibleWhen: (v) => v.kind === 'loan' },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (a) => ({
      name: a.name,
      kind: a.kind,
      platform: a.platform ?? '',
      statementDay: a.statementDay === undefined ? '' : String(a.statementDay),
      paymentDueDay: a.paymentDueDay === undefined ? '' : String(a.paymentDueDay),
      creditLimit: a.creditLimit ?? '',
      loanPrincipal: a.loanPrincipal ?? '',
      annualInterestRate: a.annualInterestRate ?? '',
      loanStartDate: a.loanStartDate ?? '',
      loanEndDate: a.loanEndDate ?? '',
      isActive: a.isActive === false ? 'false' : 'true',
      note: a.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e),
      name: v.name,
      kind: v.kind as Account['kind'],
      platform: S(v.platform),
      statementDay: v.kind === 'credit_card' && S(v.statementDay) ? Number(v.statementDay) : undefined,
      paymentDueDay: v.kind === 'credit_card' && S(v.paymentDueDay) ? Number(v.paymentDueDay) : undefined,
      creditLimit: v.kind === 'credit_card' ? S(v.creditLimit) : undefined,
      loanPrincipal: v.kind === 'loan' ? S(v.loanPrincipal) : undefined,
      annualInterestRate: v.kind === 'loan' ? S(v.annualInterestRate) : undefined,
      loanStartDate: v.kind === 'loan' ? S(v.loanStartDate) : undefined,
      loanEndDate: v.kind === 'loan' ? S(v.loanEndDate) : undefined,
      isActive: v.isActive !== 'false',
      note: S(v.note),
    }) as Account,
  };
}

export function priceMarkForm(snap: Snapshot): EntityFormSpec<PriceMark> {
  const opts = assetOpts(snap);
  const asOf = currentDate();
  return {
    title: '价格',
    fields: [
      { key: 'assetId', label: '资产', type: 'select', half: true, options: opts, required: true },
      { key: 'quoteAssetId', label: '计价币种', type: 'select', half: true, options: settlementOpts(snap), required: true },
      { key: 'price', label: '价格', type: 'number', half: true, required: true },
      { key: 'date', label: '日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (m) => ({ assetId: m.assetId, quoteAssetId: m.quoteAssetId, price: m.price, date: m.date, note: m.note ?? '' }),
    fromValues: (v, e) => ({ ...base(e), assetId: v.assetId, quoteAssetId: v.quoteAssetId, price: v.price || '0', date: v.date, source: 'manual', note: S(v.note) }) as PriceMark,
    validate: (v) => D(v.price || '0').gt(0) ? undefined : { price: '价格必须大于 0' },
  };
}

export function dcaPlanForm(snap: Snapshot): EntityFormSpec<DcaPlan> {
  const asOf = currentDate();
  return {
    title: '定投计划',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'targetAssetId', label: '目标资产', type: 'select', half: true, options: assetOpts(snap), required: true },
      { key: 'baseCurrencyAssetId', label: '投入币种', type: 'select', half: true, options: settlementOpts(snap, moduleCurrencyId(snap.setting, 'investment')), required: true },
      { key: 'plannedAmount', label: '计划金额', type: 'number', half: true, required: true },
      { key: 'frequency', label: '频率', type: 'select', half: true, options: DCA_FREQ },
      { key: 'status', label: '状态', type: 'select', half: true, options: DCA_STATUS },
      { key: 'anchorDate', label: '计划起始日', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'anchorMode', label: '月度锚点', type: 'select', half: true, defaultValue: 'calendar_day', options: [
        { value: 'calendar_day', label: '固定日期（短月取月末）' },
        { value: 'month_end', label: '每月最后一天' },
      ] },
      { key: 'timezone', label: '计划时区', type: 'text', half: true, defaultValue: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', required: true },
      { key: 'reminderDaysBefore', label: '提前提醒（天）', type: 'number', half: true, defaultValue: '3' },
      { key: 'defaultPath', label: '默认路径', type: 'text', half: true, placeholder: 'GBP → USDT → BTC' },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (p) => ({
      name: p.name, targetAssetId: p.targetAssetId, baseCurrencyAssetId: p.baseCurrencyAssetId,
      plannedAmount: p.plannedAmount, frequency: p.frequency, status: p.status,
      anchorDate: p.anchorDate, anchorMode: p.anchorMode, timezone: p.timezone,
      reminderDaysBefore: p.reminderDaysBefore == null ? '3' : String(p.reminderDaysBefore),
      defaultPath: p.defaultPath ?? '', note: p.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e), name: v.name, targetAssetId: v.targetAssetId, baseCurrencyAssetId: v.baseCurrencyAssetId,
      plannedAmount: v.plannedAmount || '0', frequency: v.frequency as DcaPlan['frequency'],
      status: v.status as DcaPlan['status'], anchorDate: v.anchorDate,
      anchorMode: v.anchorMode as DcaPlan['anchorMode'], timezone: v.timezone,
      reminderDaysBefore: Number(v.reminderDaysBefore || 0), defaultPath: S(v.defaultPath), note: S(v.note),
    }) as DcaPlan,
    validate: (v) => {
      const errors: Record<string, string> = {};
      if (!D(v.plannedAmount || '0').gt(0)) errors.plannedAmount = '计划金额必须大于 0';
      if (!isValidDay(v.anchorDate || '')) errors.anchorDate = '计划起始日无效';
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: v.timezone || '' }).format(new Date());
      } catch {
        errors.timezone = '请输入有效的 IANA 时区，例如 Asia/Shanghai';
      }
      return Object.keys(errors).length > 0 ? errors : undefined;
    },
  };
}

export function categoryForm(snap?: Snapshot): EntityFormSpec<Category> {
  const parentOptions = snap ? categoryOptions(snap.categories, undefined, { parentsOnly: true }) : [];
  return {
    title: '收支分类',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'type', label: '类型', type: 'select', half: true, options: CATEGORY_TYPES, required: true },
      { key: 'parentId', label: '父级分类', type: 'select', half: true, options: parentOptions, allowEmpty: true },
      { key: 'color', label: '颜色', type: 'text', half: true, placeholder: '#ef4444' },
      { key: 'sortOrder', label: '排序', type: 'number', half: true, defaultValue: '100' },
      { key: 'budgetable', label: '纳入预算', type: 'checkbox', half: true },
      { key: 'isHidden', label: '在快速选择中隐藏', type: 'checkbox', half: true },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'note', label: '备注', type: 'text' },
    ],
    toValues: (c) => ({
      name: c.name, type: c.type, parentId: c.parentId ?? '', color: c.color ?? '', sortOrder: c.sortOrder == null ? '100' : String(c.sortOrder),
      budgetable: c.budgetable === false ? 'false' : 'true', isHidden: c.isHidden ? 'true' : 'false', isActive: c.isActive ? 'true' : 'false', note: c.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e), name: v.name, type: v.type as Category['type'], parentId: S(v.parentId), color: S(v.color),
      sortOrder: Number(v.sortOrder || 100), budgetable: v.budgetable === 'true',
      isHidden: v.isHidden === 'true', isActive: v.isActive !== 'false', note: S(v.note),
    }) as Category,
    validate: (v, existing) => {
      if (existing && v.parentId === existing.id) return { parentId: '分类不能把自己设为父级' } as Record<string, string>;
      // 防循环:新父级若沿现有父链上溯能回到自身,则会形成 A→B→A 死循环。
      if (snap && existing && v.parentId) {
        const seen = new Set<string>([existing.id]);
        let current = snap.categories.find((c) => c.id === v.parentId);
        while (current?.parentId) {
          if (seen.has(current.parentId)) return { parentId: '父级分类会形成循环引用' } as Record<string, string>;
          seen.add(current.id);
          current = snap.categories.find((c) => c.id === current?.parentId);
        }
      }
      const duplicate = snap?.categories.some((category) => category.id !== existing?.id && !category.isDeleted && category.type === v.type && (category.parentId ?? '') === (v.parentId ?? '') && category.name.trim().toLowerCase() === (v.name ?? '').trim().toLowerCase());
      return duplicate ? { name: '同一父级下已经存在同名分类' } as Record<string, string> : undefined;
    },
  };
}

export function transactionTagForm(): EntityFormSpec<TransactionTag> {
  return {
    title: '标签',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'groupName', label: '分组', type: 'text', half: true, placeholder: '项目 / 人 / 地点 / 报销 / 游戏' },
      { key: 'color', label: '颜色', type: 'text', half: true, placeholder: '#14b8a6' },
      { key: 'sortOrder', label: '排序', type: 'number', half: true, defaultValue: '100' },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'note', label: '备注', type: 'textarea' },
    ],
    toValues: (t) => ({
      name: t.name, groupName: t.groupName ?? '', color: t.color ?? '', sortOrder: t.sortOrder == null ? '100' : String(t.sortOrder),
      isActive: t.isActive ? 'true' : 'false', note: t.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e), name: v.name, groupName: S(v.groupName), color: S(v.color),
      sortOrder: Number(v.sortOrder || 100), isActive: v.isActive !== 'false', note: S(v.note),
    }) as TransactionTag,
  };
}

export function transactionLocationForm(): EntityFormSpec<TransactionLocation> {
  return {
    title: '地点',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'address', label: '地址文本', type: 'text', half: true },
      { key: 'latitude', label: '纬度', type: 'number', half: true },
      { key: 'longitude', label: '经度', type: 'number', half: true },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'note', label: '备注', type: 'textarea' },
    ],
    toValues: (l) => ({
      name: l.name, address: l.address ?? '', latitude: l.latitude ?? '', longitude: l.longitude ?? '',
      isActive: l.isActive ? 'true' : 'false', note: l.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e), name: v.name, address: S(v.address), latitude: S(v.latitude), longitude: S(v.longitude),
      isActive: v.isActive !== 'false', note: S(v.note),
    }) as TransactionLocation,
  };
}

export function transactionTemplateForm(snap: Snapshot, options: LedgerFormOptions = {}): EntityFormSpec<TransactionTemplate> {
  const usesAccounts = options.usesAccounts ?? snap.setting?.ledgerMode !== 'spending';
  const accountFields: FieldDef[] = usesAccounts
    ? [{ key: 'accountId', label: '默认账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: true }]
    : [];
  return {
    title: '交易模板',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, placeholder: '午餐 / 房租 / 工资', required: true },
      { key: 'type', label: '类型', type: 'select', half: true, options: usesAccounts ? TX_TYPES_STANDARD : TX_TYPES_STANDARD.filter((t) => t.value !== 'transfer'), required: true },
      { key: 'category', label: '二级分类', type: 'category', half: true, options: (v) => categoryOptions(snap.categories, v.type === 'income' ? 'income' : 'expense', { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap), required: true },
      { key: 'amount', label: '常用金额', type: 'number', half: true },
      { key: 'assetId', label: '币种', type: 'select', half: true, options: settlementOpts(snap), allowEmpty: true },
      ...accountFields,
      { key: 'payeeId', label: '商户', type: 'select', half: true, options: payeeOpts(snap), allowEmpty: true },
      { key: 'tagIds', label: '标签', type: 'multiselect', options: tagOpts(snap) },
      { key: 'locationId', label: '地点', type: 'select', half: true, options: locationOpts(snap), allowEmpty: true },
      { key: 'merchant', label: '商户文本', type: 'text', half: true },
      { key: 'description', label: '描述', type: 'text', half: true },
      { key: 'sortOrder', label: '排序', type: 'number', half: true, defaultValue: '100' },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'note', label: '备注', type: 'textarea' },
    ],
    toValues: (t) => ({
      name: t.name, type: t.type, category: t.category, amount: t.amount ?? '', assetId: t.assetId ?? '',
      accountId: t.accountId ?? '', payeeId: t.payeeId ?? '', tagIds: t.tagIds?.join(',') ?? '',
      locationId: t.locationId ?? '', merchant: t.merchant ?? '', description: t.description ?? '',
      sortOrder: t.sortOrder == null ? '100' : String(t.sortOrder), isActive: t.isActive ? 'true' : 'false',
      note: t.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e), name: v.name, type: v.type as TransactionTemplate['type'], category: v.category,
      amount: S(v.amount), assetId: S(v.assetId), accountId: usesAccounts ? S(v.accountId) : undefined,
      payeeId: S(v.payeeId), tagIds: splitList(v.tagIds), locationId: S(v.locationId),
      merchant: S(v.merchant), description: S(v.description), sortOrder: Number(v.sortOrder || 100),
      isActive: v.isActive !== 'false', note: S(v.note),
    }) as TransactionTemplate,
  };
}

export function payeeForm(snap: Snapshot, options: LedgerFormOptions = {}): EntityFormSpec<Payee> {
  const usesAccounts = options.usesAccounts ?? snap.setting?.ledgerMode !== 'spending';
  return {
    title: '商户',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'defaultCategory', label: '默认分类', type: 'category', half: true, options: categoryOptions(snap.categories, undefined, { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap), allowEmpty: true },
      ...(usesAccounts ? [{ key: 'defaultAccountId', label: '默认账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: true } satisfies FieldDef] : []),
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'aliases', label: '别名', type: 'text', half: true, placeholder: '逗号分隔' },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (p) => ({
      name: p.name, defaultCategory: p.defaultCategory ?? '', defaultAccountId: p.defaultAccountId ?? '',
      isActive: p.isActive ? 'true' : 'false', aliases: p.aliases?.join(', ') ?? '', note: p.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e), name: v.name, defaultCategory: S(v.defaultCategory), defaultAccountId: usesAccounts ? S(v.defaultAccountId) : undefined,
      isActive: v.isActive !== 'false', aliases: (v.aliases ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      note: S(v.note),
    }) as Payee,
  };
}

export function transactionForm(snap: Snapshot, options: LedgerFormOptions = {}): EntityFormSpec<Transaction> {
  const usesAccounts = options.usesAccounts ?? snap.setting?.ledgerMode !== 'spending';
  const refundMode = options.refundMode ?? false;
  const expenseOnly = options.expenseOnly ?? false;
  const defaultAssetId = defaultSettlementAssetId(snap);
  const accountFields: FieldDef[] = usesAccounts ? [
    { key: 'accountId', label: '账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: true, section: 'more' },
    { key: 'transferAssetId', label: '转入币种', type: 'select', half: true, options: settlementOpts(snap), allowEmpty: true, section: 'more' },
    { key: 'transferAccountId', label: '转入账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: true, section: 'more' },
    { key: 'transferAmount', label: '转入金额', type: 'number', half: true, section: 'more' },
    { key: 'status', label: '状态', type: 'select', half: true, options: TX_STATUS, section: 'more' },
  ] : [];
  const refundableExpenses = snap.transactions.filter((t) => !t.isDeleted && t.recordState !== 'voided' && t.type === 'expense');
  const refundAllocationOptions = (values: Record<string, string>) => {
    const original = snap.transactions.find((transaction) => transaction.id === values.refundForId && transaction.type === 'expense');
    if (!original) return [];
    const splits = snap.transactionSplits.filter((split) => !split.isDeleted && split.transactionId === original.id);
    return splits.length
      ? splits.map((split) => ({ value: split.id, label: `${categoryLabel(split.category, snap.categories)} · 可退基数 ${split.amount}` }))
      : [{ value: '__root__', label: `${categoryLabel(original.category, snap.categories)} · 可退基数 ${original.amount}` }];
  };
  return {
    title: refundMode ? '记录退款' : expenseOnly ? '日常支出' : '日常收支',
    modalWidth: 880,
    fields: [
      { key: 'date', label: '日期', type: 'date', half: true, defaultValue: currentDate(), lockedVisible: true, required: true },
      { key: 'time', label: '交易时间', type: 'time', half: true, defaultValue: currentTime(), lockedVisible: true, required: true },
      {
        key: 'type', label: '类型', type: 'select', half: true,
        options: refundMode ? [{ value: 'refund', label: '退款' }] : expenseOnly ? [{ value: 'expense', label: '支出' }] : usesAccounts ? TX_TYPES : TX_TYPES_BASIC,
        defaultValue: expenseOnly ? 'expense' : undefined,
        hidden: expenseOnly,
        lockedVisible: true,
        required: true,
      },
      { key: 'category', label: '二级分类', type: 'category', options: (v) => categoryOptions(snap.categories, expenseOnly ? 'expense' : v.type === 'income' ? 'income' : 'expense', { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap), lockedVisible: true, required: true },
      { key: 'amount', label: '金额', type: 'number', half: true, lockedVisible: true, required: true },
      { key: 'assetId', label: '币种', type: 'select', half: true, options: settlementOpts(snap), lockedVisible: true, required: true },
      { key: 'description', label: '描述', type: 'text', half: true, placeholder: '午餐 / 工资 / 房租（可留空，列表用分类兜底）', lockedVisible: true },
      { key: 'attachmentDrafts', label: '附件 / 图片', type: 'file', accept: 'image/*,.pdf', multiple: true, capture: 'environment', lockedVisible: true },
      { key: 'timezone', label: '交易时区', type: 'text', half: true, defaultValue: currentTimezone(), section: 'more' },
      ...accountFields,
      { key: 'refundForId', label: '退款关联原支出', type: 'select', options: refundableExpenses.map((t) => ({ value: t.id, label: `${t.date} · ${t.description ?? t.merchant ?? t.category} · ${t.amount} ${snap.assets.find((a) => a.id === t.assetId)?.code ?? ''}` })), allowEmpty: !refundMode, section: refundMode ? undefined : 'more', lockedVisible: refundMode, required: refundMode, hidden: expenseOnly },
      { key: 'refundAppliedAmount', label: '冲减原消费金额', type: 'number', half: true, placeholder: '与到账币种不同时必填', section: refundMode ? undefined : 'more', lockedVisible: refundMode, hidden: expenseOnly },
      { key: 'refundAllocationMode', label: '退款分配方式', type: 'select', half: true, options: [{ value: 'proportional', label: '按原单剩余比例' }, { value: 'specified', label: '指定退款项目' }], defaultValue: 'proportional', section: refundMode ? undefined : 'more', lockedVisible: refundMode, hidden: expenseOnly },
      { key: 'refundAllocationDrafts', label: '指定退款项目金额', type: 'allocation', options: refundAllocationOptions, section: refundMode ? undefined : 'more', lockedVisible: refundMode, hidden: expenseOnly },
      { key: 'payeeId', label: '已有商户', type: 'select', half: true, options: payeeOpts(snap), allowEmpty: true, section: 'more' },
      { key: 'merchant', label: '新商户名称', type: 'text', half: true, placeholder: '没有维护商户时填写', section: 'more' },
      { key: 'locationId', label: '地点', type: 'select', half: true, options: locationOpts(snap), allowEmpty: true, section: 'more' },
      { key: 'locationName', label: '地点文本', type: 'text', half: true, placeholder: '公司附近 / 家 / 某商场', section: 'more', deviceAction: 'current-location' },
      { key: 'latitude', label: '纬度', type: 'text', hidden: true },
      { key: 'longitude', label: '经度', type: 'text', hidden: true },
      { key: 'locationAccuracyMeters', label: '定位精度', type: 'text', hidden: true },
      { key: 'tagIds', label: '标签', type: 'multiselect', options: tagOpts(snap), section: 'more' },
      { key: 'note', label: '备注', type: 'textarea', section: 'more' },
    ],
    toValues: (t) => ({
      date: t.date,
      time: t.time ?? currentTime(),
      timezone: t.timezone ?? currentTimezone(),
      type: t.type,
      category: t.category,
      amount: t.amount,
      assetId: t.assetId || defaultAssetId,
      accountId: t.accountId ?? '',
      transferAssetId: t.transferAssetId ?? '',
      transferAccountId: t.transferAccountId ?? '',
      transferAmount: t.transferAmount ?? '',
      status: t.status ?? 'cleared',
      payeeId: t.payeeId ?? '',
      refundForId: t.refundForId ?? '',
      refundAppliedAmount: t.refundAppliedAmount ?? '',
      refundAllocationMode: t.refundAllocationMode ?? 'proportional',
      refundAllocationDrafts: JSON.stringify(Object.fromEntries(snap.refundAllocations
        .filter((row) => !row.isDeleted && row.refundTransactionId === t.id)
        .map((row) => [row.sourceSplitId ?? '__root__', row.amount]))),
      tagIds: t.tagIds?.join(',') ?? '',
      locationId: t.locationId ?? '',
      locationName: t.locationName ?? '',
      latitude: t.latitude ?? '',
      longitude: t.longitude ?? '',
      locationAccuracyMeters: t.locationAccuracyMeters ?? '',
      description: t.description ?? '',
      merchant: t.merchant ?? '',
      note: t.note ?? '',
      attachmentDrafts: JSON.stringify(snap.attachments
        .filter((a) => !a.isDeleted && a.entityType === 'transaction' && a.entityId === t.id)
        .map((a) => ({
          id: a.id, fileName: a.fileName, mimeType: a.mimeType, note: a.note, sizeBytes: a.sizeBytes,
          sha256: a.sha256, thumbnailSha256: a.thumbnailSha256,
          thumbnailSizeBytes: a.thumbnailSizeBytes, thumbnailMimeType: a.thumbnailMimeType,
        } satisfies AttachmentDraft))),
    }),
    fromValues: (v, e, files) => ({
      ...base(e),
      date: v.date,
      time: S(v.time),
      timezone: S(v.timezone),
      type: expenseOnly ? 'expense' : v.type as Transaction['type'],
      category: v.category as Transaction['category'],
      amount: D(v.amount || '0').abs().toString(),
      assetId: v.assetId || defaultAssetId,
      accountId: usesAccounts ? S(v.accountId) : undefined,
      transferAssetId: usesAccounts ? S(v.transferAssetId) : undefined,
      transferAccountId: usesAccounts ? S(v.transferAccountId) : undefined,
      transferAmount: usesAccounts ? S(v.transferAmount) : undefined,
      status: usesAccounts ? ((v.status as Transaction['status']) || 'cleared') : 'cleared',
      reportingTreatment: e?.reportingTreatment,
      payeeId: S(v.payeeId),
      refundForId: S(v.refundForId),
      refundAppliedAmount: S(v.refundAppliedAmount),
      refundAppliedAssetId: e?.refundAppliedAssetId,
      refundAllocationMode: (v.refundAllocationMode as Transaction['refundAllocationMode']) || 'proportional',
      refundAllocationDrafts: (() => {
        try {
          const parsed = JSON.parse(v.refundAllocationDrafts || '{}') as Record<string, unknown>;
          return Object.entries(parsed)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
            .map(([sourceSplitId, amount]) => ({ sourceSplitId: sourceSplitId === '__root__' ? undefined : sourceSplitId, amount }));
        } catch {
          return [];
        }
      })(),
      recordState: e?.recordState ?? 'active',
      voidedAt: e?.voidedAt,
      voidReason: e?.voidReason,
      tagIds: splitList(v.tagIds),
      locationId: S(v.locationId),
      locationName: S(v.locationName),
      latitude: S(v.latitude),
      longitude: S(v.longitude),
      locationAccuracyMeters: S(v.locationAccuracyMeters),
      description: S(v.description),
      merchant: S(v.merchant),
      note: S(v.note),
      attachmentDrafts: files?.attachmentDrafts ?? parseAttachmentDrafts(v.attachmentDrafts),
    }) as TransactionFormValue,
    validate: (v) => {
      if (!D(v.amount || '0').gt(0)) return { amount: '金额必须大于 0' } as Record<string, string>;
      if (v.type === 'transfer' && usesAccounts && (!v.accountId || !v.transferAccountId)) return { accountId: '转账需要转出账户', transferAccountId: '转账需要转入账户' } as Record<string, string>;
      if (v.type === 'refund' && !v.refundForId) return { refundForId: '退款必须关联原支出' } as Record<string, string>;
      if (v.type === 'refund' && v.refundAppliedAmount && !D(v.refundAppliedAmount).gt(0)) return { refundAppliedAmount: '冲减金额必须大于 0' } as Record<string, string>;
      return undefined;
    },
  };
}

export function transactionSplitForm(snap: Snapshot): EntityFormSpec<TransactionSplit> {
  const txOptions = snap.transactions
    .filter((t) => !t.isDeleted && t.type !== 'transfer' && t.type !== 'adjustment')
    .map((t) => ({
      value: t.id,
      label: `${t.date} · ${t.description ?? t.merchant ?? t.category} · ${t.amount}`,
    }));
  return {
    title: '拆分明细',
    fields: [
      { key: 'transactionId', label: '原流水', type: 'select', options: txOptions, required: true },
      { key: 'category', label: '二级分类', type: 'category', half: true, options: categoryOptions(snap.categories, 'expense', { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap), required: true },
      { key: 'amount', label: '金额', type: 'number', half: true, required: true },
      { key: 'note', label: '备注', type: 'text' },
    ],
    toValues: (s) => ({ transactionId: s.transactionId, category: s.category, amount: s.amount, note: s.note ?? '' }),
    fromValues: (v, e) => ({
      ...base(e), transactionId: v.transactionId, category: v.category,
      amount: D(v.amount || '0').abs().toString(), note: S(v.note),
    }) as TransactionSplit,
    validate: (v) => D(v.amount || '0').gt(0) ? undefined : { amount: '拆分金额必须大于 0' },
  };
}

export function budgetCategoryForm(snap: Snapshot, selectedMonth = currentDate().slice(0, 7)): EntityFormSpec<BudgetCategory> {
  const month = selectedMonth;
  const defaultAssetId = moduleCurrencyId(snap.setting, 'transaction');
  return {
    title: '分类预算',
    fields: [
      { key: 'month', label: '月份', type: 'text', half: true, defaultValue: month, placeholder: '2026-07', required: true },
      { key: 'category', label: '二级分类', type: 'category', half: true, options: categoryOptions(snap.categories, 'expense', { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap), required: true },
      { key: 'plannedAmount', label: '预算金额', type: 'number', half: true, required: true },
      { key: 'assetId', label: '预算币种', type: 'select', half: true, defaultValue: defaultAssetId, options: settlementOpts(snap, defaultAssetId), required: true },
      { key: 'rolloverMode', label: '结转方式', type: 'select', half: true, options: [
        { value: 'none', label: '不结转' },
        { value: 'positive_only', label: '仅结余结转' },
        { value: 'signed', label: '结余与超支都结转' },
      ] },
      { key: 'note', label: '备注', type: 'text' },
    ],
    toValues: (b) => ({ month: b.month, category: b.category, plannedAmount: b.plannedAmount, assetId: b.assetId, rolloverMode: b.rolloverMode, note: b.note ?? '' }),
    fromValues: (v, e) => ({ ...base(e), month: v.month, category: v.category, plannedAmount: D(v.plannedAmount || '0').abs().toString(), assetId: v.assetId, rolloverMode: (v.rolloverMode || 'none') as BudgetCategory['rolloverMode'], note: S(v.note) }) as BudgetCategory,
    validate: (v) => !/^\d{4}-\d{2}$/.test(v.month ?? '') ? { month: '月份格式应为 YYYY-MM' } as Record<string, string> : D(v.plannedAmount || '0').gt(0) ? undefined : { plannedAmount: '预算金额必须大于 0' } as Record<string, string>,
  };
}

export function scheduledTransactionForm(snap: Snapshot, options: LedgerFormOptions = {}): EntityFormSpec<ScheduledTransaction> {
  const asOf = currentDate();
  const usesAccounts = options.usesAccounts ?? snap.setting?.ledgerMode !== 'spending';
  const defaultAssetId = defaultSettlementAssetId(snap);
  const accountFields: FieldDef[] = usesAccounts ? [
    { key: 'accountId', label: '账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: true },
    { key: 'transferAssetId', label: '转入币种', type: 'select', half: true, options: settlementOpts(snap), allowEmpty: true },
    { key: 'transferAccountId', label: '转入账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: true },
    { key: 'transferAmount', label: '转入金额', type: 'number', half: true },
  ] : [];
  return {
    title: '定期交易',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'type', label: '类型', type: 'select', half: true, options: usesAccounts ? TX_TYPES_STANDARD : TX_TYPES_STANDARD.filter((t) => t.value !== 'transfer') },
      { key: 'category', label: '二级分类', type: 'category', half: true, options: (v) => categoryOptions(snap.categories, v.type === 'income' ? 'income' : 'expense', { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap) },
      { key: 'amount', label: '金额', type: 'number', half: true, required: true },
      { key: 'assetId', label: '币种', type: 'select', half: true, options: settlementOpts(snap), required: true },
      ...accountFields,
      { key: 'payeeId', label: '商户', type: 'select', half: true, options: payeeOpts(snap), allowEmpty: true },
      { key: 'frequency', label: '频率', type: 'select', half: true, options: SCHEDULE_FREQ },
      { key: 'anchorDate', label: '开始日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'time', label: '生成时间', type: 'time', half: true, defaultValue: '09:00' },
      { key: 'timezone', label: '时区', type: 'text', half: true, defaultValue: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', required: true },
      { key: 'anchorMode', label: '月度锚点', type: 'select', half: true, options: [
        { value: 'calendar_day', label: '固定日（月底自动取最后一天）' },
        { value: 'month_end', label: '始终使用月末' },
      ] },
      { key: 'endDate', label: '结束日期', type: 'date', half: true },
      { key: 'autoCreate', label: '打开应用时自动补齐', type: 'checkbox', half: true },
      { key: 'catchUpPolicy', label: '漏记补齐', type: 'select', half: true, options: [
        { value: 'all', label: '补齐每一期' },
        { value: 'latest', label: '只生成最近一期' },
      ] },
      { key: 'status', label: '状态', type: 'select', half: true, options: SCHEDULE_STATUS },
      { key: 'merchant', label: '商户文本', type: 'text', half: true },
      { key: 'description', label: '描述', type: 'text', half: true },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (s) => ({
      name: s.name, type: s.type, category: s.category, amount: s.amount, assetId: s.assetId || defaultAssetId, accountId: s.accountId ?? '',
      transferAssetId: s.transferAssetId ?? '', transferAccountId: s.transferAccountId ?? '', transferAmount: s.transferAmount ?? '',
      payeeId: s.payeeId ?? '', frequency: s.frequency, anchorDate: s.anchorDate, anchorMode: s.anchorMode,
      time: s.time ?? '', timezone: s.timezone, endDate: s.endDate ?? '',
      autoCreate: s.autoCreate ? 'true' : 'false', catchUpPolicy: s.catchUpPolicy, status: s.status, merchant: s.merchant ?? '',
      description: s.description ?? '', note: s.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e), name: v.name, type: v.type as ScheduledTransaction['type'], category: v.category,
      amount: D(v.amount || '0').abs().toString(), assetId: v.assetId || defaultAssetId,
      accountId: usesAccounts ? S(v.accountId) : undefined,
      transferAssetId: usesAccounts ? S(v.transferAssetId) : undefined,
      transferAccountId: usesAccounts ? S(v.transferAccountId) : undefined,
      transferAmount: usesAccounts ? S(v.transferAmount) : undefined,
      payeeId: S(v.payeeId), merchant: S(v.merchant), description: S(v.description),
      frequency: v.frequency as ScheduledTransaction['frequency'],
      anchorDate: v.anchorDate, anchorMode: (v.anchorMode || 'calendar_day') as ScheduledTransaction['anchorMode'],
      time: S(v.time), timezone: v.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      endDate: S(v.endDate), autoCreate: v.autoCreate === 'true',
      catchUpPolicy: (v.catchUpPolicy || 'all') as ScheduledTransaction['catchUpPolicy'],
      status: v.status as ScheduledTransaction['status'], note: S(v.note),
    }) as ScheduledTransaction,
    validate: (v) => {
      const errors: Record<string, string> = {};
      const anchorDate = v.anchorDate ?? '';
      if (!D(v.amount || '0').gt(0)) errors.amount = '金额必须大于 0';
      if (!isValidDay(anchorDate)) errors.anchorDate = '开始日期无效';
      if (v.endDate && (!isValidDay(v.endDate) || v.endDate < anchorDate)) errors.endDate = '结束日期不能早于开始日期';
      if (v.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) errors.time = '生成时间无效';
      try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }).format(); } catch { errors.timezone = '请输入有效的 IANA 时区，例如 Asia/Shanghai'; }
      if (usesAccounts && v.type === 'transfer' && (!v.accountId || !v.transferAccountId)) {
        errors.accountId = '请选择转出账户';
        errors.transferAccountId = '请选择转入账户';
      }
      if (v.type !== 'transfer' && !v.category) errors.category = '请选择二级分类';
      return Object.keys(errors).length ? errors : undefined;
    },
  };
}

export function gameForm(): EntityFormSpec<Game> {
  return {
    title: '游戏',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'platform', label: '平台', type: 'text', half: true },
      { key: 'serverName', label: '区服', type: 'text', half: true },
      { key: 'enableSeason', label: '启用赛季', type: 'checkbox', half: true },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'note', label: '备注', type: 'text' },
    ],
    toValues: (g) => ({
      name: g.name, platform: g.platform ?? '', serverName: g.serverName ?? '',
      enableSeason: g.enableSeason ? 'true' : 'false', isActive: g.isActive !== false ? 'true' : 'false',
      note: g.note ?? '',
    }),
    fromValues: (v, e) => ({
      ...base(e), name: v.name, platform: S(v.platform), serverName: S(v.serverName),
      enableSeason: v.enableSeason === 'true', isActive: v.isActive !== 'false', note: S(v.note),
    }) as Game,
  };
}

export function gameAccountForm(snap: Snapshot): EntityFormSpec<GameAccount> {
  return {
    title: '游戏账号',
    fields: [
      { key: 'gameId', label: '游戏', type: 'select', half: true, options: gameOpts(snap), required: true },
      { key: 'accountName', label: '账号名称', type: 'text', half: true, required: true },
      { key: 'serverName', label: '区服', type: 'text', half: true },
      { key: 'characterName', label: '角色名', type: 'text', half: true },
      { key: 'status', label: '状态', type: 'select', half: true, options: GACC_STATUS },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (a) => ({ gameId: a.gameId, accountName: a.accountName, serverName: a.serverName ?? '', characterName: a.characterName ?? '', status: a.status, note: a.note ?? '' }),
    fromValues: (v, e) => ({ ...base(e), gameId: v.gameId, accountName: v.accountName, serverName: S(v.serverName), characterName: S(v.characterName), status: v.status as GameAccount['status'], note: S(v.note) }) as GameAccount,
  };
}

export function gameSeasonForm(snap: Snapshot): EntityFormSpec<GameSeason> {
  const asOf = currentDate();
  return {
    title: '赛季',
    fields: [
      { key: 'gameId', label: '游戏', type: 'select', half: true, options: gameOpts(snap), required: true },
      { key: 'name', label: '赛季名称', type: 'text', half: true, required: true },
      { key: 'seasonNo', label: '赛季编号', type: 'text', half: true },
      { key: 'status', label: '状态', type: 'select', half: true, options: SEASON_STATUS },
      { key: 'startDate', label: '开始日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'endDate', label: '结束日期', type: 'date', half: true },
      { key: 'hours', label: '游戏时长（h）', type: 'number', half: true },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (s) => ({ gameId: s.gameId, name: s.name, seasonNo: s.seasonNo ?? '', status: s.status, startDate: s.startDate ?? '', endDate: s.endDate ?? '', hours: s.hours ?? '', note: s.note ?? '' }),
    fromValues: (v, e) => ({ ...base(e), gameId: v.gameId, name: v.name, seasonNo: S(v.seasonNo), status: v.status as GameSeason['status'], startDate: S(v.startDate), endDate: S(v.endDate), hours: S(v.hours), note: S(v.note) }) as GameSeason,
    validate: (v) => v.endDate && v.startDate && v.endDate < v.startDate ? { endDate: '结束日期不能早于开始日期' } : undefined,
  };
}

const GAME_CASHFLOW_MODES = [
  { value: 'create_transaction', label: '同时创建流水' },
  { value: 'linked_transaction', label: '关联已有流水' },
  { value: 'record_only', label: '仅登记，不影响资产' },
];
const GAME_INCOME_TYPES = new Set(['sell_currency', 'sell_equipment', 'sell_material', 'withdraw', 'other_income']);
const GAME_EXPENSE_TYPES = new Set(['buy_currency', 'topup', 'fee', 'account_cost', 'boosting_cost', 'other_expense']);

function gameCashflowTransactionOptions(snap: Snapshot, values: Record<string, string>, role: GameCashflowRole) {
  const recordType = values.recordType ?? '';
  const expectedType = role === 'fee' || GAME_EXPENSE_TYPES.has(recordType) ? 'expense'
    : GAME_INCOME_TYPES.has(recordType) ? 'income'
      : '';
  const assetId = role === 'fee' ? values.feeAssetId : values.settlementAssetId;
  const amount = role === 'fee' ? values.feeAmount : values.settlementAmount;
  const amountMatches = (candidate: string) => {
    if (!amount) return true;
    try {
      return D(candidate).eq(amount);
    } catch {
      return false;
    }
  };
  return snap.transactions
    .filter((transaction) =>
      !transaction.isDeleted
      && transaction.recordState !== 'voided'
      && transaction.type === expectedType
      && (!assetId || transaction.assetId === assetId)
      && amountMatches(transaction.amount))
    .map((transaction) => ({
      value: transaction.id,
      label: `${transaction.date} · ${transaction.description ?? transaction.merchant ?? categoryLabel(transaction.category, snap.categories)} · ${transaction.amount} ${snap.assets.find((asset) => asset.id === transaction.assetId)?.code ?? ''}`,
    }));
}

function gameCashflowFormValues(snap: Snapshot, record: GameRecord, role: GameCashflowRole) {
  const link = snap.gameCashflowLinks.find((row) => !row.isDeleted && row.gameRecordId === record.id && row.role === role);
  const transaction = snap.transactions.find((row) => row.id === link?.transactionId);
  return {
    mode: link?.ownership === 'created' ? 'create_transaction' : link ? 'linked_transaction' : 'record_only',
    transactionId: link?.transactionId ?? '',
    categoryId: transaction?.category ?? '',
    accountId: transaction?.accountId ?? '',
    merchant: transaction?.merchant ?? '',
  };
}

export function gameRecordForm(snap: Snapshot): EntityFormSpec<GameRecordFormValue> {
  const asOf = currentDate();
  const usesAccounts = (snap.setting?.ledgerMode ?? 'spending') !== 'spending';
  return {
    title: '游戏记录',
    draftKey: 'game-record',
    modalWidth: 900,
    fields: [
      { key: 'date', label: '日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'recordType', label: '记录类型', type: 'select', half: true, options: REC_TYPES, required: true },
      { key: 'gameId', label: '游戏', type: 'select', half: true, options: gameOpts(snap), required: true },
      { key: 'seasonId', label: '赛季', type: 'select', half: true, options: (v) => seasonOpts(snap, v.gameId), allowEmpty: true },
      { key: 'gameAccountId', label: '账号（可选）', type: 'select', half: true, options: (v) => gameAccountOpts(snap, v.gameId), allowEmpty: true },
      { key: 'gameCurrencyName', label: '游戏货币', type: 'text', half: true, placeholder: '初火' },
      { key: 'gameCurrencyAmount', label: '货币数量', type: 'number', half: true },
      { key: 'settlementAssetId', label: '结算币种', type: 'select', half: true, options: settlementOpts(snap, moduleCurrencyId(snap.setting, 'game')) },
      { key: 'settlementAmount', label: '结算金额', type: 'number', half: true },
      { key: 'settlementCashflowMode', label: '结算资金处理', type: 'select', half: true, options: GAME_CASHFLOW_MODES, defaultValue: 'create_transaction' },
      {
        key: 'settlementTransactionId', label: '关联结算流水', type: 'select',
        options: (values) => gameCashflowTransactionOptions(snap, values, 'settlement'), allowEmpty: true,
        visibleWhen: (values) => values.settlementCashflowMode === 'linked_transaction',
      },
      {
        key: 'settlementCategoryId', label: '结算流水分类', type: 'category', half: true,
        options: (values) => categoryOptions(snap.categories, GAME_INCOME_TYPES.has(values.recordType ?? '') ? 'income' : 'expense', { leafOnly: true, includeHidden: true }),
        ...categoryPickerPreference(snap),
        visibleWhen: (values) => values.settlementCashflowMode === 'create_transaction',
      },
      {
        key: 'settlementAccountId', label: '结算账户', type: 'select', half: true,
        options: accountOpts(snap), allowEmpty: !usesAccounts, required: usesAccounts,
        visibleWhen: (values) => usesAccounts && values.settlementCashflowMode === 'create_transaction',
      },
      { key: 'settlementMerchant', label: '结算商户 / 平台', type: 'text', half: true, section: 'more', visibleWhen: (values) => values.settlementCashflowMode === 'create_transaction' },
      { key: 'feeAssetId', label: '手续费币种', type: 'select', half: true, options: assetOpts(snap), allowEmpty: true },
      { key: 'feeAmount', label: '手续费', type: 'number', half: true },
      { key: 'feeCashflowMode', label: '手续费资金处理', type: 'select', half: true, options: GAME_CASHFLOW_MODES, defaultValue: 'create_transaction' },
      {
        key: 'feeTransactionId', label: '关联手续费流水', type: 'select',
        options: (values) => gameCashflowTransactionOptions(snap, values, 'fee'), allowEmpty: true,
        visibleWhen: (values) => values.feeCashflowMode === 'linked_transaction',
      },
      {
        key: 'feeCategoryId', label: '手续费分类', type: 'category', half: true,
        options: categoryOptions(snap.categories, 'expense', { leafOnly: true, includeHidden: true }),
        ...categoryPickerPreference(snap),
        visibleWhen: (values) => values.feeCashflowMode === 'create_transaction',
      },
      {
        key: 'feeAccountId', label: '手续费账户', type: 'select', half: true,
        options: accountOpts(snap), allowEmpty: !usesAccounts, required: usesAccounts,
        visibleWhen: (values) => usesAccounts && values.feeCashflowMode === 'create_transaction',
      },
      { key: 'feeMerchant', label: '手续费商户 / 平台', type: 'text', half: true, section: 'more', visibleWhen: (values) => values.feeCashflowMode === 'create_transaction' },
      { key: 'note', label: '备注', type: 'text' },
    ],
    toValues: (record) => {
      const settlement = gameCashflowFormValues(snap, record, 'settlement');
      const fee = gameCashflowFormValues(snap, record, 'fee');
      return {
        date: record.date, recordType: record.recordType, gameId: record.gameId,
        seasonId: record.seasonId ?? '', gameAccountId: record.gameAccountId ?? '',
        gameCurrencyName: record.gameCurrencyName ?? '', gameCurrencyAmount: record.gameCurrencyAmount ?? '',
        settlementAssetId: record.settlementAssetId ?? '', settlementAmount: record.settlementAmount ?? '',
        settlementCashflowMode: record.settlementCashflowMode ?? settlement.mode,
        settlementTransactionId: record.settlementTransactionId ?? settlement.transactionId,
        settlementCategoryId: record.settlementCategoryId ?? settlement.categoryId,
        settlementAccountId: record.settlementAccountId ?? settlement.accountId,
        settlementMerchant: record.settlementMerchant ?? settlement.merchant,
        feeAssetId: record.feeAssetId ?? '', feeAmount: record.feeAmount ?? '',
        feeCashflowMode: record.feeCashflowMode ?? fee.mode,
        feeTransactionId: record.feeTransactionId ?? fee.transactionId,
        feeCategoryId: record.feeCategoryId ?? fee.categoryId,
        feeAccountId: record.feeAccountId ?? fee.accountId,
        feeMerchant: record.feeMerchant ?? fee.merchant,
        note: record.note ?? '',
      };
    },
    fromValues: (v, e) => ({
      ...base(e), date: v.date, recordType: v.recordType as GameRecord['recordType'], gameId: v.gameId,
      seasonId: S(v.seasonId), gameAccountId: S(v.gameAccountId), gameCurrencyName: S(v.gameCurrencyName),
      gameCurrencyAmount: S(v.gameCurrencyAmount), settlementAssetId: S(v.settlementAssetId), settlementAmount: S(v.settlementAmount),
      settlementCashflowMode: (v.settlementCashflowMode as GameCashflowMode) || 'record_only',
      settlementTransactionId: S(v.settlementTransactionId), settlementCategoryId: S(v.settlementCategoryId),
      settlementAccountId: S(v.settlementAccountId), settlementMerchant: S(v.settlementMerchant),
      feeAssetId: S(v.feeAssetId), feeAmount: S(v.feeAmount),
      feeCashflowMode: (v.feeCashflowMode as GameCashflowMode) || 'record_only',
      feeTransactionId: S(v.feeTransactionId), feeCategoryId: S(v.feeCategoryId),
      feeAccountId: S(v.feeAccountId), feeMerchant: S(v.feeMerchant), note: S(v.note),
    }) as GameRecordFormValue,
    validate: (v) => {
      const season = v.seasonId ? snap.seasons.find((row) => row.id === v.seasonId) : undefined;
      const account = v.gameAccountId ? snap.gameAccounts.find((row) => row.id === v.gameAccountId) : undefined;
      if (season && season.gameId !== v.gameId) return { seasonId: '赛季不属于所选游戏' } as Record<string, string>;
      if (account && account.gameId !== v.gameId) return { gameAccountId: '账号不属于所选游戏' } as Record<string, string>;
      const settlementHasMoney = !!v.settlementAssetId && D(v.settlementAmount || 0).gt(0);
      if (settlementHasMoney && v.settlementCashflowMode === 'linked_transaction' && !v.settlementTransactionId) return { settlementTransactionId: '请选择已有流水' };
      if (settlementHasMoney && v.settlementCashflowMode === 'create_transaction') {
        const errors: Record<string, string> = {};
        if (!v.settlementCategoryId) errors.settlementCategoryId = '请选择二级分类';
        if (usesAccounts && !v.settlementAccountId) errors.settlementAccountId = '请选择结算账户';
        if (Object.keys(errors).length) return errors;
      }
      const feeHasMoney = !!v.feeAssetId && D(v.feeAmount || 0).gt(0);
      if (feeHasMoney && v.feeCashflowMode === 'linked_transaction' && !v.feeTransactionId) return { feeTransactionId: '请选择已有流水' };
      if (feeHasMoney && v.feeCashflowMode === 'create_transaction') {
        const errors: Record<string, string> = {};
        if (!v.feeCategoryId) errors.feeCategoryId = '请选择二级分类';
        if (usesAccounts && !v.feeAccountId) errors.feeAccountId = '请选择手续费账户';
        if (Object.keys(errors).length) return errors;
      }
      if (v.recordType === 'fee' && !!v.feeAssetId) {
        return { feeAmount: '独立手续费记录的费用请填写在结算金额字段，不要重复填写手续费' } as Record<string, string>;
      }
      return undefined;
    },
  };
}

export function fixedAssetCategoryForm(snap: Snapshot): EntityFormSpec<FixedAssetCategory> {
  return {
    title: '物品资产分类',
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'parentId', label: '一级分类', type: 'select', half: true, options: fixedCategoryOpts(snap, true), allowEmpty: true },
      { key: 'color', label: '颜色', type: 'text', half: true, placeholder: '#0f766e' },
      { key: 'sortOrder', label: '排序', type: 'number', half: true, defaultValue: '100' },
      { key: 'isHidden', label: '默认隐藏', type: 'checkbox', half: true },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'note', label: '备注', type: 'text' },
    ],
    toValues: (category) => ({
      name: category.name, parentId: category.parentId ?? '', color: category.color ?? '',
      sortOrder: String(category.sortOrder ?? 100), isHidden: category.isHidden ? 'true' : 'false',
      isActive: category.isActive ? 'true' : 'false', note: category.note ?? '',
    }),
    fromValues: (v, existing) => ({
      ...base(existing), name: v.name, parentId: S(v.parentId), color: S(v.color),
      sortOrder: Number(v.sortOrder || 100), isHidden: v.isHidden === 'true',
      isActive: v.isActive !== 'false', note: S(v.note),
    }) as FixedAssetCategory,
    validate: (v, existing) => {
      if (v.parentId === existing?.id) return { parentId: '分类不能把自己设为父级' } as Record<string, string>;
      const duplicate = snap.fixedAssetCategories.some((row) => row.id !== existing?.id && !row.isDeleted && (row.parentId ?? '') === (v.parentId ?? '') && row.name.trim().toLowerCase() === (v.name ?? '').trim().toLowerCase());
      return duplicate ? { name: '同一父级下已存在同名分类' } as Record<string, string> : undefined;
    },
  };
}

export function fixedAssetForm(snap: Snapshot, attachments: Attachment[] = [], purchaseEvent?: FixedAssetEvent): EntityFormSpec<FixedAssetFormValue> {
  const asOf = currentDate();
  const preferredCurrency = moduleCurrencyId(snap.setting, 'fixed');
  const expenseOptions = snap.transactions
    .filter((transaction) => !transaction.isDeleted && transaction.recordState !== 'voided' && transaction.type === 'expense')
    .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt))
    .map((transaction) => ({
      value: transaction.id,
      label: `${transaction.date} · ${transaction.description ?? transaction.merchant ?? categoryLabel(transaction.category, snap.categories)} · ${transaction.amount} ${snap.assets.find((asset) => asset.id === transaction.assetId)?.code ?? ''}`,
    }));
  const usesAccounts = (snap.setting?.ledgerMode ?? 'spending') !== 'spending';
  const files = (role: Attachment['role']) => attachments.filter((attachment) => attachment.role === role).map((attachment) => ({
    id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, note: attachment.note,
    sizeBytes: attachment.sizeBytes, sha256: attachment.sha256,
    thumbnailSha256: attachment.thumbnailSha256, thumbnailSizeBytes: attachment.thumbnailSizeBytes,
    thumbnailMimeType: attachment.thumbnailMimeType,
  }));
  return {
    title: '物品资产',
    modalWidth: 860,
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true },
      { key: 'categoryId', label: '分类', type: 'category', half: true, options: fixedCategoryOpts(snap), required: true },
      { key: 'purchaseDate', label: '购买日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'purchaseAmount', label: '购买金额', type: 'number', half: true, defaultValue: '0', required: true },
      { key: 'baseCurrencyAssetId', label: '记账币种', type: 'select', half: true, options: settlementOpts(snap, preferredCurrency), required: true },
      { key: 'cashflowMode', label: '资金处理', type: 'select', half: true, defaultValue: 'record_only', options: [
        { value: 'record_only', label: '仅登记物品（不影响余额）' },
        { value: 'linked_transaction', label: '关联已有支出' },
        { value: 'create_transaction', label: '同时创建支出' },
      ], required: true },
      { key: 'cashflowTransactionId', label: '已有支出流水', type: 'select', options: expenseOptions, allowEmpty: true, visibleWhen: (values) => values.cashflowMode === 'linked_transaction', required: true },
      { key: 'cashflowSourceAmount', label: '从该支出分配的金额', type: 'number', half: true, visibleWhen: (values) => values.cashflowMode === 'linked_transaction', required: true },
      { key: 'cashflowCategory', label: '支出二级分类', type: 'category', options: categoryOptions(snap.categories, 'expense', { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap), visibleWhen: (values) => values.cashflowMode === 'create_transaction', required: true },
      { key: 'cashflowAccountId', label: '付款账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: !usesAccounts, visibleWhen: (values) => values.cashflowMode === 'create_transaction', required: usesAccounts },
      { key: 'cashflowPayeeId', label: '已有商户', type: 'select', half: true, options: payeeOpts(snap), allowEmpty: true, visibleWhen: (values) => values.cashflowMode === 'create_transaction' },
      { key: 'cashflowMerchant', label: '商户文本', type: 'text', half: true, visibleWhen: (values) => values.cashflowMode === 'create_transaction' },
      { key: 'cashflowDescription', label: '支出描述', type: 'text', visibleWhen: (values) => values.cashflowMode === 'create_transaction', placeholder: '默认使用“购买 + 物品名称”' },
      { key: 'status', label: '状态', type: 'select', half: true, options: FIXED_STATUS },
      { key: 'activatedDate', label: '启用日期', type: 'date', half: true },
      { key: 'tag', label: '标签', type: 'text', half: true, placeholder: '主力机 / 客厅' },
      { key: 'brand', label: '品牌', type: 'text', half: true },
      { key: 'model', label: '型号', type: 'text', half: true },
      { key: 'serialNumber', label: '序列号', type: 'text', half: true },
      { key: 'barcode', label: '条形码 / 设备码', type: 'text', half: true, deviceAction: 'scan-barcode' },
      { key: 'purchaseMerchant', label: '购买商户', type: 'text', half: true },
      { key: 'orderNumber', label: '订单号', type: 'text', half: true },
      { key: 'warrantyEndDate', label: '保修截止日', type: 'date', half: true },
      { key: 'warrantyProvider', label: '保修方', type: 'text', half: true },
      { key: 'imageFiles', label: '物品图片', type: 'file', accept: 'image/*', multiple: true, capture: 'environment' },
      { key: 'invoiceFiles', label: '发票 / 购买凭证', type: 'file', accept: 'image/*,.pdf', multiple: true, capture: 'environment' },
      { key: 'warrantyFiles', label: '保修凭证 / 说明书', type: 'file', accept: 'image/*,.pdf', multiple: true, capture: 'environment' },
      { key: 'note', label: '备注', type: 'textarea' },
    ],
    toValues: (asset) => {
      const cashflowLink = snap.fixedCashflowLinks.find((row) => !row.isDeleted && row.sourceType === 'event' && row.sourceId === purchaseEvent?.id);
      const cashflowTransaction = cashflowLink ? snap.transactions.find((row) => row.id === cashflowLink.transactionId) : undefined;
      return ({
      name: asset.name, categoryId: asset.categoryId, tag: asset.tag ?? '', status: asset.status,
      purchaseDate: asset.purchaseDate, purchaseAmount: asset.purchaseAmount ?? purchaseEvent?.amountBase ?? '0', activatedDate: asset.activatedDate ?? '', baseCurrencyAssetId: asset.baseCurrencyAssetId,
      cashflowMode: purchaseEvent?.cashflowMode ?? 'record_only',
      cashflowTransactionId: cashflowLink?.transactionId ?? '', cashflowSourceAmount: cashflowLink?.sourceAmount ?? purchaseEvent?.amountBase ?? '',
      cashflowCategory: cashflowTransaction?.category ?? '', cashflowAccountId: cashflowTransaction?.accountId ?? '',
      cashflowPayeeId: cashflowTransaction?.payeeId ?? '', cashflowMerchant: cashflowTransaction?.merchant ?? '',
      cashflowDescription: cashflowTransaction?.description ?? '',
      brand: asset.brand ?? '', model: asset.model ?? '', serialNumber: asset.serialNumber ?? '', barcode: asset.barcode ?? '',
      purchaseMerchant: asset.purchaseMerchant ?? '', orderNumber: asset.orderNumber ?? '', warrantyEndDate: asset.warrantyEndDate ?? '',
      warrantyProvider: asset.warrantyProvider ?? '', imageFiles: JSON.stringify(files('image')),
      invoiceFiles: JSON.stringify(files('invoice')), warrantyFiles: JSON.stringify([...files('warranty'), ...files('manual')]), note: asset.note ?? '',
    });
    },
    fromValues: (v, existing, formFiles) => ({
      ...base(existing), name: v.name, categoryId: v.categoryId, tag: S(v.tag), status: v.status as FixedAsset['status'],
      purchaseDate: v.purchaseDate, purchaseAmount: D(v.purchaseAmount || 0).toString(), activatedDate: S(v.activatedDate), baseCurrencyAssetId: v.baseCurrencyAssetId,
      cashflowMode: (v.cashflowMode || 'record_only') as FixedAssetCashflowMode,
      cashflowTransactionId: S(v.cashflowTransactionId), cashflowSourceAmount: S(v.cashflowSourceAmount),
      cashflowCategory: S(v.cashflowCategory), cashflowAccountId: S(v.cashflowAccountId),
      cashflowPayeeId: S(v.cashflowPayeeId), cashflowMerchant: S(v.cashflowMerchant), cashflowDescription: S(v.cashflowDescription),
      brand: S(v.brand), model: S(v.model), serialNumber: S(v.serialNumber), barcode: S(v.barcode),
      purchaseMerchant: S(v.purchaseMerchant), orderNumber: S(v.orderNumber), warrantyEndDate: S(v.warrantyEndDate),
      warrantyProvider: S(v.warrantyProvider), note: S(v.note),
      attachmentDrafts: [
        ...(formFiles?.imageFiles ?? parseAttachmentDrafts(v.imageFiles)).map((draft) => ({ ...draft, role: 'image' as const })),
        ...(formFiles?.invoiceFiles ?? parseAttachmentDrafts(v.invoiceFiles)).map((draft) => ({ ...draft, role: 'invoice' as const })),
        ...(formFiles?.warrantyFiles ?? parseAttachmentDrafts(v.warrantyFiles)).map((draft) => ({ ...draft, role: 'warranty' as const })),
      ],
    }) as FixedAssetFormValue,
    validate: (v) => {
      if (v.warrantyEndDate && v.purchaseDate && v.warrantyEndDate < v.purchaseDate) return { warrantyEndDate: '保修截止日不能早于购买日期' } as Record<string, string>;
      if (D(v.purchaseAmount || 0).lt(0)) return { purchaseAmount: '购买金额不能为负数' } as Record<string, string>;
      if (v.cashflowMode !== 'record_only' && !D(v.purchaseAmount || 0).gt(0)) return { purchaseAmount: '关联资金时购买金额必须大于 0' } as Record<string, string>;
      if (v.cashflowMode === 'linked_transaction' && !v.cashflowTransactionId) return { cashflowTransactionId: '请选择已有支出流水' } as Record<string, string>;
      if (v.cashflowMode === 'linked_transaction' && !D(v.cashflowSourceAmount || 0).gt(0)) return { cashflowSourceAmount: '分配金额必须大于 0' } as Record<string, string>;
      if (v.cashflowMode === 'create_transaction' && !v.cashflowCategory) return { cashflowCategory: '请选择支出二级分类' } as Record<string, string>;
      if (v.cashflowMode === 'create_transaction' && usesAccounts && !v.cashflowAccountId) return { cashflowAccountId: '当前账户模式必须选择付款账户' } as Record<string, string>;
      return undefined;
    },
  };
}

export function fixedEventForm(
  snap: Snapshot,
  fixedAssetId: string,
  asOf = currentDate(),
  investedCost = '0',
): EntityFormSpec<FixedAssetEventFormValue> {
  const usesAccounts = (snap.setting?.ledgerMode ?? 'spending') !== 'spending';
  const isFinancial = (values: Record<string, string>) => ['repair', 'upgrade', 'sale'].includes(values.type ?? '');
  const isInflow = (values: Record<string, string>) => values.type === 'sale';
  const transactionOptions = (values: Record<string, string>) => snap.transactions
    .filter((transaction) => !transaction.isDeleted
      && transaction.recordState !== 'voided'
      && transaction.type === (isInflow(values) ? 'income' : 'expense'))
    .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt))
    .map((transaction) => ({
      value: transaction.id,
      label: `${transaction.date} · ${transaction.description ?? transaction.merchant ?? categoryLabel(transaction.category, snap.categories)} · ${transaction.amount} ${snap.assets.find((asset) => asset.id === transaction.assetId)?.code ?? ''}`,
    }));
  return {
    title: '物品生命周期事件',
    modalWidth: 760,
    fields: [
      { key: 'type', label: '事件类型', type: 'select', half: true, options: FIXED_EVENTS.filter((option) => option.value !== 'purchase'), required: true },
      { key: 'date', label: '日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'amountBase', label: '金额', type: 'number', half: true, defaultValue: '0', required: true },
      { key: 'valueMode', label: '残值录入口径（仅更新残值）', type: 'select', half: true, options: [{ value: 'residual', label: '当前残值' }, { value: 'depreciation', label: '累计损耗金额' }] },
      { key: 'cashflowMode', label: '资金处理', type: 'select', half: true, defaultValue: 'record_only', options: [
        { value: 'record_only', label: '仅登记事件（不影响余额）' },
        { value: 'linked_transaction', label: '关联已有流水' },
        { value: 'create_transaction', label: '同时创建流水' },
      ], visibleWhen: isFinancial, required: true },
      { key: 'cashflowTransactionId', label: '已有资金流水', type: 'select', options: transactionOptions, allowEmpty: true, visibleWhen: (values) => isFinancial(values) && values.cashflowMode === 'linked_transaction', required: true },
      { key: 'cashflowSourceAmount', label: '从该流水分配的金额', type: 'number', half: true, visibleWhen: (values) => isFinancial(values) && values.cashflowMode === 'linked_transaction', required: true },
      { key: 'cashflowCategory', label: '流水二级分类', type: 'category', options: (values) => categoryOptions(snap.categories, isInflow(values) ? 'income' : 'expense', { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap), visibleWhen: (values) => isFinancial(values) && values.cashflowMode === 'create_transaction', required: true },
      { key: 'cashflowAccountId', label: '付款 / 收款账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: !usesAccounts, visibleWhen: (values) => isFinancial(values) && values.cashflowMode === 'create_transaction', required: usesAccounts },
      { key: 'cashflowPayeeId', label: '已有商户', type: 'select', half: true, options: payeeOpts(snap), allowEmpty: true, visibleWhen: (values) => isFinancial(values) && values.cashflowMode === 'create_transaction' },
      { key: 'cashflowMerchant', label: '商户文本', type: 'text', half: true, visibleWhen: (values) => isFinancial(values) && values.cashflowMode === 'create_transaction' },
      { key: 'cashflowDescription', label: '流水描述', type: 'text', visibleWhen: (values) => isFinancial(values) && values.cashflowMode === 'create_transaction' },
      { key: 'cashflowReportingTreatment', label: '出售报表口径', type: 'select', half: true, defaultValue: 'ordinary', options: [
        { value: 'ordinary', label: '计入收入' },
        { value: 'balance_only', label: '仅增加余额，不计收入' },
      ], visibleWhen: (values) => values.type === 'sale' && values.cashflowMode === 'create_transaction' },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (event) => {
      const link = snap.fixedCashflowLinks.find((row) => !row.isDeleted && row.sourceType === 'event' && row.sourceId === event.id);
      const transaction = link ? snap.transactions.find((row) => row.id === link.transactionId) : undefined;
      return {
        type: event.type,
        date: event.date,
        amountBase: event.enteredAmount ?? event.amountBase,
        valueMode: event.valueMode ?? 'residual',
        cashflowMode: event.cashflowMode ?? 'record_only',
        cashflowTransactionId: link?.transactionId ?? '',
        cashflowSourceAmount: link?.sourceAmount ?? event.amountBase,
        cashflowCategory: transaction?.category ?? '',
        cashflowAccountId: transaction?.accountId ?? '',
        cashflowPayeeId: transaction?.payeeId ?? '',
        cashflowMerchant: transaction?.merchant ?? '',
        cashflowDescription: transaction?.description ?? '',
        cashflowReportingTreatment: transaction?.reportingTreatment ?? 'ordinary',
        note: event.note ?? '',
      };
    },
    fromValues: (v, existing) => {
      const type = v.type as FixedAssetEvent['type'];
      const entered = D(v.amountBase || 0);
      const valueMode = v.valueMode as FixedAssetEvent['valueMode'];
      const amountBase = type === 'residual_update' && valueMode === 'depreciation'
        ? D(investedCost).minus(entered)
        : entered;
      const financial = ['repair', 'upgrade', 'sale'].includes(type);
      return {
        ...base(existing),
        fixedAssetId: existing?.fixedAssetId ?? fixedAssetId,
        type,
        date: v.date,
        amountBase: amountBase.toString(),
        valueMode: type === 'residual_update' ? valueMode : undefined,
        enteredAmount: type === 'residual_update' ? entered.toString() : undefined,
        cashflowMode: financial ? (v.cashflowMode || 'record_only') as FixedAssetCashflowMode : undefined,
        cashflowTransactionId: S(v.cashflowTransactionId),
        cashflowSourceAmount: S(v.cashflowSourceAmount),
        cashflowCategory: S(v.cashflowCategory),
        cashflowAccountId: S(v.cashflowAccountId),
        cashflowPayeeId: S(v.cashflowPayeeId),
        cashflowMerchant: S(v.cashflowMerchant),
        cashflowDescription: S(v.cashflowDescription),
        cashflowReportingTreatment: (v.cashflowReportingTreatment || 'ordinary') as Transaction['reportingTreatment'],
        note: S(v.note),
      } as FixedAssetEventFormValue;
    },
    validate: (v) => {
      const errors: Record<string, string> = {};
      const amount = D(v.amountBase || 0);
      if (amount.lt(0)) errors.amountBase = '金额不能小于 0';
      if (v.type === 'residual_update' && v.valueMode === 'depreciation' && amount.gt(investedCost)) errors.amountBase = '累计损耗不能超过当前累计投入';
      if (isFinancial(v) && v.cashflowMode !== 'record_only' && !amount.gt(0)) errors.amountBase = '关联资金时金额必须大于 0';
      if (isFinancial(v) && v.cashflowMode === 'linked_transaction' && !v.cashflowTransactionId) errors.cashflowTransactionId = '请选择已有流水';
      if (isFinancial(v) && v.cashflowMode === 'linked_transaction' && !D(v.cashflowSourceAmount || 0).gt(0)) errors.cashflowSourceAmount = '分配金额必须大于 0';
      if (isFinancial(v) && v.cashflowMode === 'create_transaction' && !v.cashflowCategory) errors.cashflowCategory = '请选择流水二级分类';
      if (isFinancial(v) && v.cashflowMode === 'create_transaction' && usesAccounts && !v.cashflowAccountId) errors.cashflowAccountId = '当前账户模式必须选择账户';
      return Object.keys(errors).length > 0 ? errors : undefined;
    },
  };
}

export function fixedUsageMetricForm(fixedAssetId: string): EntityFormSpec<FixedAssetUsageMetric> {
  return {
    title: '使用量指标',
    fields: [
      { key: 'name', label: '指标名称', type: 'text', half: true, required: true, placeholder: '里程 / 使用时长 / 使用次数' },
      { key: 'unit', label: '单位', type: 'select', half: true, options: FIXED_USAGE_UNITS, required: true },
      { key: 'customUnit', label: '自定义单位', type: 'text', half: true, placeholder: '页 / 杯 / 次循环' },
      { key: 'entryMode', label: '录入方式', type: 'select', half: true, options: FIXED_ENTRY_MODES, required: true },
      { key: 'startValue', label: '初始读数', type: 'number', half: true, defaultValue: '0', required: true },
      { key: 'isPrimary', label: '主指标', type: 'checkbox', half: true },
      { key: 'isActive', label: '启用', type: 'checkbox', half: true, defaultValue: 'true' },
      { key: 'sortOrder', label: '排序', type: 'number', half: true, defaultValue: '100' },
      { key: 'note', label: '备注', type: 'text' },
    ],
    toValues: (metric) => ({ name: metric.name, unit: metric.unit, customUnit: metric.customUnit ?? '', entryMode: metric.entryMode, startValue: metric.startValue, isPrimary: metric.isPrimary ? 'true' : 'false', isActive: metric.isActive ? 'true' : 'false', sortOrder: String(metric.sortOrder ?? 100), note: metric.note ?? '' }),
    fromValues: (v, existing) => ({ ...base(existing), fixedAssetId: existing?.fixedAssetId ?? fixedAssetId, name: v.name, unit: v.unit as FixedAssetUsageMetric['unit'], customUnit: S(v.customUnit), entryMode: v.entryMode as FixedAssetUsageMetric['entryMode'], startValue: D(v.startValue || 0).toString(), isPrimary: v.isPrimary === 'true', isActive: v.isActive !== 'false', sortOrder: Number(v.sortOrder || 100), note: S(v.note) }) as FixedAssetUsageMetric,
    validate: (v) => v.unit === 'custom' && !(v.customUnit ?? '').trim() ? { customUnit: '自定义单位不能为空' } as Record<string, string> : D(v.startValue || 0).lt(0) ? { startValue: '初始读数不能为负数' } as Record<string, string> : undefined,
  };
}

export function fixedUsageLogForm(metric: FixedAssetUsageMetric, asOf = currentDate()): EntityFormSpec<FixedAssetUsageLog> {
  return {
    title: '使用量记录',
    fields: [
      { key: 'date', label: '日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'value', label: metric.entryMode === 'meter' ? '当前累计读数' : '本次增加量', type: 'number', half: true, required: true },
      { key: 'entryMode', label: '录入方式', type: 'select', half: true, options: FIXED_ENTRY_MODES, required: true, defaultValue: metric.entryMode },
      { key: 'note', label: '备注', type: 'text', half: true },
    ],
    toValues: (log) => ({ date: log.date, value: log.value, entryMode: log.entryMode, note: log.note ?? '' }),
    fromValues: (v, existing) => ({ ...base(existing), fixedAssetId: existing?.fixedAssetId ?? metric.fixedAssetId, metricId: existing?.metricId ?? metric.id, date: v.date, value: D(v.value || 0).toString(), entryMode: v.entryMode as FixedAssetUsageLog['entryMode'], note: S(v.note) }) as FixedAssetUsageLog,
    validate: (v) => D(v.value || 0).gt(0) ? undefined : { value: '使用量必须大于 0' },
  };
}

export function fixedConsumableForm(
  snap: Snapshot,
  fixedAssetId: string,
  metrics: FixedAssetUsageMetric[],
  asOf = currentDate(),
): EntityFormSpec<FixedAssetConsumableFormValue> {
  const metricOptions = metrics.filter((metric) => metric.fixedAssetId === fixedAssetId && metric.isActive).map((metric) => ({ value: metric.id, label: metric.name }));
  const usesAccounts = (snap.setting?.ledgerMode ?? 'spending') !== 'spending';
  const expenseOptions = snap.transactions
    .filter((transaction) => !transaction.isDeleted && transaction.recordState !== 'voided' && transaction.type === 'expense')
    .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt))
    .map((transaction) => ({
      value: transaction.id,
      label: `${transaction.date} · ${transaction.description ?? transaction.merchant ?? categoryLabel(transaction.category, snap.categories)} · ${transaction.amount} ${snap.assets.find((asset) => asset.id === transaction.assetId)?.code ?? ''}`,
    }));
  return {
    title: '耗材 / 易损件',
    modalWidth: 760,
    fields: [
      { key: 'name', label: '名称', type: 'text', half: true, required: true, placeholder: '空调滤芯 / 墨盒 / 轮胎' },
      { key: 'category', label: '耗材类别', type: 'text', half: true },
      { key: 'amountBase', label: '购买成本', type: 'number', half: true, defaultValue: '0', required: true },
      { key: 'purchaseDate', label: '购买日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'cashflowMode', label: '资金处理', type: 'select', half: true, defaultValue: 'record_only', options: [
        { value: 'record_only', label: '仅登记耗材（不影响余额）' },
        { value: 'linked_transaction', label: '关联已有支出' },
        { value: 'create_transaction', label: '同时创建支出' },
      ], required: true },
      { key: 'cashflowTransactionId', label: '已有支出流水', type: 'select', options: expenseOptions, allowEmpty: true, visibleWhen: (values) => values.cashflowMode === 'linked_transaction', required: true },
      { key: 'cashflowSourceAmount', label: '从该支出分配的金额', type: 'number', half: true, visibleWhen: (values) => values.cashflowMode === 'linked_transaction', required: true },
      { key: 'cashflowCategory', label: '支出二级分类', type: 'category', options: categoryOptions(snap.categories, 'expense', { leafOnly: true, includeHidden: true }), ...categoryPickerPreference(snap), visibleWhen: (values) => values.cashflowMode === 'create_transaction', required: true },
      { key: 'cashflowAccountId', label: '付款账户', type: 'select', half: true, options: accountOpts(snap), allowEmpty: !usesAccounts, visibleWhen: (values) => values.cashflowMode === 'create_transaction', required: usesAccounts },
      { key: 'cashflowPayeeId', label: '已有商户', type: 'select', half: true, options: payeeOpts(snap), allowEmpty: true, visibleWhen: (values) => values.cashflowMode === 'create_transaction' },
      { key: 'cashflowMerchant', label: '商户文本', type: 'text', half: true, visibleWhen: (values) => values.cashflowMode === 'create_transaction' },
      { key: 'cashflowDescription', label: '支出描述', type: 'text', visibleWhen: (values) => values.cashflowMode === 'create_transaction' },
      { key: 'installedDate', label: '安装日期', type: 'date', half: true },
      { key: 'usageMetricId', label: '寿命计算指标', type: 'select', half: true, options: metricOptions, allowEmpty: true },
      { key: 'installedAtUsage', label: '安装时读数', type: 'number', half: true },
      { key: 'targetLife', label: '目标寿命', type: 'number', half: true },
      { key: 'reminderAtRemaining', label: '剩余多少时提醒', type: 'number', half: true },
      { key: 'status', label: '状态', type: 'select', half: true, options: [{ value: 'active', label: '使用中' }, { value: 'replaced', label: '已更换' }, { value: 'discarded', label: '已丢弃' }] },
      { key: 'replacedDate', label: '更换 / 丢弃日期', type: 'date', half: true },
      { key: 'note', label: '备注', type: 'textarea' },
    ],
    toValues: (item) => {
      const link = snap.fixedCashflowLinks.find((row) => !row.isDeleted && row.sourceType === 'consumable' && row.sourceId === item.id);
      const transaction = link ? snap.transactions.find((row) => row.id === link.transactionId) : undefined;
      return {
        name: item.name,
        category: item.category ?? '',
        amountBase: item.amountBase,
        cashflowMode: item.cashflowMode ?? 'record_only',
        cashflowTransactionId: link?.transactionId ?? '',
        cashflowSourceAmount: link?.sourceAmount ?? item.amountBase,
        cashflowCategory: transaction?.category ?? '',
        cashflowAccountId: transaction?.accountId ?? '',
        cashflowPayeeId: transaction?.payeeId ?? '',
        cashflowMerchant: transaction?.merchant ?? '',
        cashflowDescription: transaction?.description ?? '',
        purchaseDate: item.purchaseDate,
        installedDate: item.installedDate ?? '',
        usageMetricId: item.usageMetricId ?? '',
        installedAtUsage: item.installedAtUsage ?? '',
        targetLife: item.targetLife ?? '',
        reminderAtRemaining: item.reminderAtRemaining ?? '',
        status: item.status,
        replacedDate: item.replacedDate ?? '',
        note: item.note ?? '',
      };
    },
    fromValues: (v, existing) => ({
      ...base(existing),
      fixedAssetId: existing?.fixedAssetId ?? fixedAssetId,
      name: v.name,
      category: S(v.category),
      amountBase: D(v.amountBase || 0).toString(),
      cashflowMode: (v.cashflowMode || 'record_only') as FixedAssetCashflowMode,
      cashflowTransactionId: S(v.cashflowTransactionId),
      cashflowSourceAmount: S(v.cashflowSourceAmount),
      cashflowCategory: S(v.cashflowCategory),
      cashflowAccountId: S(v.cashflowAccountId),
      cashflowPayeeId: S(v.cashflowPayeeId),
      cashflowMerchant: S(v.cashflowMerchant),
      cashflowDescription: S(v.cashflowDescription),
      purchaseDate: v.purchaseDate,
      installedDate: S(v.installedDate),
      usageMetricId: S(v.usageMetricId),
      installedAtUsage: S(v.installedAtUsage),
      targetLife: S(v.targetLife),
      reminderAtRemaining: S(v.reminderAtRemaining),
      status: v.status as FixedAssetConsumable['status'],
      replacedDate: S(v.replacedDate),
      note: S(v.note),
    }) as FixedAssetConsumableFormValue,
    validate: (v) => {
      if (D(v.amountBase || 0).lt(0)) return { amountBase: '成本不能为负数' } as Record<string, string>;
      if (v.targetLife && D(v.targetLife).lte(0)) return { targetLife: '目标寿命必须大于 0' } as Record<string, string>;
      if (v.cashflowMode !== 'record_only' && !D(v.amountBase || 0).gt(0)) return { amountBase: '关联资金时成本必须大于 0' } as Record<string, string>;
      if (v.cashflowMode === 'linked_transaction' && !v.cashflowTransactionId) return { cashflowTransactionId: '请选择已有支出流水' } as Record<string, string>;
      if (v.cashflowMode === 'linked_transaction' && !D(v.cashflowSourceAmount || 0).gt(0)) return { cashflowSourceAmount: '分配金额必须大于 0' } as Record<string, string>;
      if (v.cashflowMode === 'create_transaction' && !v.cashflowCategory) return { cashflowCategory: '请选择支出二级分类' } as Record<string, string>;
      if (v.cashflowMode === 'create_transaction' && usesAccounts && !v.cashflowAccountId) return { cashflowAccountId: '当前账户模式必须选择付款账户' } as Record<string, string>;
      return undefined;
    },
  };
}

export function fixedGoalForm(fixedAssetId: string, metrics: FixedAssetUsageMetric[], defaultCost: string, asOf = currentDate()): EntityFormSpec<FixedAssetGoal> {
  const metricOptions = [{ value: '__day__', label: '按天' }, ...metrics.filter((metric) => metric.fixedAssetId === fixedAssetId && metric.isActive).map((metric) => ({ value: metric.id, label: `${metric.name} · ${metric.unit}` }))];
  return {
    title: '使用成本目标',
    fields: [
      { key: 'name', label: '目标名称', type: 'text', half: true, required: true, defaultValue: '使用成本目标' },
      { key: 'metricId', label: '计算口径', type: 'select', half: true, options: metricOptions, required: true },
      { key: 'mode', label: '设置方式', type: 'select', half: true, options: [{ value: 'unit_cost', label: '按目标单位成本' }, { value: 'usage', label: '按目标使用量' }], required: true },
      { key: 'costBasisAmount', label: '目标成本基数（创建后冻结）', type: 'number', half: true, defaultValue: defaultCost, required: true },
      { key: 'targetUnitCost', label: '目标单位成本', type: 'number', half: true },
      { key: 'targetUsage', label: '目标使用量', type: 'number', half: true },
      { key: 'startDate', label: '开始日期', type: 'date', half: true, defaultValue: asOf, required: true },
      { key: 'status', label: '状态', type: 'select', half: true, options: [{ value: 'active', label: '进行中' }, { value: 'achieved', label: '已达成' }, { value: 'cancelled', label: '已取消' }] },
      { key: 'note', label: '备注', type: 'textarea' },
    ],
    toValues: (goal) => ({ name: goal.name, metricId: goal.metricId ?? '__day__', mode: goal.mode, costBasisAmount: goal.costBasisAmount, targetUnitCost: goal.targetUnitCost ?? '', targetUsage: goal.targetUsage, startDate: goal.startDate, status: goal.status, note: goal.note ?? '' }),
    fromValues: (v, existing) => {
      const cost = D(v.costBasisAmount || 0);
      const selectedMetric = metrics.find((metric) => metric.id === v.metricId);
      const mode = v.mode as FixedAssetGoal['mode'];
      const unitCost = mode === 'unit_cost' ? D(v.targetUnitCost || 0) : cost.div(D(v.targetUsage || 1));
      const targetUsage = mode === 'unit_cost' ? cost.div(D(v.targetUnitCost || 1)).ceil() : D(v.targetUsage || 0);
      return {
        ...base(existing), fixedAssetId: existing?.fixedAssetId ?? fixedAssetId, name: v.name,
        metricId: v.metricId === '__day__' ? undefined : v.metricId,
        unit: v.metricId === '__day__' ? 'day' : selectedMetric?.unit ?? 'custom', customUnit: selectedMetric?.customUnit,
        mode, costBasisAmount: cost.toString(), targetUnitCost: unitCost.toString(), targetUsage: targetUsage.toString(),
        startDate: v.startDate, status: v.status as FixedAssetGoal['status'], note: S(v.note),
      } as FixedAssetGoal;
    },
    validate: (v) => {
      if (D(v.costBasisAmount || 0).lte(0)) return { costBasisAmount: '目标成本基数必须大于 0' } as Record<string, string>;
      if (v.mode === 'unit_cost' && D(v.targetUnitCost || 0).lte(0)) return { targetUnitCost: '目标单位成本必须大于 0' } as Record<string, string>;
      if (v.mode === 'usage' && D(v.targetUsage || 0).lte(0)) return { targetUsage: '目标使用量必须大于 0' } as Record<string, string>;
      return undefined;
    },
  };
}
