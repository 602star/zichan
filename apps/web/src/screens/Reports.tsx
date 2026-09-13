import { accountSessionStorage } from '../account-storage.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fixedAssetCost, isDateInRange, gameRecordReportingPostings, traceChain, D, localToday, type DateRange, type QueryCursor } from '@zichan/core';
import { useSnapshot, type Snapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import type { TransactionReportAggregateRow, TransactionReportPage } from '@zichan/db';
import {
  buildReport,
  gameNetInReport,
  tableToCsv,
  tableToMarkdown,
  tableToMermaid,
  transactionTableFromAggregates,
  transactionDetails,
  type Table,
  type TabId,
  type TransactionDetailRow,
} from '../selectors/reports.js';
import { money } from '../format.js';
import { card, th as thStyle, td as tdStyle, pillBtn } from '../ui/styles.js';
import { createReportCurrency } from '../reportCurrency.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue } from '../ui/DateRangeBar.js';
import { downloadReportPdf } from '../report-pdf.js';
import {
  buildBudgetVariance,
  buildTransactionComparison,
  effectiveReportRange,
  reportComparisonRanges,
} from '../selectors/report-analysis.js';
import { ReportSummaryStrip, TransactionReportInsights } from '../ui/TransactionReportInsights.js';

const TABS: [TabId, string][] = [['transactions', '日常收支'], ['dca', '定投'], ['chain', '资产转换'], ['season', '游戏赛季'], ['fixed', '物品资产']];

/*
 * Granularity only re-buckets the trend chart, so it is rendered by the chart
 * itself (`TimeTrendChart`) instead of sitting next to the date range, where it
 * read as a third, interchangeable filter.
 */
const GRANULARITIES: readonly (readonly ['day' | 'month' | 'year', string])[] = [['day', '按日'], ['month', '按月'], ['year', '按年']];

export function Reports() {
  const baseSnap = useSnapshot('reports');
  const { store } = useStore();
  const [tab, setTab] = useState<TabId>('transactions');
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const exportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [ranges, setRanges] = useState<Record<TabId, DateRangeValue>>(() => ({
    transactions: dateRangeValue('this_month'),
    dca: dateRangeValue('all'),
    chain: dateRangeValue('all'),
    season: dateRangeValue('all'),
    fixed: dateRangeValue('all'),
  }));
  const [selectedCategory, setSelectedCategory] = useState('');
  const [granularity, setGranularity] = useState<'day' | 'month' | 'year'>('month');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [detailExportBusy, setDetailExportBusy] = useState(false);
  const [detailExported, setDetailExported] = useState(0);
  const [transactionRevision, setTransactionRevision] = useState(0);
  const [transactionDetailRange, setTransactionDetailRange] = useState<DateRangeValue>(() => dateRangeValue('this_month'));
  const [transactionSlice, setTransactionSlice] = useState<Pick<Snapshot, 'transactions' | 'transactionSplits' | 'refundAllocations'> | null>(null);
  const [transactionAggregates, setTransactionAggregates] = useState<TransactionReportAggregateRow[] | null>(null);
  const [transactionCursor, setTransactionCursor] = useState<QueryCursor | undefined>();
  const [transactionHasMore, setTransactionHasMore] = useState(false);
  const [transactionAggregateBusy, setTransactionAggregateBusy] = useState(false);
  const [transactionAggregateError, setTransactionAggregateError] = useState('');
  const [transactionPageBusy, setTransactionPageBusy] = useState(false);
  const [transactionLoadError, setTransactionLoadError] = useState('');
  const asOfDate = baseSnap?.setting?.asOfDate ?? localToday();
  const dateRange = ranges[tab];
  const effectiveRange = useMemo(
    () => effectiveReportRange(dateRange, asOfDate),
    [asOfDate, dateRange],
  );
  const transactionRange = ranges.transactions;
  const effectiveTransactionRange = useMemo(
    () => effectiveReportRange(transactionRange, asOfDate),
    [asOfDate, transactionRange],
  );
  const effectiveTransactionDetailRange = useMemo(
    () => effectiveReportRange(transactionDetailRange, asOfDate),
    [asOfDate, transactionDetailRange],
  );
  const comparisonRanges = useMemo(() => reportComparisonRanges(
    effectiveTransactionRange,
    asOfDate,
  ), [asOfDate, effectiveTransactionRange]);
  const aggregateQueryRange = useMemo(() => {
    let from = effectiveTransactionRange.from;
    let to = effectiveTransactionRange.to;
    if (from && comparisonRanges) {
      from = [from, comparisonRanges.previous.from, comparisonRanges.yearOverYear.from]
        .sort((left, right) => left.localeCompare(right))[0];
    }
    if (from && baseSnap) {
      const latestMonth = effectiveTransactionRange.to?.slice(0, 7);
      const firstBudgetMonth = baseSnap.budgetCategories
        .filter((budget) => !budget.isDeleted && (!latestMonth || budget.month <= latestMonth))
        .map((budget) => `${budget.month}-01`)
        .sort((left, right) => left.localeCompare(right))[0];
      if (firstBudgetMonth && firstBudgetMonth < from) from = firstBudgetMonth;
    }
    if (to && comparisonRanges) {
      to = [to, comparisonRanges.previous.to, comparisonRanges.yearOverYear.to]
        .sort((left, right) => right.localeCompare(left))[0];
    }
    return { from, to };
  }, [baseSnap, comparisonRanges, effectiveTransactionRange.from, effectiveTransactionRange.to]);
  useEffect(() => store.subscribe((change) => {
    if (change.entityTypes.includes('*')
      || change.entityTypes.some((type) => ['transaction', 'transaction_split', 'refund_allocation'].includes(type))) {
      setTransactionRevision((value) => value + 1);
    }
  }), [store]);
  useEffect(() => {
    if (tab !== 'transactions') return;
    let cancelled = false;
    setTransactionAggregates(null);
    setTransactionAggregateError('');
    setTransactionAggregateBusy(true);
    void store.transactionReportAggregate(aggregateQueryRange).then((aggregates) => {
      if (!cancelled) setTransactionAggregates(aggregates);
    }).catch((error) => {
      if (!cancelled) {
        setTransactionAggregates([]);
        setTransactionAggregateError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!cancelled) setTransactionAggregateBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    aggregateQueryRange,
    store,
    tab,
    transactionRevision,
  ]);
  useEffect(() => {
    if (tab !== 'transactions') return;
    let cancelled = false;
    setTransactionSlice(null);
    setTransactionCursor(undefined);
    setTransactionHasMore(false);
    setTransactionLoadError('');
    setTransactionPageBusy(true);
    void store.transactionBrowsePage({
      from: effectiveTransactionDetailRange.from,
      to: effectiveTransactionDetailRange.to,
      category: selectedCategory || undefined,
      excludeTypes: ['transfer', 'adjustment'],
      limit: 200,
    }).then((page) => {
      if (cancelled) return;
      setTransactionSlice({
        transactions: page.transactions,
        transactionSplits: page.transactionSplits,
        refundAllocations: page.refundAllocations,
      });
      setTransactionCursor(page.nextCursor);
      setTransactionHasMore(page.hasMore);
    }).catch((error) => {
      if (!cancelled) {
        setTransactionSlice({ transactions: [], transactionSplits: [], refundAllocations: [] });
        setTransactionLoadError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!cancelled) setTransactionPageBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [effectiveTransactionDetailRange.from, effectiveTransactionDetailRange.to, selectedCategory, store, tab, transactionRevision]);
  /* The export menu is a disclosure, so it must close like one: outside click or
   * Escape, with focus handed back to the trigger. */
  useEffect(() => {
    if (!exportMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setExportMenuOpen(false);
      exportTriggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [exportMenuOpen]);
  const snap = useMemo(() => {
    if (!baseSnap) return null;
    if (tab !== 'transactions') return baseSnap;
    return {
      ...baseSnap,
      ...(transactionSlice ?? { transactions: [], transactionSplits: [], refundAllocations: [] }),
    };
  }, [baseSnap, tab, transactionSlice]);
  const table = useMemo(() => {
    if (!snap) return null;
    if (tab === 'transactions') {
      return transactionAggregates
        ? transactionTableFromAggregates(snap, transactionAggregates, { dateRange: effectiveRange })
        : null;
    }
    return buildReport(snap, tab, { dateRange: effectiveRange });
  }, [effectiveRange, snap, tab, transactionAggregates]);
  const details = useMemo(
    () => (snap && tab === 'transactions' ? transactionDetails(snap, { dateRange: effectiveTransactionDetailRange, transactionCategory: selectedCategory || undefined }) : []),
    [effectiveTransactionDetailRange, selectedCategory, snap, tab],
  );
  const comparison = useMemo(() => (
    snap && tab === 'transactions' && transactionAggregates && comparisonRanges
      ? buildTransactionComparison(snap, transactionAggregates, comparisonRanges)
      : null
  ), [comparisonRanges, snap, tab, transactionAggregates]);
  const budgetVariance = useMemo(() => (
    snap && tab === 'transactions' && transactionAggregates
      ? buildBudgetVariance(snap, transactionAggregates, comparisonRanges?.current ?? effectiveTransactionRange)
      : { planned: '0', actual: '0', variance: '0', overCount: 0, complete: true, rows: [] }
  ), [comparisonRanges, effectiveTransactionRange, snap, tab, transactionAggregates]);
  if (!snap) return null;
  if (!table) return <div role="status" style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-body)' }}>{transactionAggregateBusy ? '正在计算报表…' : '报表暂不可用'}</div>;
  const reportTable = table;
  const tabLabel = TABS.find(([id]) => id === tab)?.[1] ?? '报表';
  const reportCurrency = createReportCurrency(snap, effectiveRange.to);

  function drillTransactions(category: string, range: DateRange) {
    const effective = effectiveReportRange(range, asOfDate);
    setSelectedCategory(category);
    setTransactionDetailRange({ preset: 'custom', from: effective.from, to: effective.to });
    requestAnimationFrame(() => document.getElementById('transaction-report-details')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function exportReportCsv() {
    downloadText(`zichan-${tab}-${rangeFilePart(effectiveRange)}.csv`, tableToCsv(reportTable), 'text/csv;charset=utf-8');
  }

  function exportReportMarkdown() {
    downloadText(`zichan-${tab}-${rangeFilePart(effectiveRange)}.md`, tableToMarkdown(reportTable), 'text/markdown;charset=utf-8');
  }

  function exportReportMermaid() {
    downloadText(`zichan-${tab}-${rangeFilePart(effectiveRange)}.mmd`, tableToMermaid(reportTable, tabLabel), 'text/plain;charset=utf-8');
  }

  async function exportPdf() {
    setPdfBusy(true);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      downloadReportPdf(`zichan-${tab}-${rangeFilePart(effectiveRange)}.pdf`, {
        title: `资产生命周期 · ${tabLabel}`,
        range: rangeLabel(effectiveRange),
        table: reportTable,
      });
    } finally {
      setPdfBusy(false);
    }
  }

  async function loadMoreTransactionDetails() {
    if (!transactionCursor || !transactionHasMore || transactionPageBusy) return;
    setTransactionPageBusy(true);
    setTransactionLoadError('');
    try {
      const page = await store.transactionBrowsePage({
        from: effectiveTransactionDetailRange.from,
        to: effectiveTransactionDetailRange.to,
        category: selectedCategory || undefined,
        excludeTypes: ['transfer', 'adjustment'],
        cursor: transactionCursor,
        limit: 200,
      });
      setTransactionSlice((current) => mergeTransactionSlices(current, page));
      setTransactionCursor(page.nextCursor);
      setTransactionHasMore(page.hasMore);
    } catch (error) {
      setTransactionLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setTransactionPageBusy(false);
    }
  }

  async function exportTransactionDetails() {
    if (!baseSnap || detailExportBusy) return;
    setDetailExportBusy(true);
    setDetailExported(0);
    try {
      const chunks = (async function* () {
        yield `${DETAIL_CSV_HEADER.join(',')}\n`;
        let exported = 0;
        for await (const page of store.iterateTransactionBrowse({
          from: effectiveTransactionDetailRange.from,
          to: effectiveTransactionDetailRange.to,
          category: selectedCategory || undefined,
          excludeTypes: ['transfer', 'adjustment'],
          pageSize: 500,
        })) {
          const pageSnap: Snapshot = {
            ...baseSnap,
            transactions: page.transactions,
            transactionSplits: page.transactionSplits,
            refundAllocations: page.refundAllocations,
          };
          const rows = transactionDetails(pageSnap, {
            dateRange: effectiveTransactionDetailRange,
            transactionCategory: selectedCategory || undefined,
          });
          if (rows.length) yield `${detailRowsToCsv(rows)}\n`;
          exported += rows.length;
          setDetailExported(exported);
        }
      })();
      await downloadTextChunks(
        `zichan-transactions-detail-${rangeFilePart(effectiveTransactionDetailRange)}.csv`,
        chunks,
        'text/csv;charset=utf-8',
      );
    } catch (error) {
      setTransactionLoadError(`明细导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDetailExportBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="zc-report-tabs" style={{ display: 'flex', gap: 8 }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); setExportMenuOpen(false); }} style={pillBtn(tab === id)}>{label}</button>
        ))}
      </div>
      {/* Filtering semantics, separated: the range stays in `DateRangeBar`, and
          the drill-down is a removable chip on the same row. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <DateRangeBar value={dateRange} anchor={asOfDate} onChange={(next) => {
          setRanges((current) => ({ ...current, [tab]: next }));
          setSelectedCategory('');
          if (tab === 'transactions') setTransactionDetailRange(next);
        }} />
        {tab === 'transactions' && selectedCategory && (
          <button
            type="button"
            className="zc-btn zc-btn--sm"
            onClick={() => {
              setSelectedCategory('');
              setTransactionDetailRange(transactionRange);
            }}
          >
            清除分类下钻<span aria-hidden="true"> ×</span>
          </button>
        )}
      </div>
      {tab === 'transactions' && (
        <ReportSummaryStrip
          comparison={comparison}
          formatAmount={(value) => reportCurrency.formatReport(value)}
          formatSignedAmount={(value) => reportCurrency.formatSignedReport(value)}
        />
      )}
      {/* One export entry. The six old buttons were six parallel ways to ask the
          same question, which is why the numbers kept sliding below the fold. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <div className="zc-menu" ref={exportMenuRef}>
          <button
            ref={exportTriggerRef}
            type="button"
            className="zc-btn zc-btn--outline"
            /* Distinct from the header's backup export, which is also labelled 导出. */
            aria-label="导出报表"
            aria-haspopup="true"
            aria-expanded={exportMenuOpen}
            onClick={() => setExportMenuOpen((open) => !open)}
          >
            导出
          </button>
          {exportMenuOpen && (
            <div className="zc-menu-list">
              {tab === 'transactions' && (
                <button
                  type="button"
                  className="zc-menu-item"
                  aria-label="导出明细 CSV"
                  disabled={detailExportBusy}
                  onClick={() => {
                    setExportMenuOpen(false);
                    void exportTransactionDetails();
                  }}
                >
                  {detailExportBusy ? `导出明细中 ${detailExported}` : '明细 CSV'}
                </button>
              )}
              <button
                type="button"
                className="zc-menu-item"
                aria-label="导出 CSV"
                onClick={() => {
                  setExportMenuOpen(false);
                  exportReportCsv();
                }}
              >
                CSV
              </button>
              <button
                type="button"
                className="zc-menu-item"
                aria-label="导出 PDF"
                disabled={pdfBusy}
                onClick={() => {
                  setExportMenuOpen(false);
                  void exportPdf();
                }}
              >
                {pdfBusy ? '正在生成 PDF…' : 'PDF'}
              </button>
              <button
                type="button"
                className="zc-menu-item"
                aria-label="导出 Markdown"
                onClick={() => {
                  setExportMenuOpen(false);
                  exportReportMarkdown();
                }}
              >
                Markdown
              </button>
              <button
                type="button"
                className="zc-menu-item"
                aria-label="导出 Mermaid"
                onClick={() => {
                  setExportMenuOpen(false);
                  exportReportMermaid();
                }}
              >
                Mermaid
              </button>
            </div>
          )}
        </div>
      </div>
      {!!table.missingRateAssetCodes?.length && (
        <div style={{ ...card, padding: '12px 14px', borderColor: 'var(--warning)', color: 'var(--warning)', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-medium)' }}>
          缺少 {table.missingRateAssetCodes.join('、')} → {table.reportCurrencyCode} 的价格标记；相关记录显示为“未折算”，且不参与可比汇总。
        </div>
      )}
      {tab === 'transactions' && transactionAggregateError && (
        <div role="alert" style={{ ...card, padding: '12px 14px', borderColor: 'var(--negative)', color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
          对比与汇总读取失败：{transactionAggregateError}
        </div>
      )}
      <TimeTrendChart
        snap={snap}
        tab={tab}
        dateRange={effectiveRange}
        granularity={granularity}
        onGranularityChange={setGranularity}
        transactionAggregates={transactionAggregates ?? []}
      />
      <ReportChart
        snap={snap}
        tab={tab}
        dateRange={effectiveRange}
        selectedCategory={selectedCategory}
        onSelectCategory={(category) => drillTransactions(category, effectiveRange)}
        transactionTable={tab === 'transactions' ? table : undefined}
      />
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="zc-card-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{table.headers.map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => {
                const rowCategory = row[1]?.data?.category ?? '';
                const clickable = tab === 'transactions' && !!rowCategory;
                return (
                <tr
                  key={i}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={() => { if (clickable) drillTransactions(rowCategory, effectiveRange); }}
                  onKeyDown={(event) => {
                    if (!clickable || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    drillTransactions(rowCategory, effectiveRange);
                  }}
                  style={{ cursor: clickable ? 'pointer' : undefined, background: selectedCategory && selectedCategory === rowCategory ? 'var(--surface-2)' : undefined }}
                >
                  {row.map((c, j) => (
                    <td key={j} data-label={table.headers[j]} style={{ ...tdStyle, color: c.color ?? 'var(--fg)', fontWeight: c.bold ? 'var(--fw-bold)' : 'var(--fw-regular)' }}>{c.v}</td>
                  ))}
                </tr>
                );
              })}
              {table.rows.length === 0 && (
                <tr><td className="zc-card-table-empty" style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={table.headers.length}>暂无数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {tab === 'transactions' && (
        <TransactionDetailTable
          rows={details}
          range={effectiveTransactionDetailRange}
          selectedCategory={selectedCategory}
          loadedCount={transactionSlice?.transactions.length ?? 0}
          hasMore={transactionHasMore}
          busy={transactionPageBusy}
          error={transactionLoadError}
          onLoadMore={() => void loadMoreTransactionDetails()}
        />
      )}
      {tab === 'transactions' && (
        <TransactionReportInsights
          comparison={comparison}
          budget={budgetVariance}
          formatAmount={(value) => reportCurrency.formatReport(value)}
          formatSignedAmount={(value) => reportCurrency.formatSignedReport(value)}
          onDrill={drillTransactions}
        />
      )}
    </div>
  );
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function mergeTransactionSlices(
  current: Pick<Snapshot, 'transactions' | 'transactionSplits' | 'refundAllocations'> | null,
  page: TransactionReportPage,
): Pick<Snapshot, 'transactions' | 'transactionSplits' | 'refundAllocations'> {
  return {
    transactions: [...(current?.transactions ?? []), ...page.transactions],
    transactionSplits: [...(current?.transactionSplits ?? []), ...page.transactionSplits],
    refundAllocations: [...(current?.refundAllocations ?? []), ...page.refundAllocations],
  };
}

const DETAIL_CSV_HEADER = ['reportDate', 'cashDate', 'type', 'category', 'payee', 'description', 'amount', 'baseAmount'];

function csvCell(cell: string): string {
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function detailRowsToCsv(rows: TransactionDetailRow[]): string {
  return rows
    .map((row) => [
      row.reportDate, row.cashDate, row.type, row.category,
      row.payee, row.description, row.amount, row.baseAmount,
    ].map(csvCell).join(','))
    .join('\n');
}

type FileWriter = {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<FileWriter> }>;
};

async function downloadTextChunks(
  filename: string,
  chunks: AsyncIterable<string>,
  mime: string,
): Promise<void> {
  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (picker) {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: 'CSV', accept: { [mime.split(';')[0] || 'text/plain']: ['.csv'] } }],
    });
    const writer = await handle.createWritable();
    try {
      for await (const chunk of chunks) await writer.write(chunk);
      await writer.close();
    } catch (error) {
      await writer.abort?.(error);
      throw error;
    }
    return;
  }
  const parts: string[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  const blob = new Blob(parts, { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function rangeLabel(range: DateRangeValue): string {
  if (!range.from && !range.to) return '全部时间';
  if (range.from === range.to) return range.from ?? range.to ?? '全部时间';
  return `${range.from ?? '最早'} 至 ${range.to ?? '至今'}`;
}

function rangeFilePart(range: DateRangeValue): string {
  return `${range.from ?? 'start'}_${range.to ?? 'latest'}`;
}

function TransactionDetailTable(props: {
  rows: TransactionDetailRow[];
  range: DateRangeValue;
  selectedCategory: string;
  loadedCount: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  onLoadMore: () => void;
}) {
  const { rows, range, selectedCategory, loadedCount, hasMore, busy, error, onLoadMore } = props;
  const openInTransactions = () => {
    accountSessionStorage.setItem('zichan.transactions.filterPreset', JSON.stringify({ range: range.preset, dateFrom: range.from, dateTo: range.to, category: selectedCategory || 'all' }));
    window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'transactions' } }));
  };
  return (
    <div id="transaction-report-details" style={{ ...card, padding: 0, overflow: 'hidden', scrollMarginTop: 16 }}>
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <div>
          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{rangeLabel(range)}流水明细{selectedCategory ? ' · 已按分类下钻' : ''}</div>
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 3 }}>
            已加载 {loadedCount} 笔原始流水，当前展示 {rows.length} 条分类明细；可回到流水页继续筛选、批量修改或编辑。
          </div>
        </div>
        <button onClick={openInTransactions} style={pillBtn(false)}>在流水页整理</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="zc-card-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['报表归属日', '实际发生时间', '类型', '分类', '商户', '描述', '金额', '折算'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="报表归属日" style={tdStyle}>{row.reportDate}</td>
                <td data-label="实际发生时间" style={tdStyle}>{row.cashDate}</td>
                <td data-label="类型" style={tdStyle}>{row.type}</td>
                <td data-label="分类" style={tdStyle}>{row.category}</td>
                <td data-label="商户" style={tdStyle}>{row.payee}</td>
                <td data-label="描述" style={{ ...tdStyle, whiteSpace: 'normal' }}>{row.description || '—'}</td>
                <td data-label="金额" style={tdStyle}>{row.amount}</td>
                <td data-label="折算" style={tdStyle}>{row.baseAmount}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="zc-card-table-empty" style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={8}>暂无流水明细</td></tr>}
          </tbody>
        </table>
      </div>
      {(hasMore || error) && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {hasMore && <button type="button" onClick={onLoadMore} disabled={busy} style={pillBtn(false)}>{busy ? '加载中…' : '继续加载 200 笔'}</button>}
          {error && <span role="alert" style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)' }}>{error}</span>}
        </div>
      )}
    </div>
  );
}

function TimeTrendChart(props: {
  snap: Snapshot;
  tab: TabId;
  dateRange: DateRangeValue;
  granularity: 'day' | 'month' | 'year';
  onGranularityChange: (value: 'day' | 'month' | 'year') => void;
  transactionAggregates: TransactionReportAggregateRow[];
}) {
  const { snap, tab, dateRange, granularity, onGranularityChange, transactionAggregates } = props;
  const report = createReportCurrency(snap, dateRange.to);
  const values = new Map<string, ReturnType<typeof D>>();
  const bucket = (date: string) => date.slice(0, granularity === 'year' ? 4 : granularity === 'month' ? 7 : 10);
  const add = (date: string, amount: ReturnType<typeof D>) => {
    if (!isDateInRange(date, dateRange)) return;
    const key = bucket(date);
    values.set(key, (values.get(key) ?? D(0)).plus(amount));
  };

  if (tab === 'transactions') {
    for (const aggregate of transactionAggregates) {
      if (!isDateInRange(aggregate.reportDate, dateRange)) continue;
      const native = aggregate.amounts.reduce((total, amount) => total.plus(amount), D(0));
      const delta = aggregate.direction === 'income' ? native : native.negated();
      const converted = report.toReportAt(delta, aggregate.reportAssetId, aggregate.reportDate);
      if (converted) add(aggregate.reportDate, converted);
    }
  } else if (tab === 'dca') {
    for (const execution of snap.dcaExecutions.filter((row) => !row.isDeleted)) {
      const converted = report.toReportAt(execution.actualBaseCost, execution.baseCurrencyAssetId, execution.date);
      if (converted) add(execution.date, converted.negated());
    }
  } else if (tab === 'chain') {
    for (const chain of snap.chains.filter((row) => row.chain.recordState !== 'voided' && row.chain.type !== 'deposit')) {
      const traced = traceChain(chain);
      const native = chain.chain.type === 'sell' ? traced.totalBaseProceeds : traced.totalBaseCost;
      const converted = report.toReportAt(native, chain.chain.baseCurrencyAssetId, chain.chain.date);
      if (converted) add(chain.chain.date, chain.chain.type === 'sell' ? converted : converted.negated());
    }
  } else if (tab === 'season') {
    for (const record of snap.gameRecords.filter((row) => !row.isDeleted)) {
      for (const posting of gameRecordReportingPostings(record)) {
        const converted = report.toReportAt(posting.amount, posting.assetId, record.date);
        if (converted) add(record.date, converted);
      }
    }
  } else {
    for (const event of snap.fixedEvents.filter((row) => !row.isDeleted && ['purchase', 'repair', 'upgrade', 'sale'].includes(row.type))) {
      const asset = snap.fixedAssets.find((row) => row.id === event.fixedAssetId);
      if (!asset) continue;
      const converted = report.toReportAt(event.amountBase, asset.baseCurrencyAssetId, event.date);
      if (converted) add(event.date, event.type === 'sale' ? converted : converted.negated());
    }
    for (const item of snap.fixedConsumables.filter((row) => !row.isDeleted)) {
      const asset = snap.fixedAssets.find((row) => row.id === item.fixedAssetId);
      if (!asset) continue;
      const converted = report.toReportAt(item.amountBase, asset.baseCurrencyAssetId, item.purchaseDate);
      if (converted) add(item.purchaseDate, converted.negated());
    }
  }

  const rows = [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-24).map(([label, value]) => ({ label, value }));
  const max = Math.max(...rows.map((row) => row.value.abs().toNumber()), 1);
  const title = `${TABS.find(([id]) => id === tab)?.[1] ?? '报表'} · ${granularity === 'day' ? '按日' : granularity === 'month' ? '按月' : '按年'}期间变化`;
  return (
    <div style={card}>
      {/* The granularity control lives with the chart it re-buckets, so it can
          never show up on a tab that has no trend to bucket. */}
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', minWidth: 0 }}>{title}</div>
        <div role="tablist" aria-label="报表时间粒度" style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {GRANULARITIES.map(([value, label]) => <button key={value} onClick={() => onGranularityChange(value)} style={pillBtn(granularity === value)}>{label}</button>)}
        </div>
      </div>
      <div className="zc-report-chart-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(rows.length, 1)}, minmax(42px, 1fr))`, gap: 8, minHeight: 130, alignItems: 'end' }}>
        {rows.map((row) => <div key={row.label} style={{ minWidth: 0, textAlign: 'center' }}><div style={{ height: 82, background: 'var(--surface-2)', display: 'flex', alignItems: 'end' }}><div style={{ width: '100%', height: `${Math.max(5, row.value.abs().div(max).times(100).toNumber())}%`, background: row.value.isNegative() ? 'var(--negative)' : 'var(--positive)' }} /></div><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</div><div style={{ fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', marginTop: 3 }}>{report.formatSignedReport(row.value)}</div></div>)}
        {rows.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>该时间范围内暂无可绘制数据</div>}
      </div>
    </div>
  );
}

function ReportChart(props: {
  snap: Snapshot;
  tab: TabId;
  dateRange: DateRangeValue;
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
  transactionTable?: Table;
}) {
  const { snap, tab, dateRange, selectedCategory, onSelectCategory, transactionTable } = props;
  const report = createReportCurrency(snap, dateRange.to);
  let title = '';
  let rows: { label: string; value: number; text: string; color: string; category?: string }[] = [];
  if (tab === 'transactions') {
    title = `${rangeLabel(dateRange)}分类支出`;
    rows = (transactionTable ?? buildReport(snap, 'transactions', { dateRange })).rows
      .filter((row) => row[0]?.v === '支出')
      .slice(0, 8)
      .map((row) => {
        const value = Number(row[2]?.data?.reportAmount ?? '0');
        return { label: row[1]?.v ?? '未分类', value, text: row[2]?.v ?? money(0), color: 'var(--negative)', category: row[1]?.data?.category };
      });
  } else if (tab === 'dca') {
    title = `定投累计成本 · ${report.code}`;
    let cumulative = D(0);
    rows = [...snap.dcaExecutions]
      .filter((execution) => !execution.isDeleted && isDateInRange(execution.date, dateRange))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((execution) => {
        const converted = report.toReportAt(execution.actualBaseCost, execution.baseCurrencyAssetId, execution.date);
        if (converted) cumulative = cumulative.plus(converted);
        return {
          label: execution.date.slice(5),
          value: cumulative.toNumber(),
          text: converted ? report.formatReport(cumulative) : '未完整折算',
          color: 'var(--accent)',
        };
      })
      .slice(-24);
  } else if (tab === 'season') {
    title = `赛季净收益 · ${report.code}`;
    rows = snap.seasons.map((s) => {
      const records = snap.gameRecords.filter((r) => r.seasonId === s.id && isDateInRange(r.date, dateRange));
      const net = gameNetInReport(report, records).toNumber();
      return { label: s.name, value: Math.abs(net), text: report.formatSignedReport(net), color: net >= 0 ? 'var(--positive)' : 'var(--negative)' };
    }).filter((row) => row.value > 0 || (!dateRange.from && !dateRange.to));
  } else if (tab === 'fixed') {
    title = `物品资产主要单位成本 · ${report.code}`;
    const asOf = dateRange.to ?? snap.setting?.asOfDate ?? new Date().toLocaleDateString('en-CA');
    rows = snap.fixedAssets.filter((asset) => !dateRange.from && !dateRange.to
      || isDateInRange(asset.purchaseDate, dateRange)
      || snap.fixedEvents.some((event) => event.fixedAssetId === asset.id && isDateInRange(event.date, dateRange))
      || snap.fixedUsageLogs.some((log) => log.fixedAssetId === asset.id && isDateInRange(log.date, dateRange))).map((f) => {
      const cost = fixedAssetCost(f, snap.fixedEvents, { asOf, usageMetrics: snap.fixedUsageMetrics, usageLogs: snap.fixedUsageLogs, consumables: snap.fixedConsumables });
      const usage = cost.usageCosts.find((row) => row.metricId) ?? cost.usageCosts[0]!;
      const converted = report.toReport(usage.perUnit, f.baseCurrencyAssetId);
      return {
        label: f.name,
        value: converted?.abs().toNumber() ?? 0,
        text: converted ? `${report.formatReport(converted)} / ${usage.unitLabel}` : '未折算',
        color: 'var(--accent)',
      };
    });
  } else {
    title = `资产转换手续费 · ${report.code}`;
    rows = snap.chains.filter((c) => c.chain.recordState !== 'voided' && c.chain.type !== 'deposit' && isDateInRange(c.chain.date, dateRange)).map((c) => {
      const t = traceChain(c);
      const converted = report.toReportAt(t.totalFeesInBase, c.chain.baseCurrencyAssetId, c.chain.date);
      return {
        label: c.chain.title ?? c.chain.type,
        value: converted?.abs().toNumber() ?? 0,
        text: converted ? report.formatReport(converted) : '未折算',
        color: 'var(--negative)',
      };
    });
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div style={card}>
      <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', marginBottom: 12 }}>{title}</div>
      <div className="zc-report-chart-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(rows.length, 1)}, minmax(42px, 1fr))`, gap: 10, alignItems: 'end', minHeight: 130 }}>
        {rows.map((r, i) => (
          <button
            key={`${r.label}-${i}`}
            onClick={() => { if (r.category) onSelectCategory(r.category); }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 7,
              minWidth: 0,
              border: r.category && r.category === selectedCategory ? '1px solid var(--accent)' : '1px solid transparent',
              background: 'transparent',
              padding: 0,
              borderRadius: 'var(--r-sm)',
              color: 'inherit',
              cursor: r.category ? 'pointer' : 'default',
            }}
          >
            <div style={{ height: 86, display: 'flex', alignItems: 'end', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
              <div style={{ width: '100%', height: `${Math.max(6, D(r.value).div(max).times(100).toNumber())}%`, background: r.color }} />
            </div>
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'center' }}>{r.label}</div>
            <div style={{ fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', textAlign: 'center', whiteSpace: 'nowrap' }}>{r.text}</div>
          </button>
        ))}
        {rows.length === 0 && <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>暂无可绘制数据</div>}
      </div>
    </div>
  );
}
