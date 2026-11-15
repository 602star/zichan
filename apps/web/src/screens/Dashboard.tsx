import { accountSessionStorage } from '../account-storage.js';
import { localToday } from '@zichan/core';
import { ledgerToday } from '../as-of.js';
import { useEffect, useMemo, useState } from 'react';
import { useDashboardTransactionReadModel } from '../db/dashboard-read-model.js';
import { useSnapshot } from '../db/snapshot.js';
import { baseAsset } from '../db/derive.js';
import { buildDashboard } from '../selectors/dashboard.js';
import { money, signedMoney, pct, num } from '../format.js';
import { amountColor } from '../ui/styles.js';
import { Card, CardAlert, CardEmpty, CardFact, CardGroup, CardMetric } from '../ui/Card.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue } from '../ui/DateRangeBar.js';
import { AddConversionModal } from './AddConversionModal.js';
import { listSavedBackups, type SavedBackup } from '../db/backups.js';
import { readSafetyState, type SafetyState } from '../db/safety.js';
import { loadSyncConnections, SYNC_CONFIG_CHANGED_EVENT, type SyncConnection } from '../sync-config.js';
import { SYNC_LIFECYCLE_RESULT_EVENT, type LifecycleSyncResult } from '../background-sync.js';
import { buildTaskCenter, type TaskCenterItem } from '../selectors/task-center.js';
import { LedgerCutoffNotice } from '../ui/LedgerCutoffNotice.js';
import { useCompactView } from '../ui/useCompactView.js';
import { TaskList } from '../ui/MobilePage.js';
import { navigateTo } from '../screen-target.js';
import { useMobileHomeFocus } from '../mobile-preferences.js';

function fmtDate(d: string) {
  return d.slice(5); // MM-DD
}

