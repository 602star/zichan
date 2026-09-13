import { D, type DateRange } from '@zichan/core';
import type {
  BudgetVarianceSummary,
  ComparisonValue,
  TransactionComparison,
} from '../selectors/report-analysis.js';
import { card, pillBtn, td as tdStyle, th as thStyle } from './styles.js';

interface Props {
  comparison: TransactionComparison | null;
  budget: BudgetVarianceSummary;
  formatAmount: (value: string) => string;
  formatSignedAmount: (value: string) => string;
  onDrill: (category: string, range: Required<DateRange>) => void;
}

/*
 * The answer first, the evidence second.
 *
 * `ReportSummaryStrip` is the three numbers a reader opens the report for, so it
 * renders above the export row and every table. The driver list, the comparison
 * cards and the budget table move into the collapsed `TransactionReportInsights`
 * disclosure that sits after the tables — they explain the numbers, they are not
 * the numbers.
 */
function percent(value?: string): string {
  if (value === undefined) return '基期为 0';
  const decimal = D(value);
  return `${decimal.isPositive() ? '+' : decimal.isNegative() ? '−' : ''}${decimal.abs().toDecimalPlaces(1).toString()}%`;
}

function tone(value: string): string {
  const decimal = D(value);
  return decimal.isPositive() ? 'var(--positive)' : decimal.isNegative() ? 'var(--negative)' : 'var(--fg-muted)';
}

function metricTone(kind: 'income' | 'expense' | 'net', value: string): string {
  if (D(value).isZero()) return 'var(--fg-muted)';
  if (kind === 'expense') return D(value).isPositive() ? 'var(--negative)' : 'var(--positive)';
  return tone(value);
}

function comparisonPair(
  label: string,
  kind: 'income' | 'expense' | 'net',
  percentValue: string | undefined,
  delta: string,
  formatSignedAmount: (value: string) => string,
) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <b style={{ color: metricTone(kind, delta) }}>{percent(percentValue)} · {formatSignedAmount(delta)}</b>
    </div>
  );
}

/* One cell of the leading summary strip: value, then its 环比 / 同比 context. */
function SummaryMetric(props: {
  label: string;
  kind: 'income' | 'expense' | 'net';
  value: ComparisonValue;
  formatAmount: (value: string) => string;
  formatSignedAmount: (value: string) => string;
}) {
  const { label, kind, value, formatAmount, formatSignedAmount } = props;
  return (
    <div className="zc-summary-metric">
      <div className="zc-summary-label">{label}</div>
      <div className="zc-summary-value">{kind === 'net' ? formatSignedAmount(value.current) : formatAmount(value.current)}</div>
      <div style={{ display: 'grid', gap: 4, marginTop: 4, fontSize: 'var(--fs-meta)' }}>
        {comparisonPair('环比', kind, value.previousPercent, value.previousDelta, formatSignedAmount)}
        {comparisonPair('同比', kind, value.yearOverYearPercent, value.yearOverYearDelta, formatSignedAmount)}
      </div>
    </div>
  );
}

