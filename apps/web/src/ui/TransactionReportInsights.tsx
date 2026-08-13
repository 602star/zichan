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
      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 21, fontWeight: 950 }}>{current}</div>
      <div style={{ display: 'grid', gap: 5, marginTop: 10, fontSize: 11 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: 'var(--fg-subtle)' }}>环比（上期）</span>
          <b style={{ color: metricTone(kind, value.previousDelta) }}>
            {percent(value.previousPercent)} · {formatSignedAmount(value.previousDelta)}
          </b>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: 'var(--fg-subtle)' }}>同比（去年同期）</span>
          <b style={{ color: metricTone(kind, value.yearOverYearDelta) }}>
            {percent(value.yearOverYearPercent)} · {formatSignedAmount(value.yearOverYearDelta)}
          </b>
        </div>
      </div>
    </div>
  );
}

export function TransactionReportInsights(props: Props) {
  const { comparison, budget, formatAmount, formatSignedAmount, onDrill } = props;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section aria-labelledby="transaction-comparison-heading" style={{ display: 'grid', gap: 10 }}>
        <div>
          <div id="transaction-comparison-heading" style={{ fontSize: 15, fontWeight: 900 }}>收支同比与环比</div>
          <div style={{ marginTop: 3, fontSize: 11, color: 'var(--fg-subtle)' }}>
            {comparison
              ? `${comparison.ranges.current.from} 至 ${comparison.ranges.current.to}；进行中的范围按账本基准日截断后做同口径比较。`
              : '请选择同时包含开始和结束日期的范围后查看可比分析。'}
          </div>
        </div>
        {comparison ? (
          <>
            <div className="zc-report-insight-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <ComparisonMetricCard label="收入" kind="income" value={comparison.income} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
              <ComparisonMetricCard label="支出" kind="expense" value={comparison.expense} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
              <ComparisonMetricCard label="净收支" kind="net" value={comparison.net} formatAmount={formatAmount} formatSignedAmount={formatSignedAmount} />
            </div>
            {!comparison.complete && (
              <div role="status" style={{ color: 'var(--warning)', fontSize: 12, fontWeight: 750 }}>
                对比期间缺少 {comparison.missingRateAssetCodes.join('、')} 的汇率；当前仅展示可折算部分，百分比不代表完整账本。
              </div>
            )}
            <div style={{ ...card, padding: 15 }}>
              <div style={{ fontSize: 13, fontWeight: 900 }}>前三变化驱动</div>
              <div style={{ marginTop: 3, fontSize: 11, color: 'var(--fg-subtle)' }}>按相对上期对净收支影响的绝对值排序；可分别下钻本期或上期流水。</div>
              <div style={{ display: 'grid', gap: 8, marginTop: 11 }}>
                {comparison.topDrivers.map((driver) => (
                  <div key={driver.key} className="zc-report-driver-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) auto auto', alignItems: 'center', gap: 10, padding: '9px 10px', background: 'var(--surface-2)', borderRadius: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{driver.categoryLabel} · {driver.directionLabel}</div>
                      <div style={{ marginTop: 3, fontSize: 10, color: 'var(--fg-subtle)' }}>
                        本期 {formatAmount(driver.currentAmount)} · 上期 {formatAmount(driver.previousAmount)}
                      </div>
                    </div>
                    <b style={{ color: tone(driver.netImpactDelta), fontSize: 12 }}>{formatSignedAmount(driver.netImpactDelta)}</b>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'end' }}>
                      <button type="button" onClick={() => onDrill(driver.category, comparison.ranges.current)} style={pillBtn(false)}>本期流水</button>
                      <button type="button" onClick={() => onDrill(driver.category, comparison.ranges.previous)} style={pillBtn(false)}>上期流水</button>
                    </div>
                  </div>
                ))}
                {comparison.topDrivers.length === 0 && <div style={{ color: 'var(--fg-subtle)', fontSize: 12 }}>本期与上期没有可比较的分类变化。</div>}
              </div>
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="budget-variance-heading" style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div>
            <div id="budget-variance-heading" style={{ fontSize: 14, fontWeight: 900 }}>预算偏差</div>
            <div style={{ marginTop: 3, fontSize: 11, color: 'var(--fg-subtle)' }}>汇总比较原定预算与实际支出；月度行使用含结转可用额，避免跨月重复累计结转。</div>
          </div>
          {budget.rows.length > 0 && (
            <div style={{ textAlign: 'right', fontSize: 11 }}>
              <div>原定 {formatAmount(budget.planned)} · 实际 {formatAmount(budget.actual)}</div>
              <b style={{ color: D(budget.variance).isPositive() ? 'var(--negative)' : 'var(--positive)' }}>
                相对原定 {formatSignedAmount(budget.variance)} · 超出 {budget.overCount} 项
              </b>
            </div>
          )}
        </div>
        {!budget.complete && budget.rows.length > 0 && (
          <div role="status" style={{ padding: '10px 16px', color: 'var(--warning)', fontSize: 11, borderBottom: '1px solid var(--border)' }}>
            部分预算或支出缺少换算价格，以下偏差仅代表已折算部分。
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['月份', '分类', '原定', '含结转可用', '实际', '偏差', ''].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr></thead>
            <tbody>
              {budget.rows.map((row) => (
                <tr key={row.key}>
                  <td style={tdStyle}>{row.month}</td>
                  <td style={{ ...tdStyle, fontWeight: 800 }}>{row.categoryLabel}</td>
                  <td style={tdStyle}>{row.complete ? formatAmount(row.planned) : '未完整折算'}</td>
                  <td style={tdStyle}>{row.complete ? formatAmount(row.available) : '未完整折算'}</td>
                  <td style={tdStyle}>{row.complete ? formatAmount(row.actual) : '未完整折算'}</td>
                  <td style={{ ...tdStyle, color: row.over ? 'var(--negative)' : 'var(--positive)', fontWeight: 800 }}>{row.complete ? formatSignedAmount(row.variance) : '—'}</td>
                  <td style={tdStyle}><button type="button" onClick={() => onDrill(row.category, row.range)} style={pillBtn(false)}>查看流水</button></td>
                </tr>
              ))}
              {budget.rows.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={7}>所选范围内没有月度预算。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
