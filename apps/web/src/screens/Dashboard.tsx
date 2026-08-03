import { useMemo, useState } from 'react';
import { useSnapshot } from '../db/snapshot.js';
import { buildDashboard } from '../selectors/dashboard.js';
import { money, signedMoney, pct } from '../format.js';
import { card, cardTight, amountColor } from '../ui/styles.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue } from '../ui/DateRangeBar.js';

function fmtDate(d: string) {
  return d.slice(5); // MM-DD
}

export function Dashboard() {
  const snap = useSnapshot('dashboard');
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('this_month'));
  const vm = useMemo(() => (snap ? buildDashboard(snap, dateRange) : null), [dateRange, snap]);
  if (!vm) return null;
  const partial = (metric: string) => vm.incompleteMetrics.includes(metric);
  const partialText = (metric: string, value: string) => partial(metric) ? `${value}（已知部分）` : value;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <DateRangeBar value={dateRange} onChange={setDateRange} />
      {vm.missingRateAssetCodes.length > 0 && (
        <div style={{ ...cardTight, borderColor: 'var(--warning)', color: 'var(--warning)', fontSize: 13, fontWeight: 700 }}>
          缺少 {vm.missingRateAssetCodes.join('、')} → {vm.reportCurrencyCode} 的价格标记；下方相关指标明确显示为“已知部分”，不会把缺价资产按 0 计算。请在“数据管理 → 价格标记”补录。
        </div>
      )}
      <div className="zc-dashboard-hero-grid" style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 18 }}>
        <div style={{ ...card, padding: '26px 28px' }}>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', fontWeight: 700 }}>{partial('netWorth') ? '已估值净资产' : '净资产总值'} · 折算 {vm.reportCurrencyCode}</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginTop: 8 }}>
            <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: 0, lineHeight: 1 }}>
              {money(vm.netWorth)}
            </div>
            <div style={{ color: 'var(--fg-subtle)', fontWeight: 600, fontSize: 13, paddingBottom: 5, whiteSpace: 'nowrap' }}>
              截至 {vm.asOf}
            </div>
          </div>
          <div style={{ marginTop: 28, paddingTop: 18, borderTop: '1px solid var(--border)', color: 'var(--fg-muted)', fontSize: 13 }}>
            汇总金融账户、加密持仓与物品资产现状残值；模块原币仅在存在价格标记时参与折算。
          </div>
        </div>
        <div style={{ ...card, padding: '22px 24px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontWeight: 700, letterSpacing: 0, marginBottom: 6 }}>资产快照</div>
          {[
            ['所选期间投入', partialText('investedFiat', money(vm.investedFiat)), 'var(--fg)'],
            ['未实现盈亏', partialText('unrealized', signedMoney(vm.unrealized)), Number(vm.unrealized) >= 0 ? 'var(--positive)' : 'var(--negative)'],
            ['持仓资产类别', `${vm.alloc.length} 类`, 'var(--fg)'],
            ['物品资产每日成本', partialText('fixedPerDay', money(vm.fixedPerDay)), 'var(--fg)'],
            ['报表基准日', vm.asOf, 'var(--fg)'],
          ].map(([l, v, color]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 13, color: 'var(--fg-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{l}</span>
              <span style={{ whiteSpace: 'nowrap', fontSize: 14, fontWeight: 800, color }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="zc-dashboard-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 16 }}>
        {[
          ['期间法币投入', partialText('investedFiat', money(vm.investedFiat)), '买入与定投链路', 'var(--fg)'],
          ['未实现盈亏', partialText('unrealized', signedMoney(vm.unrealized)), '加密资产持仓', Number(vm.unrealized) >= 0 ? 'var(--positive)' : 'var(--negative)'],
          ['期间已实现盈亏', partialText('realizedCrypto', signedMoney(vm.realizedCrypto)), '所选日期内卖出链路', Number(vm.realizedCrypto) >= 0 ? 'var(--positive)' : 'var(--negative)'],
          ['期间游戏净收益', partialText('seasonNet', signedMoney(vm.seasonNet)), '所选日期内游戏记录', Number(vm.seasonNet) >= 0 ? 'var(--positive)' : 'var(--negative)'],
          ['期间日常收支', partialText('transactions', signedMoney(vm.txNet)), `收入 ${money(vm.txIncome)} · 支出 ${money(vm.txExpense)}${partial('transactions') ? ' · 均为已知部分' : ''}`, Number(vm.txNet) >= 0 ? 'var(--positive)' : 'var(--negative)'],
        ].map(([label, value, subv, color]) => (
          <div key={label} style={cardTight}>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 600 }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 800, marginTop: 10, letterSpacing: 0, whiteSpace: 'nowrap', color }}>{value}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 5, fontWeight: 500 }}>{subv}</div>
          </div>
        ))}
      </div>

      {vm.dcaReminders.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>定投提醒</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontWeight: 600 }}>按计划锚点与未完成期次推算</div>
          </div>
          <div className="zc-dashboard-allocation-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
            {vm.dcaReminders.map((r) => {
              const color = r.state === 'overdue' || r.state === 'due' ? 'var(--negative)' : r.state === 'manual' ? 'var(--fg-muted)' : 'var(--positive)';
              const dueText = r.state === 'manual' ? '手动执行' : r.daysLeft < 0 ? `逾期 ${Math.abs(r.daysLeft)} 天` : r.daysLeft === 0 ? '今天' : `${r.daysLeft} 天后`;
              return (
                <div key={r.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                    <div style={{ fontSize: 12, fontWeight: 800, color, whiteSpace: 'nowrap' }}>{dueText}</div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 600 }}>{r.amount} · {r.target}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>{r.nextDate}{r.path ? ` · ${r.path}` : ''}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="zc-dashboard-detail-grid" style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 18 }}>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>资产配置</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontWeight: 600 }}>{partial('netWorth') ? '缺少汇率，暂不计算占比' : '按当前折算价值'}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {vm.alloc.map((a) => (
              <div key={a.name}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{a.name}</span>
                    <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{a.note}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 800 }}>{money(a.value)}</span>
                    <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 600, width: 44, textAlign: 'right' }}>{partial('netWorth') ? '—' : pct(a.weight)}</span>
                  </div>
                </div>
                <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 99, overflow: 'hidden' }}>
                  {!partial('netWorth') && <div style={{ height: 8, borderRadius: 99, background: 'var(--accent)', width: `${(a.weight * 100).toFixed(2)}%` }} />}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 14 }}>期间动态</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {vm.activity.map((ev, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 700, width: 38, flexShrink: 0 }}>{fmtDate(ev.date)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{ev.desc}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1 }}>{ev.type} · {ev.detail}</div>
                </div>
                <div style={{ fontSize: 13, flexShrink: 0, ...(ev.amt === undefined ? { color: 'var(--warning)' } : amountColor(ev.amt)) }}>
                  {ev.amt === undefined ? '未折算' : ev.amt === 0 ? money(0) : signedMoney(ev.amt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