export function ReportSummaryStrip(props: {
  comparison: TransactionComparison | null;
  formatAmount: (value: string) => string;
  formatSignedAmount: (value: string) => string;
}) {
  const { comparison, formatAmount, formatSignedAmount } = props;
  if (!comparison) {
    return (
      <div style={{ ...card, padding: '12px 14px', fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>
        请选择同时包含开始和结束日期的范围后查看收支汇总。
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="zc-summary-bar">
        <SummaryMetric label="净收支" kind="net" value={comparison.net} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
        <SummaryMetric label="收入" kind="income" value={comparison.income} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
        <SummaryMetric label="支出" kind="expense" value={comparison.expense} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
      </div>
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
        {comparison.ranges.current.from} 至 {comparison.ranges.current.to}；进行中的范围按账本基准日截断后做同口径比较。
      </div>
      {!comparison.complete && (
        <div role="status" style={{ color: 'var(--warning)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
          对比期间缺少 {comparison.missingRateAssetCodes.join('、')} 的汇率；当前仅展示可折算部分，百分比不代表完整账本。
        </div>
      )}
    </div>
  );
}

function ComparisonMetricCard(props: {
  label: string;
  kind: 'income' | 'expense' | 'net';
  value: ComparisonValue;
  formatAmount: (value: string) => string;
  formatSignedAmount: (value: string) => string;
}) {
  const { label, kind, value, formatAmount, formatSignedAmount } = props;
  const current = kind === 'net' ? formatSignedAmount(value.current) : formatAmount(value.current);
  return (
    <div style={{ ...card, padding: 15 }}>
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>{current}</div>
      <div style={{ display: 'grid', gap: 5, marginTop: 10, fontSize: 'var(--fs-meta)' }}>
        {comparisonPair('环比（上期）', kind, value.previousPercent, value.previousDelta, formatSignedAmount)}
        {comparisonPair('同比（去年同期）', kind, value.yearOverYearPercent, value.yearOverYearDelta, formatSignedAmount)}
      </div>
    </div>
  );
}

const BUDGET_MONTH = '月份';
const BUDGET_CATEGORY = '分类';
const BUDGET_PLANNED = '原定';
const BUDGET_AVAILABLE = '含结转可用';
const BUDGET_ACTUAL = '实际';
const BUDGET_VARIANCE = '偏差';
const BUDGET_ACTION = '操作';
const BUDGET_HEADINGS = [
  BUDGET_MONTH,
  BUDGET_CATEGORY,
  BUDGET_PLANNED,
  BUDGET_AVAILABLE,
  BUDGET_ACTUAL,
  BUDGET_VARIANCE,
  BUDGET_ACTION,
];

/* Evidence: change drivers and budget variance, collapsed below the tables. */
export function TransactionReportInsights(props: Props) {
  const { comparison, budget, formatAmount, formatSignedAmount, onDrill } = props;
  return (
    <details style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <summary style={{ padding: '14px 16px', cursor: 'pointer', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>
        分析明细
        <span style={{ marginLeft: 8, fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-regular)', color: 'var(--text-tertiary)' }}>
          前三变化驱动 · 预算偏差{budget.rows.length > 0 ? ` · 超出 ${budget.overCount} 项` : ''}
        </span>
      </summary>
      <div style={{ display: 'grid', gap: 14, padding: '2px 16px 16px' }}>
        {comparison && (
          <section aria-labelledby="transaction-comparison-heading" style={{ display: 'grid', gap: 10 }}>
            <div>
              <div id="transaction-comparison-heading" style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>收支同比与环比</div>
              <div style={{ marginTop: 3, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
                {comparison.ranges.current.from} 至 {comparison.ranges.current.to}；进行中的范围按账本基准日截断后做同口径比较。
              </div>
            </div>
            <div className="zc-report-insight-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <ComparisonMetricCard label="收入" kind="income" value={comparison.income} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
              <ComparisonMetricCard label="支出" kind="expense" value={comparison.expense} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
              <ComparisonMetricCard label="净收支" kind="net" value={comparison.net} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
            </div>
            {!comparison.complete && (
              <div role="status" style={{ color: 'var(--warning)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
                对比期间缺少 {comparison.missingRateAssetCodes.join('、')} 的汇率；当前仅展示可折算部分，百分比不代表完整账本。
              </div>
            )}
            <div style={{ ...card, padding: 15 }}>
              <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>前三变化驱动</div>
              <div style={{ marginTop: 3, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>按相对上期对净收支影响的绝对值排序；可分别下钻本期或上期流水。</div>
              <div style={{ display: 'grid', gap: 8, marginTop: 11 }}>
                {comparison.topDrivers.map((driver) => (
                  <div key={driver.key} className="zc-report-driver-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) auto auto', alignItems: 'center', gap: 10, padding: '9px 10px', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{driver.categoryLabel} · {driver.directionLabel}</div>
                      <div style={{ marginTop: 3, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
                        本期 {formatAmount(driver.currentAmount)} · 上期 {formatAmount(driver.previousAmount)}
                      </div>
                    </div>
                    <b style={{ color: tone(driver.netImpactDelta), fontSize: 'var(--fs-caption)' }}>{formatSignedAmount(driver.netImpactDelta)}</b>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'end' }}>
                      <button type="button" onClick={() => onDrill(driver.category, comparison.ranges.current)} style={pillBtn(false)}>本期流水</button>
                      <button type="button" onClick={() => onDrill(driver.category, comparison.ranges.previous)} style={pillBtn(false)}>上期流水</button>
                    </div>
                  </div>
                ))}
                {comparison.topDrivers.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>本期与上期没有可比较的分类变化。</div>}
              </div>
            </div>
          </section>
        )}

        <section aria-labelledby="budget-variance-heading" style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div id="budget-variance-heading" style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>预算偏差</div>
              <div style={{ marginTop: 3, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>汇总比较原定预算与实际支出；月度行使用含结转可用额，避免跨月重复累计结转。</div>
            </div>
            {budget.rows.length > 0 && (
              <div style={{ textAlign: 'right', fontSize: 'var(--fs-meta)' }}>
                <div>原定 {formatAmount(budget.planned)} · 实际 {formatAmount(budget.actual)}</div>
                <b style={{ color: D(budget.variance).isPositive() ? 'var(--negative)' : 'var(--positive)' }}>
                  相对原定 {formatSignedAmount(budget.variance)} · 超出 {budget.overCount} 项
                </b>
              </div>
            )}
          </div>
          {!budget.complete && budget.rows.length > 0 && (
            <div role="status" style={{ padding: '10px 16px', color: 'var(--warning)', fontSize: 'var(--fs-meta)', borderBottom: '1px solid var(--border)' }}>
              部分预算或支出缺少换算价格，以下偏差仅代表已折算部分。
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table className="zc-card-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{BUDGET_HEADINGS.map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr></thead>
              <tbody>
                {budget.rows.map((row) => (
                  <tr key={row.key}>
                    <td data-label={BUDGET_MONTH} style={tdStyle}>{row.month}</td>
                    <td data-label={BUDGET_CATEGORY} style={{ ...tdStyle, fontWeight: 'var(--fw-bold)' }}>{row.categoryLabel}</td>
                    <td data-label={BUDGET_PLANNED} style={tdStyle}>{row.complete ? formatAmount(row.planned) : '未完整折算'}</td>
                    <td data-label={BUDGET_AVAILABLE} style={tdStyle}>{row.complete ? formatAmount(row.available) : '未完整折算'}</td>
                    <td data-label={BUDGET_ACTUAL} style={tdStyle}>{row.complete ? formatAmount(row.actual) : '未完整折算'}</td>
                    <td data-label={BUDGET_VARIANCE} style={{ ...tdStyle, color: row.over ? 'var(--negative)' : 'var(--positive)', fontWeight: 'var(--fw-bold)' }}>{row.complete ? formatSignedAmount(row.variance) : '—'}</td>
                    <td data-label={BUDGET_ACTION} style={tdStyle}><button type="button" onClick={() => onDrill(row.category, row.range)} style={pillBtn(false)}>查看流水</button></td>
                  </tr>
                ))}
                {budget.rows.length === 0 && <tr><td className="zc-card-table-empty" style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={BUDGET_HEADINGS.length}>所选范围内没有月度预算。</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </details>
  );
}
