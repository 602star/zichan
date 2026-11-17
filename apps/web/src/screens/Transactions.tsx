import { ExistingPayeePicker } from '../ui/PayeePicker.js';
import { ChevronDown, ChevronRight, FileText, MoreHorizontal, Pencil, Undo2 } from 'lucide-react';
import { EarlierBalancePanel } from '../ui/EarlierBalancePanel.js';
import { AccountSetupPanel } from '../ui/AccountSetupPanel.js';
import { AccountHistoryPanel } from '../ui/AccountHistoryPanel.js';
import { AccountsWorkspace } from '../ui/AccountsWorkspace.js';
import { useTransactionEditor } from '../use-transaction-editor.js';
import { accountSessionStorage } from '../account-storage.js';
import { readOnboarding, updateOnboarding, ONBOARDING_CHANGED_EVENT, type OnboardingState } from '../onboarding.js';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { continuedEntryFields } from '../desktop-workspace.js';
import { DcaPlans } from './DcaPlans.js';
import { useWorkspaceState } from '../ui/useWorkspaceState.js';
import { QueryGeneration } from '../query-generation.js';
import { isRecentTransactionDay, loadTransactionBrowseRange } from '../transaction-browse-range.js';
import {
  D, accountBalanceTiming, isLegacyExternalAccount, dateRangeForPreset, isDateInRange, isTransactionActive, localToday, dayOfInstant, newId, nextUnhandledScheduleOccurrence,
  type Account, type BudgetCategory, type Category, type Payee, type ReconciliationSession,
  type ScheduledTransaction, type Setting, type Transaction, type TransactionSavedView, type TransactionSplit, type TransactionTemplate, type TransactionType,
} from '@zichan/core';
import {
  archiveMasterData,
  archiveScheduledTransaction,
  deleteBudgetCategory,
  deleteTransactionSavedView,
  materializeScheduledTransaction,
  acknowledgeScheduledTransaction,
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
  transactionForm, transactionSplitForm, transactionTemplateForm, type AttachmentDraft, type TransactionFormValue,
} from '../forms.js';
import { amount as fmtAmount, money, num, signedMoney } from '../format.js';
import { amountColor, selectBase, tag as tagStyle, td as tdStyle, th as thStyle } from '../ui/styles.js';
import { ChartLegend, CompositionDonut, TrendBars, type ChartSlice } from '../ui/charts.js';
import { CATEGORY_COLORS, OTHER_CATEGORY_COLOR } from '../theme.js';
import { CATEGORY_PACKS, categoryPackState, categoryLabel, categoryName, categoryOptions, categoryType as metaCategoryType, rootCategoryId, transactionSummaryTitle, TYPE_LABEL } from '../transactionMeta.js';
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
import { ActionSheet } from '../ui/ActionSheet.js';
import { CardFact } from '../ui/Card.js';
import { useRecordGestures } from '../ui/useRecordGestures.js';
import { canNavigateWorkspace, navigateTo, rememberScreenTarget, useScreenTarget } from '../screen-target.js';
import { TaskList, useMobileSection } from '../ui/MobilePage.js';

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

function mergeAccountLedgerPage(current: AccountLedgerPage, page: AccountLedgerPage): AccountLedgerPage {
  return { ...page, rows: [...current.rows, ...page.rows] };
}

const selectStyle = selectBase;

const buttonCls = 'zc-btn';
const primaryCls = 'zc-btn zc-btn--primary';

type Tab = 'records' | 'accounts' | 'budget' | 'bills' | 'dca';
type AccountTask =
  | { kind: 'edit'; account?: Account }
  | { kind: 'history' }
  | { kind: 'earlier'; account: Account }
  | { kind: 'reconcile'; session?: ReconciliationSession; accountId: string; assetId: string };

function initialTransactionTab(): Tab {
  try {
    const requested = accountSessionStorage.getItem('zichan.transactions.tab');
    accountSessionStorage.removeItem('zichan.transactions.tab');
    return requested === 'accounts' || requested === 'budget' || requested === 'bills' || requested === 'dca' ? requested : 'records';
  } catch {
    return 'records';
  }
}

