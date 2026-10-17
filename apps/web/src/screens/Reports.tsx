import { accountSessionStorage } from '../account-storage.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { componentCostOwnerAt, fixedAssetAttributedCost, isDateInRange, gameRecordReportingPostings, traceChain, D, localToday, type DateRange, type QueryCursor } from '@zichan/core';
import { useSnapshot, type Snapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import type { TransactionReportAggregateRow, TransactionReportPage } from '@zichan/db';
import {
  buildReport,
  expenseCompositionFromTable,
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
import { card, th as thStyle, td as tdStyle, pillBtn, selectBase } from '../ui/styles.js';
import { CompositionDonut, RankBars, type ChartSlice } from '../ui/charts.js';
import { categoryLabel, categoryName, rootCategoryId } from '../transactionMeta.js';
import { createReportCurrency } from '../reportCurrency.js';
import { ledgerAsOfDate } from '../as-of.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue } from '../ui/DateRangeBar.js';
import { downloadReportPdf } from '../report-pdf.js';
import {
  buildBudgetVariance,
  buildTransactionComparison,
  effectiveReportRange,
  reportComparisonRanges,
} from '../selectors/report-analysis.js';
import { ReportSummaryStrip, TransactionReportInsights } from '../ui/TransactionReportInsights.js';
import { LedgerCutoffNotice } from '../ui/LedgerCutoffNotice.js';
import { useCompactView } from '../ui/useCompactView.js';
import { CATEGORY_COLORS, OTHER_CATEGORY_COLOR } from '../theme.js';

/** 空构成：非日常收支页签也要给图一个合法形状，免得再写一遍内联字面量。 */
function emptyComposition() {
  return { slices: [], others: { amount: '0', count: 0, weight: 0 }, total: '0' };
}

const TABS: [TabId, string][] = [['transactions', '日常收支'], ['dca', '定投'], ['chain', '资产转换'], ['season', '游戏赛季'], ['fixed', '物品资产']];

/*
 * Granularity only re-buckets the trend chart, so it is rendered by the chart
 * itself (`TimeTrendChart`) instead of sitting next to the date range, where it
 * read as a third, interchangeable filter.
 */
const GRANULARITIES: readonly (readonly ['day' | 'month' | 'year', string])[] = [['day', '按日'], ['month', '按月'], ['year', '按年']];

export function Reports() {
  const compactView = useCompactView();
  const [showAllRows, setShowAllRows] = useState(false);
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
  const [selectedParent, setSelectedParent] = useState('');
  const [selectedChild, setSelectedChild] = useState('');
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
  const asOfDate = baseSnap ? ledgerAsOfDate(baseSnap) : localToday();
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
      parentCategory: selectedParent || undefined,
      category: selectedChild || undefined,
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
  }, [effectiveTransactionDetailRange.from, effectiveTransactionDetailRange.to, selectedParent, selectedChild, store, tab, transactionRevision]);
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
    () => (snap && tab === 'transactions'
      ? transactionDetails(snap, {
        dateRange: effectiveTransactionDetailRange,
        transactionParentCategory: selectedParent || undefined,
        transactionCategory: selectedChild || undefined,
      })
      : []),
    [effectiveTransactionDetailRange, selectedParent, selectedChild, snap, tab],
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

  /*
   * 分类下钻是两级：一级板块（环上的段）+ 二级细分。表头那一行直接点某一行则是
   * 二级下钻（它自带归属），所以两个值总是一起设，不会出现“板块是 A、细分属于 B”。
   */
  function drillTransactions(parent: string, child: string, range: DateRange) {
    const effective = effectiveReportRange(range, asOfDate);
    setSelectedParent(parent);
    setSelectedChild(child);
    setTransactionDetailRange({ preset: 'custom', from: effective.from, to: effective.to });
    requestAnimationFrame(() => document.getElementById('transaction-report-details')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function clearCategoryDrill() {
    setSelectedParent('');
    setSelectedChild('');
  }

  /** 退一层：从细分退回它所属的板块。 */
  function stepBackToParent() {
    setSelectedChild('');
  }

  /* 点环上高亮的那一段 = 退回上一层，与支出页同一套手感。 */
  function toggleParentDrill(parent: string, range: DateRange) {
    if (selectedParent !== parent) drillTransactions(parent, '', range);
    else if (selectedChild) stepBackToParent();
    else clearCategoryDrill();
  }

  function toggleChildDrill(parent: string, child: string, range: DateRange) {
    if (selectedParent === parent && selectedChild === child) stepBackToParent();
    else drillTransactions(parent, child, range);
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
        parentCategory: selectedParent || undefined,
        category: selectedChild || undefined,
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
          parentCategory: selectedParent || undefined,
          category: selectedChild || undefined,
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
            transactionParentCategory: selectedParent || undefined,
            transactionCategory: selectedChild || undefined,
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
          the drill-down is a breadcrumb on the same row — it names the level that
          is actually filtering, not just an × to undo it. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <DateRangeBar value={dateRange} anchor={asOfDate} onChange={(next) => {
          setRanges((current) => ({ ...current, [tab]: next }));
          clearCategoryDrill();
          if (tab === 'transactions') setTransactionDetailRange(next);
        }} />
        {tab === 'transactions' && (selectedParent || selectedChild) && (
          <nav className="zc-drill-crumbs" aria-label="分类下钻">
            <button
              type="button"
              className="zc-drill-crumb"
              aria-label="退回到全部支出"
              onClick={() => {
                clearCategoryDrill();
                setTransactionDetailRange(transactionRange);
              }}
            >
              全部支出
            </button>
            <span aria-hidden="true">›</span>
            {selectedChild ? (
              <button type="button" className="zc-drill-crumb" aria-label={`退回一级：${categoryLabel(selectedParent, snap.categories)}`} onClick={stepBackToParent}>
                {categoryLabel(selectedParent, snap.categories)}
              </button>
            ) : (
              <b className="zc-drill-crumb is-current">{categoryLabel(selectedParent, snap.categories)}</b>
            )}
            {selectedChild && (
              <>
                <span aria-hidden="true">›</span>
                <b className="zc-drill-crumb is-current">{categoryLabel(selectedChild, snap.categories)}</b>
              </>
            )}
          </nav>
        )}
      </div>
      {baseSnap && <LedgerCutoffNotice snap={baseSnap} />}
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
        selectedParent={selectedParent}
        selectedChild={selectedChild}
        onSelectParent={(parent) => toggleParentDrill(parent, effectiveRange)}
        onSelectChild={(parent, child) => toggleChildDrill(parent, child, effectiveRange)}
        transactionTable={tab === 'transactions' ? table : undefined}
      />
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="zc-card-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{table.headers.map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {(compactView && !showAllRows && tab === 'transactions' ? table.rows.slice(0, 5) : table.rows).map((row, i) => {
                const rowCategory = row[1]?.data?.category ?? '';
                const clickable = tab === 'transactions' && !!rowCategory;
                /* 表格行是二级行，所以点它也自带归属：板块与细分一起设，保持两级一致。 */
                const highlight = selectedChild
                  ? selectedChild === rowCategory
                  : Boolean(selectedParent) && rootCategoryId(rowCategory, snap.categories) === selectedParent;
                return (
                <tr
                  key={i}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={() => { if (clickable) drillTransactions(rootCategoryId(rowCategory, snap.categories), rowCategory, effectiveRange); }}
                  onKeyDown={(event) => {
                    if (!clickable || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    drillTransactions(rootCategoryId(rowCategory, snap.categories), rowCategory, effectiveRange);
                  }}
                  style={{ cursor: clickable ? 'pointer' : undefined, background: highlight ? 'var(--surface-2)' : undefined }}
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
      {compactView && tab === 'transactions' && table.rows.length > 5 && <button type="button" className="zc-btn zc-btn--outline" aria-expanded={showAllRows} onClick={() => setShowAllRows((open) => !open)}>{showAllRows ? '收起分类' : `查看全部 ${table.rows.length} 个分类`}</button>}
      {tab === 'transactions' && (
        <TransactionDetailTable
          rows={details}
          range={effectiveTransactionDetailRange}
          selectedParent={selectedParent}
          selectedChild={selectedChild}
          drillLabel={
            selectedChild
              ? ` · 已按分类下钻：${categoryLabel(selectedParent, snap.categories)} / ${categoryLabel(selectedChild, snap.categories)}`
              : selectedParent ? ` · 已按分类下钻：${categoryLabel(selectedParent, snap.categories)} 全部` : ''
          }
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
          onDrill={(category, range) => drillTransactions(rootCategoryId(category, snap.categories), category, range)}
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
  selectedParent: string;
  selectedChild: string;
  /** 下钻的层级说明（“已按分类下钻”），由调用方算好；没有下钻时为空。 */
  drillLabel: string;
  loadedCount: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  onLoadMore: () => void;
}) {
  const compactView = useCompactView();
  const [expanded, setExpanded] = useState(false);
  const { rows, range, selectedParent, selectedChild, drillLabel, loadedCount, hasMore, busy, error, onLoadMore } = props;
  useEffect(() => {
    if (selectedParent || selectedChild) setExpanded(true);
  }, [selectedParent, selectedChild]);
  const openInTransactions = () => {
    /* 把两级都带过去：只带二级的话，回到流水页后面包屑会缺一层归属。 */
    accountSessionStorage.setItem('zichan.transactions.filterPreset', JSON.stringify({
      range: range.preset,
      dateFrom: range.from,
      dateTo: range.to,
      category: selectedChild || 'all',
      parentCategory: selectedParent || 'all',
    }));
    window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'transactions' } }));
  };
  return (
    <div id="transaction-report-details" style={{ ...card, padding: 0, overflow: 'hidden', scrollMarginTop: 16 }}>
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <div>
          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{rangeLabel(range)}流水明细{drillLabel}</div>
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 3 }}>
            已加载 {loadedCount} 笔原始流水，当前展示 {rows.length} 条分类明细；可回到流水页继续筛选、批量修改或编辑。
          </div>
        </div>
        <button onClick={openInTransactions} style={pillBtn(false)}>在流水页整理</button>
      </div>
      {compactView && <button type="button" className="zc-report-detail-toggle zc-btn zc-btn--outline" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>{expanded ? '收起流水明细' : `查看 ${rows.length} 条流水明细`}</button>}
      {(!compactView || expanded) && <>
      <div style={{ overflowX: 'auto' }}>
        <table className="zc-card-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['报表归属日', '实际发生时间', '类型', '分类', '交易对象', '描述', '金额', '折算'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="报表归属日" style={tdStyle}>{row.reportDate}</td>
                <td data-label="实际发生时间" style={tdStyle}>{row.cashDate}</td>
                <td data-label="类型" style={tdStyle}>{row.type}</td>
                <td data-label="分类" style={tdStyle}>{row.category}</td>
                <td data-label="交易对象" style={tdStyle}>{row.payee}</td>
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
      </>}
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
      const converted = execution.actualBaseCost === null ? undefined : report.toReportAt(execution.actualBaseCost, execution.baseCurrencyAssetId, execution.date);
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
    for (const event of snap.fixedEvents.filter((row) => !row.isDeleted && ['purchase', 'repair', 'upgrade', 'part_sale', 'sale'].includes(row.type))) {
      const asset = snap.fixedAssets.find((row) => row.id === event.fixedAssetId);
      if (!asset) continue;
      const converted = report.toReportAt(event.amountBase, asset.baseCurrencyAssetId, event.date);
      if (converted) add(event.date, event.type === 'sale' || event.type === 'part_sale' ? converted : converted.negated());
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
        {/*
          * Granularity re-buckets this chart and nothing else, so it sits with
          * the chart. It used to be three pills, which read as a third filter
          * peer to the date range and the tabs while costing three controls;
          * one select says the same thing with one.
          */}
        <select
          aria-label="报表时间粒度"
          value={granularity}
          onChange={(event) => onGranularityChange(event.target.value as 'day' | 'month' | 'year')}
          style={{ ...selectBase, width: 'auto', flexShrink: 0 }}
        >
          {GRANULARITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
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
  selectedParent: string;
  selectedChild: string;
  onSelectParent: (parent: string) => void;
  onSelectChild: (parent: string, child: string) => void;
  transactionTable?: Table;
}) {
  const { snap, tab, dateRange, selectedParent, selectedChild, onSelectParent, onSelectChild, transactionTable } = props;
  const report = createReportCurrency(snap, dateRange.to);
  /*
   * 日常收支的分类图有两种读法，都是对的：环形回答「钱花在哪里」，
   * 条形回答「谁比谁多」。趋势画饼是错读法，所以这个开关只出现在这一个页签。
   */
  const [shape, setShape] = useState<'donut' | 'bar'>('donut');
  const table = useMemo(
    () => (tab === 'transactions' ? transactionTable ?? buildReport(snap, 'transactions', { dateRange }) : undefined),
    [dateRange, snap, tab, transactionTable],
  );
  /* 左环按一级板块聚合：流水只挂二级，直接画二级会让当月最大的板块被拆散而不入环。 */
  const composition = useMemo(
    () => (table ? expenseCompositionFromTable(table, { categories: snap.categories }) : emptyComposition()),
    [snap.categories, table],
  );
  /* 右环只多一道归属过滤，同一张表的同一批行，所以两环之和必然对得上。 */
  const children = useMemo(
    () => (table && selectedParent
      ? expenseCompositionFromTable(table, { categories: snap.categories, level: 'leaf', underParent: selectedParent })
      : undefined),
    [selectedParent, snap.categories, table],
  );
  const parentLabel = selectedParent ? categoryLabel(selectedParent, snap.categories) : '';
  let title = '';
  let rows: { label: string; value: number; text: string; color: string; category?: string }[] = [];
  if (tab === 'transactions') {
    /*
     * 已选板块时条形也只排那一个板块的二级：图上高亮了一段、下面却又列全部分类的话，
     * 两种形态就变成两道题了。点击仍然按二级下钻（条形的长处就是能列得比环多）。
     */
    const leafRows = (table?.rows ?? [])
      .filter((row) => row[0]?.v === '支出')
      .filter((row) => !selectedParent || rootCategoryId(String(row[1]?.data?.category ?? ''), snap.categories) === selectedParent)
      .slice(0, 8);
    title = `${rangeLabel(dateRange)}${parentLabel ? `${parentLabel} ` : ''}分类支出`;
    rows = leafRows.map((row) => {
      const value = Number(row[2]?.data?.reportAmount ?? '0');
      return { label: categoryName(String(row[1]?.data?.category ?? ''), snap.categories), value, text: row[2]?.v ?? money(0), color: 'var(--negative)', category: row[1]?.data?.category };
    });
  } else if (tab === 'dca') {
    title = `定投累计成本 · ${report.code}`;
    let cumulative = D(0);
    rows = [...snap.dcaExecutions]
      .filter((execution) => !execution.isDeleted && isDateInRange(execution.date, dateRange))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((execution) => {
        const converted = execution.actualBaseCost === null ? undefined : report.toReportAt(execution.actualBaseCost, execution.baseCurrencyAssetId, execution.date);
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
    title = `物品资产单位净投入 · ${report.code}`;
    const asOf = dateRange.to ?? ledgerAsOfDate(snap);
    rows = snap.fixedAssets.filter((asset) => !(asset.role === 'component' && componentCostOwnerAt(asset, snap.fixedEvents, asOf)) && (!dateRange.from && !dateRange.to
      || isDateInRange(asset.purchaseDate, dateRange)
      || snap.fixedEvents.some((event) => event.fixedAssetId === asset.id && isDateInRange(event.date, dateRange))
      || snap.fixedAssets.some((component) => component.role === 'component'
        && componentCostOwnerAt(component, snap.fixedEvents, asOf) === asset.id
        && (isDateInRange(component.purchaseDate, dateRange)
          || snap.fixedEvents.some((event) => event.fixedAssetId === component.id && isDateInRange(event.date, dateRange))))
      || snap.fixedUsageLogs.some((log) => log.fixedAssetId === asset.id && isDateInRange(log.date, dateRange)))).map((f) => {
      const cost = fixedAssetAttributedCost(f, snap.fixedAssets, snap.fixedEvents, { asOf, usageMetrics: snap.fixedUsageMetrics, usageLogs: snap.fixedUsageLogs, consumables: snap.fixedConsumables });
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
  const isComposition = tab === 'transactions';
  /*
   * One category, one colour, whichever shape is on: a slice and its bar must
   * match, otherwise switching shape looks like new data rather than a new view
   * of the same rows. (语义红只属于「支出」，不兼职分类——见 theme.ts.)
   */
  const colorAt = (index: number) => CATEGORY_COLORS[index % CATEGORY_COLORS.length] ?? OTHER_CATEGORY_COLOR;
  const chartSlices = (data: typeof composition, onSelect: (category: string) => void): ChartSlice[] => [
    ...data.slices.map((slice, index) => ({
      key: slice.category,
      label: slice.label,
      amountText: report.formatReport(D(slice.amount)),
      weight: slice.weight,
      color: colorAt(index),
      onSelect: () => onSelect(slice.category),
    })),
    ...(data.others.count > 0
      ? [{
        key: '__other__',
        label: `其他 ${data.others.count} 类`,
        amountText: report.formatReport(D(data.others.amount)),
        weight: data.others.weight,
        color: OTHER_CATEGORY_COLOR,
      }]
      : []),
  ];
  const slices = chartSlices(composition, onSelectParent);
  const childSlices = children ? chartSlices(children, (category) => onSelectChild(selectedParent, category)) : [];
  return (
    <div style={card}>
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', minWidth: 0 }}>{title}</div>
        {isComposition && (
          <div role="group" aria-label="分类图形态" style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button type="button" aria-pressed={shape === 'donut'} onClick={() => setShape('donut')} style={pillBtn(shape === 'donut')}>环形</button>
            <button type="button" aria-pressed={shape === 'bar'} onClick={() => setShape('bar')} style={pillBtn(shape === 'bar')}>条形</button>
          </div>
        )}
      </div>
      {isComposition && shape === 'donut' ? (
        <div className="zc-chart-pair">
          <CompositionDonut
            ariaLabel={`${rangeLabel(dateRange)}分类支出构成（一级分类）`}
            totalText={report.formatReport(D(composition.total))}
            totalCaption="分类支出合计"
            selectedKey={selectedParent || undefined}
            testId="composition-parent"
            slices={slices}
          />
          {children && (
            <CompositionDonut
              ariaLabel={`${parentLabel} 的二级构成`}
              totalText={report.formatReport(D(children.total))}
              totalCaption={parentLabel}
              selectedKey={selectedChild || undefined}
              emptyText="这个板块在该范围内没有可归类的支出"
              testId="composition-children"
              slices={childSlices}
            />
          )}
        </div>
      ) : (
        <RankBars
          ariaLabel={`${title}排名`}
          rows={rows.map((r, index) => ({
            key: `${r.label}-${index}`,
            label: r.label,
            heightRatio: r.value / max,
            text: r.text,
            color: isComposition ? colorAt(index) : r.color,
            selected: Boolean(r.category) && r.category === selectedChild,
            /* 条形列的是二级，所以点它也自带归属——板块跟着这条二级上溯，
               与表格行、左环两条路同一个规则。 */
            onSelect: r.category ? () => onSelectChild(rootCategoryId(r.category as string, snap.categories), r.category as string) : undefined,
          }))}
        />
      )}
    </div>
  );
}
