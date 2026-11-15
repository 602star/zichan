import { D, localToday } from '@zichan/core';
import { ledgerToday } from '../as-of.js';
import { useEffect, useMemo, useState } from 'react';
import { useDashboardTransactionReadModel } from '../db/dashboard-read-model.js';
import { useSnapshot } from '../db/snapshot.js';
import { baseAsset } from '../db/derive.js';
import { buildDashboard } from '../selectors/dashboard.js';
import { buildDashboardAgenda } from '../selectors/dashboard-agenda.js';
import { money, signedMoney, pct, num } from '../format.js';
import { amountColor } from '../ui/styles.js';
import { Card, CardAlert, CardEmpty, CardGroup, CardMetric } from '../ui/Card.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue } from '../ui/DateRangeBar.js';
import { AddConversionModal } from './AddConversionModal.js';
import { listSavedBackups, type SavedBackup } from '../db/backups.js';
import { readSafetyState, type SafetyState } from '../db/safety.js';
import { loadSyncConnections, SYNC_CONFIG_CHANGED_EVENT, type SyncConnection } from '../sync-config.js';
import { SYNC_LIFECYCLE_RESULT_EVENT, type LifecycleSyncResult } from '../background-sync.js';
import { buildTaskCenter, type TaskCenterItem } from '../selectors/task-center.js';
import { LedgerCutoffNotice } from '../ui/LedgerCutoffNotice.js';
import { useCompactView } from '../ui/useCompactView.js';
import { navigateTo } from '../screen-target.js';
import { useMobileHomeFocus } from '../mobile-preferences.js';
import { DashboardAgenda } from '../ui/DashboardAgenda.js';
import { DashboardRecent } from '../ui/DashboardRecent.js';

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
  const [now, setNow] = useState(() => new Date());
  const today = useMemo(() => (snap ? ledgerToday(snap, now) : localToday()), [snap, now]);
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
  const agenda = useMemo(() => snap ? buildDashboardAgenda(snap, today) : [], [snap, today]);

  useEffect(() => {
    const refreshDay = () => setNow(new Date());
    const timer = window.setInterval(refreshDay, 60_000);
    window.addEventListener('focus', refreshDay);
    document.addEventListener('visibilitychange', refreshDay);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshDay);
      document.removeEventListener('visibilitychange', refreshDay);
    };
  }, []);

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
    if (task.action === 'open_bills') navigateTo({ screen: 'transactions', tab: 'bills' });
    else if (task.action === 'open_fixed') navigateTo({ screen: 'fixed' });
    else navigateTo({ screen: 'settings', tab: task.action === 'open_settings' ? 'device' : 'server' });
  }
  if (!vm) return <p role="status">正在读取总览…</p>;
  const partial = (metric: string) => vm.incompleteMetrics.includes(metric);
  const partialText = (metric: string, value: string) => partial(metric) ? `${value}（已知部分）` : value;
  const spendingFirst = compactView && homeFocus === 'spending';
  const reportDecimals = snap ? baseAsset(snap)?.decimals ?? 2 : 2;
  const otherTasks = tasks.filter((task) => task.kind !== 'scheduled');
  const hasNegativeAllocation = vm.alloc.some((item) => D(item.value).isNegative());
  const showAllocationRatios = !partial('netWorth') && !hasNegativeAllocation;
  const agendaCard = snap && <DashboardAgenda key="agenda" items={agenda} assets={snap.assets} today={today} compact={compactView} />;
  const recentCard = snap && <DashboardRecent key="recent" rows={transactionReadModel?.recentTransactions ?? []} assets={snap.assets} accounts={snap.accounts} compact={compactView} />;

  return (
    <div className="zc-desktop-workbench" style={compactView ? { display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' } : undefined}>
      <DateRangeBar value={dateRange} onChange={setDateRange} />
      {snap && <LedgerCutoffNotice snap={snap} />}
      {vm.missingRateAssetCodes.length > 0 && (
        <CardAlert>
          缺少 {vm.missingRateAssetCodes.join('、')} → {vm.reportCurrencyCode} 的价格标记；下方相关指标明确显示为"已知部分"，不会把缺价资产按 0 计算。请在"数据管理 → 价格标记"补录。
        </CardAlert>
      )}
      <Card className="zc-dashboard-overview" title="账本概况" note={`账本日 ${vm.asOf} · 折算 ${vm.reportCurrencyCode}`}
        action={compactView ? undefined : <button type="button" className="zc-btn zc-btn--sm" onClick={() => navigateTo({ screen: 'reports' })}>查看报表</button>}>
        <div className="zc-dashboard-overview-band">
          <CardMetric className="zc-dashboard-primary" label={spendingFirst ? '所选期间支出' : partial('netWorth') ? '已估值净资产' : '净资产总值'}
            value={<span className="zc-hero-amount">{num(spendingFirst ? vm.txExpense : vm.netWorth, reportDecimals)}</span>}
            note={<span className="zc-hero-asof">{spendingFirst ? partial('transactions') ? '缺价，显示已知部分' : '所选期间的日常支出' : '按账本日估值'}</span>}
            tone={spendingFirst ? 'negative' : 'default'} />
          <CardMetric label="期间收入" value={partialText('transactions', money(vm.txIncome))} tone="positive" note="转账不计入收入" />
          {spendingFirst ? <CardMetric label={partial('netWorth') ? '已估值净资产' : '净资产总值'} value={num(vm.netWorth, reportDecimals)} note={`截至 ${vm.asOf}`} />
            : <CardMetric label="期间支出" value={partialText('transactions', money(vm.txExpense))} tone="negative" note="按所选统计期间汇总" />}
          <CardMetric label="期间结余" value={partialText('transactions', signedMoney(vm.txNet, undefined, reportDecimals))} tone={vm.txNet.isNegative() ? 'negative' : 'positive'} note="收入减去支出" />
        </div>
      </Card>

      {spendingFirst ? <>{recentCard}{agendaCard}</> : <>{agendaCard}{recentCard}</>}

      {compactView && <button type="button" className="zc-dashboard-more-metrics-toggle zc-btn" aria-expanded={showAllMetrics} onClick={() => setShowAllMetrics((open) => !open)}>{showAllMetrics ? '收起完整指标' : '查看完整指标'}</button>}

      {(!compactView || showAllMetrics) && <Card title="投资与使用" className="zc-dashboard-investment" note="投入、收益和使用成本各自列示">
      <div className="zc-card-band is-inset zc-dashboard-kpi-grid">
        {[
          ['期间法币投入', partialText('investedFiat', money(vm.investedFiat)), '买入与定投链路', 'var(--fg)'],
          ['未实现盈亏', partialText('unrealized', signedMoney(vm.unrealized)), '加密资产持仓', vm.unrealized.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['期间已实现盈亏', partialText('realizedCrypto', signedMoney(vm.realizedCrypto)), '所选日期内卖出链路', vm.realizedCrypto.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['期间游戏净收益', partialText('seasonNet', signedMoney(vm.seasonNet)), '所选日期内游戏记录', vm.seasonNet.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['物品每日成本', partialText('fixedPerDay', money(vm.fixedPerDay)), '按物品使用与生命周期计算', 'var(--fg)'],
        ].map(([label, value, subv, color]) => (
          <CardMetric key={label} label={label} value={value} note={subv} tone={color === 'var(--negative)' ? 'negative' : color === 'var(--positive)' ? 'positive' : 'default'} />
        ))}
      </div>
      </Card>}

      {otherTasks.length > 0 && (
        <Card className="zc-dashboard-tasks" title="其他待办" note="定投 · 耗材 · 备份 · 同步">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              {otherTasks.map((task) => {
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
        </Card>
      )}

      <div className="zc-dashboard-detail-grid">
        <Card title="资产配置" note={partial('netWorth') ? '缺少汇率，暂不计算占比' : hasNegativeAllocation ? '含负余额，仅展示净额' : '按当前折算价值'}>
          {vm.alloc.length === 0 && <CardEmpty>目前没有可展示的资产配置，录入账户、持仓或物品后会显示在这里。</CardEmpty>}
          <div>
            {vm.alloc.map((a) => (
              <CardGroup key={a.name}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-1)' }}>
                  <div className="zc-dashboard-allocation-name" style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
                    <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{a.name}</span>
                    <span className="zc-dashboard-allocation-note" style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>{a.note}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
                    <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', ...amountColor(a.value) }}>{num(a.value, reportDecimals)} {vm.reportCurrencyCode}</span>
                    <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)', width: 44, textAlign: 'right' }}>{showAllocationRatios ? pct(a.weight) : '—'}</span>
                  </div>
                </div>
                {showAllocationRatios && <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 'var(--r-pill)', overflow: 'hidden' }}>
                  <div style={{ height: 8, borderRadius: 'var(--r-pill)', background: 'var(--accent)', width: `${(a.weight * 100).toFixed(2)}%` }} />
                </div>}
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
