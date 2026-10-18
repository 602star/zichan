import { ExistingPayeePicker } from '../ui/PayeePicker.js';
import { EarlierBalancePanel } from '../ui/EarlierBalancePanel.js';
import { AccountSetupPanel } from '../ui/AccountSetupPanel.js';
import { AccountHistoryPanel } from '../ui/AccountHistoryPanel.js';
import { accountSessionStorage } from '../account-storage.js';
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { QueryGeneration } from '../query-generation.js';
import {
  D, accountBalanceTiming, isDefaultAccount, dateRangeForPreset, isDateInRange, isTransactionActive, localToday, newId,
  type BudgetCategory, type Category, type Payee, type ReconciliationSession,
  type LedgerMode, type ScheduledTransaction, type Setting, type Transaction, type TransactionSavedView, type TransactionSplit, type TransactionTemplate, type TransactionType,
} from '@zichan/core';
import {
  archiveMasterData,
  archiveScheduledTransaction,
  deleteBudgetCategory,
  deleteTransactionSavedView,
  materializeScheduledTransaction,
  previewScheduledBacklog,
  restoreArchivedMasterData,
  restoreDeletedBudgetCategory,
  restoreDeletedTransactionSavedView,
  restoreScheduledTransactionState,
  restoreTransaction,
  retryScheduledExecution,
  saveTransaction as persistTransaction,
  saveTransactionAggregate,
  voidTransaction,
  type ScheduledBacklogItem,
  type SqlLedgerStore,
  type TransactionBrowseInput,
  type TransactionBrowsePage,
  type RefundRowSummary,
  type TransactionReportAggregateRow,
  type AccountBalanceAggregateRow,
  type AccountLedgerPage,
} from '@zichan/db';
import { useStore } from '../db/store.js';
import { useSnapshot, type Snapshot } from '../db/snapshot.js';
import { CategoryPicker, EntityFormModal } from '../ui/EntityFormModal.js';
import {
  budgetCategoryForm, categoryForm, payeeForm, scheduledTransactionForm,
  transactionForm, transactionSplitForm, type AttachmentDraft, type TransactionFormValue,
} from '../forms.js';
import { amount as fmtAmount, money, signedMoney } from '../format.js';
import { amountColor, btnOutline, btnPrimary, card, cardTight, selectBase, tag as tagStyle, td as tdStyle, th as thStyle } from '../ui/styles.js';
import { ChartLegend, CompositionDonut, TrendBars, type ChartSlice } from '../ui/charts.js';
import { CATEGORY_COLORS, OTHER_CATEGORY_COLOR } from '../theme.js';
import { categoryLabel, categoryName, categoryOptions, categoryType as metaCategoryType, rootCategoryId, transactionSummaryTitle, TYPE_LABEL } from '../transactionMeta.js';
import {
  buildBudgetMonth,
  buildBudgetMonthFromAggregates,
  buildScheduleOccurrences,
  buildTransactions,
  buildTransactionsFromReadModel,
  categoryType,
  type AdvancedQueryCondition,
  type AdvancedQueryField,
  type AdvancedQueryOperator,
  type AdvancedTransactionQuery,
  type TransactionFilters,
  transactionIsReconciled,
  transactionDateRange,
  type AccountBalanceVM,
  historicalCategoryValueOptions,
} from '../selectors/transactions.js';
import { optionalTransactionFields, transactionFormPresetKeys } from '../transactionFormPrefs.js';
import { ledgerAsOfDate } from '../as-of.js';
import { moduleCurrencyId } from '../currencyPreferences.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue, type TimelineViewMode } from '../ui/DateRangeBar.js';
import {
  abortPreparedAttachments,
  commitPreparedAttachment,
  finalizePreparedAttachments,
  prepareAttachmentDraft,
  reconcileAttachmentStorage,
  type PreparedAttachment,
} from '../db/attachment-storage.js';
import { TimelineExplorer } from '../ui/TimelineExplorer.js';
import { useUndo } from '../ui/UndoToast.js';
import { resolveTransactionTags } from '../transaction-tags.js';
import { rememberTransactionPayee, withRememberedPayee } from '../payee-recording.js';
import { ReconciliationModal } from './ReconciliationModal.js';
import { DialogShell } from '../ui/DialogShell.js';
import { useCompactView } from '../ui/useCompactView.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { QuickExpenseModal, type QuickExpenseDraft } from '../ui/QuickExpenseModal.js';

const TYPE_OPTIONS: { value: 'all' | TransactionType; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
  { value: 'refund', label: '退款' },
  { value: 'adjustment', label: '余额调整' },
];
const BASIC_TYPE_OPTIONS = TYPE_OPTIONS.filter((o) => o.value !== 'transfer' && o.value !== 'adjustment');
const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待核实' },
  { value: 'cleared', label: '已记录' },
  { value: 'partially_reconciled', label: '部分对账' },
  { value: 'reconciled', label: '已对账' },
] as const;

const defaultTransactionRange = dateRangeValue('this_month');
type DrillRange = Pick<TransactionFilters, 'range' | 'dateFrom' | 'dateTo'>;
/**
 * 构成环的两级下钻状态。`child` 为空表示只下钻到板块（一级）。
 *
 * 一次下钻会改写两样东西：分类条件（`parentCategory` + `category`）和时间区间，所以
 * `before`/`after` 各留一份，退出来时区间能**原样**放回，而不是只清掉一半、把人留在
 * 自己没选过的本月里。
 *
 * 环本身不随筛选变化（画的就是本月全景），所以“当前在看哪一层”只能靠屏上的面包屑与
 * 高亮那一段表达。
 */
type CategoryDrill = {
  parent: string;
  child: string;
  before: DrillRange;
  after: DrillRange;
};
const DEFAULT_FILTERS: TransactionFilters = {
  range: defaultTransactionRange.preset,
  dateFrom: defaultTransactionRange.from,
  dateTo: defaultTransactionRange.to,
  type: 'all',
  category: 'all',
  accountId: 'all',
  payeeId: 'all',
  tagId: 'all',
  status: 'all',
  amountMin: '',
  amountMax: '',
  search: '',
};
function todayDate(): string {
  return localToday();
}

function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year || 1970, (monthNumber || 1) - 1 + delta, 1)).toISOString().slice(0, 7);
}

function trendRange(month: string, months: number): { from: string; to: string } {
  const nextMonth = shiftMonth(month, 1);
  const lastDay = new Date(`${nextMonth}-01T00:00:00.000Z`);
  lastDay.setUTCDate(0);
  return {
    from: `${shiftMonth(month, -(months - 1))}-01`,
    to: lastDay.toISOString().slice(0, 10),
  };
}

function mergeBrowsePage(current: TransactionBrowsePage, page: TransactionBrowsePage): TransactionBrowsePage {
  return {
    ...page,
    transactions: [...current.transactions, ...page.transactions],
    transactionSplits: [...current.transactionSplits, ...page.transactionSplits],
    refundAllocations: [...current.refundAllocations, ...page.refundAllocations],
    attachments: [...current.attachments, ...page.attachments],
    reconciliationItems: [...current.reconciliationItems, ...page.reconciliationItems],
    reconciliationSessions: [
      ...current.reconciliationSessions,
      ...page.reconciliationSessions.filter((row) =>
        !current.reconciliationSessions.some((currentRow) => currentRow.id === row.id)),
    ],
    refundAppliedAmounts: { ...current.refundAppliedAmounts, ...page.refundAppliedAmounts },
    refundsByOriginal: { ...current.refundsByOriginal, ...page.refundsByOriginal },
  };
}

function mergeAccountLedgerPage(current: AccountLedgerPage, page: AccountLedgerPage): AccountLedgerPage {
  return { ...page, rows: [...current.rows, ...page.rows] };
}

const selectStyle = selectBase;

const button = btnOutline;
const primary = btnPrimary;

type Tab = 'records' | 'accounts' | 'budget' | 'bills';

function initialTransactionTab(): Tab {
  try {
    const requested = accountSessionStorage.getItem('zichan.transactions.tab');
    accountSessionStorage.removeItem('zichan.transactions.tab');
    return requested === 'accounts' || requested === 'budget' || requested === 'bills' ? requested : 'records';
  } catch {
    return 'records';
  }
}

