import { accountSessionStorage } from '../account-storage.js';
import { useEffect, useMemo, useState } from 'react';
import { useDashboardTransactionReadModel } from '../db/dashboard-read-model.js';
import { useSnapshot } from '../db/snapshot.js';
import { buildDashboard } from '../selectors/dashboard.js';
import { money, signedMoney, pct } from '../format.js';
import { card, cardTight, amountColor } from '../ui/styles.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue } from '../ui/DateRangeBar.js';
import { AddConversionModal } from './AddConversionModal.js';
import { listSavedBackups, type SavedBackup } from '../db/backups.js';
import { readSafetyState, type SafetyState } from '../db/safety.js';
import { loadSyncConnections, SYNC_CONFIG_CHANGED_EVENT, type SyncConnection } from '../sync-config.js';
import { SYNC_LIFECYCLE_RESULT_EVENT, type LifecycleSyncResult } from '../background-sync.js';
import { buildTaskCenter, type TaskCenterItem } from '../selectors/task-center.js';

function fmtDate(d: string) {
  return d.slice(5); // MM-DD
}

export function Dashboard() {
  const snap = useSnapshot('dashboard');
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('this_month'));
  const [dcaPlanToRecord, setDcaPlanToRecord] = useState<string | null>(null);
  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []);
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
        <div className="zc-hero-card" style={{ ...card, padding: 'clamp(16px, 4vw, 28px)' }}>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', fontWeight: 700 }}>{partial('netWorth') ? '已估值净资产' : '净资产总值'} · 折算 {vm.reportCurrencyCode}</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: '2px 14px', marginTop: 8, minWidth: 0 }}>
            <div className="zc-hero-amount" style={{ fontSize: 'clamp(26px, 8.5vw, 46px)', fontWeight: 800, letterSpacing: 0, lineHeight: 1.05, minWidth: 0, overflowWrap: 'anywhere' }}>
              {money(vm.netWorth)}
            </div>
            <div className="zc-hero-asof" style={{ color: 'var(--fg-subtle)', fontWeight: 600, fontSize: 13, paddingBottom: 5 }}>
              截至 {vm.asOf}
            </div>
          </div>
          <div style={{ marginTop: 28, paddingTop: 18, borderTop: '1px solid var(--border)', color: 'var(--fg-muted)', fontSize: 13 }}>
            汇总金融账户、加密持仓与物品资产现状残值；模块原币仅在存在价格标记时参与折算。
          </div>
        </div>
        <div className="zc-hero-snapshot" style={{ ...card, padding: 'clamp(14px, 3.4vw, 24px)', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontWeight: 700, letterSpacing: 0, marginBottom: 6 }}>资产快照</div>
          {[
            ['所选期间投入', partialText('investedFiat', money(vm.investedFiat)), 'var(--fg)'],
            ['未实现盈亏', partialText('unrealized', signedMoney(vm.unrealized)), vm.unrealized.isNegative() ? 'var(--negative)' : 'var(--positive)'],
            ['持仓资产类别', `${vm.alloc.length} 类`, 'var(--fg)'],
            ['物品资产每日成本', partialText('fixedPerDay', money(vm.fixedPerDay)), 'var(--fg)'],
            ['报表基准日', vm.asOf, 'var(--fg)'],
          ].map(([l, v, color]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 13, color: 'var(--fg-muted)', fontWeight: 500 }}>{l}</span>
              <span style={{ fontSize: 14, fontWeight: 800, color, textAlign: 'right' }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="zc-dashboard-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 16 }}>
        {[
          ['期间法币投入', partialText('investedFiat', money(vm.investedFiat)), '买入与定投链路', 'var(--fg)'],
          ['未实现盈亏', partialText('unrealized', signedMoney(vm.unrealized)), '加密资产持仓', vm.unrealized.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['期间已实现盈亏', partialText('realizedCrypto', signedMoney(vm.realizedCrypto)), '所选日期内卖出链路', vm.realizedCrypto.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['期间游戏净收益', partialText('seasonNet', signedMoney(vm.seasonNet)), '所选日期内游戏记录', vm.seasonNet.isNegative() ? 'var(--negative)' : 'var(--positive)'],
          ['期间日常收支', partialText('transactions', signedMoney(vm.txNet)), `收入 ${money(vm.txIncome)} · 支出 ${money(vm.txExpense)}${partial('transactions') ? ' · 均为已知部分' : ''}`, vm.txNet.isNegative() ? 'var(--negative)' : 'var(--positive)'],
        ].map(([label, value, subv, color]) => (
          <div key={label} style={cardTight}>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 600 }}>{label}</div>
            <div style={{ fontSize: 'clamp(16px, 5.4vw, 26px)', fontWeight: 800, marginTop: 10, letterSpacing: 0, overflowWrap: 'anywhere', color }}>{value}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 5, fontWeight: 500 }}>{subv}</div>
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>任务中心</div>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontWeight: 600 }}>
            账单 · 定投 · 耗材 · 备份 · 同步
          </div>
        </div>
        {tasks.length === 0 ? (
          <div style={{ color: 'var(--positive)', fontSize: 13, fontWeight: 750 }}>当前没有需要处理的任务</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tasks.map((task) => {
              const color = task.severity === 'danger' ? 'var(--negative)' : task.severity === 'warning' ? 'var(--warning)' : 'var(--accent)';
              return (
                <div key={task.id} className="zc-task-row" style={{ display: 'grid', gridTemplateColumns: '10px minmax(0, 1fr) auto', gap: 10, alignItems: 'center', border: '1px solid var(--border)', background: 'var(--surface-2)', padding: '10px 12px' }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: 99, background: color }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 850 }}>{task.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 3, overflowWrap: 'anywhere' }}>{task.detail}</div>
                  </div>
                  <button type="button" onClick={() => openTask(task)} style={{ border: '1px solid var(--border)', background: 'var(--surface)', color, padding: '6px 10px', fontSize: 12, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>{task.actionLabel}</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
                  {ev.amt === undefined ? '未折算' : signedMoney(ev.amt)}
                </div>
              </div>
            ))}
          </div>
        </div>
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