export function Transactions({ entryOnly = false, onEntryClose }: { entryOnly?: boolean; onEntryClose?: () => void } = {}) {
  const compactView = useCompactView();
  const screenTarget = useScreenTarget('transactions');
  const { store, bump, rev, preview } = useStore();
  const undo = useUndo(store, bump);
  const billUndo = useUndo();
  const snap = useSnapshot('transactions');
  const [accountId, setAccountId] = useWorkspaceState('transactions.account', '');
  const [accountRange, setAccountRange] = useWorkspaceState<DateRangeValue>('transactions.account-range', dateRangeValue('all'));
  const [assetId, setAssetId] = useWorkspaceState('transactions.asset', 'all');
  const [filters, setFilters] = useWorkspaceState<TransactionFilters>('transactions.filters', DEFAULT_FILTERS);
  const [initialTab] = useState(initialTransactionTab);
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [mobileTab, selectMobileTab] = useMobileSection('transactions', initialTab);
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    if (!entryOnly) selectMobileTab(next);
  }, [entryOnly, selectMobileTab]);
  useEffect(() => { if (!entryOnly && compactView && ['records', 'accounts', 'budget', 'bills', 'dca'].includes(mobileTab)) setTabState(mobileTab as Tab); }, [mobileTab, compactView, entryOnly]);
  useEffect(() => {
    if (entryOnly) return;
    if (screenTarget?.tab && ['records', 'accounts', 'budget', 'bills', 'dca'].includes(screenTarget.tab)) setTab(screenTarget.tab as Tab);
    if (screenTarget?.tab === 'accounts' && screenTarget.id) setAccountId(screenTarget.id);
    let active = true;
    if (screenTarget?.tab === 'records' && screenTarget.id) {
      void store.transactions.get(screenTarget.id).then((row) => {
        if (active && row) setFilters({ ...DEFAULT_FILTERS, range: 'custom', dateFrom: row.date, dateTo: row.date });
      }).catch((cause) => { if (active) setTransactionReadError(cause instanceof Error ? cause.message : String(cause)); });
    }
    return () => { active = false; };
  }, [screenTarget, store, entryOnly, setTab, setAccountId, setFilters]);
  const [editingTx, setEditingTx] = useState<Transaction | 'new' | null>(null);
  const [entryGeneration, setEntryGeneration] = useState(0);
  const [entryFields, setEntryFields] = useState<Record<string, string>>({});
  const [retainEntryFields, setRetainEntryFields] = useState(true);
  const [showFirstEntryGuide, setShowFirstEntryGuide] = useState(false);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [creatingOwnTemplate, setCreatingOwnTemplate] = useState<TransactionTemplate | null>(null);
  const [refundDraft, setRefundDraft] = useState<Transaction | null>(null);
  /** The expense whose refunds the user asked to inspect. */
  const [refundHistoryFor, setRefundHistoryFor] = useState<Transaction | null>(null);
  const [templateDraft, setTemplateDraft] = useState<Transaction | null>(null);
  const [quickExpenseOpen, setQuickExpenseOpen] = useState(false);
  const [quickTemplate, setQuickTemplate] = useState<TransactionTemplate | null>(null);
  const [editingSplit, setEditingSplit] = useState<TransactionSplit | 'new' | null>(null);
  const [editingBudget, setEditingBudget] = useState<BudgetCategory | 'new' | null>(null);
  const [budgetDetailKey, setBudgetDetailKey] = useState('');
  const [billDetailKey, setBillDetailKey] = useState('');
  const [billActionBusy, setBillActionBusy] = useState(false);
  const [billActionError, setBillActionError] = useState('');
  const [editingSchedule, setEditingSchedule] = useState<ScheduledTransaction | 'new' | null>(null);
  const [billPreset, setBillPreset] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!entryOnly && screenTarget?.tab === 'bills' && screenTarget.id === 'new') {
      setBillPreset({}); setEditingSchedule('new');
      rememberScreenTarget({ screen: 'transactions', tab: 'bills' });
    }
  }, [entryOnly, screenTarget]);
  const [editingCategory, setEditingCategory] = useState<Category | 'new' | null>(null);
  const [editingPayee, setEditingPayee] = useState<Payee | 'new' | null>(null);
  const [accountTask, setAccountTask] = useState<AccountTask | null>(null);
  function openAccountTask(task: AccountTask) { setAccountTask((current) => current ?? task); }
  const [batchOpen, setBatchOpen] = useState(false);
  const [showVoided, setShowVoided] = useState(false);
  const [recordView, setRecordView] = useWorkspaceState<TimelineViewMode>('transactions.view', 'list');
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
  const [accountBalanceAggregates, setAccountBalanceAggregates] = useState<AccountBalanceAggregateRow[]>([]);
  const [accountBalancesBusy, setAccountBalancesBusy] = useState(true);
  const [accountBalanceError, setAccountBalanceError] = useState('');
  const [accountLedgerPage, setAccountLedgerPage] = useState<AccountLedgerPage | null>(null);
  const [accountLedgerKey, setAccountLedgerKey] = useState('');
  const [accountLedgerBusy, setAccountLedgerBusy] = useState(false);
  const [accountLedgerError, setAccountLedgerError] = useState('');
  const usesAccounts = true;
  useEffect(() => {
    if (!snap?.setting?.id) return;
    const apply = (state: OnboardingState | null) => {
      setOnboarding(state); setShowFirstEntryGuide(Boolean(state && !state.dismissed));
    };
    apply(readOnboarding(snap.setting.id));
    const changed = (event: Event) => {
      const state = (event as CustomEvent<OnboardingState>).detail;
      if (state.settingId === snap.setting?.id) apply(state);
    };
    window.addEventListener(ONBOARDING_CHANGED_EVENT, changed);
    return () => window.removeEventListener(ONBOARDING_CHANGED_EVENT, changed);
  }, [snap?.setting?.id, screenTarget?.intent]);
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
  }, [setFilters]);
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
      if (!canNavigateWorkspace()) return;
      setEntryFields({});
      setEntryGeneration((current) => current + 1);
      setTab('records');
      setEditingTx(null);
      setRefundDraft(null);
      setTemplateDraft(null);
      setEditingTx('new');
    };
    if (entryOnly) openQuickTransaction();
    try {
      if (accountSessionStorage.getItem('zichan.quickTransaction') === '1') {
        accountSessionStorage.removeItem('zichan.quickTransaction');
        openQuickTransaction();
      }
      const firstRun = accountSessionStorage.getItem('zichan.postFirstRun');
      if (firstRun === 'account-setup' || firstRun === 'quick-expense') {
        accountSessionStorage.removeItem('zichan.postFirstRun');
        setTab(firstRun === 'account-setup' ? 'accounts' : 'records');
      }
    } catch {
      // Ignore storage failures; the live event below still works.
    }
    window.addEventListener('zichan:quick-transaction', openQuickTransaction);
    return () => window.removeEventListener('zichan:quick-transaction', openQuickTransaction);
  }, [entryOnly, setTab]);
  const visibleTabs: [Tab, string][] = usesAccounts
    ? [['records', '流水'], ['accounts', '账户'], ['budget', '预算'], ['bills', '账单与还款'], ...(!compactView || tab === 'dca' ? [['dca', '定投'] as [Tab, string]] : [])]
    : [['records', '支出']];
  const activeTab = usesAccounts ? tab : 'records';
  useEffect(() => {
    if (!entryOnly) window.dispatchEvent(new CustomEvent('zichan:transaction-tab', { detail: activeTab }));
  }, [activeTab, entryOnly]);
  const viewFilters = useMemo<TransactionFilters>(() => {
    if (usesAccounts) return filters;
    return {
      ...filters,
      type: 'expense',
      accountId: 'all',
    };
  }, [filters, usesAccounts]);
  const queryAsOf = snap ? ledgerAsOfDate(snap) : todayDate();
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
    const controller = new AbortController();
    let cancelled = false;
    const month = queryAsOf.slice(0, 7);
    const summaryRange = trendRange(month, trendMonths);
    const today = localToday();
    const week = dateRangeForPreset('this_week', today);
    summaryRange.from = [summaryRange.from, week.from ?? today].sort()[0]!;
    summaryRange.to = [summaryRange.to, week.to ?? today].sort().at(-1)!;
    setTransactionPageBusy(true);
    setTransactionReadError('');
    void Promise.all([
      loadTransactionBrowseRange((input) => store.transactionBrowsePage(input), browseInput, controller.signal),
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
        const visibleIds = new Set(page.transactions.map((transaction) => transaction.id));
        setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
      }
    }).catch((error) => {
      if (!cancelled) {
        setTransactionRead(null);
        setTransactionReadError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!cancelled) setTransactionPageBusy(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [browseInput, queryAsOf, rev, snap, store, trendMonths]);
  useEffect(() => {
    if (!showVoided) {
      setVoidedPage(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void loadTransactionBrowseRange((input) => store.transactionBrowsePage(input), {
      from: queryDateRange.from,
      to: queryDateRange.to,
      recordState: 'voided',
      excludeTypes: usesAccounts ? undefined : ['transfer', 'adjustment'],
    }, controller.signal).then((page) => {
      if (!cancelled) setVoidedPage(page);
    }).catch((error) => {
      if (!cancelled) setTransactionReadError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
      controller.abort();
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
    setAccountBalancesBusy(true);
    setAccountBalanceError('');
    void store.accountBalanceAggregates()
      .then((rows) => {
        if (!cancelled) setAccountBalanceAggregates(rows);
      })
      .catch((error) => {
        if (!cancelled) setAccountBalanceError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (!cancelled) setAccountBalancesBusy(false);
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
      .sort((left, right) => left.accountName.localeCompare(right.accountName) || left.assetCode.localeCompare(right.assetCode));
  }, [accountBalanceAggregates, snap]);
  const fundAccountsForRead = snap?.accounts.filter((account) => !account.isDeleted && !isLegacyExternalAccount(account)) ?? [];
  const selectedAccountForRead = fundAccountsForRead.find((account) => account.id === accountId)?.id
    ?? fundAccountsForRead.find((account) => account.id === accountBalanceRows[0]?.accountId)?.id ?? fundAccountsForRead[0]?.id ?? '';
  const selectedAssetForRead = assetId === 'all' ? undefined : assetId;
  const expectedAccountLedgerKey = `${selectedAccountForRead}\0${selectedAssetForRead ?? ''}\0${accountRange.from ?? ''}\0${accountRange.to ?? ''}`;
  useEffect(() => {
    const gate = accountQuery.current;
    gate.reset();
    if (activeTab !== 'accounts' || !selectedAccountForRead) return;
    const token = gate.start()!;
    let cancelled = false;
    setAccountLedgerBusy(true);
    setAccountLedgerError('');
    void store.accountLedgerPage({
      accountId: selectedAccountForRead,
      assetId: selectedAssetForRead,
      from: accountRange.from,
      to: accountRange.to,
      limit: 100,
    }).then((page) => {
      if (!cancelled) { setAccountLedgerPage(page); setAccountLedgerKey(expectedAccountLedgerKey); }
    }).catch((error) => {
      if (!cancelled) setAccountLedgerError(error instanceof Error ? error.message : String(error));
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
    expectedAccountLedgerKey,
    accountRange.from,
    accountRange.to,
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
  const transactionEditor = useTransactionEditor(store, pageSnap, editingTx === 'new' ? refundDraft : editingTx, rev);
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
  if (!snap || !transactionRead || !vm || !pageSnap) return entryOnly
    ? <ActionSheet title="记一笔" onClose={() => onEntryClose?.()} actions={[]}><p role={transactionReadError ? 'alert' : 'status'}>{transactionReadError ? `流水读取失败：${transactionReadError}。请关闭后重试。` : '正在读取记账资料…'}</p></ActionSheet>
    : transactionReadError
    ? <div role="alert" className="zc-alert is-danger">流水读取失败：{transactionReadError}。请刷新页面重试。</div>
    : <div role="status" className="zc-ledger-loading">正在加载当前范围全部流水…</div>;
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
  const accountLedgerCurrent = accountLedgerKey === expectedAccountLedgerKey;
  const ledger = (accountLedgerCurrent ? accountLedgerPage?.rows ?? [] : []).map((row) => {
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
  const accountAssets = [...new Set([...readyVm.accountBalances.filter((b) => b.accountId === selectedAccountId).map((b) => b.assetId),
    ...readySnap.accounts.filter((account) => account.id === selectedAccountId && account.openingAssetId).map((account) => account.openingAssetId!)])];
  const activeTemplates = readySnap.transactionTemplates
    .filter((t) => !t.isDeleted && t.isActive && (usesAccounts || t.type === 'expense'))
    .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100) || a.name.localeCompare(b.name));
  const firstTemplate = activeTemplates[0];
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
    if (!canNavigateWorkspace()) return;
    setEntryGeneration((current) => current + 1);
    setEntryFields({});
    setQuickExpenseOpen(false);
    setQuickTemplate(null);
    setRefundDraft(null);
    setTemplateDraft(null);
    setEditingTx('new');
  }

  async function loadMoreAccountLedger() {
    if (!accountLedgerCurrent || !accountLedgerPage?.hasMore || !accountLedgerPage.nextCursor || accountLedgerBusy || !selectedAccountId) return;
    const gate = accountQuery.current;
    const token = gate.start();
    if (!token) return;
    setAccountLedgerBusy(true);
    setAccountLedgerError('');
    try {
      const page = await store.accountLedgerPage({
        accountId: selectedAccountId,
        assetId: selectedAssetId,
        from: accountRange.from,
        to: accountRange.to,
        cursor: accountLedgerPage.nextCursor,
        startingBalances: accountLedgerPage.nextStartingBalances,
        limit: 100,
      });
      setAccountLedgerPage((current) => gate.current(token) && current ? mergeAccountLedgerPage(current, page) : current);
    } catch (error) {
      if (gate.current(token)) setAccountLedgerError(error instanceof Error ? error.message : String(error));
    } finally {
      if (gate.current(token)) setAccountLedgerBusy(false);
      gate.finish(token);
    }
  }

  function openTransaction(transaction: Transaction) {
    if (!canNavigateWorkspace()) return;
    if (transaction.type === 'adjustment' && transaction.reconciliationSessionId) {
      const session = readySnap.reconciliationSessions.find((row) => row.id === transaction.reconciliationSessionId);
      if (session) {
        openAccountTask({ kind: 'reconcile', session, accountId: session.accountId, assetId: session.assetId });
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

  function startRefund(original: Transaction) {
    if (!canNavigateWorkspace()) return;
    const remaining = remainingRefundAmount(original);
    if (D(remaining).lte(0)) return;
    const now = new Date();
    const zone = readySnap.setting?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const description = original.description ?? original.merchant ?? categoryLabel(original.category, readySnap.categories);
    setRefundDraft({
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      date: dayOfInstant(now, zone),
      time: new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now),
      timezone: zone,
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
        setOnboarding((current) => current ? updateOnboarding(current, { firstTransactionRecorded: true, dismissed: current.dismissed || (!compactView && !current.firstTransactionRecorded) }) : current);
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

  function openCategoryPacks() {
    try {
      accountSessionStorage.setItem('zichan.manage.target', JSON.stringify({ tab: 'transactionCategories', categoryMode: 'quick' }));
    } catch { /* Navigation remains available without session storage. */ }
    window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'manage' } }));
  }

  function openTemplateCenter() {
    try {
      accountSessionStorage.setItem('zichan.manage.target', JSON.stringify({ tab: 'other', otherTab: 'templates' }));
    } catch { /* Navigation remains available without session storage. */ }
    window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'manage' } }));
  }

  function openOwnTemplate() {
    const recent = readyTransactionRead.recommendationTransactions.find((transaction) => isTransactionActive(transaction) && transaction.type !== 'refund' && transaction.type !== 'adjustment' && transaction.type !== 'transfer')
      ?? readySnap.transactions.find((transaction) => isTransactionActive(transaction) && transaction.type !== 'refund' && transaction.type !== 'adjustment' && transaction.type !== 'transfer');
    if (!recent) return;
    setCreatingOwnTemplate({
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      name: recent.description?.trim() || categoryLabel(recent.category, readySnap.categories),
      type: recent.type, category: recent.category, assetId: recent.assetId,
      accountId: recent.accountId, payeeId: recent.payeeId, merchant: recent.merchant,
      description: recent.description, tagIds: recent.tagIds, locationId: recent.locationId,
      sortOrder: 100, isActive: true,
    });
  }

  function dismissOnboarding() {
    setOnboarding((current) => current ? updateOnboarding(current, { dismissed: true }) : current);
    setShowFirstEntryGuide(false);
  }

  function showMobileGuideStep(step: number) {
    setOnboarding((current) => current ? updateOnboarding(current, { mobileStep: step }) : current);
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

  function openNewBill(preset: Record<string, string> = {}) {
    if (!canNavigateWorkspace()) return;
    setBillPreset(preset);
    setEditingSchedule('new');
  }

  async function handleBill(s: ScheduledTransaction, mode: 'mark' | 'record') {
    if (billActionBusy) return;
    setBillActionBusy(true); setBillActionError('');
    try {
      if (mode === 'record') await materializeSchedule(s);
      else {
        const occurrence = nextUnhandledScheduleOccurrence(s, readySnap.scheduledExecutions);
        if (!occurrence) throw new Error('账单计划已完成');
        const execution = await acknowledgeScheduledTransaction(store, s.id, occurrence.index);
        bump();
        billUndo.offer('本期已处理，未生成收支流水', async () => {
          const current = await store.scheduledExecutions.get(execution.id);
          if (!current || current.isDeleted || current.status !== 'skipped' || current.version !== execution.version) throw new Error('本期记录已变化，请刷新后查看');
          await store.runInAuditBatch('撤销账单处理标记', (transactionStore) => transactionStore.scheduledExecutions.put({ ...current, isDeleted: true }));
          bump();
        });
      }
      setBillDetailKey('');
    } catch (cause) { setBillActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBillActionBusy(false); }
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

  const mobileGuideSteps = onboarding?.path === 'accounts'
    ? (['accounts', 'entry', 'categories', 'templates', 'navigation'] as const)
    : (['entry', 'categories', 'templates', 'navigation'] as const);
  const mobileGuideStep = Math.min(Math.max(onboarding?.mobileStep ?? 0, 0), mobileGuideSteps.length - 1);
  const mobileGuideKind = mobileGuideSteps[mobileGuideStep];
  const hasEnabledCategoryPack = CATEGORY_PACKS.some((pack) => categoryPackState(pack, readySnap.categories).enabledCount > 0);

  const reopenGuideControl = onboarding && !showFirstEntryGuide && activeTab === 'records' && (
        <button type="button" className="zc-onboarding-reopen" onClick={() => { setOnboarding(updateOnboarding(onboarding, { dismissed: false })); setShowFirstEntryGuide(true); }}>
          查看新手指南
        </button>
      );
  const guideDestinations = <div className="zc-first-entry-actions">
    <button type="button" className={buttonCls} onClick={() => setTab('accounts')}>查看账户</button>
    <button type="button" className={buttonCls} onClick={() => setTab('bills')}>查看账单与还款</button>
    <button type="button" className={buttonCls} onClick={() => navigateTo({ screen: 'fixed' })}>查看物品资产</button>
    <button type="button" className={buttonCls} onClick={() => navigateTo({ screen: 'manage' })}>查看资料管理</button>
    <button type="button" className={buttonCls} onClick={() => navigateTo({ screen: 'settings', tab: 'device' })}>查看本机备份</button>
  </div>;
  return (
    <div className={`zc-ledger-page is-${activeTab}`} style={{ display: entryOnly ? 'none' : 'flex', flexDirection: 'column', gap: compactView ? 'var(--sp-5)' : 'var(--sp-3)' }}>
      {vm.missingRateAssetCodes.length > 0 && (
        <div className="zc-alert" role="status">
          缺少 {vm.missingRateAssetCodes.join('、')} → {vm.reportCurrencyCode} 的价格标记；相关流水不会静默当作 0，汇总和预算会标记为未完整折算。
        </div>
      )}
      <div className="zc-transaction-local-tabs" style={{ display: !compactView && !['budget', 'dca'].includes(activeTab) ? 'none' : 'flex', gap: 8, flexWrap: 'wrap' }}>
        {visibleTabs.filter(([id]) => compactView || (['budget', 'dca'].includes(activeTab) ? ['budget', 'dca'].includes(id) : id === activeTab)).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={activeTab === id ? primaryCls : buttonCls}>{label}</button>
        ))}
      </div>

      {compactView && reopenGuideControl}
      {onboarding && showFirstEntryGuide && !compactView && activeTab === 'records' && (
        <section className="zc-first-entry-guide" aria-label="首次记账引导">
          <div>
            <h2>账本已准备好</h2>
            <p>按自己的节奏完成以下步骤。分类和模板都可以以后再设置。</p>
          </div>
          <div className="zc-onboarding-steps">
            {onboarding.path === 'accounts' && (
              <div className="zc-onboarding-step">
                <div><strong>设置常用账户</strong><p>在“账户”添加银行卡或钱包，填写余额与截至时间，再设置默认支出、收入账户。系统预建的两个账户同属“其他”类型，可直接记账；仅这两个账户不提供对账，自行添加的账户仍可核对。</p></div>
                <button type="button" className={buttonCls} onClick={() => { setTab('accounts'); openAccountTask({ kind: 'edit' }); }}>添加账户</button>
              </div>
            )}
            <div className="zc-onboarding-step">
              <div><strong>记第一笔{onboarding.firstTransactionRecorded ? ' · 已完成' : ''}</strong><p>在流水页点击“+ 记账”，弹窗里先填金额和分类；保存后回到流水，也可保存并继续。</p></div>
              <button type="button" className={onboarding.firstTransactionRecorded ? buttonCls : primaryCls} onClick={openNewTransaction}>{onboarding.firstTransactionRecorded ? '再记一笔' : '记第一笔'}</button>
            </div>
            <div className="zc-onboarding-step">
              <div><strong>按场景补充分类{hasEnabledCategoryPack ? ' · 已启用' : onboarding.categorySkipped ? ' · 已跳过' : ''}</strong><p>养宠、旅行等分类按需启用，已有记录不会改变。</p></div>
              <div className="zc-first-entry-actions"><button type="button" className={buttonCls} onClick={openCategoryPacks}>查看扩展包</button>{!onboarding.categorySkipped && <button type="button" className={buttonCls} onClick={() => setOnboarding(updateOnboarding(onboarding, { categorySkipped: true }))}>暂不需要</button>}</div>
            </div>
            <div className="zc-onboarding-step">
              <div><strong>用模板快速记账{onboarding.templateUsed ? ' · 已体验' : ''}</strong><p>先试用自带模板；记过一笔后，也能保存自己的常用交易。</p></div>
              <div className="zc-first-entry-actions">
                {firstTemplate && <button type="button" className={buttonCls} onClick={() => { setTab('records'); createFromTemplate(firstTemplate); }}>试用{firstTemplate.name}模板</button>}
                {onboarding.firstTransactionRecorded && <button type="button" className={buttonCls} onClick={openOwnTemplate}>创建自己的模板</button>}
                <button type="button" className={buttonCls} onClick={openTemplateCenter}>查看全部模板</button>
              </div>
            </div>
          </div>
          <div className="zc-onboarding-next-tasks"><h3>找到常用功能</h3>
            <p>电脑从侧栏进入工作台、流水、账户、账单与还款、计划；资料管理维护分类、交易对象与模板。隐藏的模块可在“设置 → 记账 → 侧边栏与模块”启用。</p>
            <p>点流水行查看明细，再点“编辑”修改。账单与还款可以独立记录；物品资产默认卡片，可从“记录生命周期事件”购入配件、报废或登记云服务费用。请定期导出加密备份。</p>
            {guideDestinations}
          </div>
          <div className="zc-first-entry-actions"><button type="button" className={buttonCls} onClick={dismissOnboarding}>暂时收起</button></div>
        </section>
      )}
      {onboarding && showFirstEntryGuide && compactView && activeTab === 'records' && (
        <section className="zc-first-entry-guide zc-first-entry-guide-mobile" aria-label="首次记账引导">
          <div className="zc-mobile-guide-header">
            <span>新手指南 · {mobileGuideStep + 1}/{mobileGuideSteps.length}</span>
            <button type="button" onClick={dismissOnboarding}>收起</button>
          </div>
          <div className="zc-mobile-guide-progress" aria-hidden="true">
            {mobileGuideSteps.map((step, index) => <span key={step} className={index <= mobileGuideStep ? 'is-active' : ''} />)}
          </div>
          {mobileGuideKind === 'accounts' && (
            <div className="zc-mobile-guide-content">
              <h2>设置常用账户</h2>
              <p>从“资产 → 资金账户”添加银行卡或钱包，填写余额与截至时间，并选择默认收支账户。系统预建的两个“其他”账户也可直接记账。</p>
              <div className="zc-first-entry-actions"><button type="button" className={primaryCls} onClick={() => { setTab('accounts'); openAccountTask({ kind: 'edit' }); }}>添加账户</button></div>
            </div>
          )}
          {mobileGuideKind === 'entry' && (
            <div className="zc-mobile-guide-content">
              <h2>记第一笔{onboarding.firstTransactionRecorded ? ' · 已完成' : ''}</h2>
              <p>在弹窗中填写金额和分类。之后可从底栏“记一笔”快速记录，保存后留在原页。</p>
              <div className="zc-first-entry-actions"><button type="button" className={primaryCls} onClick={openNewTransaction}>{onboarding.firstTransactionRecorded ? '再记一笔' : '记第一笔'}</button></div>
            </div>
          )}
          {mobileGuideKind === 'categories' && (
            <div className="zc-mobile-guide-content">
              <h2>按场景补充分类{hasEnabledCategoryPack ? ' · 已启用' : onboarding.categorySkipped ? ' · 已跳过' : ''}</h2>
              <p>养宠、旅行等分类按需启用，原有记录不会改变。</p>
              <div className="zc-first-entry-actions">
                <button type="button" className={primaryCls} onClick={openCategoryPacks}>查看扩展包</button>
                {!onboarding.categorySkipped && <button type="button" className={buttonCls} onClick={() => setOnboarding(updateOnboarding(onboarding, { categorySkipped: true, mobileStep: mobileGuideStep + 1 }))}>暂不需要</button>}
              </div>
            </div>
          )}
          {mobileGuideKind === 'templates' && (
            <div className="zc-mobile-guide-content">
              <h2>用模板快速记账{onboarding.templateUsed ? ' · 已体验' : ''}</h2>
              <p>试用自带模板；记过一笔后，也能从它保存自己的常用交易。</p>
              <div className="zc-first-entry-actions">
                {firstTemplate && <button type="button" className={primaryCls} onClick={() => { setTab('records'); createFromTemplate(firstTemplate); }}>试用{firstTemplate.name}模板</button>}
                {onboarding.firstTransactionRecorded && <button type="button" className={buttonCls} onClick={openOwnTemplate}>创建自己的模板</button>}
                <button type="button" className={buttonCls} onClick={openTemplateCenter}>查看全部模板</button>
              </div>
            </div>
          )}
          {mobileGuideKind === 'navigation' && <div className="zc-mobile-guide-content">
            <h2>找到常用功能</h2>
            <p>底栏是总览、收支、记一笔、资产、更多。“资产”进入资金账户、持仓与物品，“更多”进入账单与还款、资料管理和设置。</p>
            <p>点流水看明细，长按或左右滑动打开编辑、退款等操作，也可点行尾更多。物品默认卡片，购入配件、报废和云服务费用都从物品事件入口记录。</p>
            {guideDestinations}
          </div>}
          <div className="zc-mobile-guide-nav">
            {mobileGuideStep > 0 && <button type="button" onClick={() => showMobileGuideStep(mobileGuideStep - 1)}>上一步</button>}
            {mobileGuideStep < mobileGuideSteps.length - 1
              ? <button type="button" onClick={() => showMobileGuideStep(mobileGuideStep + 1)}>下一步</button>
              : <button type="button" onClick={dismissOnboarding}>完成引导</button>}
          </div>
        </section>
      )}

      {activeTab === 'records' && (
        <>
          <div className="zc-period-expenses" role="group" aria-label={`每日每周支出 · ${vm.reportCurrencyCode}`}>
            {([{ preset: 'today', label: '今日支出', amount: vm.todayExpense }, { preset: 'this_week', label: '本周支出', amount: vm.weekExpense }] as const).map((period) => (
              <button key={period.preset} type="button" aria-pressed={viewFilters.range === period.preset} onClick={() => {
                const range = dateRangeValue(period.preset);
                setCategoryDrill(null);
                setFilters({ ...DEFAULT_FILTERS, range: range.preset, dateFrom: range.from, dateTo: range.to });
                setRecordView('list');
              }}><span>{period.label}</span><strong>{money(period.amount)}</strong><ChevronRight size={16} aria-hidden="true" /></button>
            ))}
          </div>
          <SummaryGrid vm={vm} usesAccounts={usesAccounts} />
          <section id="transaction-records" className="zc-ledger-records" aria-busy={transactionPageBusy} style={{ scrollMarginTop: 16 }}>
            <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: compactView ? 16 : 10 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{usesAccounts ? '日常流水' : '日常支出'}</h2>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 3 }}>
                  {usesAccounts ? '收入、支出、转账、退款和拆分交易；资产买卖与换汇可在“账户”中核对资金流' : '完整记录支出详情；侧栏或移动端“快记”可只填金额'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!compactView && reopenGuideControl}
                <button onClick={openNewTransaction} className="zc-header-primary zc-btn zc-btn--primary">{usesAccounts ? '+ 记账' : '+ 记支出'}</button>
                <details className="zc-ledger-more">
                  <summary className="zc-btn">更多操作</summary>
                  <div className="zc-ledger-more-panel">
                    <button onClick={() => setShowVoided((value) => !value)} className="zc-menu-item">作废记录 {voidedPage?.totalCount ?? 0}</button>
                    <button onClick={() => setEditingCategory('new')} className="zc-menu-item">新增分类</button>
                    <button onClick={() => setEditingPayee('new')} className="zc-menu-item">新增交易对象</button>
                    <button onClick={() => setEditingSplit('new')} className="zc-menu-item">新增拆分</button>
                    <button onClick={() => document.getElementById('transaction-charts')?.scrollIntoView({ block: 'start' })} className="zc-menu-item">查看构成与趋势</button>
                  </div>
                </details>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <DateRangeBar
                value={activeDateValue}
                onChange={(next) => setFilters((current) => ({ ...current, range: next.preset, dateFrom: next.from, dateTo: next.to }))}
                view={recordView}
                onViewChange={setRecordView}
                collapseDatesOnMobile
                compact
              />
              {activeFilterCount > 0 && <button type="button" className="zc-transaction-clear-desktop zc-btn" onClick={clearOtherFilters}>清除其他筛选</button>}
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
              <div className="zc-ledger-searchbar">
                <input
                  aria-label="快速搜索流水"
                  className="zc-input"
                  placeholder="搜索描述、交易对象、备注或标签"
                  value={viewFilters.search}
                  onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                />
                <button type="button" className="zc-transaction-filter-toggle zc-btn" aria-expanded={mobileFiltersOpen} aria-controls="transaction-filter-panel" onClick={() => setMobileFiltersOpen((open) => !open)}>
                  {activeFilterCount > 0 ? `筛选 · ${activeFilterCount} 项` : '筛选'} <span aria-hidden="true">{mobileFiltersOpen ? '收起' : '展开'} ▾</span>
                </button>
              </div>
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
                <button type="button" className="zc-transaction-clear-mobile zc-btn" onClick={clearOtherFilters}>清除其他筛选</button>
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
                      <button onClick={() => void restoreTx(row)} className={buttonCls} style={{ padding: '6px 10px' }}>恢复</button>
                    </div>
                  ))}
                {(voidedPage?.transactions.length ?? 0) === 0 && <div style={{ padding: '12px 0', fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>当前时间范围没有已作废流水。</div>}
              </div>
            )}
            {selectedIds.length > 0 && (
              <div className="zc-responsive-action-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>已选择 {selectedIds.length} 条流水</span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setBatchOpen(true)} className={primaryCls}>批量修改</button>
                  <button onClick={() => setSelectedIds([])} className={buttonCls}>清空选择</button>
                </span>
              </div>
            )}
            {recordView === 'list' ? (
              <TransactionList
                key={JSON.stringify(browseInput)}
                vm={vm}
                revealMatches={activeFilterCount > 0}
                initialDetailId={screenTarget?.tab === 'records' ? screenTarget.id : undefined}
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
            {activeTemplates.length > 0 && (
              <div className="zc-transaction-template-rail" aria-label="常用记账模板">
                {activeTemplates.slice(0, 10).map((tpl) => (
                  <button key={tpl.id} onClick={() => createFromTemplate(tpl)} className={buttonCls}>
                    {tpl.name}{tpl.amount ? ` · ${tpl.amount}` : ''}
                  </button>
                ))}
              </div>
            )}
            <div className="zc-transaction-load-status" role="status">
              {transactionPageBusy ? '正在加载当前范围全部流水…' : `已加载当前范围全部 ${readyTransactionRead.page.transactions.length} 笔`}
            </div>
            {transactionReadError && <div role="alert" className="zc-alert is-danger">{transactionReadError}</div>}
          </section>
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

      {accountTask?.kind === 'earlier' && <EarlierBalancePanel store={store} account={accountTask.account} setting={snap.setting} onClose={() => setAccountTask(null)} onSaved={() => { setAccountTask(null); bump(); }} />}
      {accountTask?.kind === 'edit' && <AccountSetupPanel key={accountTask.account?.id ?? 'new-account'} store={store} assets={snap.assets} accounts={snap.accounts} setting={snap.setting} initial={accountTask.account} onSaved={(account) => { if (!accountTask.account) setAddedAccount(account); setAccountTask(null); setAccountId(account.id); bump(); }} onClose={() => setAccountTask(null)} />}
      {accountTask?.kind === 'history' && <AccountHistoryPanel store={store} accounts={snap.accounts} assets={snap.assets} categories={snap.categories} timeZone={snap.setting?.timezone} initialAccountId={selectedAccountId || addedAccount?.id} onChanged={bump} onClose={() => setAccountTask(null)} />}
      {addedAccount && activeTab === 'accounts' && <div className="zc-card is-tight zc-account-added" role="status"><span>已添加 {addedAccount.name}，余额从 {addedAccount.balanceStartDate} 开始核算。以前的记录已保留。</span>
        <div className="zc-mobile-shortcuts"><button className={buttonCls} onClick={() => openAccountTask({ kind: 'history' })}>整理以前的记录</button><button className={buttonCls} disabled={!snap.accounts.some((account) => account.id === addedAccount.id)} onClick={() => { setAddedAccount(null); openNewTransaction(); }}>记一笔</button><button type="button" className="zc-workspace-link" onClick={() => setAddedAccount(null)}>收起添加提示</button></div>
      </div>}
      {usesAccounts && activeTab === 'accounts' && <AccountsWorkspace
        snap={snap} balances={vm.accountBalances} selectedId={selectedAccountId} assetId={assetId} accountAssets={accountAssets} readOnly={!!preview}
        balancesBusy={accountBalancesBusy} balanceError={accountBalanceError} ledgerError={accountLedgerError} onRetryRead={bump}
        range={accountRange} onRangeChange={setAccountRange}
        onSelect={(id) => { setAccountId(id); setAssetId('all'); }} onAssetChange={setAssetId}
        onAdd={() => openAccountTask({ kind: 'edit' })} onEdit={(account) => openAccountTask({ kind: 'edit', account })} onEarlier={(account) => openAccountTask({ kind: 'earlier', account })}
        onReconcile={(session) => openAccountTask({ kind: 'reconcile', session, accountId: session?.accountId ?? selectedAccountId, assetId: session?.assetId ?? selectedAssetId ?? accountAssets[0] ?? readySnap.assets[0]?.id ?? '' })}
        onHistory={() => openAccountTask({ kind: fundAccountsForRead.length ? 'history' : 'edit' })}
        onRecords={(id) => { setFilters((current) => ({ ...current, accountId: id })); setTab('records'); }}
        ledger={ledger} ledgerBusy={!!selectedAccountId && !accountLedgerCurrent} loadingMore={accountLedgerBusy}
        hasMore={accountLedgerCurrent && !!accountLedgerPage?.hasMore} totalCount={accountLedgerPage?.totalCount ?? 0}
        onLoadMore={() => void loadMoreAccountLedger()}
      />}

      {activeTab === 'dca' && <DcaPlans />}
      {activeTab === 'budget' && (
        <div className="zc-card">
          <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{budgetView === 'year' ? `${budgetMonth.slice(0, 4)} 年度预算` : `${budgetMonth} 分类预算`}</div>
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>预算冻结创建时币种，统一折算为 {vm.reportCurrencyCode}；拆分交易进入对应二级分类。</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button onClick={() => setBudgetView('year')} className={budgetView === 'year' ? primaryCls : buttonCls}>年度</button>
              <button onClick={() => setBudgetView('month')} className={budgetView === 'month' ? primaryCls : buttonCls}>月份</button>
              {budgetView === 'year'
                ? <input aria-label="预算年度" className="zc-input" type="number" min="1900" max="9999" value={budgetMonth.slice(0, 4)} onChange={(event) => setBudgetMonth(`${event.target.value || localToday().slice(0, 4)}-01`)} style={{ width: 108 }} />
                : <input aria-label="预算月份" className="zc-input" type="month" value={budgetMonth} onChange={(event) => setBudgetMonth(event.target.value)} style={{ width: 150 }} />}
              <button onClick={() => setEditingBudget('new')} className={primaryCls}>+ 预算</button>
            </div>
          </div>
          {budgetView === 'year' ? (
            <div className="zc-budget-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
              {budgetYearRows.map((row) => (
                <button key={row.month} onClick={() => { setBudgetMonth(row.month); setBudgetView('month'); }} className="zc-budget-row">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b>{Number(row.month.slice(5))} 月</b><span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' }}>{row.rows.length} 项</span></div>
                  <div style={{ marginTop: 14, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>预算 {money(row.planned)}</div>
                  <div style={{ marginTop: 5, fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', color: row.actual.gt(row.planned) ? 'var(--negative)' : 'var(--fg)' }}>实际 {money(row.actual)}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="zc-budget-grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              {budgetRows.map((b) => (
                <button key={b.id ?? b.category} onClick={() => compactView ? setBudgetDetailKey(b.id ?? b.category) : setEditingBudget(snap.budgetCategories.find((x) => x.id === b.id) ?? 'new')} className="zc-budget-row">
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
        <div className="zc-card">
          <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>账单与还款计划</div>
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginTop: 4 }}>不关联账户也能记录。默认只列计划；处理时可仅标记完成，或明确登记流水。</div>
            </div>
            <button onClick={() => openNewBill()} className={primaryCls}>+ 新增账单</button>
          </div>
          <div className="zc-bill-presets" role="group" aria-label="常用账单类型">
            {['房租', '水电燃气', '订阅续费', '信用卡还款', '借款还款', '分期付款'].map((name) => <button type="button" key={name} className="zc-btn zc-btn--sm" onClick={() => openNewBill({ name, frequency: 'monthly', autoCreate: 'false', linkAccount: 'false', ...(name === '分期付款' ? { limitMode: 'count', periodCount: '12' } : {}) })}>{name}</button>)}
          </div>
          <p className="zc-caption">还款已在消费时记过账，或在其他地方处理完成，可选“仅标记已处理”，不会重复计入支出。只有主动登记流水或开启自动补齐时才会写入收支。</p>
          {billActionError && <p role="alert">{billActionError}</p>}
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
            <>{compactView && <TaskList label="定期账单" items={vm.schedules.filter((schedule) => isDateInRange(schedule.nextDate, billRange)).map((schedule) => ({ label: schedule.name, note: `${schedule.nextDate} · ${scheduleLabel(schedule.status)}`, value: schedule.amount, onClick: () => { setBillActionError(''); setBillDetailKey(schedule.id); } }))} />}
            {!compactView &&
            <Table headers={['名称', '类型', '分类', '金额', '下次日期', '状态', '']}>
              {vm.schedules.filter((schedule) => isDateInRange(schedule.nextDate, billRange)).map((s) => {
                const row = snap.scheduledTransactions.find((x) => x.id === s.id)!;
                return (
                  <tr key={s.id}>
                    <td style={tdStyle}>{s.name}</td>
                    <td style={tdStyle}>{s.typeLabel}</td>
                    <td style={tdStyle}>{s.categoryLabel}</td>
                    <td style={tdStyle}>{num(row.amount, snap.assets.find((asset) => asset.id === row.assetId)?.decimals ?? 8)} {assetCodeOf(row.assetId)}</td>
                    <td style={tdStyle}>{s.nextDate}</td>
                    <td style={{ ...tdStyle, color: s.status === 'overdue' ? 'var(--negative)' : s.status === 'due' ? 'var(--accent)' : 'var(--fg-subtle)', fontWeight: 'var(--fw-bold)' }}>{scheduleLabel(s.status)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'normal' }}>
                      <div className="zc-bill-row-actions">
                        <button onClick={() => void handleBill(row, 'mark')} disabled={billActionBusy || row.status !== 'active' || s.status === 'completed'} className={buttonCls}>仅标记已处理</button>
                        <button onClick={() => void handleBill(row, 'record')} disabled={billActionBusy || row.status !== 'active' || s.status === 'completed'} className={buttonCls}>登记流水</button>
                        <button onClick={() => setEditingSchedule(row)} className={buttonCls}>编辑</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {vm.schedules.filter((schedule) => isDateInRange(schedule.nextDate, billRange)).length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={7}>该时间范围内暂无到期交易</td></tr>}
            </Table>
            }</>
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
              onOpen={(item) => compactView ? setBillDetailKey(item.schedule.id) : setEditingSchedule(item.schedule)}
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
                      }}>{execution.status === 'created' ? '已生成' : execution.status === 'failed' ? '失败' : '未入账（标记或跳过）'}</td>
                      <td style={tdStyle}>{execution.attemptedAt ? new Date(execution.attemptedAt).toLocaleString() : '—'}</td>
                      <td style={{ ...tdStyle, maxWidth: 320 }}>
                        {execution.lastError ?? (execution.status === 'failed' ? '未知错误' : execution.transactionId ? `流水 ${execution.transactionId.slice(0, 8)}` : '未生成流水，具体处理原因见操作历史')}
                        {execution.status === 'failed' && <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 2 }}>已重试 {execution.retryCount ?? 0} 次{execution.nextRetryAt ? ` · 下次 ${new Date(execution.nextRetryAt).toLocaleString()}` : ''}</div>}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {execution.status === 'failed' && (
                          <button
                            type="button"
                            disabled={retryingExecutionId === execution.id}
                            onClick={() => void retryScheduleExecution(execution.id)}
                            className={buttonCls}
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

      {budgetDetailKey && (() => {
        const row = budgetRows.find((budget) => (budget.id ?? budget.category) === budgetDetailKey);
        if (!row) return null;
        return <ActionSheet title="预算详情" description={`${budgetMonth} · ${row.label}`} onClose={() => setBudgetDetailKey('')} actions={[{ label: '编辑预算', onSelect: () => { setBudgetDetailKey(''); setEditingBudget(snap.budgetCategories.find((budget) => budget.id === row.id) ?? 'new'); } }]}>
          <div className="zc-record-sheet-facts">
            <CardFact label="原预算" value={row.plannedNative} />
            <CardFact label="实际支出" value={`${num(row.actual, vm.reportCurrencyDecimals)} ${vm.reportCurrencyCode}`} />
            <CardFact label="剩余额度" value={row.conversionKnown ? `${num(row.remaining, vm.reportCurrencyDecimals)} ${vm.reportCurrencyCode}` : '未完整折算'} tone={row.over ? 'negative' : 'default'} />
            <CardFact label="上月结转" value={`${num(row.carryIn, vm.reportCurrencyDecimals)} ${vm.reportCurrencyCode}`} />
            <CardFact label="下月结转" value={`${num(row.carryOut, vm.reportCurrencyDecimals)} ${vm.reportCurrencyCode}`} />
          </div>
          {!row.conversionKnown && <p className="zc-caption">缺少流水或预算币种的汇率，请补充价格后查看完整额度。</p>}
        </ActionSheet>;
      })()}
      {billDetailKey && (() => {
        const row = vm.schedules.find((schedule) => schedule.id === billDetailKey);
        const schedule = snap.scheduledTransactions.find((item) => item.id === billDetailKey);
        if (!row || !schedule) return null;
        return <ActionSheet title="账单详情" description={row.name} dismissDisabled={billActionBusy} onClose={() => { if (!billActionBusy) setBillDetailKey(''); }} actions={[
          { label: '仅标记已处理', disabled: billActionBusy || row.status === 'completed' || schedule.status !== 'active', onSelect: () => { void handleBill(schedule, 'mark'); } },
          { label: billActionBusy ? '正在生成流水…' : '生成本期流水', disabled: billActionBusy || row.status === 'completed' || schedule.status !== 'active', onSelect: () => { void handleBill(schedule, 'record'); } },
          { label: '编辑账单计划', disabled: billActionBusy, onSelect: () => { setBillDetailKey(''); setEditingSchedule(schedule); } },
        ]}>
          <div className="zc-record-sheet-facts"><CardFact label="金额" value={row.amount} /><CardFact label="下次日期" value={row.nextDate} /><CardFact label="状态" value={scheduleLabel(row.status)} /><CardFact label="分类" value={row.categoryLabel} /></div>
          <p className="zc-caption">仅标记已处理不会写入收支或改变账户余额；生成本期流水才会入账。同一期只处理一次。</p>
          {billActionError && <p role="alert">{billActionError}</p>}
        </ActionSheet>;
      })()}

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
          onClose={() => { setQuickExpenseOpen(false); setQuickTemplate(null); onEntryClose?.(); }}
        />
      )}

      {creatingOwnTemplate && (
        <EntityFormModal
          spec={transactionTemplateForm(readySnap, { usesAccounts })}
          initial={creatingOwnTemplate}
          isNew
          onSave={async (entity) => { await store.transactionTemplates.put(entity); bump(); }}
          onClose={() => setCreatingOwnTemplate(null)}
        />
      )}

      {editingTx && (transactionEditor.loading || transactionEditor.error) && <DialogShell labelledBy="transaction-editor-loading" onDismiss={() => { setEditingTx(null); setRefundDraft(null); }} panelStyle={{ padding: 24, background: 'var(--surface)', borderRadius: 'var(--r-sm)', width: 'min(560px, calc(100vw - 24px))' }}>
        <h2 id="transaction-editor-loading">读取退款资料</h2>{transactionEditor.error ? <p role="alert">{transactionEditor.error}</p> : <p role="status">正在读取原消费和退款记录…</p>}
        {transactionEditor.error && <button type="button" className="zc-btn" onClick={transactionEditor.retry}>重新读取</button>}<button type="button" className="zc-btn" onClick={() => { setEditingTx(null); setRefundDraft(null); }}>关闭</button>
      </DialogShell>}
      {editingTx && !transactionEditor.loading && !transactionEditor.error && (
        <EntityFormModal
          key={`${entryGeneration}-${editingTx === 'new' ? 'new' : editingTx.id}`}
          workspace={false}
          initialFieldValues={editingTx === 'new' && !refundDraft && !templateDraft ? entryFields : undefined}
          retainEntryFields={retainEntryFields}
          onRetainEntryFieldsChange={setRetainEntryFields}
          onSaveContinue={!compactView && editingTx === 'new' && !refundDraft ? (values) => {
            setEntryFields(continuedEntryFields(values, retainEntryFields));
            setTemplateDraft(null);
            setEntryGeneration((current) => current + 1);
          } : undefined}
          spec={transactionForm(transactionEditor.snapshot ?? readySnap, {
            usesAccounts,
            refundMode: editingTx === 'new' ? !!refundDraft : editingTx.type === 'refund',
            expenseOnly: !usesAccounts && !(editingTx === 'new' ? refundDraft : editingTx.type === 'refund'),
            refundRemaining: transactionEditor.remaining,
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
          onSave={async (entity) => {
            await saveTx(entity);
            if (templateDraft) setOnboarding((current) => current ? updateOnboarding(current, { templateUsed: true }) : current);
            setTemplateDraft(null);
          }}
          onDelete={editingTx !== 'new' ? async () => voidTx(editingTx) : undefined}
          deleteLabel="作废"
          onClose={() => { setEditingTx(null); setRefundDraft(null); setTemplateDraft(null); onEntryClose?.(); }}
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
          workspace={false}
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
          key={editingSchedule === 'new' ? `bill-new-${billPreset.name ?? ''}` : editingSchedule.id}
          spec={scheduledTransactionForm(snap, { usesAccounts })}
          initial={editingSchedule === 'new' ? undefined : editingSchedule}
          initialFieldValues={editingSchedule === 'new' ? billPreset : undefined}
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
          workspace={false}
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
          workspace={false}
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
      {usesAccounts && accountTask?.kind === 'reconcile' && (
        <ReconciliationModal
          store={store}
          snap={readySnap}
          session={accountTask.session}
          initialAccountId={accountTask.accountId}
          initialAssetId={accountTask.assetId}
          readVersion={rev}
          readOnly={!!preview}
          onChanged={bump}
          onClose={() => setAccountTask(null)}
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
        <button onClick={props.onSave} className={primaryCls}>保存当前筛选</button>
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
                      className={buttonCls}
                      style={{ padding: '6px 9px' }}
                    >
                      保存
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => props.onApply(view)} className="zc-btn zc-btn--ghost">{view.name}</button>
                    <button onClick={() => props.onTogglePin(view)} title={view.isPinned ? '取消置顶' : '置顶'} className="zc-btn zc-btn--sm">{view.isPinned ? '★' : '☆'}</button>
                    <button
                      onClick={() => {
                        setEditingId(view.id);
                        setEditingName(view.name);
                      }}
                      title="重命名"
                      className="zc-btn zc-btn--sm"
                    >
                      改名
                    </button>
                  </>
                )}
                <button type="button" aria-label={`删除保存的筛选 ${view.name}`} onClick={() => props.onRemove(view)} title="删除保存的筛选" className="zc-btn zc-btn--sm">×</button>
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
        <button onClick={() => setOpen((v) => !v)} className={buttonCls}>高级查询{conditionCount ? ` · ${conditionCount}` : ''}</button>
        {conditionCount > 0 && <button onClick={() => setQuery(undefined)} className={buttonCls}>清空高级条件</button>}
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => applyPreset('reimburse')} className={buttonCls}>待报销</button>
            <button onClick={() => applyPreset('large_expense')} className={buttonCls}>大额支出</button>
            <button onClick={() => applyPreset('with_attachment')} className={buttonCls}>含附件</button>
            <button onClick={() => applyPreset('food')} className={buttonCls}>本月餐饮</button>
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
                <button onClick={() => addCondition(group.id)} className={buttonCls}>+ 条件</button>
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
          <button onClick={addGroup} className={buttonCls} style={{ width: 'fit-content' }}>+ 条件组 OR</button>
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
      <button type="button" aria-label="删除筛选条件" onClick={onRemove} title="删除条件" className={buttonCls} style={{ padding: '8px 10px' }}>×</button>
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
  const compact = useCompactView();
  if (!compact) return <div className="zc-transaction-summary-grid has-accounts is-query-summary" role="group" aria-label="当前范围收支摘要">
    <div className="zc-transaction-summary-metric"><Kpi label="当前范围收入" value={money(vm.filteredIncome)} tone="var(--positive)" sub="转账不计入收入" /></div>
    <div className="zc-transaction-summary-metric"><Kpi label="当前范围支出" value={money(vm.filteredExpense)} tone="var(--negative)" sub="按既有退款归属口径" /></div>
    <div className="zc-transaction-summary-metric"><Kpi label="当前范围结余" value={signedMoney(vm.filteredNet)} tone={D(vm.filteredNet).gte(0) ? 'var(--positive)' : 'var(--negative)'} sub={`${vm.count} 条 · ${vm.reportCurrencyCode}`} /></div>
  </div>;
  if (!usesAccounts) {
    return (
      <div className="zc-transaction-summary-grid is-simple" role="group" aria-label="本月收支摘要">
        <div className="zc-transaction-summary-metric"><Kpi label={`${vm.month} 本月支出`} value={money(vm.expense)} tone="var(--negative)" sub="自动汇总全部支出" /></div>
        <div className="zc-transaction-summary-metric"><Kpi label="当前范围" value={`${vm.count} 笔`} tone="var(--accent)" sub={`合计支出 ${money(vm.filteredExpense)}`} /></div>
      </div>
    );
  }
  return (
    <div className="zc-transaction-summary-grid has-accounts" role="group" aria-label="本月收支摘要">
      <div className="zc-transaction-summary-metric"><Kpi label={`${vm.month} 本月收入`} value={money(vm.income)} tone="var(--positive)" sub="不受筛选影响" /></div>
      <div className="zc-transaction-summary-metric"><Kpi label={`${vm.month} 本月支出`} value={money(vm.expense)} tone="var(--negative)" sub={usesAccounts ? '转账不计入支出' : '只统计收入和支出'} /></div>
      <div className="zc-transaction-summary-metric"><Kpi label="本月结余" value={signedMoney(vm.net)} tone={Number(vm.net) >= 0 ? 'var(--positive)' : 'var(--negative)'} sub="收入 - 支出" /></div>
      <div className="zc-transaction-summary-metric"><Kpi label="当前筛选" value={`${vm.count} 条`} tone="var(--accent)" sub={`收 ${money(vm.filteredIncome)} · 支 ${money(vm.filteredExpense)} · ${signedMoney(vm.filteredNet)}`} /></div>
    </div>
  );
}

function TransactionList({ vm, revealMatches, initialDetailId, onEdit, onRefund, refundRemaining, refundsFor, onManageRefunds, assetCode, usesAccounts, tagName, locationName, attachmentCount, selectedIds, setSelectedIds }: {
  vm: NonNullable<ReturnType<typeof buildTransactions>>;
  revealMatches: boolean;
  initialDetailId?: string;
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
  const compact = useCompactView();
  const dayId = useId();
  const [dayMode, setDayMode] = useState<'recent' | 'all' | 'none'>(revealMatches ? 'all' : 'recent');
  const [dayOverrides, setDayOverrides] = useState<Record<string, boolean>>({});
  const today = localToday();
  const previousCompact = useRef(compact);
  const [panel, setPanel] = useState<{ id: string; mode: 'detail' | 'actions' } | null>(null);
  const openedInitial = useRef('');
  useEffect(() => {
    if (initialDetailId && openedInitial.current !== initialDetailId && vm.items.some((item) => item.tx.id === initialDetailId)) {
      openedInitial.current = initialDetailId;
      setPanel({ id: initialDetailId, mode: 'detail' });
    }
  }, [initialDetailId, vm.items]);
  const gestures = useRecordGestures((id) => setPanel({ id, mode: 'actions' }), compact);
  const active = panel && vm.items.find((item) => item.tx.id === panel.id);
  const activeRefunds = active?.tx.type === 'expense' ? refundsFor(active.tx) : [];
  const activeRefunded = activeRefunds.reduce((total, refund) => total.plus(refund.appliedAmount), D(0));
  const closePanel = () => setPanel(null);
  const expandedDay = (group: typeof vm.groups[number]) => (
    Boolean(panel && group.items.some((item) => item.tx.id === panel.id))
      || (dayOverrides[group.key] ?? (dayMode === 'all' || (dayMode === 'recent' && isRecentTransactionDay(group.key, today))))
  );
  const setAllDays = (mode: 'all' | 'none') => { setPanel(null); setDayOverrides({}); setDayMode(mode); };
  const columns = () => <>
    <colgroup>
      {setSelectedIds && <col className="is-select" />}
      <col className="is-date" /><col className="is-category" /><col className="is-numeric" /><col />
      {usesAccounts && <col className="is-status" />}<col className="is-actions" />
    </colgroup>
    <thead><tr>
      {setSelectedIds && <th scope="col" className="is-select"><span className="zc-sr-only">选择</span></th>}
      <th scope="col" className="is-date">时间</th><th scope="col" className="is-category">分类</th>
      <th scope="col" className="is-numeric">金额</th><th scope="col">摘要</th>
      {usesAccounts && <th scope="col" className="is-status">账户</th>}
      <th scope="col" className="is-actions"><span className="zc-sr-only">操作</span></th>
    </tr></thead>
  </>;
  const choose = (action: () => void) => { closePanel(); action(); };
  useEffect(() => { setPanel((current) => current && !vm.items.some((item) => item.tx.id === current.id) ? null : current); }, [vm]);
  useEffect(() => {
    if (previousCompact.current !== compact) setPanel(null);
    previousCompact.current = compact;
  }, [compact]);
  return (
    <div className="zc-transaction-days">
      <p className="zc-record-gesture-hint">点按查看详情，长按或左右滑动打开流水操作。</p>
      {vm.groups.length > 0 && <>
        <div className="zc-transaction-day-controls">
          <span>{dayMode === 'recent' ? '默认展开近 7 天 · 含今天' : `共 ${vm.groups.length} 天 · ${vm.count} 笔`}</span>
          <div role="group" aria-label="日期展开控制">
            <button type="button" className="zc-btn zc-btn--sm" disabled={vm.groups.every(expandedDay)} onClick={() => setAllDays('all')}>全部展开</button>
            <button type="button" className="zc-btn zc-btn--sm" disabled={vm.groups.every((group) => !expandedDay(group))} onClick={() => setAllDays('none')}>全部折叠</button>
          </div>
        </div>
        <table className="zc-transaction-table zc-transaction-columns" aria-hidden="true">{columns()}</table>
      </>}
      {vm.groups.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-body)', padding: '20px 0' }}>暂无流水</div>}
      {vm.groups.map((g) => {
        const expanded = expandedDay(g);
        return (
        <section className={`zc-transaction-day${expanded ? '' : ' is-collapsed'}`} key={g.key}>
          <div className="zc-transaction-day-summary" aria-label={`${g.label}收支小计`}>
            <button type="button" className="zc-transaction-day-toggle" aria-expanded={expanded} aria-controls={`${dayId}-${g.key}`} onClick={() => {
              if (panel && g.items.some((item) => item.tx.id === panel.id)) setPanel(null);
              setDayOverrides((current) => ({ ...current, [g.key]: !expanded }));
            }}>
              <ChevronDown size={16} aria-hidden="true" />
              <span className="zc-transaction-day-date">{g.label}</span><span className="zc-transaction-day-count">{g.items.length} 笔</span>
            </button>
            <span>
              {usesAccounts && <span className="zc-day-income">收入 {num(g.income, vm.reportCurrencyDecimals)}</span>}
              <span className="zc-day-expense">支出合计 <strong>{num(g.expense, vm.reportCurrencyDecimals)}</strong> <span className="zc-day-currency">{vm.reportCurrencyCode}</span></span>
              {g.incomplete && <span className="zc-day-incomplete">未完整折算</span>}
            </span>
          </div>
          <div id={`${dayId}-${g.key}`} hidden={!expanded}>
          {expanded && <table className={`zc-transaction-table${setSelectedIds ? ' has-selection' : ''}${usesAccounts ? ' has-account' : ''}`} aria-label={`${g.label}流水`}>
            {columns()}
            <tbody>
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
              // An expense that came back in full is no longer still "spent". It stays
              // in the list (the history is the point) but has to read as settled, and it
              // must keep a way into its refunds: the refund row itself is filtered out
              // of a 支出-scoped list, so the badge is the only handle left.
              const settled = refunds.length > 0 && !D(remaining).gt(0);
              const refundChip = refunds.length > 0
                ? {
                  label: `${settled ? '全额退款' : '部分退款'} +${num(refunded, item.assetDecimals)} ${assetCode(tx.assetId)}`,
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
                tx.date !== g.key ? `${tx.date}${tx.time ? ` ${tx.time}` : ''}` : tx.time,
              ].filter(Boolean).join(' · ');
              return (
                <Fragment key={tx.id}>
                <tr
                  className={`zc-transaction-row${setSelectedIds ? ' has-selection' : ''}${usesAccounts ? ' has-account' : ''}`}
                  key={tx.id}
                  {...gestures.bind(tx.id)}
                  data-gesture-direction={gestures.preview?.id === tx.id ? gestures.preview.direction : undefined}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      setPanel((current) => !compact && current?.id === tx.id ? null : { id: tx.id, mode: 'detail' });
                    } else if (compact && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
                      event.preventDefault();
                      setPanel({ id: tx.id, mode: 'actions' });
                    }
                  }}
                  onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true });
                    setPanel((current) => !compact && current?.id === tx.id ? null : { id: tx.id, mode: 'detail' });
                  }}
                >
                  {setSelectedIds && (
                    <td className="zc-transaction-select"><span className="zc-check-target">
                      <input
                        type="checkbox"
                        checked={selected.has(tx.id)}
                        disabled={!selectable}
                        title={selectable ? '选择流水' : '已对账流水需先解除对账'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => { if (selectable) toggle(tx.id); }}
                        aria-label={`选择 ${title}`}
                      />
                    </span></td>
                  )}
                  <td className="zc-transaction-date" style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>{compact ? tx.date : tx.time?.slice(0, 5) || tx.date.slice(5)}{compact && tx.time ? <span className="zc-transaction-time"><br />{tx.time}</span> : null}</td>
                  <td
                    className="zc-transaction-category"
                    style={{ color: tx.type === 'income' || tx.type === 'refund' ? 'var(--positive)' : tx.type === 'expense' ? 'var(--negative)' : 'var(--accent)' }}
                    title={item.categoryLabel}
                  >
                    <span className="zc-transaction-category-label">{item.categoryLabel}</span>
                  </td>
                  <td className="is-numeric zc-transaction-amount" style={{ fontSize: 'var(--fs-body)', ...amountColor(item.signedAmount) }}>
                    <span className="zc-transaction-amount-original">{tx.type === 'transfer' ? '' : tx.type === 'income' || tx.type === 'refund' || (tx.type === 'adjustment' && tx.adjustmentDirection === 'increase') ? '+' : '-'}{num(tx.amount, item.assetDecimals)} {item.assetCode}</span>
                    {refundChip && <><button type="button" className="zc-refund-chip" aria-label={`查看 ${title} 的退款记录`} title={`${refundChip.title}；此处按原支出币种显示冲减额，实际到账金额见退款记录。`} onClick={(event) => { event.stopPropagation(); onManageRefunds(tx); }}>{refundChip.label}</button>
                      <span className="zc-refund-net" title="原支出减累计退款冲减，期间统计仍按退款归属设置计算">净支出 {num(remaining, item.assetDecimals)} {item.assetCode}</span></>}
                  </td>
                  <td className="zc-transaction-summary" style={{ minWidth: 0 }}>
                    <span className="zc-transaction-summary-title" style={{ display: 'block', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                    <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                      <span className="zc-transaction-details-desktop" style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
                        {details}
                      </span>
                      {mobileDetails && <span className="zc-transaction-details-mobile" style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{mobileDetails}</span>}
                    </span>
                  </td>
                  {usesAccounts && <td className="zc-transaction-account"><span title={item.accountName} className={item.statusLabel === '已对账' ? 'zc-ledger-stamp' : undefined} style={{ fontSize: 'var(--fs-meta)', color: item.statusLabel === '已对账' ? 'var(--accent)' : 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>{compact ? item.statusLabel : item.accountName}</span></td>}
                  <td className="zc-transaction-actions">
                    <button type="button" aria-label={`查看 ${title} 的详情`} onClick={(event) => {
                      event.stopPropagation();
                      setPanel((current) => !compact && current?.id === tx.id ? null : { id: tx.id, mode: 'detail' });
                    }} className="zc-btn zc-btn--sm zc-record-details">详情</button>
                    <button type="button" className="zc-record-more" aria-label={`打开 ${title} 的流水操作`} onClick={(event) => { event.stopPropagation(); setPanel({ id: tx.id, mode: 'actions' }); }}><MoreHorizontal size={20} aria-hidden="true" /></button>
                    {tx.type === 'expense' && D(remaining).gt(0) ? (
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onRefund(tx); }}
                        className="zc-btn zc-btn--sm zc-record-refund"
                        title={`剩余可退 ${remaining}`}
                      >退款</button>
                    ) : null}
                  </td>
                </tr>
                {!compact && panel?.id === tx.id && <tr className="zc-record-expansion-row"><td colSpan={(setSelectedIds ? 1 : 0) + (usesAccounts ? 6 : 5)}>
                  <section className="zc-record-expansion" aria-label={`${title}的详情`}>
                    <div className="zc-record-expansion-head"><h3>{title}</h3><button type="button" className="zc-btn zc-btn--sm" onClick={closePanel}>收起详情</button></div>
                    <div className="zc-record-expansion-facts">
                      <CardFact label="日期" value={`${tx.date} ${tx.time ?? ''}`} />
                      <CardFact label="原币金额" value={`${tx.amount} ${item.assetCode}`} />
                      <CardFact label="分类" value={item.categoryLabel} />
                      {usesAccounts && <CardFact label="账户" value={item.accountName} />}
                      <CardFact label="状态" value={item.statusLabel} />
                      {item.payeeName && <CardFact label="交易对象" value={item.payeeName} />}
                      {tags.length > 0 && <CardFact label="标签" value={tags.join(' / ')} />}
                      {files > 0 && <CardFact label="附件" value={`${files} 个 · 编辑流水可查看凭证`} />}
                      {loc && <CardFact label="地点" value={loc} />}
                      {refunds.length > 0 && <CardFact label="累计退款" value={`${num(refunded, item.assetDecimals)} ${item.assetCode}`} />}
                    </div>
                    {tx.note && <p className="zc-record-expansion-note">{tx.note}</p>}
                    <div className="zc-record-expansion-actions">
                      <button type="button" className="zc-btn zc-btn--primary" onClick={() => onEdit(tx)}><Pencil size={15} aria-hidden="true" />{tx.type === 'adjustment' && tx.reconciliationSessionId ? '查看关联对账' : '编辑流水'}</button>
                      {tx.type === 'expense' && D(remaining).gt(0) && <button type="button" className="zc-btn" onClick={() => onRefund(tx)}>记录退款</button>}
                      {refunds.length > 0 && <button type="button" className="zc-btn" onClick={() => onManageRefunds(tx)}>查看退款记录</button>}
                    </div>
                  </section>
                </td></tr>}
                </Fragment>
              );
            })}
            </tbody>
          </table>}
          </div>
        </section>
      );})}
      {compact && active && panel && (
        <ActionSheet
          title={panel.mode === 'detail' ? '流水详情' : '流水操作'}
          description={`${active.tx.date}${active.tx.time ? ` ${active.tx.time}` : ''} · ${active.typeLabel}`}
          onClose={closePanel}
          actions={[
            ...(panel.mode === 'actions' ? [
              { label: active.tx.type === 'adjustment' && active.tx.reconciliationSessionId ? '查看关联对账' : '编辑流水', icon: <Pencil size={20} />, onSelect: () => choose(() => onEdit(active.tx)) },
              ...(active.tx.type === 'expense' && D(refundRemaining(active.tx)).gt(0) ? [{ label: '记录退款', note: `剩余可退 ${refundRemaining(active.tx)} ${active.assetCode}`, icon: <Undo2 size={20} />, onSelect: () => choose(() => onRefund(active.tx)) }] : []),
              ...(refundsFor(active.tx).length ? [{ label: '查看退款记录', icon: <FileText size={20} />, onSelect: () => choose(() => onManageRefunds(active.tx)) }] : []),
              { label: '查看详情', icon: <FileText size={20} />, onSelect: () => setPanel({ id: active.tx.id, mode: 'detail' }) },
            ] : [
              { label: '流水操作', note: active.tx.type === 'expense' ? '编辑、退款及相关记录' : '编辑及相关记录', icon: <MoreHorizontal size={20} />, onSelect: () => setPanel({ id: active.tx.id, mode: 'actions' }) },
            ]),
          ]}
        >
          <div className="zc-record-sheet-summary">
            <h3>{active.title}</h3>
            <p className="zc-record-sheet-amount" style={amountColor(active.signedAmount)}>{D(active.signedAmount).isNegative() ? '−' : D(active.signedAmount).gt(0) ? '+' : ''}{num(active.tx.amount, active.assetDecimals)} <span>{active.assetCode}</span></p>
          </div>
          {panel.mode === 'detail' && <div className="zc-record-sheet-facts">
            <CardFact label="分类" value={active.categoryLabel} />
            {usesAccounts && <CardFact label="账户" value={active.accountName} />}
            <CardFact label="状态" value={active.statusLabel} />
            {activeRefunds.length > 0 && <>
              <CardFact label="累计退款" value={`${num(activeRefunded, active.assetDecimals)} ${active.assetCode}`} />
              <CardFact label="剩余可退" value={`${num(refundRemaining(active.tx), active.assetDecimals)} ${active.assetCode}`} />
            </>}
            {active.payeeName && <CardFact label="交易对象" value={active.payeeName} />}
            {active.splitSummary && <CardFact label="拆分" value={active.splitSummary} />}
            {!!active.tx.tagIds?.length && <CardFact label="标签" value={active.tx.tagIds.map(tagName).join(' / ')} />}
            {locationName(active.tx) && <CardFact label="地点" value={locationName(active.tx)} />}
            {!!attachmentCount(active.tx) && <CardFact label="附件" value={`${attachmentCount(active.tx)} 个`} />}
            {active.tx.note && <CardFact label="备注" value={active.tx.note} />}
          </div>}
        </ActionSheet>
      )}
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

      header={<> <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div id={titleId} style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>退款记录</div>
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>
            {original.date} · {title} · 原支出 {original.amount} {originalCode}
          </div>
        </div>
        <button type="button" data-dialog-initial-focus onClick={onClose} className={buttonCls}>关闭</button>
      </div> </>}
    >


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
                <button type="button" onClick={() => void onEditRefund(refund.id)} className="zc-btn zc-btn--sm">编辑</button>
                <button type="button" onClick={() => setPendingVoid(refund)} className="zc-btn zc-btn--sm">作废</button>
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
          <button type="button" onClick={() => onNewRefund(original)} className={primaryCls}>再记一笔退款</button>
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

      header={<> <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div>
            <div id={titleId} style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>批量修改流水</div>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 3 }}>将修改应用到 {count} 条流水，金额不会被批量改动。</div>
          </div>
          <button type="button" data-dialog-initial-focus disabled={busy} onClick={onClose} className={buttonCls}>关闭</button>
        </div> </>}

      footer={<> {error && <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', marginTop: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} disabled={busy} className={buttonCls}>取消</button>
          <button onClick={() => void submit()} disabled={busy} className={primaryCls}>{busy ? '正在应用…' : review ? '确认应用' : '预览修改'}</button>
        </div> </>}
    >

        <div className="zc-modal-form-grid">
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
              <label className="zc-field">账户
                <select style={selectStyle} value={accountId} onChange={(e) => { markDirty(); setAccountId(e.target.value); }}>
                  <option value="">不改账户</option>
                  {snap.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label className="zc-field">状态
                <select style={selectStyle} value={status} onChange={(e) => { markDirty(); setStatus(e.target.value); }}>
                  <option value="">不改状态</option>
                  {STATUS_OPTIONS.filter((o) => o.value !== 'all').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            </>
          )}
          <label className="zc-field">地点
            <select style={selectStyle} value={locationId} onChange={(e) => { markDirty(); setLocationId(e.target.value); }}>
              <option value="">不改地点</option>
              {snap.transactionLocations.filter((l) => !l.isDeleted).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        </div>
        <div className="zc-modal-form-grid" style={{ marginTop: "var(--sp-2)" }}>
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
    <div className="zc-card">
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
    <div className="zc-card">
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
      <div className="zc-summary-kpi-label">{label}</div>
      <div className="zc-summary-kpi-value" style={{ color: tone }}>{value}</div>
      <div className="zc-summary-kpi-sub">{sub}</div>
    </>
  );
}

function scheduleLabel(status: 'overdue' | 'due' | 'future' | 'paused' | 'completed'): string {
  if (status === 'completed') return '计划已完成';
  if (status === 'overdue') return '计划日已过';
  if (status === 'due') return '待处理';
  if (status === 'paused') return '已暂停';
  return '未来';
}