export function Transactions() {
  const compactView = useCompactView();
  const { store, bump, rev } = useStore();
  const undo = useUndo(store, bump);
  const snap = useSnapshot('transactions');
  const [tab, setTab] = useState<Tab>(initialTransactionTab);
  const [editingTx, setEditingTx] = useState<Transaction | 'new' | null>(null);
  const [showFirstEntryGuide, setShowFirstEntryGuide] = useState(false);
  const [refundDraft, setRefundDraft] = useState<Transaction | null>(null);
  /** The expense whose refunds the user asked to inspect. */
  const [refundHistoryFor, setRefundHistoryFor] = useState<Transaction | null>(null);
  const [templateDraft, setTemplateDraft] = useState<Transaction | null>(null);
  const [quickExpenseOpen, setQuickExpenseOpen] = useState(false);
  const [quickTemplate, setQuickTemplate] = useState<TransactionTemplate | null>(null);
  const [editingSplit, setEditingSplit] = useState<TransactionSplit | 'new' | null>(null);
  const [editingBudget, setEditingBudget] = useState<BudgetCategory | 'new' | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<ScheduledTransaction | 'new' | null>(null);
  const [editingCategory, setEditingCategory] = useState<Category | 'new' | null>(null);
  const [editingPayee, setEditingPayee] = useState<Payee | 'new' | null>(null);
  const [editingReconcile, setEditingReconcile] = useState<ReconciliationSession | 'new' | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [showVoided, setShowVoided] = useState(false);
  const [recordView, setRecordView] = useState<TimelineViewMode>('list');
  /*
   * Trend window. It is a view of the same unfiltered read the month KPIs come
   * from, so it lives here rather than in `filters`: widening it must not look
   * like narrowing the list.
   */
  const [trendMonths, setTrendMonths] = useState<3 | 6 | 12>(6);
  const [trendFocus, setTrendFocus] = useState('');
  const [recordFocusDate, setRecordFocusDate] = useState(localToday);
  const [budgetView, setBudgetView] = useState<'year' | 'month'>('month');
  const [budgetMonth, setBudgetMonth] = useState(() => localToday().slice(0, 7));
  const [billView, setBillView] = useState<TimelineViewMode>('list');
  const [billFocusDate, setBillFocusDate] = useState(localToday);
  const [billRange, setBillRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [accountId, setAccountId] = useState('');
  const [assetId, setAssetId] = useState('all');
  const [filters, setFilters] = useState<TransactionFilters>(DEFAULT_FILTERS);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [categoryDrill, setCategoryDrill] = useState<CategoryDrill | null>(null);
  const [savedViewName, setSavedViewName] = useState('本月常用查询');
  const [savedViewError, setSavedViewError] = useState('');
  const [scheduledBacklog, setScheduledBacklog] = useState<ScheduledBacklogItem[]>([]);
  const [retryingExecutionId, setRetryingExecutionId] = useState('');
  const [transactionRead, setTransactionRead] = useState<{
    page: TransactionBrowsePage;
    summaryAggregates: TransactionReportAggregateRow[];
    filteredAggregates: TransactionReportAggregateRow[];
    recommendationTransactions: Transaction[];
  } | null>(null);
  const [transactionPageBusy, setTransactionPageBusy] = useState(false);
  const [transactionReadError, setTransactionReadError] = useState('');
  const [voidedPage, setVoidedPage] = useState<TransactionBrowsePage | null>(null);
  const [budgetAggregates, setBudgetAggregates] = useState<TransactionReportAggregateRow[] | null>(null);
  const [defaultAccountTotals, setDefaultAccountTotals] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!snap || tab !== 'accounts') return;
    let cancelled = false;
    const month = localToday().slice(0, 7);
    void Promise.all(snap.accounts.filter(isDefaultAccount).map(async (a) => {
      const rows = await store.transactionReportAggregate({ accountId: a.id, from: month + '-01', to: month + '-31' });
      const totals = new Map<string, string>();
      for (const row of rows) for (const value of row.amounts) totals.set(row.reportAssetId, D(totals.get(row.reportAssetId) ?? 0).plus(value).toString());
      return [a.id, [...totals].map(([id, value]) => value + ' ' + (snap.assets.find((asset) => asset.id === id)?.code ?? id)).join(' / ') || '0'] as const;
    })).then((rows) => { if (!cancelled) setDefaultAccountTotals(Object.fromEntries(rows)); }).catch(() => { if (!cancelled) setDefaultAccountTotals({}); });
    return () => { cancelled = true; };
  }, [snap, tab, rev, store]);
  const [accountBalanceAggregates, setAccountBalanceAggregates] = useState<AccountBalanceAggregateRow[]>([]);
  const [accountLedgerPage, setAccountLedgerPage] = useState<AccountLedgerPage | null>(null);
  const [accountLedgerBusy, setAccountLedgerBusy] = useState(false);
  const ledgerMode: LedgerMode = snap?.setting?.ledgerMode ?? 'spending';
  const usesAccounts = true;
  const [accountSetupOpen, setAccountSetupOpen] = useState(false);
  const [accountHistoryOpen, setAccountHistoryOpen] = useState(false);
  const [earlierBalanceAccount, setEarlierBalanceAccount] = useState<import('@zichan/core').Account | null>(null);
  const [addedAccount, setAddedAccount] = useState<import('@zichan/core').Account | null>(null);

  useEffect(() => {
    const raw = accountSessionStorage.getItem('zichan.transactions.filterPreset');
    if (!raw) return;
    accountSessionStorage.removeItem('zichan.transactions.filterPreset');
    try {
      const preset = JSON.parse(raw) as Partial<TransactionFilters>;
      setFilters((cur) => {
        if (preset.range && preset.dateFrom === undefined && preset.dateTo === undefined) {
          const dates = dateRangeForPreset(preset.range, localToday());
          return { ...cur, ...preset, dateFrom: dates.from, dateTo: dates.to };
        }
        return { ...cur, ...preset };
      });
      /*
       * 报表页“在流水页整理”带过来的分类条件也要有归属：没有 `categoryDrill` 就没有
       * 面包屑，用户会看到一个没有出口的分类筛选——那正是这次要修的那个 bug。
       * 区间按预设放，所以这里把 before/after 都设成同一个值，退出时不会被改。
       */
      const parent = preset.parentCategory && preset.parentCategory !== 'all' ? preset.parentCategory : '';
      const child = preset.category && preset.category !== 'all' ? preset.category : '';
      if (parent || child) {
        const rangeFields = {
          range: preset.range ?? DEFAULT_FILTERS.range,
          dateFrom: preset.dateFrom,
          dateTo: preset.dateTo,
        };
        /* 一级缺了就留空，渲染时按二级的归属补上（旧格式的预设只有 `category`）。 */
        setCategoryDrill({ parent, child, before: rangeFields, after: rangeFields });
      }
    } catch {
      // Ignore stale navigation payloads.
    }
  }, []);
  useEffect(() => {
    if (!snap) return;
    let active = true;
    void previewScheduledBacklog(store)
      .then((rows) => { if (active) setScheduledBacklog(rows); })
      .catch(() => { if (active) setScheduledBacklog([]); });
    return () => { active = false; };
  }, [snap, store]);
  useEffect(() => {
    const openQuickTransaction = () => {
      setTab('records');
      setShowFirstEntryGuide(false);
      setEditingTx(null);
      setRefundDraft(null);
      setTemplateDraft(null);
      setEditingTx('new');
    };
    try {
      if (accountSessionStorage.getItem('zichan.quickTransaction') === '1') {
        accountSessionStorage.removeItem('zichan.quickTransaction');
        openQuickTransaction();
      }
      if (accountSessionStorage.getItem('zichan.postFirstRun') === 'account-setup') {
        accountSessionStorage.removeItem('zichan.postFirstRun'); setTab('accounts'); setAccountSetupOpen(true);
      }
      if (accountSessionStorage.getItem('zichan.postFirstRun') === 'quick-expense') {
        accountSessionStorage.removeItem('zichan.postFirstRun');
        if (compactView) {
          setTab('records');
          setShowFirstEntryGuide(true);
        } else {
          openQuickTransaction();
        }
      }
    } catch {
      // Ignore storage failures; the live event below still works.
    }
    window.addEventListener('zichan:quick-transaction', openQuickTransaction);
    return () => window.removeEventListener('zichan:quick-transaction', openQuickTransaction);
  }, [compactView, ledgerMode]);
  const visibleTabs: [Tab, string][] = usesAccounts
    ? [['records', '流水'], ['accounts', '账户'], ['budget', '预算'], ['bills', '账单']]
    : [['records', '支出']];
  const activeTab = usesAccounts ? tab : 'records';
  const viewFilters = useMemo<TransactionFilters>(() => {
    if (usesAccounts) return filters;
    return {
      ...filters,
      type: 'expense',
      accountId: 'all',
    };
  }, [filters, usesAccounts]);
  const queryAsOf = snap ? ledgerAsOfDate(snap) : todayDate();
  const transactionQuery = useRef(new QueryGeneration());
  const accountQuery = useRef(new QueryGeneration());
  const queryDateRange = transactionDateRange(queryAsOf, viewFilters);
  const browseInput = useMemo<TransactionBrowseInput>(() => ({
    from: queryDateRange.from,
    to: queryDateRange.to,
    type: viewFilters.type === 'all' ? undefined : viewFilters.type,
    excludeTypes: usesAccounts ? undefined : ['transfer', 'adjustment'],
    category: viewFilters.category === 'all' ? undefined : viewFilters.category,
    parentCategory: !viewFilters.parentCategory || viewFilters.parentCategory === 'all' ? undefined : viewFilters.parentCategory,
    accountId: viewFilters.accountId === 'all' ? undefined : viewFilters.accountId,
    payeeId: !viewFilters.payeeId || viewFilters.payeeId === 'all' ? undefined : viewFilters.payeeId,
    tagId: !viewFilters.tagId || viewFilters.tagId === 'all' ? undefined : viewFilters.tagId,
    status: !viewFilters.status || viewFilters.status === 'all' ? undefined : viewFilters.status,
    // Keep the user's decimal text intact. The repository validates finite
    // Decimal values and reports invalid input through transactionReadError.
    amountMin: viewFilters.amountMin?.trim() || undefined,
    amountMax: viewFilters.amountMax?.trim() || undefined,
    search: viewFilters.search,
    advanced: viewFilters.advanced ? {
      groups: viewFilters.advanced.groups.map((group) => ({
        conditions: group.conditions.map(({ field, op, value, value2 }) => ({ field, op, value, value2 })),
      })),
    } : undefined,
    recordState: 'active',
  }), [queryDateRange.from, queryDateRange.to, usesAccounts, viewFilters]);
  useEffect(() => {
    if (!snap) return;
    const gate = transactionQuery.current;
    gate.reset();
    const token = gate.start()!;
    let cancelled = false;
    const month = queryAsOf.slice(0, 7);
    const summaryRange = trendRange(month, trendMonths);
    setTransactionPageBusy(true);
    setTransactionReadError('');
    void Promise.all([
      store.transactionBrowsePage({ ...browseInput, limit: 100 }),
      store.transactionBrowseAggregate(browseInput),
      store.transactionReportAggregate(summaryRange),
      store.transactions.list({ where: { type: 'expense' }, orderBy: 'date', desc: true, limit: 1000 }),
    ]).then(([page, filteredAggregates, summaryAggregates, recommendationTransactions]) => {
      if (!cancelled) {
        setTransactionRead({
          page,
          filteredAggregates,
          summaryAggregates,
          recommendationTransactions,
        });
        setSelectedIds([]);
      }
    }).catch((error) => {
      if (!cancelled) {
        setTransactionRead(null);
        setTransactionReadError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      gate.finish(token);
      if (!cancelled) setTransactionPageBusy(false);
    });
    return () => {
      cancelled = true;
      gate.reset();
    };
  }, [browseInput, queryAsOf, rev, snap, store, trendMonths]);
  useEffect(() => {
    if (!showVoided) {
      setVoidedPage(null);
      return;
    }
    let cancelled = false;
    void store.transactionBrowsePage({
      from: queryDateRange.from,
      to: queryDateRange.to,
      recordState: 'voided',
      excludeTypes: usesAccounts ? undefined : ['transfer', 'adjustment'],
      limit: 500,
    }).then((page) => {
      if (!cancelled) setVoidedPage(page);
    }).catch((error) => {
      if (!cancelled) setTransactionReadError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [queryDateRange.from, queryDateRange.to, rev, showVoided, store, usesAccounts]);
  useEffect(() => {
    if (activeTab !== 'budget' || !snap) return;
    let cancelled = false;
    const firstBudgetMonth = snap.budgetCategories
      .filter((row) => !row.isDeleted)
      .map((row) => row.month)
      .sort()[0];
    void store.transactionReportAggregate({
      from: firstBudgetMonth ? `${firstBudgetMonth}-01` : undefined,
      to: `${budgetMonth.slice(0, 4)}-12-31`,
    }).then((rows) => {
      if (!cancelled) setBudgetAggregates(rows);
    }).catch((error) => {
      if (!cancelled) setTransactionReadError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab, budgetMonth, rev, snap, store]);
  useEffect(() => {
    if (!usesAccounts) {
      setAccountBalanceAggregates([]);
      return;
    }
    let cancelled = false;
    void store.accountBalanceAggregates()
      .then((rows) => {
        if (!cancelled) setAccountBalanceAggregates(rows);
      })
      .catch((error) => {
        if (!cancelled) setTransactionReadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [rev, store, usesAccounts]);
  const accountBalanceRows = useMemo<AccountBalanceVM[]>(() => {
    if (!snap) return [];
    return accountBalanceAggregates
      .map((row) => ({
        accountId: row.accountId,
        accountName: snap.accounts.find((account) => account.id === row.accountId)?.name ?? row.accountId,
        assetId: row.assetId,
        assetCode: snap.assets.find((asset) => asset.id === row.assetId)?.code ?? row.assetId,
        amount: row.amounts.reduce((total, amount) => total.plus(amount), D(0)).toString(),
      }))
      .filter((row) => !D(row.amount).isZero())
      .sort((left, right) => left.accountName.localeCompare(right.accountName) || left.assetCode.localeCompare(right.assetCode));
  }, [accountBalanceAggregates, snap]);
  const selectedAccountForRead = accountId || accountBalanceRows[0]?.accountId || snap?.accounts.find((a) => !isDefaultAccount(a) && a.kind !== 'other')?.id || '';
  const selectedAssetForRead = assetId === 'all' ? undefined : assetId;
  useEffect(() => {
    const gate = accountQuery.current;
    gate.reset();
    if (activeTab !== 'accounts' || !selectedAccountForRead) return;
    const token = gate.start()!;
    let cancelled = false;
    setAccountLedgerBusy(true);
    void store.accountLedgerPage({
      accountId: selectedAccountForRead,
      assetId: selectedAssetForRead,
      from: queryDateRange.from,
      to: queryDateRange.to,
      limit: 100,
    }).then((page) => {
      if (!cancelled) setAccountLedgerPage(page);
    }).catch((error) => {
      if (!cancelled) setTransactionReadError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      gate.finish(token);
      if (!cancelled) setAccountLedgerBusy(false);
    });
    return () => {
      cancelled = true;
      gate.reset();
    };
  }, [
    activeTab,
    queryDateRange.from,
    queryDateRange.to,
    rev,
    selectedAccountForRead,
    selectedAssetForRead,
    store,
  ]);
  const pageSnap = useMemo<Snapshot | null>(() => {
    if (!snap || !transactionRead) return null;
    return {
      ...snap,
      transactions: transactionRead.page.transactions,
      transactionSplits: transactionRead.page.transactionSplits,
      refundAllocations: transactionRead.page.refundAllocations,
      attachments: transactionRead.page.attachments,
      reconciliationItems: transactionRead.page.reconciliationItems,
      reconciliationSessions: snap.reconciliationSessions,
      scheduledTransactions: usesAccounts
        ? snap.scheduledTransactions
        : snap.scheduledTransactions.filter((schedule) => schedule.type !== 'transfer'),
    };
  }, [snap, transactionRead, usesAccounts]);
  const vm = useMemo(() => (
    snap && pageSnap && transactionRead
      ? buildTransactionsFromReadModel(snap, viewFilters, {
        page: pageSnap,
        summaryAggregates: transactionRead.summaryAggregates,
        trendMonths,
        filteredAggregates: transactionRead.filteredAggregates,
        filteredCount: transactionRead.page.totalCount,
        accountBalances: accountBalanceRows,
      })
      : null
  ), [accountBalanceRows, pageSnap, snap, transactionRead, trendMonths, viewFilters]);
  if (!snap || !transactionRead || !vm || !pageSnap) return transactionReadError
    ? <div role="alert" style={{ ...cardTight, color: 'var(--negative)' }}>流水读取失败：{transactionReadError}</div>
    : null;
  const readyTransactionRead = transactionRead;
  const readySnap = pageSnap;
  const readyVm = vm;
  /*
   * 渲染用的下钻视图：一级优先取状态里的值，缺了就按二级的归属补上——报表页
   * “在流水页整理”带过来的旧格式预设只有 `category`。补在渲染层而不是状态里，
   * 是因为分类目录要等快照到位才拿得到。
   */
  const drillView: CategoryDrill | null = categoryDrill
    ? { ...categoryDrill, parent: categoryDrill.parent || (categoryDrill.child ? rootCategoryId(categoryDrill.child, readySnap.categories) : '') }
    : null;

  const asOf = ledgerAsOfDate(readySnap);
  const activeDateRange = transactionDateRange(asOf, viewFilters);
  const activeDateValue: DateRangeValue = { preset: viewFilters.range, from: activeDateRange.from, to: activeDateRange.to };
  const activeFilterCount = [
    viewFilters.type !== 'all',
    viewFilters.category !== 'all' || Boolean(viewFilters.parentCategory && viewFilters.parentCategory !== 'all'),
    viewFilters.accountId !== 'all',
    Boolean(viewFilters.payeeId && viewFilters.payeeId !== 'all'),
    Boolean(viewFilters.tagId && viewFilters.tagId !== 'all'),
    Boolean(viewFilters.status && viewFilters.status !== 'all'),
    Boolean(viewFilters.amountMin),
    Boolean(viewFilters.amountMax),
    Boolean(viewFilters.search.trim()),
    Boolean(viewFilters.advanced?.groups.length),
  ].filter(Boolean).length;
  const selectedAccountId = selectedAccountForRead;
  const selectedAssetId = assetId === 'all' ? undefined : assetId;
  const ledger = (accountLedgerPage?.rows ?? []).map((row) => {
    const asset = readySnap.assets.find((item) => item.id === row.assetId);
    const quantity = D(row.postingAmount);
    const displayAmount = `${quantity.isZero() ? '' : quantity.isNegative() ? '−' : '+'}${fmtAmount(quantity.abs(), asset?.decimals ?? 8)}`;
    if (row.conversion) {
      const { chain, step } = row.conversion;
      const fromCode = readySnap.assets.find((asset) => asset.id === step.fromAssetId)?.code ?? step.fromAssetId;
      const toCode = readySnap.assets.find((asset) => asset.id === step.toAssetId)?.code ?? step.toAssetId;
      const typeLabel: Record<string, string> = {
        buy: '买入', sell: '卖出', swap: '资产互换', exchange: '换汇',
        dca: '定投', deposit: '入金', withdraw: '提现',
      };
      return {
        id: row.entryId,
        title: chain.title || `${fromCode} → ${toCode}`,
        categoryLabel: typeLabel[chain.type] ?? '资产转换',
        date: row.date,
        statusLabel: '已记录',
        amount: row.postingAmount,
        displayAmount,
        balance: row.balance,
        assetCode: asset?.code ?? row.assetId,
      };
    }
    const transaction = row.transaction;
    if (!transaction) return null;
    const specialCategoryLabel = transaction.type === 'transfer'
      ? '转账'
      : transaction.type === 'adjustment' ? '对账调整' : undefined;
    return {
      id: row.entryId,
      title: transactionSummaryTitle(
        transaction,
        readySnap.payees,
        specialCategoryLabel ?? categoryName(transaction.category, readySnap.categories),
      ),
      categoryLabel: specialCategoryLabel ?? categoryLabel(transaction.category, readySnap.categories),
      date: transaction.date,
      statusLabel: row.reconciliationStatus === 'reconciled'
        ? '已对账'
        : row.reconciliationStatus === 'partially_reconciled'
          ? '部分对账'
          : row.reconciliationStatus === 'pending' ? '待核实' : '已记录',
      amount: row.postingAmount,
      displayAmount,
      balance: row.balance,
      assetCode: asset?.code ?? row.assetId,
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null);
  const reconciliationRows = readySnap.reconciliationSessions.filter((row) => isDateInRange(row.statementDate, activeDateRange));
  const budgetRows = budgetAggregates
    ? buildBudgetMonthFromAggregates(readySnap, budgetMonth, budgetAggregates)
    : buildBudgetMonth(readySnap, budgetMonth);
  const budgetYearRows = Array.from({ length: 12 }, (_, index) => {
    const month = `${budgetMonth.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`;
    const rows = budgetAggregates
      ? buildBudgetMonthFromAggregates(readySnap, month, budgetAggregates)
      : buildBudgetMonth(readySnap, month);
    return { month, rows, planned: rows.reduce((total, row) => total.plus(row.available), D(0)), actual: rows.reduce((total, row) => total.plus(row.actual), D(0)) };
  });
  const billOccurrences = buildScheduleOccurrences(readySnap, billRange);
  const scheduleById = new Map(readySnap.scheduledTransactions.map((schedule) => [schedule.id, schedule]));
  const executionHistory = [...readySnap.scheduledExecutions]
    .filter((execution) => !execution.isDeleted)
    .sort((left, right) =>
      (right.attemptedAt ?? right.updatedAt).localeCompare(left.attemptedAt ?? left.updatedAt))
    .slice(0, 50);
  const accountAssets = [...new Set(readyVm.accountBalances.filter((b) => b.accountId === selectedAccountId).map((b) => b.assetId))];
  const activeTemplates = readySnap.transactionTemplates
    .filter((t) => !t.isDeleted && t.isActive && (usesAccounts || t.type === 'expense'))
    .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100) || a.name.localeCompare(b.name));
  const tagName = (id: string) => {
    const t = readySnap.transactionTags.find((x) => x.id === id);
    return t ? (t.groupName ? `${t.groupName}/${t.name}` : t.name) : id;
  };
  const locationName = (tx: Transaction) =>
    tx.locationId ? readySnap.transactionLocations.find((l) => l.id === tx.locationId)?.name ?? tx.locationName ?? tx.locationId : tx.locationName;
  const txAttachments = (txId: string) => readySnap.attachments.filter((a) => !a.isDeleted && a.entityType === 'transaction' && a.entityId === txId);
  const isLeafCategory = (category: string) => isLeafTransactionCategory(category, readySnap);
  const savedViews = readySnap.transactionSavedViews
    .filter((v) => !v.isDeleted && v.isActive)
    .sort((a, b) => Number(b.isPinned ?? false) - Number(a.isPinned ?? false) || (a.sortOrder ?? 100) - (b.sortOrder ?? 100) || a.name.localeCompare(b.name));

  function openNewTransaction() {
    setShowFirstEntryGuide(false);
    setQuickExpenseOpen(false);
    setQuickTemplate(null);
    setRefundDraft(null);
    setTemplateDraft(null);
    setEditingTx('new');
  }

  async function loadMoreTransactions() {
    const cursor = readyTransactionRead.page.nextCursor;
    if (!cursor || !readyTransactionRead.page.hasMore || transactionPageBusy) return;
    const gate = transactionQuery.current;
    const token = gate.start();
    if (!token) return;
    setTransactionPageBusy(true);
    setTransactionReadError('');
    try {
      const page = await store.transactionBrowsePage({ ...browseInput, cursor, limit: 100 });
      setTransactionRead((current) => gate.current(token) && current
        ? { ...current, page: mergeBrowsePage(current.page, page) }
        : current);
    } catch (error) {
      if (gate.current(token)) setTransactionReadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (gate.current(token)) setTransactionPageBusy(false);
      gate.finish(token);
    }
  }

  async function loadMoreAccountLedger() {
    if (!accountLedgerPage?.hasMore || !accountLedgerPage.nextCursor || accountLedgerBusy || !selectedAccountId) return;
    const gate = accountQuery.current;
    const token = gate.start();
    if (!token) return;
    setAccountLedgerBusy(true);
    setTransactionReadError('');
    try {
      const page = await store.accountLedgerPage({
        accountId: selectedAccountId,
        assetId: selectedAssetId,
        from: activeDateRange.from,
        to: activeDateRange.to,
        cursor: accountLedgerPage.nextCursor,
        startingBalances: accountLedgerPage.nextStartingBalances,
        limit: 100,
      });
      setAccountLedgerPage((current) => gate.current(token) && current ? mergeAccountLedgerPage(current, page) : current);
    } catch (error) {
      if (gate.current(token)) setTransactionReadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (gate.current(token)) setAccountLedgerBusy(false);
      gate.finish(token);
    }
  }

  function openTransaction(transaction: Transaction) {
    if (transaction.type === 'adjustment' && transaction.reconciliationSessionId) {
      const session = readySnap.reconciliationSessions.find((row) => row.id === transaction.reconciliationSessionId);
      if (session) {
        setEditingReconcile(session);
        return;
      }
    }
    setEditingTx(transaction);
  }

  /** The refund rows of one expense, newest first. Available even on a 支出-scoped page. */
  function refundsOf(original: Transaction): RefundRowSummary[] {
    return readyTransactionRead.page.refundsByOriginal[original.id] ?? [];
  }

  function assetCodeOf(assetId: string): string {
    return readySnap.assets.find((asset) => asset.id === assetId)?.code ?? assetId;
  }

  /**
   * Refund rows are filtered out of a 支出-scoped page, so the refund being edited
   * is fetched on demand rather than read out of the snapshot.
   */
  async function openRefundEditor(refundId: string) {
    const refund = await store.transactions.get(refundId);
    setRefundHistoryFor(null);
    if (refund) setEditingTx(refund);
  }

  /**
   * What is still refundable. `excludeRefundId` answers the same question from the
   * point of view of one refund being edited, which must not count itself.
   */
  function remainingRefundAmount(original: Transaction, excludeRefundId?: string): string {
    if (original.type !== 'expense' || !isTransactionActive(original)) return '0';
    const refunded = refundsOf(original)
      .filter((refund) => refund.id !== excludeRefundId)
      .reduce((total, refund) => total.plus(refund.appliedAmount), D(0));
    const remaining = D(original.amount).minus(refunded);
    return (remaining.gt(0) ? remaining : D(0)).toString();
  }

  /** Remaining refundable amount for the refund form currently open, if any. */
  function refundFormRemaining(): string | undefined {
    const editing = editingTx === 'new' ? refundDraft : editingTx;
    if (!editing || editing.type !== 'refund' || !editing.refundForId) return undefined;
    const original = readySnap.transactions.find((row) => row.id === editing.refundForId);
    if (!original) return undefined;
    return remainingRefundAmount(original, editingTx === 'new' ? undefined : editing.id);
  }

  function startRefund(original: Transaction) {
    const remaining = remainingRefundAmount(original);
    if (D(remaining).lte(0)) return;
    const now = new Date();
    const description = original.description ?? original.merchant ?? categoryLabel(original.category, readySnap.categories);
    setRefundDraft({
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      date: todayDate(),
      time: now.toTimeString().slice(0, 5),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '系统默认',
      type: 'refund',
      category: original.category,
      amount: remaining,
      assetId: original.assetId,
      accountId: original.accountId,
      payeeId: original.payeeId,
      merchant: original.merchant,
      description: `退款 · ${description}`,
      tagIds: original.tagIds,
      locationId: original.locationId,
      locationName: original.locationName,
      status: 'cleared',
      refundForId: original.id,
      refundAppliedAmount: remaining,
      refundAppliedAssetId: original.assetId,
      recordState: 'active',
    });
    setEditingTx('new');
  }

  async function saveCurrentView(nameInput: string) {
    const name = nameInput.trim();
    if (!name) return;
    const saved: TransactionSavedView = {
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      name,
      queryJson: JSON.stringify(viewFilters),
      sortOrder: savedViews.length + 1,
      isPinned: true,
      isActive: true,
    };
    await store.runInAuditBatch(
      `保存筛选“${saved.name}”`,
      (transactionStore) => transactionStore.transactionSavedViews.put(saved),
    );
    setSavedViewName('本月常用查询');
    setSavedViewError('');
    bump();
  }

  function clearOtherFilters() {
    setFilters((current) => ({ ...DEFAULT_FILTERS, range: current.range, dateFrom: current.dateFrom, dateTo: current.dateTo }));
    setCategoryDrill(null);
    setSelectedIds([]);
    setSavedViewError('');
  }

  function applySavedView(view: TransactionSavedView) {
    try {
      const parsed = JSON.parse(view.queryJson) as Partial<TransactionFilters>;
      setFilters({ ...DEFAULT_FILTERS, ...parsed });
      /* 保存的查询自带它自己的分类条件，所以环的下钻状态不再成立——留着的话
       * 面包屑会指着一个已经不在生效的筛选。 */
      setCategoryDrill(null);
      setSelectedIds([]);
    } catch {
      setSavedViewError('保存的筛选条件无法解析，请删除后重新保存。');
    }
  }

  /*
   * 筛选行里手动改分类。两件事都要做，缺一个就会留下一个「点了等于没点」的筛选：
   *
   * - **清空时连一级一起清。** 之前只把 `category` 置回 all，`parentCategory` 留着，
   *   于是控件写着「全部分类」而列表仍按那个板块筛——界面上既没生效提示，也没有出口。
   *   选了二级时仍然记下它的一级：那时一级只是归属，写上是为了防止与别处的一级筛选
   *   打架（下钻到 A 后再从控件里挑 B 的二级，两个条件同时生效会得到空列表）。
   * - **环的下钻不再成立。** 下钻是它写进筛选的，用户自己改了分类后就该让位（与
   *   `applySavedView` 同一条规矩），否则面包屑会指着一个已经不在生效的筛选。但新值
   *   仍落在下钻那一层里时（下钻到板块后又选了它的二级）下钻继续有效，面包屑和它记着
   *   的区间都不该丢。
   */
  function changeCategoryFilter(next: string) {
    setCategoryDrill((drill) => {
      if (!drill) return null;
      const parent = drill.parent || (drill.child ? rootCategoryId(drill.child, readySnap.categories) : '');
      const nextParent = next ? rootCategoryId(next, readySnap.categories) : '';
      const stillInside = next !== '' && parent === nextParent && (!drill.child || drill.child === next);
      return stillInside ? drill : null;
    });
    setFilters((current) => (next
      ? { ...current, category: next, parentCategory: rootCategoryId(next, readySnap.categories) }
      : { ...current, category: 'all', parentCategory: 'all' }));
  }

  async function removeSavedView(view: TransactionSavedView) {
    const compensation = await deleteTransactionSavedView(store, view.id, view.version);
    bump();
    undo.offer(`保存筛选“${view.name}”已删除`, async () => {
      await restoreDeletedTransactionSavedView(store, compensation);
      bump();
    });
  }

  async function renameSavedView(view: TransactionSavedView, name: string) {
    const next = name.trim();
    if (!next) return;
    await store.runInAuditBatch(
      `重命名保存筛选“${view.name}”`,
      (transactionStore) => transactionStore.transactionSavedViews.put({ ...view, name: next }),
    );
    bump();
  }

  async function toggleSavedViewPin(view: TransactionSavedView) {
    await store.runInAuditBatch(
      `${view.isPinned ? '取消固定' : '固定'}保存筛选“${view.name}”`,
      (transactionStore) => transactionStore.transactionSavedViews.put({ ...view, isPinned: !view.isPinned }),
    );
    bump();
  }

  async function saveTransactionFormFields(keys: string[]) {
    const cur: Setting = readySnap.setting ?? {
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      baseCurrencyAssetId: readySnap.assets[0]?.id ?? '', defaultLotMethod: 'fifo',
      ledgerMode: 'spending', asOfDate: todayDate(), categoryPickerDefaultScope: 'frequent', refundAttributionMode: 'original_date',
    };
    await store.runInAuditBatch(
      '调整记账表单字段',
      (transactionStore) => transactionStore.settings.put({ ...cur, transactionFormOptionalFields: keys.join(',') }),
    );
    bump();
  }

  async function rememberLocation(store: SqlLedgerStore, entity: Transaction): Promise<Pick<Transaction, 'locationId' | 'locationName' | 'latitude' | 'longitude' | 'locationAccuracyMeters'>> {
    const name = entity.locationName?.trim();
    const coordinates = { latitude: entity.latitude, longitude: entity.longitude, locationAccuracyMeters: entity.locationAccuracyMeters };
    if (entity.locationId || !name) return { locationId: entity.locationId, locationName: name || entity.locationName, ...coordinates };
    if (name === '当前位置' && entity.latitude && entity.longitude) return { locationName: name, ...coordinates };
    const found = readySnap.transactionLocations.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (found) return { locationId: found.id, locationName: found.name, ...coordinates };
    const l = await store.transactionLocations.put({
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      name, latitude: entity.latitude, longitude: entity.longitude, isActive: true,
    });
    return { locationId: l.id, locationName: l.name, ...coordinates };
  }

  async function prepareAttachments(store: SqlLedgerStore, txId: string, drafts: AttachmentDraft[] = []) {
    const existing = await store.attachments.list({ where: { entityType: 'transaction', entityId: txId } });
    const existingIds = new Set(existing.map((row) => row.id));
    const prepared: PreparedAttachment[] = [];
    try {
      for (const draft of drafts.filter((row) => row.fileName && (row.contentBlob || row.sha256))) {
        const id = draft.id ?? newId();
        prepared.push(await prepareAttachmentDraft(store, id, draft, existingIds.has(id) ? 'replace' : 'create'));
      }
    } catch (error) {
      await abortPreparedAttachments(store, prepared);
      throw error;
    }
    return {
      prepared,
      removeIds: existing.filter((row) => !new Set(prepared.map((item) => item.attachmentId)).has(row.id)).map((row) => row.id),
    };
  }

  async function saveTx(
    entity: Transaction | TransactionFormValue,
    activeStore: SqlLedgerStore = store,
    refresh = true,
  ): Promise<Transaction> {
    if (D(entity.amount).lte(0)) throw new Error('金额必须大于 0');
    const clean = { ...(entity as TransactionFormValue) };
    const drafts = clean.attachmentDrafts ?? [];
    const refundAllocationDrafts = clean.refundAllocationDrafts;
    delete clean.attachmentDrafts;
    delete clean.refundAllocationDrafts;
    let next: Transaction = { ...clean, status: clean.status ?? 'cleared' };
    if (next.type === 'transfer') {
      if (!next.accountId || !next.transferAccountId) throw new Error('转账需要填写转出和转入账户');
      next = {
        ...next,
        category: next.category || 'other_expense',
        transferAssetId: next.transferAssetId || next.assetId,
        transferAmount: next.transferAmount || next.amount,
      };
    } else if (next.type !== 'adjustment') {
      if (!isLeafCategory(next.category)) throw new Error('请选择二级分类，不能直接选择一级分类');
      const catType = metaCategoryType(next.category, readySnap.categories) ?? categoryType(next.category, readySnap);
      const expectedCategoryType = next.type === 'refund' ? 'expense' : next.type as 'income' | 'expense';
      if (catType !== expectedCategoryType) throw new Error('分类与收入/支出类型不匹配');
      next = { ...next, transferAssetId: undefined, transferAccountId: undefined, transferAmount: undefined };
    }
    if (next.locationId) {
      const location = readySnap.transactionLocations.find((row) => row.id === next.locationId);
      if (location) {
        next = {
          ...next,
          locationName: location.name,
          latitude: location.latitude,
          longitude: location.longitude,
          locationAccuracyMeters: undefined,
        };
      }
    }
    const before = await activeStore.transactions.get(next.id);
    const beforeAttachments = before
      ? await activeStore.attachments.list({ includeDeleted: true, where: { entityType: 'transaction', entityId: next.id } })
      : [];
    const attachmentPlan = await prepareAttachments(activeStore, next.id, drafts);
    let committed = false;
    let saved: Transaction;
    try {
      saved = await activeStore.runInAuditBatch('保存流水及附件', async (transactionStore) => {
        const tagIds = await resolveTransactionTags(transactionStore, next.tagIds);
        const payeeId = await rememberTransactionPayee(transactionStore, next);
        const loc = await rememberLocation(transactionStore, next);
        const transaction = (await saveTransactionAggregate(transactionStore, {
          transaction: { ...next, tagIds, payeeId, ...loc },
          expectedVersion: next.version,
          refundAllocations: next.type === 'refund' && next.refundAllocationMode === 'specified'
            ? refundAllocationDrafts
            : undefined,
        })).transaction;
        for (const prepared of attachmentPlan.prepared) {
          await commitPreparedAttachment(transactionStore, prepared, 'transaction', transaction.id);
        }
        for (const id of attachmentPlan.removeIds) {
          const attachment = beforeAttachments.find((row) => row.id === id);
          if (attachment) await transactionStore.attachments.remove(id, attachment.version);
        }
        return transaction;
      });
      committed = true;
      await finalizePreparedAttachments(activeStore, attachmentPlan.prepared);
      await reconcileAttachmentStorage(activeStore);
    } catch (error) {
      if (!committed) await abortPreparedAttachments(activeStore, attachmentPlan.prepared);
      throw error;
    }
    if (refresh) {
      bump();
      if (!before) {
        undo.offer(`已保存${saved.type === 'refund' ? '退款' : '流水'}`, async () => {
          await voidTransaction(store, saved.id, '撤销刚才的新增');
          bump();
        });
      } else {
        undo.offer('已保存流水修改', async () => {
          const current = await store.transactions.get(saved.id);
          if (!current || current.version !== saved.version) throw new Error('该流水后来又被修改，不能直接撤销');
          await store.transaction(async (transactionStore) => {
            await persistTransaction(transactionStore, { ...before, version: current.version });
            const currentAttachments = await transactionStore.attachments.list({ includeDeleted: true, where: { entityType: 'transaction', entityId: saved.id } });
            const oldIds = new Set(beforeAttachments.map((row) => row.id));
            for (const attachment of beforeAttachments) await transactionStore.attachments.put({ ...attachment, isDeleted: false });
            for (const attachment of currentAttachments.filter((row) => !row.isDeleted && !oldIds.has(row.id))) await transactionStore.attachments.remove(attachment.id, attachment.version);
          });
          await reconcileAttachmentStorage(store);
          bump();
        });
      }
    }
    return saved;
  }

  function createFromTemplate(tpl: TransactionTemplate) {
    const tx: Transaction = {
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      date: todayDate(),
      time: new Date().toTimeString().slice(0, 5),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '系统默认',
      type: tpl.type,
      category: tpl.category,
      amount: tpl.amount || '0',
      assetId: tpl.assetId || moduleCurrencyId(readySnap.setting, 'transaction', readySnap.assets[0]?.id || ''),
      accountId: usesAccounts ? tpl.accountId : undefined,
      payeeId: tpl.payeeId,
      merchant: tpl.merchant,
      description: tpl.description ?? tpl.name,
      tagIds: tpl.tagIds,
      locationId: tpl.locationId,
      note: tpl.note,
      status: 'cleared',
    };
    setQuickExpenseOpen(false);
    setQuickTemplate(null);
    setRefundDraft(null);
    setTemplateDraft(tx);
    setEditingTx('new');
  }

  async function saveQuickExpense(draft: QuickExpenseDraft) {
    await saveTx({
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      date: draft.date,
      time: draft.time,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '系统默认',
      type: 'expense',
      category: draft.category,
      amount: D(draft.amount).abs().toString(),
      assetId: draft.assetId,
      description: draft.description,
      status: 'cleared',
      recordState: 'active',
    });
  }

  async function voidTx(entity: { id: string }) {
    const saved = await voidTransaction(store, entity.id);
    bump();
    undo.offer('流水已作废', async () => {
      const current = await store.transactions.get(saved.id);
      if (!current || current.version !== saved.version) throw new Error('该流水后来又被修改，不能直接恢复');
      await restoreTransaction(store, saved.id);
      bump();
    });
  }

  async function restoreTx(entity: Transaction) {
    const saved = await restoreTransaction(store, entity.id);
    bump();
    undo.offer('流水已恢复', async () => {
      const current = await store.transactions.get(saved.id);
      if (!current || current.version !== saved.version) throw new Error('该流水后来又被修改，不能直接撤销恢复');
      await voidTransaction(store, saved.id, '撤销刚才的恢复');
      bump();
    });
  }

  async function saveSplit(entity: TransactionSplit) {
    const parent = readySnap.transactions.find((t) => t.id === entity.transactionId);
    if (!parent) throw new Error('请选择原流水');
    if (parent.type === 'refund') throw new Error('退款请在退款表单中按原单项目分配，不能使用普通拆分');
    if (!isLeafCategory(entity.category)) throw new Error('请选择二级分类，不能直接选择一级分类');
    const others = readySnap.transactionSplits.filter((s) => !s.isDeleted && !s.isRemainder && s.transactionId === entity.transactionId && s.id !== entity.id);
    await saveTransactionAggregate(store, {
      transaction: parent,
      expectedVersion: parent.version,
      splits: [...others, { ...entity, isRemainder: false }],
    });
    bump();
  }

  async function deleteSplit(entity: TransactionSplit) {
    const parent = readySnap.transactions.find((row) => row.id === entity.transactionId);
    if (!parent) throw new Error('原流水不存在');
    const remaining = readySnap.transactionSplits.filter((row) => !row.isDeleted && !row.isRemainder && row.transactionId === parent.id && row.id !== entity.id);
    await saveTransactionAggregate(store, { transaction: parent, expectedVersion: parent.version, splits: remaining });
    bump();
  }

  async function materializeSchedule(s: ScheduledTransaction) {
    if (s.status !== 'active') return;
    if (!usesAccounts && s.type === 'transfer') throw new Error('轻量模式不生成转账流水，请在设置中切换到账户模式');
    await materializeScheduledTransaction(store, s.id);
    bump();
  }

  async function retryScheduleExecution(executionId: string) {
    setRetryingExecutionId(executionId);
    try {
      await retryScheduledExecution(store, executionId);
      bump();
    } finally {
      setRetryingExecutionId('');
    }
  }

  async function saveBatchEdits(patch: BatchPatch) {
    const ids = new Set(selectedIds);
    const rows = readySnap.transactions.filter((t) => ids.has(t.id));
    if (rows.some((row) => row.type === 'adjustment' || transactionIsReconciled(readySnap, row.id))) {
      throw new Error('余额调整和已对账流水不能批量修改，请先在对账详情中解除对账');
    }
    const updates = rows.map((tx) => applyBatchPatch(tx, patch, readySnap, usesAccounts));
    const batch = await store.createAuditBatch({
      id: newId(),
      type: 'bulk_update',
      label: `批量修改 ${updates.length} 条流水`,
      entityCount: updates.length,
      summary: batchSummary(patch, readySnap),
    });
    await store.withAuditContext({ batchId: batch.id, source: 'local' }, async (store) => {
      await store.transaction(async (store) => {
        for (const next of updates) await persistTransaction(store, next);
      });
    });
    await store.finishAuditBatch(batch.id, { entityCount: updates.length, summary: batch.summary });
    setBatchOpen(false);
    setSelectedIds([]);
    bump();
  }

  /*
   * 从构成环下钻。环是「一级板块 → 二级细分」两级，左环画全部板块，右环画选中那一个
   * 板块的细分；所以一次下钻同时决定 `parentCategory`（一级）与 `category`（二级，可空）。
   *
   * 第一次下钻时区间一起收窄到本月——环画的就是本月这一块，不然「点一下看到的是
   * 全部时间里的所有该分类」会与刚才那个数字对不上。但已经在两级之间走的时候不再动
   * 区间，否则用户自己改过的范围会被悄悄改回本月。
   *
   * 轻量模式不渲染筛选行（`Filters` 只在资产模式下出现），所以下钻必须是**可撤销**、
   * 且当前层级必须写在屏幕上（面包屑）：否则点一下就把账本锁进一个看不见的筛选里。
   */
  function drillTo(parent: string, child: string) {
    const started = categoryDrill;
    const monthRange = dateRangeValue('this_month');
    setCategoryDrill({
      parent,
      child,
      before: started?.before ?? { range: filters.range, dateFrom: filters.dateFrom, dateTo: filters.dateTo },
      after: started?.after ?? { range: monthRange.preset, dateFrom: monthRange.from, dateTo: monthRange.to },
    });
    setFilters((current) => ({
      ...current,
      parentCategory: parent,
      category: child || 'all',
      ...(started ? {} : { range: monthRange.preset, dateFrom: monthRange.from, dateTo: monthRange.to }),
    }));
    setRecordView('list');
    setTrendFocus('');
    window.requestAnimationFrame(() => document.getElementById('transaction-records')?.scrollIntoView({ block: 'start' }));
  }

  /*
   * 全清。区间只在它还是下钻当时设的那个值时才能放回原样——下钻之后用户
   * 自己改过区间，那就以用户为准，只清分类。
   */
  function clearCategoryDrill() {
    const drill = categoryDrill;
    const restoreRange = drill !== null
      && filters.range === drill.after.range
      && filters.dateFrom === drill.after.dateFrom
      && filters.dateTo === drill.after.dateTo;
    setFilters((current) => ({
      ...current,
      parentCategory: 'all',
      category: 'all',
      ...(drill && restoreRange ? drill.before : {}),
    }));
    setCategoryDrill(null);
  }

  /** 退一层：从细分退回它所属的板块（区间不动）。 */
  function stepBackToParent() {
    if (!categoryDrill) return;
    setCategoryDrill({ ...categoryDrill, child: '' });
    setFilters((current) => ({ ...current, category: 'all' }));
  }

  /* 点环上高亮的那一段就是「退回上一层」：细分 → 板块 → 全部。 */
  function toggleParentDrill(parent: string) {
    if (categoryDrill?.parent !== parent) drillTo(parent, '');
    else if (categoryDrill.child) stepBackToParent();
    else clearCategoryDrill();
  }

  function toggleChildDrill(parent: string, child: string) {
    if (categoryDrill?.parent === parent && categoryDrill.child === child) stepBackToParent();
    else drillTo(parent, child);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {vm.missingRateAssetCodes.length > 0 && (
        <div style={{ ...cardTight, borderColor: 'var(--warning)', color: 'var(--warning)', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>
          缺少 {vm.missingRateAssetCodes.join('、')} → {vm.reportCurrencyCode} 的价格标记；相关流水不会静默当作 0，汇总和预算会标记为未完整折算。
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {visibleTabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={activeTab === id ? primary : button}>{label}</button>
        ))}
      </div>

      {activeTab === 'records' && (
        <>
          {compactView && showFirstEntryGuide && (
            <section className="zc-first-entry-guide" aria-label="首次记账引导">
              <div>
                <h2>账本已准备好</h2>
                <p>先看看收支概览。准备好时再记第一笔；以后也能用<span className="zc-nowrap">底部“快记”</span>。</p>
              </div>
              <div className="zc-first-entry-actions">
                <button type="button" style={primary} onClick={openNewTransaction}>记第一笔</button>
                <button type="button" style={button} onClick={() => setShowFirstEntryGuide(false)}>先看看</button>
              </div>
            </section>
          )}
          <SummaryGrid vm={vm} usesAccounts={usesAccounts} />
          <div id="transaction-records" style={{ ...card, scrollMarginTop: 16 }}>
            <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{usesAccounts ? '日常流水' : '日常支出'}</div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 3 }}>
                  {usesAccounts ? '收入、支出、转账、退款和拆分交易；资产买卖与换汇可在“账户”中核对资金流' : '完整记录支出详情；侧栏或移动端“快记”可只填金额'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => setShowVoided((value) => !value)} style={showVoided ? primary : button}>作废记录 {voidedPage?.totalCount ?? 0}</button>
                <button onClick={() => setEditingCategory('new')} style={button}>+ 分类</button>
                <button onClick={() => setEditingPayee('new')} style={button}>+ 交易对象</button>
                <button onClick={() => setEditingSplit('new')} style={button}>+ 拆分</button>
                {/* 图区在列表下方（手机上可能好几屏），所以留一个直接下去的锚点。 */}
                <button onClick={() => document.getElementById('transaction-charts')?.scrollIntoView({ block: 'start' })} style={button}>构成与趋势 ↓</button>
                <button onClick={openNewTransaction} className="zc-header-primary" style={primary}>{usesAccounts ? '+ 记账' : '+ 记支出'}</button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <DateRangeBar
                value={activeDateValue}
                onChange={(next) => setFilters((current) => ({ ...current, range: next.preset, dateFrom: next.from, dateTo: next.to }))}
                view={recordView}
                onViewChange={setRecordView}
                collapseDatesOnMobile
              />
              <button type="button" className="zc-transaction-clear-desktop" onClick={clearOtherFilters} style={button}>清除其他筛选</button>
              {/* 下钻是环写进筛选的，所以在环能到的地方必须能退出去：轻量模式没有
                  筛选行，这条面包屑是那两级筛选唯一的出口，也顺便把「现在在看哪一层」
                  写在屏上——图表本身不随筛选变化，不说清楚就只能靠猜。 */}
              {categoryDrill && (
                <nav className="zc-drill-crumbs" aria-label="分类下钻">
                  <button type="button" className="zc-drill-crumb" aria-label="退回到全部支出" onClick={clearCategoryDrill}>
                    全部支出
                  </button>
                  <span aria-hidden="true">›</span>
                  {categoryDrill.child ? (
                    <button type="button" className="zc-drill-crumb" aria-label={`退回一级：${categoryLabel(drillView?.parent ?? '', readySnap.categories)}`} onClick={stepBackToParent}>
                      {categoryLabel(drillView?.parent ?? '', readySnap.categories)}
                    </button>
                  ) : (
                    <b className="zc-drill-crumb is-current">{categoryLabel(drillView?.parent ?? '', readySnap.categories)}</b>
                  )}
                  {categoryDrill.child && (
                    <>
                      <span aria-hidden="true">›</span>
                      <b className="zc-drill-crumb is-current">{categoryLabel(categoryDrill.child, readySnap.categories)}</b>
                    </>
                  )}
                </nav>
              )}
            </div>
            {usesAccounts && (
              <button type="button" className="zc-transaction-filter-toggle" aria-expanded={mobileFiltersOpen} aria-controls="transaction-filter-panel" onClick={() => setMobileFiltersOpen((open) => !open)}>
                筛选与搜索{activeFilterCount > 0 ? ` · 已启用 ${activeFilterCount} 项` : ''}<span aria-hidden="true">{mobileFiltersOpen ? '收起' : '展开'} ▾</span>
              </button>
            )}
            {usesAccounts && (
              <div id="transaction-filter-panel" className={`zc-transaction-filter-panel${mobileFiltersOpen ? ' is-open' : ''}`}>
                <Filters snap={snap} filters={viewFilters} setFilters={setFilters} usesAccounts={usesAccounts} onCategoryChange={changeCategoryFilter} />
                <SavedViews
                  views={savedViews}
                  name={savedViewName}
                  error={savedViewError}
                  onNameChange={setSavedViewName}
                  onApply={applySavedView}
                  onSave={() => void saveCurrentView(savedViewName)}
                  onRename={(v, name) => void renameSavedView(v, name)}
                  onTogglePin={(v) => void toggleSavedViewPin(v)}
                  onRemove={(v) => void removeSavedView(v)}
                />
                <AdvancedQueryBuilder snap={snap} filters={viewFilters} setFilters={setFilters} usesAccounts={usesAccounts} />
                <button type="button" className="zc-transaction-clear-mobile" onClick={clearOtherFilters} style={button}>清除其他筛选</button>
              </div>
            )}
            {showVoided && (
              <div style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
                <div style={{ padding: '10px 0', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>已作废流水</div>
                {(voidedPage?.transactions ?? [])
                  .sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? '').localeCompare(a.time ?? ''))
                  .map((row) => (
                    <div key={row.id} className="zc-voided-row" style={{ display: 'grid', gridTemplateColumns: '130px 90px minmax(0, 1fr) 130px 72px', gap: 10, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                      <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{row.date}{row.time ? ` ${row.time}` : ''}</span>
                      <span style={{ ...tagStyle, width: 'fit-content' }}>{TYPE_LABEL[row.type]}</span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{transactionSummaryTitle(row, readySnap.payees, categoryLabel(row.category, readySnap.categories))}</span>
                      <b style={{ textAlign: 'right' }}>{row.amount} {readySnap.assets.find((asset) => asset.id === row.assetId)?.code ?? row.assetId}</b>
                      <button onClick={() => void restoreTx(row)} style={{ ...button, padding: '6px 10px' }}>恢复</button>
                    </div>
                  ))}
                {(voidedPage?.transactions.length ?? 0) === 0 && <div style={{ padding: '12px 0', fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>当前时间范围没有已作废流水。</div>}
              </div>
            )}
            {activeTemplates.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                {activeTemplates.slice(0, 10).map((tpl) => (
                  <button key={tpl.id} onClick={() => createFromTemplate(tpl)} style={button}>
                    {tpl.name}{tpl.amount ? ` · ${tpl.amount}` : ''}
                  </button>
                ))}
              </div>
            )}
            {selectedIds.length > 0 && (
              <div className="zc-responsive-action-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>已选择 {selectedIds.length} 条流水</span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setBatchOpen(true)} style={primary}>批量修改</button>
                  <button onClick={() => setSelectedIds([])} style={button}>清空选择</button>
                </span>
              </div>
            )}
            {recordView === 'list' ? (
              <TransactionList
                vm={vm}
                onEdit={openTransaction}
                usesAccounts={usesAccounts}
                tagName={tagName}
                locationName={locationName}
                attachmentCount={(tx) => txAttachments(tx.id).length}
                selectedIds={selectedIds}
                setSelectedIds={setSelectedIds}
                refundRemaining={remainingRefundAmount}
                refundsFor={refundsOf}
                onManageRefunds={setRefundHistoryFor}
                assetCode={assetCodeOf}
                onRefund={startRefund}
              />
            ) : (
              <TimelineExplorer
                items={vm.items}
                view={recordView}
                focusDate={recordFocusDate}
                onFocusDate={setRecordFocusDate}
                onViewChange={setRecordView}
                dateOf={(item) => item.tx.date}
                keyOf={(item) => item.tx.id}
                renderCompact={(item) => <>{item.tx.date.slice(8)} · <b>{item.categoryLabel}</b>{item.tx.description || item.payeeName ? ` · ${item.tx.description ?? item.payeeName}` : ''}</>}
                renderEntry={(item) => (
                  <div className="zc-transaction-timeline-entry" style={{ display: 'grid', gridTemplateColumns: '90px 120px minmax(0, 1fr) 130px', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{item.tx.date}{item.tx.time ? ` ${item.tx.time}` : ''}</span>
                    <b style={{ fontSize: 'var(--fs-caption)' }}>{item.categoryLabel}</b>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.tx.description ?? item.payeeName ?? ''}</span>
                    <b style={{ justifySelf: 'end', ...amountColor(item.signedAmount) }}>{item.tx.type === 'income' || item.tx.type === 'refund' ? '+' : item.tx.type === 'expense' ? '-' : ''}{item.tx.amount} {item.assetCode}</b>
                  </div>
                )}
                renderSummary={(rows) => {
                  const income = rows.reduce((total, row) => total.plus(row.incomeBase), D(0));
                  const expense = rows.reduce((total, row) => total.plus(row.expenseBase), D(0));
                  return <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>收 {money(income)} · 支 {money(expense)}</span>;
                }}
                onOpen={(item) => openTransaction(item.tx)}
                emptyText="该时间范围内没有日常流水。"
              />
            )}
            {(readyTransactionRead.page.hasMore || transactionReadError) && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                {readyTransactionRead.page.hasMore && (
                  <button type="button" onClick={() => void loadMoreTransactions()} disabled={transactionPageBusy} style={button}>
                    {transactionPageBusy ? '加载中…' : '继续加载 100 笔'}
                  </button>
                )}
                <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
                  已加载 {readyTransactionRead.page.transactions.length} / {readyTransactionRead.page.totalCount} 笔
                </span>
                {transactionReadError && <span role="alert" style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)' }}>{transactionReadError}</span>}
              </div>
            )}
          </div>
          {/*
            * 构成在上、趋势在下，各占一行。以前两张图并排：每张只剩半幅，而环的图例
            * 是它唯一的读法，二级分类名被挤成省略号后就等于没画。顺序也顺着阅读：
            * 先看「这个月钱花在哪」，再看「几个月下来怎么走」。
            */}
          <div id="transaction-charts" className="zc-chart-stack" style={{ scrollMarginTop: 16 }}>
            <ExpenseCompositionCard
              vm={vm}
              drill={drillView}
              parentLabel={categoryLabel(drillView?.parent ?? '', readySnap.categories)}
              onSelectParent={toggleParentDrill}
              onSelectChild={toggleChildDrill}
            />
            <Trend
              vm={vm}
              months={trendMonths}
              onMonthsChange={setTrendMonths}
              focus={trendFocus}
              onFocusChange={setTrendFocus}
            />
          </div>
        </>
      )}

      {earlierBalanceAccount && <EarlierBalancePanel store={store} account={earlierBalanceAccount} setting={snap.setting} onClose={() => setEarlierBalanceAccount(null)} onSaved={() => { setEarlierBalanceAccount(null); bump(); }} />}
      {accountSetupOpen && <AccountSetupPanel store={store} assets={snap.assets} accounts={snap.accounts} setting={snap.setting} onSaved={(account) => { setAccountSetupOpen(false); setAddedAccount(account); setAccountId(account.id); bump(); }} onClose={() => setAccountSetupOpen(false)} />}
      {accountHistoryOpen && <AccountHistoryPanel store={store} accounts={snap.accounts} assets={snap.assets} categories={snap.categories} timeZone={snap.setting?.timezone} initialAccountId={addedAccount?.id} onChanged={bump} onClose={() => setAccountHistoryOpen(false)} />}
      {addedAccount && <div style={cardTight} role="status">已添加 {addedAccount.name} · 余额起点 {new Date(addedAccount.balanceStartAt!).toLocaleString('zh-CN', { timeZone: snap.setting?.timezone })}，{addedAccount.openingBalance} {snap.assets.find((a) => a.id === addedAccount.openingAssetId)?.code}。以前的记录已保留。<p>默认付款：{snap.accounts.find((a) => a.id === snap.setting?.expenseDefaultAccountId)?.name}；默认收款：{snap.accounts.find((a) => a.id === snap.setting?.incomeDefaultAccountId)?.name}。</p>
        <button style={button} onClick={() => setAccountHistoryOpen(true)}>整理以前的记录</button><button style={button} onClick={() => { setAddedAccount(null); openNewTransaction(); }}>记一笔</button>
      </div>}
      {usesAccounts && activeTab === 'accounts' && (
        <div style={card}>
          <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>账户流水与对账</div>
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>账户流水列出收支、转账和资产转换。买卖资产会改变账户余额，不计入日常收入或支出。</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setAccountSetupOpen(true)} style={primary}>添加银行卡 / 钱包</button>
              <button onClick={() => snap.accounts.some((a) => !isDefaultAccount(a) && a.kind !== 'other') ? setAccountHistoryOpen(true) : setAccountSetupOpen(true)} style={button}>整理以前的记录</button>
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <DateRangeBar value={activeDateValue} onChange={(next) => setFilters((current) => ({ ...current, range: next.preset, dateFrom: next.from, dateTo: next.to }))} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>{snap.accounts.filter(isDefaultAccount).map((a) => <button key={a.id} style={button} onClick={() => { setFilters((current) => ({ ...current, accountId: a.id })); setTab('records'); }}>{a.name} · 本月{a.purpose === 'default_income' ? '收入' : '净支出'} {defaultAccountTotals[a.id] ?? '…'} · 查看记录</button>)}</div>
          <p className="zc-meta">默认账户归集暂不细分来源的收支。下方银行卡与钱包展示账面余额；余额流水从各自的余额起点开始。</p>
          {!selectedAccountId ? <p>添加银行卡或钱包后，可以核对余额和账单。现在也可以继续使用默认账户记收支。</p> : <>
          <div className="zc-account-filter-grid" style={{ display: 'grid', gridTemplateColumns: '220px 160px 1fr', gap: 10, marginBottom: 14 }}>
            <select style={selectStyle} value={selectedAccountId} onChange={(e) => setAccountId(e.target.value)}>
              {snap.accounts.filter((a) => !isDefaultAccount(a) && a.kind !== 'other').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select style={selectStyle} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="all">全部币种</option>
              {accountAssets.map((id) => <option key={id} value={id}>{snap.assets.find((a) => a.id === id)?.code ?? id}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {vm.accountBalances.filter((b) => b.accountId === selectedAccountId).map((b) => (
                <span key={`${b.accountId}:${b.assetId}`} style={tagStyle}>{b.amount} {b.assetCode}</span>
              ))}
            </div>
          </div>
          {snap.accounts.find((a) => a.id === selectedAccountId)?.balanceStartAt && <button style={button} onClick={() => setEarlierBalanceAccount(snap.accounts.find((a) => a.id === selectedAccountId)!)}>从更早日期核算</button>}
          <button style={button} onClick={() => setEditingReconcile('new')}>核对账单</button>
          <button style={button} onClick={() => { setFilters((current) => ({ ...current, accountId: selectedAccountId })); setTab('records'); }}>查看这个账户的日常收支</button>
          <Table headers={['日期', '摘要', '分类', '状态', '金额', '余额']}>
            {ledger.map((r) => (
              <tr key={r.id}>
                <td style={tdStyle}>{r.date}</td>
                <td style={tdStyle}>{r.title}</td>
                <td style={tdStyle}>{r.categoryLabel}</td>
                <td style={tdStyle}>{r.statusLabel}</td>
                <td style={{ ...tdStyle, ...amountColor(r.amount) }}>{r.displayAmount} {r.assetCode}</td>
                <td style={tdStyle}>{r.balance} {r.assetCode}</td>
              </tr>
            ))}
            {ledger.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={6}>暂无账户流水</td></tr>}
          </Table>
          {accountLedgerPage?.hasMore && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
              <button type="button" onClick={() => void loadMoreAccountLedger()} disabled={accountLedgerBusy} style={button}>
                {accountLedgerBusy ? '加载中…' : '继续加载 100 笔'}
              </button>
              <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
                已加载 {accountLedgerPage.rows.length} / {accountLedgerPage.totalCount} 条账户分录
              </span>
            </div>
          )}
          <div style={{ marginTop: 18, fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>对账记录</div>
          <Table headers={['账单日', '账户', '币种', '账单余额', '差额', '状态']}>
            {reconciliationRows.map((r) => (
              <tr key={r.id} onClick={() => setEditingReconcile(r)} style={{ cursor: 'pointer' }}>
                <td style={tdStyle}>{r.statementDate}</td>
                <td style={tdStyle}>{snap.accounts.find((a) => a.id === r.accountId)?.name ?? r.accountId}</td>
                <td style={tdStyle}>{snap.assets.find((a) => a.id === r.assetId)?.code ?? r.assetId}</td>
                <td style={tdStyle}>{r.statementBalance}</td>
                <td style={{ ...tdStyle, ...amountColor(D(r.difference).negated()) }}>{r.difference}</td>
                <td style={tdStyle}>{r.status === 'closed' ? '已完成' : '进行中'}</td>
              </tr>
            ))}
            {reconciliationRows.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={6}>该时间范围内暂无对账记录</td></tr>}
          </Table></>}
        </div>
      )}

      {activeTab === 'budget' && (
        <div style={card}>
          <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{budgetView === 'year' ? `${budgetMonth.slice(0, 4)} 年度预算` : `${budgetMonth} 分类预算`}</div>
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>预算冻结创建时币种，统一折算为 {vm.reportCurrencyCode}；拆分交易进入对应二级分类。</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button onClick={() => setBudgetView('year')} style={budgetView === 'year' ? primary : button}>年度</button>
              <button onClick={() => setBudgetView('month')} style={budgetView === 'month' ? primary : button}>月份</button>
              {budgetView === 'year'
                ? <input aria-label="预算年度" className="zc-input" type="number" min="1900" max="9999" value={budgetMonth.slice(0, 4)} onChange={(event) => setBudgetMonth(`${event.target.value || localToday().slice(0, 4)}-01`)} style={{ width: 108 }} />
                : <input aria-label="预算月份" className="zc-input" type="month" value={budgetMonth} onChange={(event) => setBudgetMonth(event.target.value)} style={{ width: 150 }} />}
              <button onClick={() => setEditingBudget('new')} style={primary}>+ 预算</button>
            </div>
          </div>
          {budgetView === 'year' ? (
            <div className="zc-budget-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
              {budgetYearRows.map((row) => (
                <button key={row.month} onClick={() => { setBudgetMonth(row.month); setBudgetView('month'); }} style={{ ...cardTight, minHeight: 112, textAlign: 'left', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b>{Number(row.month.slice(5))} 月</b><span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' }}>{row.rows.length} 项</span></div>
                  <div style={{ marginTop: 14, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>预算 {money(row.planned)}</div>
                  <div style={{ marginTop: 5, fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', color: row.actual.gt(row.planned) ? 'var(--negative)' : 'var(--fg)' }}>实际 {money(row.actual)}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="zc-budget-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              {budgetRows.map((b) => (
                <button key={b.id ?? b.category} onClick={() => setEditingBudget(snap.budgetCategories.find((x) => x.id === b.id) ?? 'new')} style={{ ...cardTight, textAlign: 'left', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>
                    <span>{b.label}</span>
                    <span style={{ color: b.over ? 'var(--negative)' : b.conversionKnown ? 'var(--fg)' : 'var(--warning)' }}>{b.conversionKnown ? money(b.remaining) : '未折算'}</span>
                  </div>
                  <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 'var(--r-pill)', overflow: 'hidden', margin: '10px 0' }}>
                    <div style={{ height: 8, width: `${Math.min(100, Math.max(3, b.usedRatio * 100))}%`, background: b.over ? 'var(--negative)' : 'var(--accent)', borderRadius: 'var(--r-pill)' }} />
                  </div>
                  <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>
                    {b.conversionKnown ? `已用 ${money(b.actual)} / 可用 ${money(b.available)} · 上月结转 ${money(b.carryIn)} · 下月 ${money(b.carryOut)}` : '缺少流水或预算币种汇率'} · 原预算 {b.plannedNative}
                  </div>
                </button>
              ))}
              {budgetRows.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-body)' }}>该月份暂无预算</div>}
            </div>
          )}
        </div>
      )}

      {activeTab === 'bills' && (
        <div style={card}>
          <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>定期交易与账单</div>
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>启用后会在打开应用时自动补齐；关闭应用期间不会在后台执行。</div>
            </div>
            <button onClick={() => setEditingSchedule('new')} style={primary}>+ 定期交易</button>
          </div>
          <div style={{ marginBottom: 14 }}><DateRangeBar value={billRange} onChange={setBillRange} view={billView} onViewChange={setBillView} /></div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 12px', marginBottom: 14, background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>
            <b style={{ fontSize: 'var(--fs-caption)' }}>待补齐 {scheduledBacklog.length} 期</b>
            <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
              其中失败 {scheduledBacklog.filter((row) => row.status === 'failed').length} 期
            </span>
            {scheduledBacklog[0] && <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)' }}>最早：{scheduledBacklog[0].occurrenceDate} · {scheduledBacklog[0].scheduleName}</span>}
          </div>
          {billView === 'list' ? (
            <Table headers={['名称', '类型', '分类', '金额', '下次日期', '状态', '']}>
              {vm.schedules.filter((schedule) => isDateInRange(schedule.nextDate, billRange)).map((s) => {
                const row = snap.scheduledTransactions.find((x) => x.id === s.id)!;
                return (
                  <tr key={s.id}>
                    <td style={tdStyle}>{s.name}</td>
                    <td style={tdStyle}>{s.typeLabel}</td>
                    <td style={tdStyle}>{s.categoryLabel}</td>
                    <td style={tdStyle}>{s.amount}</td>
                    <td style={tdStyle}>{s.nextDate}</td>
                    <td style={{ ...tdStyle, color: s.status === 'overdue' ? 'var(--negative)' : s.status === 'due' ? 'var(--accent)' : 'var(--fg-subtle)', fontWeight: 'var(--fw-bold)' }}>{scheduleLabel(s.status)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <button onClick={() => void materializeSchedule(row)} disabled={row.status !== 'active'} style={button}>生成</button>
                      <button onClick={() => setEditingSchedule(row)} style={{ ...button, marginLeft: 8 }}>编辑</button>
                    </td>
                  </tr>
                );
              })}
              {vm.schedules.filter((schedule) => isDateInRange(schedule.nextDate, billRange)).length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={7}>该时间范围内暂无到期交易</td></tr>}
            </Table>
          ) : (
            <TimelineExplorer
              items={billOccurrences}
              view={billView}
              focusDate={billFocusDate}
              onFocusDate={setBillFocusDate}
              onViewChange={setBillView}
              dateOf={(item) => item.date}
              keyOf={(item) => item.id}
              renderCompact={(item) => <>{item.date.slice(8)} · <b>{item.name}</b> · {item.amount}</>}
              renderEntry={(item) => <div className="zc-transaction-timeline-entry" style={{ display: 'grid', gridTemplateColumns: '100px 120px minmax(0, 1fr) 130px', gap: 12 }}><span>{item.date}</span><b>{item.typeLabel}</b><span>{item.name} · {item.categoryLabel}</span><b style={{ textAlign: 'right' }}>{item.amount}</b></div>}
              renderSummary={(rows) => <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{rows.length} 笔待办</span>}
              onOpen={(item) => setEditingSchedule(item.schedule)}
              emptyText="该时间范围内没有定期交易待办。"
            />
          )}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>执行历史</div>
            <div className="zc-scroll-x">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={thStyle}>计划</th><th style={thStyle}>期次</th><th style={thStyle}>结果</th><th style={thStyle}>尝试时间</th><th style={thStyle}>详情</th><th style={thStyle}></th></tr></thead>
                <tbody>
                  {executionHistory.map((execution) => (
                    <tr key={execution.id}>
                      <td style={tdStyle}>{scheduleById.get(execution.scheduleId)?.name ?? execution.scheduleId}</td>
                      <td style={tdStyle}>{execution.occurrenceDate}</td>
                      <td style={{
                        ...tdStyle,
                        color: execution.status === 'created' ? 'var(--positive)' : execution.status === 'failed' ? 'var(--negative)' : 'var(--fg-subtle)',
                        fontWeight: 'var(--fw-bold)',
                      }}>{execution.status === 'created' ? '已生成' : execution.status === 'failed' ? '失败' : '已跳过'}</td>
                      <td style={tdStyle}>{execution.attemptedAt ? new Date(execution.attemptedAt).toLocaleString() : '—'}</td>
                      <td style={{ ...tdStyle, maxWidth: 320 }}>
                        {execution.lastError ?? (execution.status === 'failed' ? '未知错误' : execution.transactionId ? `流水 ${execution.transactionId.slice(0, 8)}` : '按补齐策略跳过')}
                        {execution.status === 'failed' && <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 2 }}>已重试 {execution.retryCount ?? 0} 次{execution.nextRetryAt ? ` · 下次 ${new Date(execution.nextRetryAt).toLocaleString()}` : ''}</div>}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {execution.status === 'failed' && (
                          <button
                            type="button"
                            disabled={retryingExecutionId === execution.id}
                            onClick={() => void retryScheduleExecution(execution.id)}
                            style={button}
                          >{retryingExecutionId === execution.id ? '重试中…' : '立即重试'}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {executionHistory.length === 0 && <tr><td colSpan={6} style={{ ...tdStyle, color: 'var(--text-tertiary)' }}>还没有执行记录</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {quickExpenseOpen && !usesAccounts && (
        <QuickExpenseModal
          key={quickTemplate?.id ?? 'quick-expense'}
          assets={readySnap.assets}
          categories={categoryOptions(readySnap.categories, 'expense', { leafOnly: true, includeHidden: true })}
          recentTransactions={readyTransactionRead.recommendationTransactions}
          templates={activeTemplates}
          initialTemplate={quickTemplate ?? undefined}
          defaultAssetId={moduleCurrencyId(readySnap.setting, 'transaction', readySnap.assets[0]?.id || '')}
          categoryShowHiddenDefault={readySnap.setting?.categoryPickerDefaultScope === 'all'}
          onSave={saveQuickExpense}
          onClose={() => { setQuickExpenseOpen(false); setQuickTemplate(null); }}
        />
      )}

      {editingTx && (
        <EntityFormModal
          spec={transactionForm(readySnap, {
            usesAccounts,
            refundMode: editingTx === 'new' ? !!refundDraft : editingTx.type === 'refund',
            expenseOnly: !usesAccounts && !(editingTx === 'new' ? refundDraft : editingTx.type === 'refund'),
            refundRemaining: refundFormRemaining(),
          })}
          initial={editingTx === 'new' ? refundDraft ?? templateDraft ?? undefined : editingTx}
          isNew={editingTx === 'new'}
          optionalFieldKeys={compactView && editingTx === 'new' && snap.setting?.transactionFormOptionalFields === undefined
            ? [] : optionalTransactionFields(snap.setting, usesAccounts)}
          optionalFieldPresets={[
            { label: '仅核心', keys: transactionFormPresetKeys('core', usesAccounts) },
            { label: '常用', keys: transactionFormPresetKeys('common', usesAccounts) },
            { label: '完整', keys: transactionFormPresetKeys('full', usesAccounts) },
          ]}
          onOptionalFieldKeysChange={(keys) => saveTransactionFormFields(keys)}
          onSave={async (entity) => { await saveTx(entity); setTemplateDraft(null); }}
          onDelete={editingTx !== 'new' ? async () => voidTx(editingTx) : undefined}
          deleteLabel="作废"
          onClose={() => { setEditingTx(null); setRefundDraft(null); setTemplateDraft(null); }}
        />
      )}
      {refundHistoryFor && (
        <RefundHistoryDialog
          original={refundHistoryFor}
          refunds={refundsOf(refundHistoryFor)}
          remaining={remainingRefundAmount(refundHistoryFor)}
          assetCode={assetCodeOf}
          categories={readySnap.categories}
          onEditRefund={openRefundEditor}
          onVoidRefund={async (refundId) => { await voidTx({ id: refundId }); }}
          onNewRefund={(original) => { setRefundHistoryFor(null); startRefund(original); }}
          onClose={() => setRefundHistoryFor(null)}
        />
      )}
      {editingSplit && (
        <EntityFormModal
          spec={transactionSplitForm(snap)}
          initial={editingSplit === 'new' ? undefined : editingSplit}
          onSave={saveSplit}
          onDelete={editingSplit !== 'new' ? async () => deleteSplit(editingSplit) : undefined}
          onClose={() => setEditingSplit(null)}
        />
      )}
      {editingBudget && (
        <EntityFormModal
          spec={budgetCategoryForm(snap, budgetMonth)}
          initial={editingBudget === 'new' ? undefined : editingBudget}
          onSave={async (e) => {
            if (!isLeafCategory(e.category)) throw new Error('请选择二级分类，不能直接选择一级分类');
            await store.runInAuditBatch(
              `${editingBudget === 'new' ? '新增' : '编辑'}分类预算`,
              (transactionStore) => transactionStore.budgetCategories.put(e),
            );
            bump();
          }}
          onDelete={editingBudget !== 'new' ? async () => {
            const compensation = await deleteBudgetCategory(store, editingBudget.id, editingBudget.version);
            bump();
            undo.offer('预算已删除', async () => {
              await restoreDeletedBudgetCategory(store, compensation);
              bump();
            });
          } : undefined}
          onClose={() => setEditingBudget(null)}
        />
      )}
      {editingSchedule && (
        <EntityFormModal
          spec={scheduledTransactionForm(snap, { usesAccounts })}
          initial={editingSchedule === 'new' ? undefined : editingSchedule}
          onSave={async (e) => {
            if (!usesAccounts && e.type === 'transfer') throw new Error('轻量模式不记录转账账单，请在设置中切换到账户模式');
            if (e.type !== 'transfer' && !isLeafCategory(e.category)) throw new Error('请选择二级分类，不能直接选择一级分类');
            await store.runInAuditBatch(
              `${editingSchedule === 'new' ? '新增' : '编辑'}定期交易`,
              async (transactionStore) => transactionStore.scheduledTransactions.put(await withRememberedPayee(transactionStore, e)),
            );
            bump();
          }}
          onDelete={editingSchedule !== 'new' ? async () => {
            const compensation = await archiveScheduledTransaction(store, editingSchedule.id, editingSchedule.version);
            bump();
            undo.offer(`定期交易“${editingSchedule.name}”已停用`, async () => {
              await restoreScheduledTransactionState(store, compensation);
              bump();
            });
          } : undefined}
          deleteLabel="停用"
          onClose={() => setEditingSchedule(null)}
        />
      )}
      {editingCategory && (
        <EntityFormModal
          spec={categoryForm(snap)}
          initial={editingCategory === 'new' ? undefined : editingCategory}
          onSave={async (e) => {
            await store.runInAuditBatch(
              `${editingCategory === 'new' ? '新增' : '编辑'}分类“${e.name}”`,
              (transactionStore) => transactionStore.categories.put(e),
            );
            bump();
          }}
          onDelete={editingCategory !== 'new' ? async () => {
            const compensation = await archiveMasterData(store, 'category', editingCategory.id, editingCategory.version);
            bump();
            undo.offer(`分类“${editingCategory.name}”已归档`, async () => {
              await restoreArchivedMasterData(store, compensation);
              bump();
            });
          } : undefined}
          deleteLabel="归档"
          onClose={() => setEditingCategory(null)}
        />
      )}
      {editingPayee && (
        <EntityFormModal
          spec={payeeForm(snap, { usesAccounts })}
          initial={editingPayee === 'new' ? undefined : editingPayee}
          onSave={async (e) => {
            await store.runInAuditBatch(
              `${editingPayee === 'new' ? '新增' : '编辑'}交易对象“${e.name}”`,
              (transactionStore) => transactionStore.payees.put(e),
            );
            bump();
          }}
          onDelete={editingPayee !== 'new' ? async () => {
            const compensation = await archiveMasterData(store, 'payee', editingPayee.id, editingPayee.version);
            bump();
            undo.offer(`交易对象“${editingPayee.name}”已归档`, async () => {
              await restoreArchivedMasterData(store, compensation);
              bump();
            });
          } : undefined}
          deleteLabel="归档"
          onClose={() => setEditingPayee(null)}
        />
      )}
      {usesAccounts && editingReconcile && (
        <ReconciliationModal
          store={store}
          snap={readySnap}
          session={editingReconcile === 'new' ? undefined : editingReconcile}
          initialAccountId={selectedAccountId}
          initialAssetId={selectedAssetId ?? accountAssets[0] ?? readySnap.assets[0]?.id ?? ''}
          onChanged={bump}
          onClose={() => setEditingReconcile(null)}
        />
      )}
      {batchOpen && (
        <BatchEditModal
          snap={snap}
          usesAccounts={usesAccounts}
          count={selectedIds.length}
          transactions={readySnap.transactions.filter((t) => selectedIds.includes(t.id))}
          onSave={saveBatchEdits}
          onClose={() => setBatchOpen(false)}
        />
      )}
    </div>
  );
}

const ADVANCED_FIELD_OPTIONS: { value: AdvancedQueryField; label: string; accountsOnly?: boolean }[] = [
  { value: 'time', label: '时间' },
  { value: 'type', label: '类型' },
  { value: 'category', label: '二级分类' },
  { value: 'parentCategory', label: '一级分类' },
  { value: 'amount', label: '金额' },
  { value: 'assetId', label: '币种' },
  { value: 'accountId', label: '账户', accountsOnly: true },
  { value: 'payeeId', label: '交易对象' },
  { value: 'merchant', label: '交易对象文本' },
  { value: 'description', label: '描述' },
  { value: 'note', label: '备注' },
  { value: 'tagId', label: '标签' },
  { value: 'locationId', label: '地点' },
  { value: 'status', label: '状态', accountsOnly: true },
  { value: 'hasAttachment', label: '附件' },
];

const ADVANCED_OPERATOR_OPTIONS: { value: AdvancedQueryOperator; label: string }[] = [
  { value: 'eq', label: '等于' },
  { value: 'neq', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'not_contains', label: '不包含' },
  { value: 'gte', label: '大于等于' },
  { value: 'lte', label: '小于等于' },
  { value: 'between', label: '区间' },
  { value: 'in', label: '属于' },
  { value: 'empty', label: '为空' },
  { value: 'not_empty', label: '有值' },
];

type BatchPatch = {
  category?: string;
  payeeId?: string;
  accountId?: string;
  status?: Transaction['status'];
  locationId?: string;
  addTagIds?: string[];
  removeTagIds?: string[];
};

function isLeafTransactionCategory(category: string, snap: Snapshot): boolean {
  return !snap.categories.some((c) => !c.isDeleted && c.parentId === category);
}

function applyBatchPatch(tx: Transaction, patch: BatchPatch, snap: Snapshot, usesAccounts: boolean): Transaction {
  let next: Transaction = { ...tx };
  if (patch.category) {
    if (next.type === 'transfer') throw new Error('转账流水不能批量设置收支分类');
    if (!isLeafTransactionCategory(patch.category, snap)) throw new Error('请选择二级分类，不能直接选择一级分类');
    const catType = metaCategoryType(patch.category, snap.categories) ?? categoryType(patch.category, snap);
    if (catType !== next.type) throw new Error(`分类与流水类型不匹配：${next.description ?? next.id}`);
    next = { ...next, category: patch.category };
  }
  if (patch.payeeId !== undefined) next = { ...next, payeeId: patch.payeeId, merchant: snap.payees.find((payee) => payee.id === patch.payeeId)?.name ?? '' };
  if (patch.accountId !== undefined && usesAccounts) next = { ...next, accountId: patch.accountId || undefined };
  if (patch.status !== undefined && usesAccounts) next = { ...next, status: patch.status || 'cleared' };
  if (patch.locationId !== undefined) {
    const loc = snap.transactionLocations.find((l) => l.id === patch.locationId);
    next = patch.locationId
      ? { ...next, locationId: patch.locationId, locationName: loc?.name, latitude: loc?.latitude, longitude: loc?.longitude, locationAccuracyMeters: undefined }
      : { ...next, locationId: undefined, locationName: undefined, latitude: undefined, longitude: undefined, locationAccuracyMeters: undefined };
  }
  const currentTags = new Set(next.tagIds ?? []);
  for (const id of patch.addTagIds ?? []) currentTags.add(id);
  for (const id of patch.removeTagIds ?? []) currentTags.delete(id);
  if ((patch.addTagIds?.length ?? 0) > 0 || (patch.removeTagIds?.length ?? 0) > 0) {
    next = { ...next, tagIds: [...currentTags] };
  }
  return next;
}

function tagLabel(id: string, snap: Snapshot): string {
  const tag = snap.transactionTags.find((t) => t.id === id);
  return tag ? (tag.groupName ? `${tag.groupName} / ${tag.name}` : tag.name) : id;
}

function batchPreviewLine(tx: Transaction, snap: Snapshot, usesAccounts: boolean): string {
  const payee = tx.payeeId ? snap.payees.find((p) => p.id === tx.payeeId)?.name ?? tx.payeeId : tx.merchant;
  const account = tx.accountId ? snap.accounts.find((a) => a.id === tx.accountId)?.name ?? tx.accountId : undefined;
  const status = STATUS_OPTIONS.find((s) => s.value === tx.status)?.label ?? tx.status;
  const funds = snap.accounts.find((a) => a.id === tx.accountId);
  const beforeOpening = funds?.balanceStartAt && funds.openingAssetId === tx.assetId && accountBalanceTiming(funds, tx) === 'before';
  const location = tx.locationId ? snap.transactionLocations.find((l) => l.id === tx.locationId)?.name ?? tx.locationName ?? tx.locationId : tx.locationName;
  const tags = (tx.tagIds ?? []).map((id) => tagLabel(id, snap)).join('、');
  return [
    `${TYPE_LABEL[tx.type]} · ${categoryLabel(tx.category, snap.categories)}`,
    payee ? `交易对象 ${payee}` : '',
    usesAccounts && account ? `账户 ${account}` : '',
    usesAccounts ? `状态 ${status}` : '',
    beforeOpening ? '已包含在起始余额中，不重复扣减' : '',
    location ? `地点 ${location}` : '',
    tags ? `标签 ${tags}` : '无标签',
  ].filter(Boolean).join(' · ');
}

function batchSummary(patch: BatchPatch, snap: Snapshot): string {
  const parts: string[] = [];
  if (patch.category) parts.push(`分类：${categoryLabel(patch.category, snap.categories)}`);
  if (patch.payeeId !== undefined) parts.push(patch.payeeId ? `交易对象：${snap.payees.find((p) => p.id === patch.payeeId)?.name ?? patch.payeeId}` : '清空交易对象');
  if (patch.accountId) parts.push(`账户：${snap.accounts.find((a) => a.id === patch.accountId)?.name ?? patch.accountId}`);
  if (patch.status) parts.push(`状态：${STATUS_OPTIONS.find((s) => s.value === patch.status)?.label ?? patch.status}`);
  if (patch.locationId) parts.push(`地点：${snap.transactionLocations.find((l) => l.id === patch.locationId)?.name ?? patch.locationId}`);
  if (patch.addTagIds?.length) parts.push(`追加标签：${patch.addTagIds.map((id) => snap.transactionTags.find((t) => t.id === id)?.name ?? id).join('、')}`);
  if (patch.removeTagIds?.length) parts.push(`移除标签：${patch.removeTagIds.map((id) => snap.transactionTags.find((t) => t.id === id)?.name ?? id).join('、')}`);
  return parts.join('；') || '批量修改流水';
}

function SavedViews(props: {
  views: TransactionSavedView[];
  name: string;
  error: string;
  onNameChange: (name: string) => void;
  onApply: (view: TransactionSavedView) => void;
  onSave: () => void;
  onRename: (view: TransactionSavedView, name: string) => void;
  onTogglePin: (view: TransactionSavedView) => void;
  onRemove: (view: TransactionSavedView) => void;
}) {
  const [editingId, setEditingId] = useState('');
  const [editingName, setEditingName] = useState('');
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 10, marginBottom: 14, background: 'var(--surface-2)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="zc-input"
          value={props.name}
          onChange={(e) => props.onNameChange(e.target.value)}
          placeholder="筛选名称"
          style={{ width: 180, height: 36 }}
        />
        <button onClick={props.onSave} style={primary}>保存当前筛选</button>
        {props.error && <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--negative)', fontWeight: 'var(--fw-medium)' }}>{props.error}</span>}
      </div>
      {props.views.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {props.views.map((view) => {
            const editing = editingId === view.id;
            return (
              <span key={view.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: 3, background: 'var(--surface)' }}>
                {editing ? (
                  <>
                    <input className="zc-input" value={editingName} onChange={(e) => setEditingName(e.target.value)} style={{ width: 130, height: 32, borderRadius: 'var(--r-pill)' }} />
                    <button
                      onClick={() => {
                        props.onRename(view, editingName);
                        setEditingId('');
                      }}
                      style={{ ...button, padding: '6px 9px' }}
                    >
                      保存
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => props.onApply(view)} style={{ ...button, border: 'none', padding: '6px 10px', background: 'transparent' }}>{view.name}</button>
                    <button onClick={() => props.onTogglePin(view)} title={view.isPinned ? '取消置顶' : '置顶'} style={{ ...button, padding: '6px 8px' }}>{view.isPinned ? '★' : '☆'}</button>
                    <button
                      onClick={() => {
                        setEditingId(view.id);
                        setEditingName(view.name);
                      }}
                      title="重命名"
                      style={{ ...button, padding: '6px 8px' }}
                    >
                      改名
                    </button>
                  </>
                )}
                <button onClick={() => props.onRemove(view)} title="删除保存的筛选" style={{ ...button, padding: '6px 8px' }}>×</button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AdvancedQueryBuilder(props: { snap: Snapshot; filters: TransactionFilters; setFilters: Dispatch<SetStateAction<TransactionFilters>>; usesAccounts: boolean }) {
  const { snap, filters, setFilters, usesAccounts } = props;
  const [open, setOpen] = useState(() => !!filters.advanced?.groups.length);
  const query: AdvancedTransactionQuery = filters.advanced ?? { op: 'or', groups: [] };
  const conditionCount = query.groups.reduce((acc, g) => acc + g.conditions.length, 0);
  const fieldOptions = ADVANCED_FIELD_OPTIONS.filter((f) => usesAccounts || !f.accountsOnly);
  const queryPreview = describeAdvancedQuery(query, snap, fieldOptions);

  const setQuery = (next: AdvancedTransactionQuery | undefined) => setFilters((f) => ({ ...f, advanced: next }));
  const applyPreset = (preset: 'reimburse' | 'large_expense' | 'with_attachment' | 'food') => {
    const tag = snap.transactionTags.find((t) => !t.isDeleted && t.name.includes('报销'));
    const condition = (field: AdvancedQueryField, op: AdvancedQueryOperator, value = ''): AdvancedQueryCondition => ({ id: newId(), field, op, value });
    const groups: AdvancedTransactionQuery['groups'] = [];
    if (preset === 'reimburse' && tag) groups.push({ id: newId(), op: 'and', conditions: [condition('tagId', 'eq', tag.id)] });
    if (preset === 'large_expense') groups.push({ id: newId(), op: 'and', conditions: [condition('type', 'eq', 'expense'), condition('amount', 'gte', '100')] });
    if (preset === 'with_attachment') groups.push({ id: newId(), op: 'and', conditions: [condition('hasAttachment', 'eq', 'true')] });
    if (preset === 'food') groups.push({ id: newId(), op: 'and', conditions: [condition('category', 'eq', 'food')] });
    if (!groups.length) return;
    setOpen(true);
    const dates = preset === 'food' ? dateRangeValue('this_month') : undefined;
    setFilters((f) => ({ ...f, ...(dates ? { range: dates.preset, dateFrom: dates.from, dateTo: dates.to } : {}), advanced: { op: 'or', groups } }));
  };
  const addGroup = () => setQuery({
    op: 'or',
    groups: [...query.groups, { id: newId(), op: 'and', conditions: [{ id: newId(), field: 'amount', op: 'gte', value: '' }] }],
  });
  const addCondition = (groupId: string) => setQuery({
    op: 'or',
    groups: query.groups.map((g) => g.id === groupId
      ? { ...g, conditions: [...g.conditions, { id: newId(), field: 'merchant', op: 'contains', value: '' }] }
      : g),
  });
  const updateCondition = (groupId: string, conditionId: string, patch: Partial<AdvancedQueryCondition>) => setQuery({
    op: 'or',
    groups: query.groups.map((g) => g.id === groupId
      ? { ...g, conditions: g.conditions.map((c) => c.id === conditionId ? { ...c, ...patch } : c) }
      : g),
  });
  const removeCondition = (groupId: string, conditionId: string) => setQuery({
    op: 'or',
    groups: query.groups
      .map((g) => g.id === groupId ? { ...g, conditions: g.conditions.filter((c) => c.id !== conditionId) } : g)
      .filter((g) => g.conditions.length > 0),
  });

  return (
    <div style={{ borderTop: '1px solid var(--border)', borderBottom: open ? '1px solid var(--border)' : undefined, padding: '12px 0', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <button onClick={() => setOpen((v) => !v)} style={button}>高级查询{conditionCount ? ` · ${conditionCount}` : ''}</button>
        {conditionCount > 0 && <button onClick={() => setQuery(undefined)} style={button}>清空高级条件</button>}
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => applyPreset('reimburse')} style={button}>待报销</button>
            <button onClick={() => applyPreset('large_expense')} style={button}>大额支出</button>
            <button onClick={() => applyPreset('with_attachment')} style={button}>含附件</button>
            <button onClick={() => applyPreset('food')} style={button}>本月餐饮</button>
          </div>
          {queryPreview && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 10, background: 'var(--surface-2)', fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>
              当前查询：{queryPreview}
            </div>
          )}
          {query.groups.map((group, groupIndex) => (
            <div key={group.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>
                <span>{groupIndex === 0 ? '满足以下全部条件' : '或者满足以下全部条件'}</span>
                <button onClick={() => addCondition(group.id)} style={button}>+ 条件</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {group.conditions.map((condition) => (
                  <AdvancedConditionRow
                    key={condition.id}
                    snap={snap}
                    usesAccounts={usesAccounts}
                    condition={condition}
                    fieldOptions={fieldOptions}
                    onChange={(patch) => updateCondition(group.id, condition.id, patch)}
                    onRemove={() => removeCondition(group.id, condition.id)}
                  />
                ))}
              </div>
            </div>
          ))}
          <button onClick={addGroup} style={{ ...button, width: 'fit-content' }}>+ 条件组 OR</button>
        </div>
      )}
    </div>
  );
}

function describeAdvancedQuery(query: AdvancedTransactionQuery, snap: Snapshot, fieldOptions: { value: AdvancedQueryField; label: string }[]): string {
  if (!query.groups.length) return '';
  const fieldLabel = (field: AdvancedQueryField) => fieldOptions.find((f) => f.value === field)?.label ?? field;
  const opLabel = (op: AdvancedQueryOperator) => ADVANCED_OPERATOR_OPTIONS.find((o) => o.value === op)?.label ?? op;
  const valueLabel = (condition: AdvancedQueryCondition, value?: string) => {
    if (!value) return '';
    const option = valueOptionsForField(snap, condition.field)?.find((o) => o.value === value);
    return option?.label ?? value;
  };
  const conditionText = (condition: AdvancedQueryCondition) => {
    if (condition.op === 'empty' || condition.op === 'not_empty') return `${fieldLabel(condition.field)}${opLabel(condition.op)}`;
    if (condition.op === 'between') return `${fieldLabel(condition.field)}在 ${valueLabel(condition, condition.value)} 到 ${valueLabel(condition, condition.value2)} 之间`;
    return `${fieldLabel(condition.field)}${opLabel(condition.op)}${valueLabel(condition, condition.value) || '未填写'}`;
  };
  return query.groups
    .map((group) => group.conditions.map(conditionText).join(' 且 '))
    .filter(Boolean)
    .join(' 或 ');
}

function AdvancedConditionRow(props: {
  snap: Snapshot;
  usesAccounts: boolean;
  condition: AdvancedQueryCondition;
  fieldOptions: { value: AdvancedQueryField; label: string }[];
  onChange: (patch: Partial<AdvancedQueryCondition>) => void;
  onRemove: () => void;
}) {
  const { snap, condition, fieldOptions, onChange, onRemove } = props;
  const options = valueOptionsForField(snap, condition.field);
  const noValue = condition.op === 'empty' || condition.op === 'not_empty';
  return (
    <div className="zc-advanced-condition-row" style={{ display: 'grid', gridTemplateColumns: '150px 130px minmax(160px, 1fr) minmax(120px, 1fr) 42px', gap: 8, alignItems: 'center' }}>
      <select aria-label="高级查询字段" style={selectStyle} value={condition.field} onChange={(e) => onChange({ field: e.target.value as AdvancedQueryField, value: '', value2: '' })}>
        {fieldOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <select aria-label="高级查询条件" style={selectStyle} value={condition.op} onChange={(e) => onChange({ op: e.target.value as AdvancedQueryOperator })}>
        {ADVANCED_OPERATOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {noValue ? <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>无需输入值</span> : (
        <ConditionValueInput snap={snap} field={condition.field} value={condition.value ?? ''} options={options} onChange={(value) => onChange({ value })} />
      )}
      {condition.op === 'between'
        ? <ConditionValueInput snap={snap} field={condition.field} value={condition.value2 ?? ''} options={options} onChange={(value2) => onChange({ value2 })} />
        : <span />}
      <button onClick={onRemove} title="删除条件" style={{ ...button, padding: '8px 10px' }}>×</button>
    </div>
  );
}

function ConditionValueInput(props: { snap: Snapshot; field: AdvancedQueryField; value: string; options: { value: string; label: string }[] | null; onChange: (value: string) => void }) {
  const { snap, field, value, options, onChange } = props;
  // 二级分类单独走分类控件：它有上百项且含隐藏分类，原生下拉既翻不动也够不到。
  if (field === 'category') return <CategoryConditionValue snap={snap} value={value} onChange={onChange} />;
  if (field === 'payeeId') return <ExistingPayeePicker label="高级查询值" payees={snap.payees} value={value} onChange={onChange} />;
  if (options) {
    return (
      <select aria-label="高级查询值" style={selectStyle} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">请选择</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  const type = field === 'date' ? 'date' : field === 'time' ? 'time' : field === 'amount' ? 'number' : 'text';
  return <input aria-label="高级查询值" className="zc-input" type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder="条件值" />;
}

/**
 * 分类取值选项：账本内真实存在、未停用的二级分类，含被用户隐藏的。
 *
 * `includeCatalog: false`：目录里尚未写入账本的分类没有任何流水会引用它，
 * 选了只会得到空结果。（`includeHidden` 会把 catalogOnly 一并带进来，所以必须显式关掉。）
 */
function categoryValueOptions(snap: Snapshot) {
  return categoryOptions(snap.categories, undefined, { leafOnly: true, includeHidden: true, includeCatalog: false });
}

/** 高级查询里「二级分类」的取值控件——与记账弹窗同一个分类控件。 */
function CategoryConditionValue(props: { snap: Snapshot; value: string; onChange: (value: string) => void }) {
  const fieldId = useId();
  return (
    <CategoryPicker
      fieldId={fieldId}
      name="advancedCategory"
      ariaLabel="高级查询值"
      value={props.value}
      options={historicalCategoryValueOptions(props.snap)}
      allowEmpty
      emptyLabel="请选择"
      placeholder="请选择"
      defaultShowHidden={props.snap.setting?.categoryPickerDefaultScope === 'all'}
      triggerStyle={selectStyle}
      onChange={props.onChange}
    />
  );
}

function valueOptionsForField(snap: Snapshot, field: AdvancedQueryField): { value: string; label: string }[] | null {
  if (field === 'type') return TYPE_OPTIONS.filter((o) => o.value !== 'all').map((o) => ({ value: o.value, label: o.label }));
  if (field === 'category') return historicalCategoryValueOptions(snap).map((o) => ({ value: o.value, label: o.label }));
  if (field === 'parentCategory') {
    const parentIds = new Set(snap.categories.filter((c) => c.parentId).map((c) => c.parentId!));
    return snap.categories.filter((c) => parentIds.has(c.id)).map((c) => ({ value: c.id, label: c.name }));
  }
  if (field === 'assetId') return snap.assets.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  if (field === 'accountId') return snap.accounts.map((a) => ({ value: a.id, label: a.name }));
  if (field === 'payeeId') return snap.payees.filter((p) => !p.isDeleted).map((p) => ({ value: p.id, label: p.name }));
  if (field === 'tagId') return snap.transactionTags.filter((t) => !t.isDeleted).map((t) => ({ value: t.id, label: t.groupName ? `${t.groupName} / ${t.name}` : t.name }));
  if (field === 'locationId') return snap.transactionLocations.filter((l) => !l.isDeleted).map((l) => ({ value: l.id, label: l.name }));
  if (field === 'status') return STATUS_OPTIONS.filter((o) => o.value !== 'all').map((o) => ({ value: o.value, label: o.label }));
  if (field === 'hasAttachment') return [{ value: 'true', label: '有附件' }, { value: 'false', label: '无附件' }];
  return null;
}

function Filters(props: { snap: Snapshot; filters: TransactionFilters; setFilters: Dispatch<SetStateAction<TransactionFilters>>; usesAccounts: boolean; onCategoryChange: (next: string) => void }) {
  const { snap, filters, setFilters, usesAccounts, onCategoryChange } = props;
  const typeOptions = usesAccounts ? TYPE_OPTIONS : BASIC_TYPE_OPTIONS;
  /* 环下钻到板块时（`parentCategory`）分类控件本身没有这一项可选，但它确实在筛。 */
  const parentDrill = filters.parentCategory && filters.parentCategory !== 'all' ? filters.parentCategory : '';
  /*
   * 控件说「X · 全部」只在筛选确实停在一级上时（值里没有二级）。选了二级的话一级只是
   * 它的归属（见 `changeCategoryFilter`），该说的是「全部分类」——否则空选项就被一级的
   * 名字占着，用户再也回不到「全部分类」（当初这两处 e2e 红的就是这一步）。
   */
  const boardOnly = filters.category === 'all' ? parentDrill : '';
  const boardOnlyLabel = boardOnly ? categoryLabel(boardOnly, snap.categories) : '';
  return (
    <div className="zc-transaction-filters" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
      <select aria-label="流水类型" style={selectStyle} value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as TransactionFilters['type'] }))}>
        {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <CategoryPicker
        fieldId="transaction-filter-category"
        name="category"
        ariaLabel="流水分类"
        value={filters.category === 'all' ? '' : filters.category}
        // 读路径：含隐藏与被停用的分类（后者带「已停用」徒标，搜索或开「显示隐藏」能找到），
        // 否则那些分类下的旧流水就筛不着了。目录里尚未落库的分类不出现——
        // 没有任何流水会引用它们，选了只会得到空结果。
        options={historicalCategoryValueOptions(snap)}
        allowEmpty
        /* 环下钻到板块时，这条筛选确实在生效（只是值是一级），所以空选项必须
           说清楚它跟的是哪个板块——否则控件写着「全部分类」、列表却少了一大半。*/
        emptyLabel={boardOnlyLabel ? `${boardOnlyLabel} · 全部` : '全部分类'}
        placeholder={boardOnlyLabel ? `${boardOnlyLabel} · 全部` : '全部分类'}
        defaultShowHidden={snap.setting?.categoryPickerDefaultScope === 'all'}
        triggerStyle={selectStyle}
        onChange={(next) => onCategoryChange(next)}
      />
      {usesAccounts && (
        <select aria-label="流水账户" style={selectStyle} value={filters.accountId} onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value }))}>
          <option value="all">全部账户</option>
          {snap.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      <ExistingPayeePicker label="流水交易对象" payees={snap.payees} value={filters.payeeId ?? 'all'} emptyValue="all" emptyLabel="全部交易对象"
        onChange={(payeeId) => setFilters((current) => ({ ...current, payeeId }))} />
      <select aria-label="流水标签" style={selectStyle} value={filters.tagId ?? 'all'} onChange={(e) => setFilters((f) => ({ ...f, tagId: e.target.value }))}>
        <option value="all">全部标签</option>
        {snap.transactionTags.filter((t) => !t.isDeleted).map((t) => <option key={t.id} value={t.id}>{t.groupName ? `${t.groupName} / ${t.name}` : t.name}</option>)}
      </select>
      {usesAccounts && (
        <select aria-label="流水状态" style={selectStyle} value={filters.status ?? 'all'} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as TransactionFilters['status'] }))}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      <input aria-label="最低金额" className="zc-input" value={filters.amountMin ?? ''} placeholder="最低金额" onChange={(e) => setFilters((f) => ({ ...f, amountMin: e.target.value }))} />
      <input aria-label="最高金额" className="zc-input" value={filters.amountMax ?? ''} placeholder="最高金额" onChange={(e) => setFilters((f) => ({ ...f, amountMax: e.target.value }))} />
      <input aria-label="流水搜索" className="zc-input" value={filters.search} placeholder="搜索描述、交易对象、备注、标签、地点" onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} style={{ gridColumn: 'span 2' }} />
    </div>
  );
}

function SummaryGrid({ vm, usesAccounts }: { vm: NonNullable<ReturnType<typeof buildTransactions>>; usesAccounts: boolean }) {
  if (!usesAccounts) {
    return (
      <div className="zc-transaction-summary-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
        <div className="zc-transaction-summary-metric" style={cardTight}><Kpi label={`${vm.month} 本月支出`} value={money(vm.expense)} tone="var(--negative)" sub="自动汇总全部支出" /></div>
        <div className="zc-transaction-summary-metric" style={cardTight}><Kpi label="当前范围" value={`${vm.count} 笔`} tone="var(--accent)" sub={`合计支出 ${money(vm.filteredExpense)}`} /></div>
        <div style={cardTight}>
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>常用支出分类</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 11 }}>
            {vm.topExpenseCategories.length === 0 && <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>记下第一笔支出后会自动汇总</div>}
            {vm.topExpenseCategories.slice(0, 3).map((category) => (
              <div key={category.category} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
                <span>{category.label}</span><span>{money(category.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="zc-transaction-summary-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16 }}>
      <div className="zc-transaction-summary-metric" style={cardTight}><Kpi label={`${vm.month} 本月收入`} value={money(vm.income)} tone="var(--positive)" sub="不受筛选影响" /></div>
      <div className="zc-transaction-summary-metric" style={cardTight}><Kpi label={`${vm.month} 本月支出`} value={money(vm.expense)} tone="var(--negative)" sub={usesAccounts ? '转账不计入支出' : '只统计收入和支出'} /></div>
      <div className="zc-transaction-summary-metric" style={cardTight}><Kpi label="本月结余" value={signedMoney(vm.net)} tone={Number(vm.net) >= 0 ? 'var(--positive)' : 'var(--negative)'} sub="收入 - 支出" /></div>
      <div className="zc-transaction-summary-metric" style={cardTight}><Kpi label="当前筛选" value={`${vm.count} 条`} tone="var(--accent)" sub={`收 ${money(vm.filteredIncome)} · 支 ${money(vm.filteredExpense)} · ${signedMoney(vm.filteredNet)}`} /></div>
      <div style={cardTight}>
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>Top 支出分类</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 11 }}>
          {vm.topExpenseCategories.length === 0 && <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>本月暂无支出</div>}
          {vm.topExpenseCategories.map((c) => (
            <div key={c.category}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
                <span>{c.label}</span><span>{money(c.amount)}</span>
              </div>
              <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 'var(--r-pill)', overflow: 'hidden', marginTop: 5 }}>
                <div style={{ height: 6, width: `${Math.max(4, c.weight * 100)}%`, background: 'var(--negative)', borderRadius: 'var(--r-pill)' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TransactionList({ vm, onEdit, onRefund, refundRemaining, refundsFor, onManageRefunds, assetCode, usesAccounts, tagName, locationName, attachmentCount, selectedIds, setSelectedIds }: {
  vm: NonNullable<ReturnType<typeof buildTransactions>>;
  onEdit: (tx: Transaction) => void;
  onRefund: (tx: Transaction) => void;
  refundRemaining: (tx: Transaction) => string;
  refundsFor: (tx: Transaction) => RefundRowSummary[];
  onManageRefunds: (tx: Transaction) => void;
  assetCode: (assetId: string) => string;
  usesAccounts: boolean;
  tagName: (id: string) => string;
  locationName: (tx: Transaction) => string | undefined;
  attachmentCount: (tx: Transaction) => number;
  selectedIds?: string[];
  setSelectedIds?: Dispatch<SetStateAction<string[]>>;
}) {
  const selected = new Set(selectedIds ?? []);
  const toggle = (id: string) => setSelectedIds?.((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {vm.groups.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-body)', padding: '20px 0' }}>暂无流水</div>}
      {vm.groups.map((g) => (
        <div key={g.key}>
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', marginBottom: 8 }}>{g.label}</div>
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {g.items.map((item) => {
              const tx = item.tx;
              const title = item.title;
              const tags = [...(tx.tagIds ?? []).map(tagName)];
              const loc = locationName(tx);
              const latitude = Number(tx.latitude);
              const longitude = Number(tx.longitude);
              const accuracy = Number(tx.locationAccuracyMeters);
              const coordinates = tx.latitude && tx.longitude && Number.isFinite(latitude) && Number.isFinite(longitude)
                ? `坐标 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}${Number.isFinite(accuracy) ? ` ±${Math.round(accuracy)}m` : ''}`
                : undefined;
              const files = attachmentCount(tx);
              const remaining = refundRemaining(tx);
              const refunds = tx.type === 'expense' ? refundsFor(tx) : [];
              const refunded = refunds.reduce((total, refund) => total.plus(refund.appliedAmount), D(0));
              // Speak the row's own units (amount + asset), not the report currency.
              const refundedLabel = refunds.length
                ? `${refunded.toString()} / ${tx.amount} ${assetCode(tx.assetId)}`
                : '';
              // An expense that came back in full is no longer still "spent". It stays
              // in the list (the history is the point) but has to read as settled, and it
              // must keep a way into its refunds: the refund row itself is filtered out
              // of a 支出-scoped list, so the badge is the only handle left.
              const settled = refunds.length > 0 && !D(remaining).gt(0);
              const refundChip = refunds.length > 0
                ? {
                  label: settled ? `已退 ${refundedLabel}` : `部分退款 · 已退 ${refundedLabel}`,
                  title: settled
                    ? `${refunds.length} 笔退款已全额退回，点开可查看或作废`
                    : `${refunds.length} 笔退款，剩余可退 ${remaining}，点开可查看或作废`,
                }
                : undefined;
              const selectable = tx.type !== 'adjustment' && item.statusLabel !== '已对账';
              const details = [
                item.typeLabel,
                usesAccounts ? item.accountName : undefined,
                item.payeeName,
                loc ? `地点 ${loc}` : undefined,
                coordinates,
                tags.length ? `标签 ${tags.join(' / ')}` : undefined,
                files ? `附件 ${files}` : undefined,
                item.splitSummary || undefined,
              ].filter(Boolean).join(' · ');
              const mobileDetails = [
                usesAccounts ? item.accountName : undefined,
                tx.type !== 'expense' ? item.typeLabel : undefined,
                usesAccounts && item.statusLabel !== '已记录' ? item.statusLabel : undefined,
                item.splitSummary || undefined,
                files ? `附件 ${files}` : undefined,
              ].filter(Boolean).join(' · ');
              return (
                <div
                  className={`zc-transaction-row${setSelectedIds ? ' has-selection' : ''}${usesAccounts ? ' has-account' : ''}`}
                  key={tx.id}
                  onClick={() => onEdit(tx)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onEdit(tx); }}
                  role="button"
                  tabIndex={0}
                  style={{
                    width: '100%', display: 'grid', gridTemplateColumns: `${setSelectedIds ? '34px ' : ''}${usesAccounts ? '88px var(--zc-category-track) 1fr 150px 110px 72px' : '88px var(--zc-category-track) 1fr 110px 72px'}`,
                    alignItems: 'center', gap: 12, border: 'none', borderBottom: '1px solid var(--border)',
                    background: 'transparent', color: 'var(--text-primary)', padding: '13px 0', textAlign: 'left', cursor: 'pointer',
                  }}
                >
                  {setSelectedIds && (
                    <span className="zc-check-target">
                      <input
                        type="checkbox"
                        checked={selected.has(tx.id)}
                        disabled={!selectable}
                        title={selectable ? '选择流水' : '已对账流水需先解除对账'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => { if (selectable) toggle(tx.id); }}
                        aria-label={`选择 ${title}`}
                      />
                    </span>
                  )}
                  <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>{tx.date}{tx.time ? <span className="zc-transaction-time"><br />{tx.time}</span> : null}</span>
                  {/*
                    分类列宽屏能给到 200px（内置标签最长约 139px，写全了），但自建的超长名仍会
                    触到天花板，那时在这里省略；完整的「一级 / 二级」留在 hover 的 title 里，
                    否则省略之后就只剩半截了。
                  */}
                  <span
                    style={{ ...tagStyle, width: 'fit-content', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', color: tx.type === 'income' || tx.type === 'refund' ? 'var(--positive)' : tx.type === 'expense' ? 'var(--negative)' : 'var(--accent)' }}
                    title={item.categoryLabel}
                  >
                    {item.categoryLabel}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(settled ? { textDecoration: 'line-through', color: 'var(--text-tertiary)' } : {}) }}>{title}</span>
                    <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                      <span className="zc-transaction-details-desktop" style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
                        {details}
                      </span>
                      {mobileDetails && <span className="zc-transaction-details-mobile" style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{mobileDetails}</span>}
                      {refundChip && (
                        <button
                          type="button"
                          className="zc-refund-chip"
                          title={refundChip.title}
                          onClick={(event) => { event.stopPropagation(); onManageRefunds(tx); }}
                        >{refundChip.label}</button>
                      )}
                    </span>
                  </span>
                  {usesAccounts && <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>{item.statusLabel}</span>}
                  <span style={{ justifySelf: 'end', fontSize: 'var(--fs-body)', ...(settled ? { textDecoration: 'line-through', color: 'var(--text-tertiary)' } : amountColor(item.signedAmount)) }}>
                    {tx.type === 'transfer' ? '' : tx.type === 'income' || tx.type === 'refund' || (tx.type === 'adjustment' && tx.adjustmentDirection === 'increase') ? '+' : '-'}{tx.amount} {item.assetCode}
                  </span>
                  <span style={{ justifySelf: 'end' }}>
                    {tx.type === 'expense' && D(remaining).gt(0) ? (
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onRefund(tx); }}
                        style={{ ...button, padding: '6px 10px' }}
                        title={`剩余可退 ${remaining}`}
                      >退款</button>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The refunds behind one expense, and the only handle on them once the original is
 * fully refunded. Refund rows are not listed as their own entries when the ledger
 * is scoped to 支出, so without this screen a full refund would leave the user with
 * an expense they can neither void ("先作废关联退款") nor even open.
 */
function RefundHistoryDialog(props: {
  original: Transaction;
  refunds: RefundRowSummary[];
  remaining: string;
  assetCode: (assetId: string) => string;
  categories: Category[];
  onEditRefund: (refundId: string) => Promise<void>;
  onVoidRefund: (refundId: string) => Promise<void>;
  onNewRefund: (original: Transaction) => void;
  onClose: () => void;
}) {
  const { original, refunds, remaining, assetCode, categories, onEditRefund, onVoidRefund, onNewRefund, onClose } = props;
  const titleId = useId();
  const [pendingVoid, setPendingVoid] = useState<RefundRowSummary | null>(null);
  const refunded = refunds.reduce((total, refund) => total.plus(refund.appliedAmount), D(0)).toString();
  const originalCode = assetCode(original.assetId);
  const title = original.description ?? original.merchant ?? categoryLabel(original.category, categories);
  const canRefundAgain = D(remaining).gt(0);

  return (
    <DialogShell
      labelledBy={titleId}
      onDismiss={onClose}
      backdropStyle={{ background: 'var(--scrim)' }}
      panelClassName="zc-entity-modal zc-refund-history"
      panelStyle={{ width: 'min(560px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 18, boxShadow: 'var(--shadow-lg)', maxHeight: '86vh', overflow: 'auto' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div id={titleId} style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>退款记录</div>
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>
            {original.date} · {title} · 原支出 {original.amount} {originalCode}
          </div>
        </div>
        <button type="button" data-dialog-initial-focus onClick={onClose} style={button}>关闭</button>
      </div>

      <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 'var(--fs-meta)' }}>
        <span>已退 <strong style={{ color: 'var(--positive)' }}>{refunded} {originalCode}</strong></span>
        <span style={{ color: 'var(--text-tertiary)' }}>剩余可退 {remaining} {originalCode}</span>
      </div>

      <div style={{ marginTop: 14, borderTop: '1px solid var(--border)' }}>
        {refunds.map((refund) => {
          const refundCode = assetCode(refund.assetId);
          const crossCurrency = refund.assetId !== original.assetId;
          return (
            <div key={refund.id} className="zc-refund-row">
              <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>{refund.date}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-medium)' }}>
                  到账 {refund.amount} {refundCode}
                </span>
                <span style={{ display: 'block', fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {`冲减原支出 ${refund.appliedAmount} ${originalCode}${crossCurrency ? '（与到账币种不同）' : ''}`}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 6, justifySelf: 'end' }}>
                <button type="button" onClick={() => void onEditRefund(refund.id)} style={{ ...button, padding: '6px 10px' }}>编辑</button>
                <button type="button" onClick={() => setPendingVoid(refund)} style={{ ...button, padding: '6px 10px' }}>作废</button>
              </span>
            </div>
          );
        })}
        {refunds.length === 0 && (
          <div style={{ padding: '16px 0', fontSize: 'var(--fs-body)', color: 'var(--text-tertiary)' }}>这笔支出还没有退款。</div>
        )}
      </div>

      {canRefundAgain && (
        <div style={{ marginTop: 16 }}>
          <button type="button" onClick={() => onNewRefund(original)} style={primary}>再记一笔退款</button>
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 6 }}>
            金额可改小，即部分退款；剩余可退 {remaining} {originalCode}。
          </div>
        </div>
      )}

      {pendingVoid && (
        <ConfirmDialog
          title="作废退款"
          confirmLabel="作废"
          tone="danger"
          onCancel={() => setPendingVoid(null)}
          onConfirm={async () => {
            await onVoidRefund(pendingVoid.id);
            setPendingVoid(null);
          }}
        >
          <p>作废后这笔退款不再冲减原支出，{pendingVoid.amount} {assetCode(pendingVoid.assetId)} 的到账也不再计入余额。记录会写入操作历史并可以恢复。确定继续？</p>
        </ConfirmDialog>
      )}
    </DialogShell>
  );
}

function BatchEditModal(props: {
  snap: Snapshot;
  usesAccounts: boolean;
  count: number;
  transactions: Transaction[];
  onSave: (patch: BatchPatch) => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const { snap, usesAccounts, count, transactions, onSave, onClose } = props;
  const [category, setCategory] = useState('');
  const [payeeId, setPayeeId] = useState('__unchanged__');
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState('');
  const [locationId, setLocationId] = useState('');
  const [addTagIds, setAddTagIds] = useState<string[]>([]);
  const [removeTagIds, setRemoveTagIds] = useState<string[]>([]);
  const [review, setReview] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const readMulti = (e: ChangeEvent<HTMLSelectElement>) => [...e.target.selectedOptions].map((o) => o.value);
  const patch: BatchPatch = {
    category: category || undefined,
    payeeId: payeeId === '__unchanged__' ? undefined : payeeId,
    accountId: accountId || undefined,
    status: (status || undefined) as Transaction['status'] | undefined,
    locationId: locationId || undefined,
    addTagIds,
    removeTagIds,
  };
  const previewSummary = batchSummary(patch, snap);
  const hasPatch = previewSummary !== '批量修改流水';
  const previewRows = transactions.slice(0, 5).map((tx) => {
    try {
      const next = hasPatch ? applyBatchPatch(tx, patch, snap, usesAccounts) : tx;
      return { tx, before: batchPreviewLine(tx, snap, usesAccounts), after: batchPreviewLine(next, snap, usesAccounts), error: '' };
    } catch (err) {
      return { tx, before: batchPreviewLine(tx, snap, usesAccounts), after: '', error: err instanceof Error ? err.message : String(err) };
    }
  });
  const markDirty = () => setReview(false);
  const submit = async () => {
    if (!hasPatch) {
      setError('请选择至少一个要批量修改的字段');
      return;
    }
    if (!review) {
      setReview(true);
      setError('');
      return;
    }
    try {
      setError('');
      setBusy(true);
      await onSave(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <DialogShell
      labelledBy={titleId}
      onDismiss={onClose}
      dismissDisabled={busy}
      backdropStyle={{ background: 'var(--scrim)' }}
      panelClassName="zc-entity-modal zc-batch-modal"
      panelStyle={{ width: 'min(760px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 18, boxShadow: 'var(--shadow-lg)' }}
    >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div>
            <div id={titleId} style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>批量修改流水</div>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 3 }}>将修改应用到 {count} 条流水，金额不会被批量改动。</div>
          </div>
          <button type="button" data-dialog-initial-focus disabled={busy} onClick={onClose} style={button}>关闭</button>
        </div>
        <div className="zc-modal-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <CategoryPicker
            fieldId="batch-category"
            name="batchCategory"
            ariaLabel="批量修改分类"
            value={category}
            options={categoryValueOptions(snap)}
            allowEmpty
            emptyLabel="不改分类"
            placeholder="不改分类"
            defaultShowHidden={snap.setting?.categoryPickerDefaultScope === 'all'}
            triggerStyle={selectStyle}
            onChange={(next) => { markDirty(); setCategory(next); }}
          />
          <ExistingPayeePicker label="批量修改交易对象" payees={snap.payees} value={payeeId} emptyValue="__unchanged__" emptyLabel="不改交易对象" clearLabel="清空交易对象"
            allowInactive={false} disabled={busy} onChange={(id) => { markDirty(); setPayeeId(id); }} />
          {usesAccounts && (
            <>
              <select style={selectStyle} value={accountId} onChange={(e) => { markDirty(); setAccountId(e.target.value); }}>
                <option value="">不改账户</option>
                {snap.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <select style={selectStyle} value={status} onChange={(e) => { markDirty(); setStatus(e.target.value); }}>
                <option value="">不改状态</option>
                {STATUS_OPTIONS.filter((o) => o.value !== 'all').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </>
          )}
          <select style={selectStyle} value={locationId} onChange={(e) => { markDirty(); setLocationId(e.target.value); }}>
            <option value="">不改地点</option>
            {snap.transactionLocations.filter((l) => !l.isDeleted).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="zc-modal-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>
            追加标签
            <select multiple style={{ ...selectStyle, height: 118, padding: 8 }} value={addTagIds} onChange={(e) => { markDirty(); setAddTagIds(readMulti(e)); }}>
              {snap.transactionTags.filter((t) => !t.isDeleted).map((t) => <option key={t.id} value={t.id}>{t.groupName ? `${t.groupName} / ${t.name}` : t.name}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>
            移除标签
            <select multiple style={{ ...selectStyle, height: 118, padding: 8 }} value={removeTagIds} onChange={(e) => { markDirty(); setRemoveTagIds(readMulti(e)); }}>
              {snap.transactionTags.filter((t) => !t.isDeleted).map((t) => <option key={t.id} value={t.id}>{t.groupName ? `${t.groupName} / ${t.name}` : t.name}</option>)}
            </select>
          </label>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 12, background: review ? 'var(--accent-soft)' : 'var(--surface-2)', marginTop: 12 }}>
          <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)' }}>修改预览</div>
          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', marginTop: 5 }}>{hasPatch ? previewSummary : '尚未选择要修改的字段'}</div>
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 8 }}>将影响 {count} 条流水，先展示前 {Math.min(5, transactions.length)} 条：</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
            {previewRows.map(({ tx, before, after, error }) => (
              <div className="zc-batch-preview-row" key={tx.id} style={{ display: 'grid', gridTemplateColumns: '96px 1fr 100px', gap: 8, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>
                <span>{tx.date}</span>
                <span>
                  <b style={{ color: 'var(--text-tertiary)' }}>改前</b> {before}
                  <br />
                  <b style={{ color: error ? 'var(--negative)' : 'var(--fg-subtle)' }}>改后</b> {error || after}
                </span>
                <span style={{ textAlign: 'right' }}>{tx.amount}</span>
              </div>
            ))}
          </div>
        </div>
        {error && <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', marginTop: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} disabled={busy} style={button}>取消</button>
          <button onClick={() => void submit()} disabled={busy} style={primary}>{busy ? '正在应用…' : review ? '确认应用' : '预览修改'}</button>
        </div>
    </DialogShell>
  );
}

const TREND_WINDOWS: readonly (readonly [3 | 6 | 12, string])[] = [[3, '近 3 个月'], [6, '近 6 个月'], [12, '近 12 个月']];

/**
 * 全部流水趋势。
 *
 * 口径写进标题而不是留在代码里：趋势读的是**无筛选**汇总（与「本月支出」
 * KPI 同一个读），所以用户设了筛选、发现柱子不动时必须一眼看出是设计而非 bug。
 * 旧版本只写「近 6 个月趋势」，没任何地方说它不跟筛选。
 */
function Trend(props: {
  vm: NonNullable<ReturnType<typeof buildTransactions>>;
  months: 3 | 6 | 12;
  onMonthsChange: (value: 3 | 6 | 12) => void;
  focus: string;
  onFocusChange: (key: string) => void;
}) {
  const { vm, months, onMonthsChange, focus, onFocusChange } = props;
  const buckets = vm.trend.map((row) => ({
    key: row.month,
    /* 12 个月时留「年-月」，否则只留月份：两者都是为了隔月也能认出来。 */
    label: months > 6 ? row.month.slice(2) : row.month.slice(5),
    detail: `${row.month} · 收入 ${money(row.income)} · 支出 ${money(row.expense)} · 净 ${signedMoney(row.net)}`,
    bars: [
      { label: '收入', value: Number(row.income), text: money(row.income), color: 'var(--positive)' },
      { label: '支出', value: Number(row.expense), text: money(row.expense), color: 'var(--negative)' },
    ],
  }));
  /* 默认停在最近一个月：它就是用户刚记完账要看的那一格。 */
  const focused = buckets.find((bucket) => bucket.key === focus) ?? buckets[buckets.length - 1];
  const tallest = buckets.flatMap((bucket) => bucket.bars.map((bar) => ({ ...bar, month: bucket.key })))
    .reduce<{ label: string; text: string; month: string; value: number } | null>(
      (top, bar) => (top === null || bar.value > top.value ? bar : top),
      null,
    );
  return (
    <div style={card}>
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
        <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', minWidth: 0 }}>全部流水趋势 · 近 {months} 个月</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <ChartLegend items={[{ label: '收入', color: 'var(--positive)' }, { label: '支出', color: 'var(--negative)' }]} />
          <select
            aria-label="趋势时间跨度"
            value={months}
            onChange={(event) => onMonthsChange(Number(event.target.value) as 3 | 6 | 12)}
            style={{ ...selectBase, width: 'auto' }}
          >
            {TREND_WINDOWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginBottom: 14 }}>
        全部流水口径，不随上方筛选变化{tallest ? ` · 峰值 ${tallest.text}（${tallest.month} ${tallest.label}）` : ''}
      </div>
      <TrendBars
        ariaLabel={`全部流水趋势，近 ${months} 个月`}
        buckets={buckets}
        selectedKey={focused?.key}
        onSelect={onFocusChange}
      />
      {focused && (
        <div aria-live="polite" style={{ marginTop: 10, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>
          {focused.detail}　<span style={{ color: 'var(--text-tertiary)' }}>点柱查看其他月份</span>
        </div>
      )}
    </div>
  );
}

/**
 * 本月支出构成：左环是全部一级板块，选中一段后右环画出那一个板块的二级细分。
 *
 * 口径是**本月、不跟筛选**：构成图跨分类聚合，如果跟着分类筛选，
 * 用户筛一个分类之后环里就只剩一段（100%），「钱花在哪里」就自我矛盾了。
 * 所以下钻不重画左环，只是把当前层级写在面包屑上、并给右环一个主题。
 *
 * 右环不是另算一遍：两项都来自同一个 selector（`vm.expenseComposition` 与
 * `vm.expenseChildren`），所以右环各段之和恒等于左环高亮那一段的金额，
 * 两个环不会各自说一套数。
 */
function ExpenseCompositionCard(props: {
  vm: NonNullable<ReturnType<typeof buildTransactions>>;
  drill: CategoryDrill | null;
  /** 选中板块的显示名，由调用方给（它手里有分类目录）。 */
  parentLabel: string;
  onSelectParent: (parent: string) => void;
  onSelectChild: (parent: string, child: string) => void;
}) {
  const { vm, drill, parentLabel, onSelectParent, onSelectChild } = props;
  const composition = vm.expenseComposition;
  /* 两个环共用这个装箱函数：分类色按**排名**取（主题里的 --cat-N），标签、金额、份额
     都照搬 selector 给的值——图表不自己算钱。 */
  const chartSlices = (rows: typeof composition.slices, others: typeof composition.others, onSelect?: (category: string) => void): ChartSlice[] => [
    ...rows.map((slice, index) => ({
      key: slice.category,
      label: slice.label,
      amountText: money(slice.amount),
      weight: slice.weight,
      color: CATEGORY_COLORS[index % CATEGORY_COLORS.length] ?? OTHER_CATEGORY_COLOR,
      onSelect: onSelect ? () => onSelect(slice.category) : undefined,
    })),
    ...(others.count > 0
      ? [{
        key: '__other__',
        label: `其他 ${others.count} 类`,
        amountText: money(others.amount),
        weight: others.weight,
        color: OTHER_CATEGORY_COLOR,
      }]
      : []),
  ];
  const parent = drill?.parent ?? '';
  const child = drill?.child ?? '';
  const children = parent ? vm.expenseChildren[parent] : undefined;
  return (
    <div style={card}>
      <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>本月支出构成</div>
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 3, marginBottom: 14 }}>
        {composition.slices.length === 0
          ? '不随上方筛选变化'
          : parent
            ? `左环是本月全部板块；右环是「${parentLabel}」的细分。点细分只看那一项，再点退回上一层`
            : '点一段：看这个板块的细分，流水只显示它本月的支出；再点同一段取消'}
      </div>
      <div className="zc-chart-pair">
        <CompositionDonut
          ariaLabel={`${vm.month} 本月支出构成（一级分类）`}
          totalText={money(composition.total)}
          totalCaption="本月支出"
          selectedKey={parent || undefined}
          testId="composition-parent"
          slices={chartSlices(composition.slices, composition.others, onSelectParent)}
        />
        {parent && children && (
          <CompositionDonut
            ariaLabel={`${parentLabel} 的二级构成`}
            totalText={money(children.total)}
            totalCaption={parentLabel}
            selectedKey={child || undefined}
            emptyText="这个板块本月还没有可归类的支出"
            testId="composition-children"
            slices={chartSlices(children.slices, children.others, (category) => onSelectChild(parent, category))}
          />
        )}
      </div>
    </div>
  );
}

function Table(props: { headers: string[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{props.headers.map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <>
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-display)', fontWeight: 'var(--fw-bold)', marginTop: 10, color: tone, whiteSpace: 'nowrap' }}>{value}</div>
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 5, fontWeight: 'var(--fw-medium)' }}>{sub}</div>
    </>
  );
}

function scheduleLabel(status: 'overdue' | 'due' | 'future' | 'paused'): string {
  if (status === 'overdue') return '已逾期';
  if (status === 'due') return '待处理';
  if (status === 'paused') return '已暂停';
  return '未来';
}