export function Dashboard() {
  const compactView = useCompactView();
  const homeFocus = useMobileHomeFocus();
  const [showAllMetrics, setShowAllMetrics] = useState(false);
  const snap = useSnapshot('dashboard');
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('this_month'));
  const [dcaPlanToRecord, setDcaPlanToRecord] = useState<string | null>(null);
  const today = useMemo(() => (snap ? ledgerToday(snap) : localToday()), [snap]);
  const [backups, setBackups] = useState<SavedBackup[]>([]);
  const [safetyState, setSafetyState] = useState<SafetyState>(readSafetyState);
  const [syncProfiles, setSyncProfiles] = useState<SyncConnection[]>(loadSyncConnections);
  const [lifecycleErrors, setLifecycleErrors] = useState<string[]>([]);
  const transactionReadModel = useDashboardTransactionReadModel(dateRange);
  const vm = useMemo(
    () => (snap && transactionReadModel ? buildDashboard(snap, dateRange, transactionReadModel, today) : null),
    [dateRange, snap, today, transactionReadModel],
  );
  const tasks = useMemo(() => snap ? buildTaskCenter({
    snap,
    today,
    backups,
    safety: safetyState,
    syncProfiles,
    lifecycleErrors,
  }) : [], [backups, lifecycleErrors, safetyState, snap, syncProfiles, today]);

  useEffect(() => {
    let active = true;
    const refreshSafety = () => {
      setSafetyState(readSafetyState());
      void listSavedBackups().then((rows) => { if (active) setBackups(rows); }).catch(() => undefined);
    };
    const refreshSync = () => setSyncProfiles(loadSyncConnections());
    const onLifecycle = (event: Event) => {
      const result = (event as CustomEvent<LifecycleSyncResult>).detail;
      setLifecycleErrors(result.errors);
      refreshSync();
    };
    refreshSafety();
    window.addEventListener('zichan:safety-updated', refreshSafety);
    window.addEventListener(SYNC_CONFIG_CHANGED_EVENT, refreshSync);
    window.addEventListener(SYNC_LIFECYCLE_RESULT_EVENT, onLifecycle);
    return () => {
      active = false;
      window.removeEventListener('zichan:safety-updated', refreshSafety);
      window.removeEventListener(SYNC_CONFIG_CHANGED_EVENT, refreshSync);
      window.removeEventListener(SYNC_LIFECYCLE_RESULT_EVENT, onLifecycle);
    };
  }, []);

  function openTask(task: TaskCenterItem) {
    if (task.action === 'record_dca' && task.dcaPlanId) {
      setDcaPlanToRecord(task.dcaPlanId);
      return;
    }
    if (task.action === 'open_bills') {
      try { accountSessionStorage.setItem('zichan.transactions.tab', 'bills'); } catch { /* hardened browser */ }
    }
    const screen = task.action === 'open_bills' ? 'transactions'
      : task.action === 'open_fixed' ? 'fixed'
        : task.action === 'open_settings' ? 'settings'
          : 'sync';
    window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen } }));
  }
  if (!vm) return <p role="status">正在读取总览…</p>;
  const partial = (metric: string) => vm.incompleteMetrics.includes(metric);
  const partialText = (metric: string, value: string) => partial(metric) ? `${value}（已知部分）` : value;
  const spendingFirst = compactView && homeFocus === 'spending';
  const reportDecimals = snap ? baseAsset(snap)?.decimals ?? 2 : 2;

  return (
    <div className="zc-desktop-workbench" style={compactView ? { display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' } : undefined}>
      <DateRangeBar value={dateRange} onChange={setDateRange} />
      {snap && <LedgerCutoffNotice snap={snap} />}
      {vm.missingRateAssetCodes.length > 0 && (
        <CardAlert>
          缺少 {vm.missingRateAssetCodes.join('、')} → {vm.reportCurrencyCode} 的价格标记；下方相关指标明确显示为"已知部分"，不会把缺价资产按 0 计算。请在"数据管理 → 价格标记"补录。
        </CardAlert>
      )}
      <div className="zc-dashboard-hero-grid">
        <Card className="zc-hero-card">
          <div style={{ fontSize: 'var(--fs-body)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-bold)' }}>{spendingFirst ? `所选期间支出${partial('transactions') ? ' · 已知部分' : ''}` : partial('netWorth') ? '已估值净资产' : '净资产总值'} · 折算 {vm.reportCurrencyCode}</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: '2px 14px', marginTop: 'var(--sp-2)', minWidth: 0 }}>
            <div className="zc-hero-amount" style={{ fontSize: 'var(--fs-hero)', fontFamily: 'var(--font-display)', fontWeight: 'var(--fw-bold)', lineHeight: 1.05, minWidth: 0, overflowWrap: 'anywhere' }}>
              {spendingFirst ? `${num(vm.txExpense, reportDecimals)} ${vm.reportCurrencyCode}` : money(vm.netWorth)}
            </div>
            <div className="zc-hero-asof" style={{ color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', fontSize: 'var(--fs-body)', paddingBottom: 5 }}>
              截至 {vm.asOf}
            </div>
          </div>
          {spendingFirst ? <CardGroup>
            <CardFact label="期间收入" value={`${num(vm.txIncome, reportDecimals)} ${vm.reportCurrencyCode}`} tone="positive" />
            <CardFact label="期间结余" value={signedMoney(vm.txNet, undefined, reportDecimals)} tone={vm.txNet.isNegative() ? 'negative' : 'positive'} />
          </CardGroup> : <div className="zc-hero-explanation">
            汇总金融账户、加密持仓与物品资产现状残值；模块原币仅在存在价格标记时参与折算。
          </div>}
        </Card>
        {(!compactView || showAllMetrics) && (
          <Card className="zc-hero-snapshot">
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', marginBottom: 'var(--sp-1)' }}>资产快照</div>
            {[
              ['所选期间投入', partialText('investedFiat', money(vm.investedFiat)), 'var(--fg)'],
              ['未实现盈亏', partialText('unrealized', signedMoney(vm.unrealized)), vm.unrealized.isNegative() ? 'var(--negative)' : 'var(--positive)'],
              ['持仓资产类别', `${vm.alloc.length} 类`, 'var(--fg)'],
              ['物品资产每日成本', partialText('fixedPerDay', money(vm.fixedPerDay)), 'var(--fg)'],
              ['账本日', vm.asOf, 'var(--fg)'],
            ].map(([l, v, color]) => (
              <CardFact key={l} label={l} value={v} tone={color === 'var(--negative)' ? 'negative' : color === 'var(--positive)' ? 'positive' : 'default'} />
            ))}
          </Card>
        )}
      </div>

      <div className="zc-dashboard-recent">
        {compactView && <div className="zc-mobile-shortcuts">
          <button type="button" className="zc-btn" onClick={() => navigateTo({ screen: 'reports' })}>收支报表</button>
          <button type="button" className="zc-btn" onClick={() => navigateTo({ screen: 'transactions', tab: 'budget' })}>预算</button>
          <button type="button" className="zc-btn" onClick={() => navigateTo({ screen: 'assets' })}>查看资产</button>
        </div>}
        <TaskList title="最近流水" items={(transactionReadModel?.recentTransactions ?? []).slice(0, compactView ? 3 : 6).map((row) => ({
          label: row.description || row.merchant || ({ expense: '支出', income: '收入', refund: '退款', transfer: '转账', adjustment: '余额调整' })[row.type],
          note: row.date,
          value: `${row.type === 'expense' ? '−' : row.type === 'income' || row.type === 'refund' ? '+' : ''}${num(row.amount, snap?.assets.find((asset) => asset.id === row.assetId)?.decimals ?? 8)} ${snap?.assets.find((asset) => asset.id === row.assetId)?.code ?? ''}`,
          onClick: () => navigateTo({ screen: 'transactions', tab: 'records', id: row.id }),
        }))} />
        <button type="button" className="zc-btn" onClick={() => navigateTo({ screen: 'transactions', tab: 'records' })}>查看全部流水</button>
      </div>

      {compactView && <button type="button" className="zc-dashboard-more-metrics-toggle zc-btn" aria-expanded={showAllMetrics} onClick={() => setShowAllMetrics((open) => !open)}>{showAllMetrics ? '收起完整指标' : '查看完整指标'}</button>}

      <div className={`zc-card-band zc-dashboard-kpi-grid${compactView && !showAllMetrics ? ' is-compact' : ''}`}>
        {[
          ['期间法币投入', partialText('investedFiat', money(vm.investedFiat)), '买入与定投链路', 'var(--fg)'],
          ['未实现盈亏', partialText('unrealized', signedMoney(vm.unrealized)), '加密资产持仓', vm.unrealized.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['期间已实现盈亏', partialText('realizedCrypto', signedMoney(vm.realizedCrypto)), '所选日期内卖出链路', vm.realizedCrypto.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['期间游戏净收益', partialText('seasonNet', signedMoney(vm.seasonNet)), '所选日期内游戏记录', vm.seasonNet.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['期间日常收支', partialText('transactions', signedMoney(vm.txNet)), `收入 ${money(vm.txIncome)} · 支出 ${money(vm.txExpense)}${partial('transactions') ? ' · 均为已知部分' : ''}`, vm.txNet.isNegative() ? 'var(--negative)' : 'var(--positive)'],
        ].filter((_, index) => !compactView || showAllMetrics || index === 1 || index === 4).map(([label, value, subv, color]) => (
          <CardMetric key={label} label={label} value={value} note={subv} tone={color === 'var(--negative)' ? 'negative' : color === 'var(--positive)' ? 'positive' : 'default'} />
        ))}
      </div>

      {(!compactView || tasks.length > 0) && (
        <Card className="zc-dashboard-tasks" title="任务中心" note="账单 · 定投 · 耗材 · 备份 · 同步">
          {tasks.length === 0 ? (
            <CardEmpty>当前没有需要处理的任务</CardEmpty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              {tasks.map((task) => {
                const color = task.severity === 'danger' ? 'var(--negative)' : task.severity === 'warning' ? 'var(--warning)' : 'var(--accent)';
                return (
                  <div key={task.id} className="zc-task-row" style={{ display: 'grid', gridTemplateColumns: '10px minmax(0, 1fr) auto', gap: 'var(--sp-2)', alignItems: 'center', padding: 'var(--sp-2) 0' }}>
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: 'var(--r-pill)', background: color }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{task.title}</div>
                      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 3, overflowWrap: 'anywhere' }}>{task.detail}</div>
                    </div>
                    <button type="button" className="zc-btn zc-btn--sm" onClick={() => openTask(task)} style={{ color }}>{task.actionLabel}</button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      <div className="zc-dashboard-detail-grid">
        <Card title="资产配置" note={partial('netWorth') ? '缺少汇率，暂不计算占比' : '按当前折算价值'}>
          <div>
            {vm.alloc.map((a) => (
              <CardGroup key={a.name}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-1)' }}>
                  <div className="zc-dashboard-allocation-name" style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
                    <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{a.name}</span>
                    <span className="zc-dashboard-allocation-note" style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>{a.note}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
                    <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{money(a.value)}</span>
                    <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)', width: 44, textAlign: 'right' }}>{partial('netWorth') ? '—' : pct(a.weight)}</span>
                  </div>
                </div>
                <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 'var(--r-pill)', overflow: 'hidden' }}>
                  {!partial('netWorth') && <div style={{ height: 8, borderRadius: 'var(--r-pill)', background: 'var(--accent)', width: `${(a.weight * 100).toFixed(2)}%` }} />}
                </div>
              </CardGroup>
            ))}
          </div>
        </Card>
        <Card title="期间动态">
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {vm.activity.map((ev, i) => (
              <CardGroup key={i} className="zc-dashboard-activity">
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', width: 38, flexShrink: 0 }}>{fmtDate(ev.date)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{ev.desc}</div>
                  <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 1 }}>{ev.type} · {ev.detail}</div>
                </div>
                <div style={{ fontSize: 'var(--fs-body)', flexShrink: 0, ...(ev.amt === undefined ? { color: 'var(--warning)' } : amountColor(ev.amt)) }}>
                  {ev.amt === undefined ? '未折算' : signedMoney(ev.amt)}
                </div>
              </CardGroup>
            ))}
            {vm.activity.length === 0 && <CardEmpty>所选期间没有资产动态。</CardEmpty>}
          </div>
        </Card>
      </div>
      {dcaPlanToRecord && (
        <AddConversionModal
          preset={{ dcaPlanId: dcaPlanToRecord }}
          onClose={() => setDcaPlanToRecord(null)}
        />
      )}
    </div>
  );
}
