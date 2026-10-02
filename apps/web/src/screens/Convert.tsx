import { useId, useMemo, useState } from 'react';
import { restoreConversion, voidConversion, setConversionOperationState, conversionOperationDependency, type ConversionOperationInput } from '@zichan/db';
import { D, isDateInRange, localToday, type Asset, type ChainWithSteps, type ConversionType } from '@zichan/core';
import { useSnapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { buildConvert, type ConvertChainVM } from '../selectors/convert.js';
import { money, signedMoney, amount as fmtAmount, num, significant } from '../format.js';
import { baseAsset, financialPostings } from '../db/derive.js';
import { btnGhost, btnOutline, btnPrimary, card, pillBtn } from '../ui/styles.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DialogShell } from '../ui/DialogShell.js';
import { AssetIcon } from '../ui/AssetIcon.js';
import { AddConversionModal } from './AddConversionModal.js';
import { CostBasisOpeningModal } from './CostBasisOpeningModal.js';
import { HoldingPriceModal } from './HoldingPriceModal.js';
import { assetConversionActions } from '../conversion-entry.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue, type TimelineViewMode } from '../ui/DateRangeBar.js';
import { TimelineExplorer } from '../ui/TimelineExplorer.js';
import { useUndo } from '../ui/UndoToast.js';
import {
  activeAssetByCode,
  ASSET_PRESETS,
  ASSET_PRESET_GROUPS,
  FEATURED_ASSET_PRESET_CODES,
  type AssetPreset,
  type AssetPresetCode,
} from '../assetPresets.js';

const TYPE_LABEL: Record<string, string> = {
  dca: '定投', buy: '买入', sell: '卖出', swap: '资产互换', exchange: '换汇', deposit: '入金', withdraw: '提现',
};
const TYPE_OPTS: [ConversionType, string][] = [
  ['dca', '定投'], ['buy', '买入'], ['sell', '卖出'], ['swap', '资产互换'], ['exchange', '换汇'], ['deposit', '入金'], ['withdraw', '提现'],
];

function badgeStyle(type: string) {
  const base = { padding: '5px 11px', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', flexShrink: 0 } as const;
  if (type === 'dca' || type === 'buy') return { ...base, background: 'var(--accent-soft)', color: 'var(--accent)' };
  if (type === 'sell') return { ...base, background: 'var(--ok-surface)', color: 'var(--positive)' };
  return { ...base, background: 'var(--surface-2)', color: 'var(--text-secondary)' };
}

export function Convert() {
  const snap = useSnapshot('convert');
  const { store, bump } = useStore();
  const undo = useUndo(store, bump);
  const [openGroup, setOpenGroup] = useState<Record<string, boolean>>({});
  const [openChain, setOpenChain] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ assetPresetCode?: AssetPresetCode; entry?: { type: ConversionType; fromAssetId?: string; toAssetId?: string } } | null>(null);
  const [editing, setEditing] = useState<ChainWithSteps | null>(null);
  const [editingOperation, setEditingOperation] = useState<ConversionOperationInput | null>(null);
  const [actionError, setActionError] = useState('');
  const [openingCost, setOpeningCost] = useState(false);
  const [pendingTrade, setPendingTrade] = useState<{ type: ConversionType; fromAssetId?: string; toAssetId?: string } | null>(null);
  const [priceAssetId, setPriceAssetId] = useState<string | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [view, setView] = useState<'overview' | TimelineViewMode>('overview');
  const [focusDate, setFocusDate] = useState(localToday);
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const [ctype, setCtype] = useState('');
  const [assetFilter, setAssetFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showHistoryFilters, setShowHistoryFilters] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [activityAssetId, setActivityAssetId] = useState<string | null>(null);
  const detailTitleId = useId();
  const [deletingChainId, setDeletingChainId] = useState<string | null>(null);
  const vm = useMemo(() => (snap ? buildConvert(snap) : null), [snap]);
  if (!snap || !vm) return null;
  const reportAsset = baseAsset(snap);
  const reportSymbol = reportAsset?.symbol ?? `${reportAsset?.code ?? ''} `;
  const activeFilterCount = Number(!!assetFilter) + Number(!!ctype) + Number(!!accountFilter)
    + Number(!!search.trim()) + Number(dateRange.preset !== 'all') + Number(showVoided);

  async function removeChain(id: string) {
    const child = await store.conversionChains.get(id);
    if (child?.operationId) {
      const operation = await store.conversionOperations.get(child.operationId);
      if (!operation) throw new Error('所属连续转换不存在');
      const saved = await setConversionOperationState(store, operation.id, operation.version, 'voided');
      const dependency = await conversionOperationDependency(store, saved.id);
      setDeletingChainId(null); setDetailId(null); bump();
      undo.offer('连续转换已整组作废', async () => { await setConversionOperationState(store, saved.id, saved.version, 'active', dependency); bump(); });
      return;
    }
    const saved = await voidConversion(store, id);
    setDeletingChainId(null);
    bump();
    undo.offer('资产转换已作废', async () => {
      const current = await store.conversionChains.get(saved.id);
      if (!current || current.version !== saved.version) throw new Error('该转换后来又被修改，不能直接恢复');
      await restoreConversion(store, saved.id);
      bump();
    });
  }

  async function restoreChain(id: string) {
    const child = await store.conversionChains.get(id);
    if (child?.operationId) {
      const operation = await store.conversionOperations.get(child.operationId);
      if (!operation) throw new Error('所属连续转换不存在');
      const saved = await setConversionOperationState(store, operation.id, operation.version, 'active');
      const dependency = await conversionOperationDependency(store, saved.id);
      bump();
      undo.offer('连续转换已整组恢复', async () => { await setConversionOperationState(store, saved.id, saved.version, 'voided', dependency); bump(); });
      return;
    }
    const saved = await restoreConversion(store, id);
    bump();
    undo.offer('资产转换已恢复', async () => {
      const current = await store.conversionChains.get(saved.id);
      if (!current || current.version !== saved.version) throw new Error('该转换后来又被修改，不能直接撤销恢复');
      await voidConversion(store, saved.id, '撤销刚才的恢复');
      bump();
    });
  }

  async function openEditor(id: string) {
    try {
      const row = await store.getChainWithSteps(id);
      if (!row) throw new Error('转换记录不存在');
      if (!row.chain.operationId) { setEditing(row); return; }
      const operation = await store.conversionOperations.get(row.chain.operationId);
      if (!operation) throw new Error('连续转换不存在');
      const conversions = await Promise.all(operation.chainIds.map(async (chainId) => {
        const aggregate = await store.getChainWithSteps(chainId);
        if (!aggregate) throw new Error('连续转换子记录不完整');
        return aggregate;
      }));
      setEditingOperation({ operation, conversions, links: operation.links ?? conversions.slice(1).map(() => ({ retainedQuantity: '0', supplementalQuantity: '0' })) });
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const firstGroup = vm.groups[0]?.assetId;
  const matchesTextAndAccount = (id: string) => {
    const row = snap.chains.find((item) => item.chain.id === id);
    if (!row) return false;
    const segments = row.chain.operationId ? snap.chains.filter((item) => item.chain.operationId === row.chain.operationId) : [row];
    const steps = segments.flatMap((item) => item.steps);
    const text = [...segments.flatMap((item) => [item.chain.title, item.chain.note]), ...steps.flatMap((step) => [step.note, step.platform])].join(' ').toLocaleLowerCase();
    return (!search.trim() || text.includes(search.trim().toLocaleLowerCase()))
      && (!accountFilter || steps.some((step) => [step.accountFromId, step.accountToId, ...(step.fees ?? []).map((fee) => fee.accountId)].includes(accountFilter)));
  };
  const filterChains = (chains: ConvertChainVM[]) =>
    chains.filter((c) => isDateInRange(c.chain.date, dateRange) && (!ctype || c.chain.type === ctype) && (!assetFilter || c.assetIds.includes(assetFilter)) && matchesTextAndAccount(c.chain.id));
  const timeline = vm.groups.flatMap((group) => filterChains(group.chains).map((chain) => ({ group, chain })));
  const allChains = vm.groups.flatMap((group) => group.chains);
  const detail = allChains.find((row) => row.chain.id === detailId);
  const activityAsset = snap.assets.find((asset) => asset.id === activityAssetId);
  const activityPostings = activityAssetId ? financialPostings(snap).filter((posting) => posting.assetId === activityAssetId) : [];
  const activityAccounts = [...new Set(activityPostings.map((posting) => posting.accountId ?? ''))];
  const activityFlow = (postings: typeof activityPostings) => {
    if (!activityAsset) return '';
    const incoming = postings.filter((posting) => D(posting.amount).gt(0)).reduce((total, posting) => total.plus(posting.amount), D(0));
    const outgoing = postings.filter((posting) => D(posting.amount).lt(0)).reduce((total, posting) => total.minus(posting.amount), D(0));
    return [incoming.gt(0) ? `流入 ${fmtAmount(incoming, activityAsset.decimals)} ${activityAsset.code}` : '',
      outgoing.gt(0) ? `流出 ${fmtAmount(outgoing, activityAsset.decimals)} ${activityAsset.code}` : ''].filter(Boolean).join(' · ') || '无账户余额变动';
  };
  const voidedChains = snap.chains
    .filter((row) => row.chain.recordState === 'voided')
    .filter((row) => !row.chain.operationId || row.chain.operationOrder === 0)
    .filter((row) => isDateInRange(row.chain.date, dateRange) && (!ctype || row.chain.type === ctype))
    .filter((row) => !assetFilter || row.steps.some((step) => step.fromAssetId === assetFilter || step.toAssetId === assetFilter || step.fees?.some((fee) => fee.assetId === assetFilter)))
    .filter((row) => matchesTextAndAccount(row.chain.id))
    .sort((a, b) => b.chain.date.localeCompare(a.chain.date) || (b.chain.time ?? '').localeCompare(a.chain.time ?? ''));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {actionError && <div role="alert">{actionError}</div>}
      <div className="zc-convert-toolbar">
        <div className="zc-convert-view-tabs" role="tablist" aria-label="资产转换视图">
          {(['overview', 'list', 'year', 'month', 'day'] as const).map((mode) => <button key={mode} role="tab" aria-selected={view === mode} onClick={() => setView(mode)} style={pillBtn(view === mode)}>{mode === 'overview' ? '持仓概览' : mode === 'list' ? '时间线' : mode === 'year' ? '年度' : mode === 'month' ? '月历' : '单日'}</button>)}
        </div>
        <div className="zc-convert-toolbar-actions">
          <button onClick={() => setOpeningCost(true)} style={btnOutline}>{snap.costState ? '核对成本起点' : '启用统一成本核算'}</button>
          <button onClick={() => setAdding({})} style={btnPrimary}>+ 新增转换</button>
        </div>
      </div>
      <div className="zc-convert-filter-toggle">
        <button type="button" aria-expanded={showHistoryFilters} aria-controls="zc-convert-history-filters" onClick={() => setShowHistoryFilters((value) => !value)} style={btnOutline}>
          历史筛选{activeFilterCount ? ` · ${activeFilterCount} 项已启用` : ''} <span aria-hidden="true">{showHistoryFilters ? '▴' : '▾'}</span>
        </button>
      </div>
      <div id="zc-convert-history-filters" className={`zc-convert-history-filters${showHistoryFilters ? ' is-open' : ''}`}>
        <div className="zc-convert-filter-row">
          <select aria-label="历史涉及资产" className="zc-select" value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}>
            <option value="">历史 · 全部资产</option>
            {snap.assets.filter((asset) => !asset.isDeleted).map((asset) => <option key={asset.id} value={asset.id}>{asset.code}</option>)}
          </select>
          <select aria-label="历史操作类型" className="zc-select" value={ctype} onChange={(e) => setCtype(e.target.value)}>
            <option value="">历史 · 全部操作</option>
            {TYPE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="历史涉及账户" className="zc-select" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
            <option value="">历史 · 全部账户</option>
            {snap.accounts.filter((account) => !account.isDeleted && account.kind !== 'other').map((account) => <option key={account.id} value={account.id}>{account.name}{account.isActive === false ? '（已归档）' : ''}</option>)}
          </select>
          <input aria-label="搜索转换" className="zc-input" placeholder="搜索标题、备注或平台" value={search} onChange={(event) => setSearch(event.target.value)} />
          <button onClick={() => setShowVoided((value) => !value)} style={showVoided ? pillBtn(true) : btnOutline} aria-pressed={showVoided}>作废记录 {snap.chains.filter((row) => row.chain.recordState === 'voided').length}</button>
        </div>
        <DateRangeBar value={dateRange} onChange={setDateRange} />
        <div className="zc-convert-filter-note">筛选仅作用于历史记录。当前余额包含期初、收支与转换；现值按最新行情折算为 {reportAsset?.code ?? '报表币种'}。</div>
      </div>

      {view === 'overview' && vm.groups.every((group) => !group.hasPosition && group.chains.length === 0) && (
        <ConvertEmptyState assets={snap.assets} onSelect={(assetPresetCode) => setAdding({ assetPresetCode })} />
      )}

      {showVoided && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>已作废转换</div>
          {voidedChains.map((row) => (
            <div key={row.chain.id} className="zc-voided-row" style={{ display: 'grid', gridTemplateColumns: '120px 100px minmax(0, 1fr) 90px', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>{row.chain.date}{row.chain.time ? ` ${row.chain.time}` : ''}</span>
              <span style={badgeStyle(row.chain.type)}>{TYPE_LABEL[row.chain.type] ?? row.chain.type}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.chain.title ?? row.steps.map((step) => `${snap.assets.find((asset) => asset.id === step.fromAssetId)?.code ?? '?'} → ${snap.assets.find((asset) => asset.id === step.toAssetId)?.code ?? '?'}`).join(' · ')}</span>
              <button onClick={() => void restoreChain(row.chain.id).catch((cause: unknown) => setActionError(String(cause)))} style={{ padding: '6px 10px', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontWeight: 'var(--fw-bold)', cursor: 'pointer' }}>{row.chain.operationId ? '整组恢复' : '恢复'}</button>
            </div>
          ))}
          {voidedChains.length === 0 && <div style={{ padding: 18, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>当前筛选范围没有已作废转换。</div>}
        </div>
      )}

      {view === 'overview' ? vm.groups.map((g) => {
        const open = openGroup[g.assetId] ?? g.assetId === firstGroup;
        const chains = filterChains(g.chains);
        const cardAsset = snap.assets.find((asset) => asset.id === g.assetId);
        const cardActions = assetConversionActions(cardAsset?.type ?? 'fiat', !!snap.costState);
        const costCurrency = snap.assets.find((asset) => asset.id === g.costCurrencyAssetId);
        const costSymbol = costCurrency?.symbol ?? `${costCurrency?.code ?? ''} `;
        const bookCurrency = snap.assets.find((asset) => asset.id === snap.costState?.baseCurrencyAssetId);
        const needsValue = g.hasPosition && g.value === null;
        const needsCost = g.hasPosition && !g.costBasisKnown;
        return (
          <div key={g.assetId} className="zc-convert-asset-card" style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <button
              onClick={() => setOpenGroup((s) => ({ ...s, [g.assetId]: !open }))}
              className="zc-convert-asset-header"
              aria-expanded={open}
            >
              <span className="zc-convert-asset-code"><AssetIcon code={g.assetCode} symbol={cardAsset?.symbol} size={30} />{g.assetCode}</span>
              {g.hasPosition && (
                <div className="zc-convert-position-metrics">
                  <div className="zc-convert-metric is-primary"><span>当前余额</span><strong className={D(g.holdings).lt(0) ? 'is-negative' : ''}>{fmtAmount(g.holdings, g.decimals)} {g.assetCode}</strong></div>
                  <div className="zc-convert-metric is-primary"><span>现值</span><strong>{g.value === null ? '—' : signedMoney(g.value, reportSymbol)}</strong></div>
                  <div className="zc-convert-metric"><span>持仓总成本</span><strong>{g.costTotal !== null ? money(g.costTotal, costSymbol) : g.knownPartialCost !== null ? `已知 ${money(g.knownPartialCost, bookCurrency?.symbol ?? `${bookCurrency?.code ?? ''} `)}` : '—'}</strong></div>
                  <div className="zc-convert-metric"><span>持仓均价</span><strong>{g.avgCost !== null ? `${costSymbol}${significant(g.avgCost)}` : '—'}</strong></div>
                  <div className="zc-convert-metric"><span>未实现盈亏</span><strong className={g.pnl !== null ? D(g.pnl).gte(0) ? 'is-positive' : 'is-negative' : ''}>
                    {g.pnl !== null ? <>{signedMoney(g.pnl, reportSymbol)}{g.pnlPct !== null && <> · {D(g.pnlPct).gte(0) ? '+' : '−'}{num(D(g.pnlPct).abs(), 1)}%</>}</> : '—'}
                  </strong></div>
                </div>
              )}
              {!g.hasPosition && <span className="zc-convert-empty-position">当前余额 0 · {g.chains.length ? '历史记录' : '可新增交易'}</span>}
              <span className="zc-convert-card-count">{chains.length}/{g.chains.length} 笔 <span aria-hidden="true">{open ? '▴' : '▾'}</span></span>
            </button>

            <div className="zc-convert-card-tools">
              <div className="zc-convert-trade-actions">
                {cardActions.map(({ type, label, source, requiresCostOpening }) => <button key={label} disabled={!cardAsset?.isActive} style={btnOutline} onClick={() => {
                  const entry = { type, ...(source ? { fromAssetId: g.assetId } : { toAssetId: g.assetId }) };
                  if (requiresCostOpening) { setPendingTrade(entry); setOpeningCost(true); }
                  else setAdding({ entry });
                }}>{label}</button>)}
              </div>
              <button style={btnGhost} onClick={() => setActivityAssetId(g.assetId)}>全部流水与账户分布</button>
            </div>
            {(needsValue || needsCost || g.missingCostRateAssetId || cardActions[0]?.requiresCostOpening) && <div className="zc-convert-card-status" role="status">
              <span>{[needsValue ? `缺少 ${g.assetCode} → ${reportAsset?.code ?? '报表币种'} 行情` : '', needsCost ? `成本：${g.costStatus}` : '', g.missingCostRateAssetId ? `缺少 ${bookCurrency?.code} → ${reportAsset?.code} 汇率` : '', cardActions[0]?.requiresCostOpening ? '首次买卖前需核对成本起点' : ''].filter(Boolean).join(' · ')}。现值行情不会自动补历史成本。</span>
              <div className="zc-convert-status-actions">
                {needsValue && cardAsset?.isActive !== false && <button style={btnOutline} onClick={() => setPriceAssetId(g.assetId)}>补充现值 / 价格</button>}
                {g.missingCostRateAssetId && snap.assets.find((asset) => asset.id === g.missingCostRateAssetId)?.isActive !== false && <button style={btnOutline} onClick={() => setPriceAssetId(g.missingCostRateAssetId)}>补充汇率</button>}
                {needsCost && <button style={btnOutline} onClick={() => setOpeningCost(true)}>核对成本</button>}
              </div>
            </div>}

            {open && (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                {chains.length === 0 && <div style={{ padding: '16px 22px', fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>该筛选下无记录</div>}
                {chains.map((c) => {
                  const co = openChain === c.chain.id;
                  return (
                    <div key={c.chain.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <button onClick={() => setOpenChain(co ? null : c.chain.id)} style={{ width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left', flexWrap: 'wrap' }}>
                        <span style={badgeStyle(c.chain.type)}>{TYPE_LABEL[c.chain.type] ?? c.chain.type}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 'var(--fw-bold)', overflowWrap: 'anywhere', marginBottom: 5 }}>{c.title}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {c.chips.map((chip, i) => (
                            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span className="zc-convert-path-chip"><AssetIcon code={chip} size={18} />{chip}</span>
                              {i < c.chips.length - 1 && <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>→</span>}
                            </span>
                          ))}
                          </div>
                        </div>
                        <div style={{ flex: 1 }} />
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{c.result}</div>
                          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 2 }}>{c.occurred}</div>
                        </div>
                        <div style={{ textAlign: 'right', minWidth: 92 }}>
                          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>{c.deltaLabel}</div>
                          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', marginTop: 2, color: c.deltaColor }}>{c.delta}</div>
                        </div>
                        <span style={{ fontSize: 'var(--fs-body)', color: 'var(--text-tertiary)', transition: 'transform .2s', transform: `rotate(${co ? 180 : 0}deg)` }}>▾</span>
                      </button>
                      {co && (
                        <div className="zc-convert-detail-grid" style={{ padding: '4px 22px 20px', background: 'var(--surface-2)', display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: 24 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', letterSpacing: 0 }}>换算步骤</div>
                            {c.steps.map((s) => (
                              <div key={s.n} style={{ ...card, padding: '14px 16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                  <span style={{ width: 22, height: 22, borderRadius: 'var(--r-round)', background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.n}</span>
                                  <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{s.from}</span>
                                  <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                                  <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{s.to}</span>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 9, paddingLeft: 32, overflowWrap: 'anywhere' }}>
                                  <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{s.accounts}</span>
                                  <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>汇率 · {s.rate}</span>
                                  {s.fee && <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--negative)', fontWeight: 'var(--fw-medium)' }}>{s.fee}</span>}
                                  <details style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}><summary style={{ cursor: 'pointer' }}>成交口径与完整汇率</summary>{s.details.map((detail) => <div key={detail}>{detail}</div>)}<div style={{ userSelect: 'text' }}>{s.fullRate}</div></details>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div style={{ ...card, padding: '16px 18px', alignSelf: 'start' }}>
                            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', letterSpacing: 0, marginBottom: 6 }}>收付与记账明细</div>
                            {c.calc.map((r, index) => (
                              <div key={`${r.l}-${index}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', overflowWrap: 'anywhere', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                                <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{r.l}</span>
                                <span style={{ fontSize: 'var(--fs-body)', fontWeight: r.strong ? 'var(--fw-bold)' : 'var(--fw-medium)', color: r.color ?? 'var(--fg)' }}>{r.v}</span>
                              </div>
                            ))}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                              <button onClick={() => void openEditor(c.chain.id)} style={{ padding: '6px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontWeight: 'var(--fw-medium)', fontSize: 'var(--fs-caption)', cursor: 'pointer', marginRight: 8 }}>{c.chain.operationId ? '整组编辑' : '编辑'}</button>
                              <button onClick={() => setDeletingChainId(c.chain.id)} style={{ padding: '6px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--negative)', background: 'transparent', color: 'var(--negative)', fontWeight: 'var(--fw-medium)', fontSize: 'var(--fs-caption)', cursor: 'pointer' }}>作废</button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      }) : (
        <TimelineExplorer
          items={timeline}
          view={view}
          focusDate={focusDate}
          onFocusDate={setFocusDate}
          onViewChange={setView}
          dateOf={(row) => row.chain.chain.date}
          timeOf={(row) => row.chain.chain.time ?? ''}
          keyOf={(row) => row.chain.chain.id}
          renderCompact={(row) => <>{row.chain.chain.date.slice(8)} · <b>{TYPE_LABEL[row.chain.chain.type]}</b> · {row.chain.title} · {row.chain.result}</>}
          renderEntry={(row) => <div className="zc-convert-timeline-entry" style={{ display: 'grid', gridTemplateColumns: '100px 92px minmax(0, 1fr) minmax(120px, auto) minmax(120px, auto)', gap: 12, alignItems: 'center' }}>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' }}>{row.chain.occurred}</span>
            <span style={badgeStyle(row.chain.chain.type)}>{TYPE_LABEL[row.chain.chain.type]}</span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><small className="zc-convert-path">{row.chain.chips.map((chip, index) => <span key={`${chip}-${index}`}><AssetIcon code={chip} size={18} />{chip}{index < row.chain.chips.length - 1 && <span aria-hidden="true">→</span>}</span>)}</small><b>{row.chain.title}</b></span>
            <b style={{ overflowWrap: 'anywhere' }}>{row.chain.result}</b>
            <span style={{ textAlign: 'right', overflowWrap: 'anywhere' }}><small style={{ display: 'block', color: 'var(--text-tertiary)' }}>{row.chain.deltaLabel}</small><b style={{ color: row.chain.deltaColor }}>{row.chain.delta}</b></span>
          </div>}
          renderSummary={(rows) => {
            const buys = rows.filter((row) => row.chain.chain.type === 'buy' || row.chain.chain.type === 'dca').length;
            const sells = rows.filter((row) => row.chain.chain.type === 'sell').length;
            return <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>买入 {buys} · 卖出 {sells}</span>;
          }}
          onOpen={(row) => setDetailId(row.chain.chain.id)}
          emptyText="该时间范围内没有资产转换记录。"
        />
      )}

      {detail && <DialogShell labelledBy={detailTitleId} onDismiss={() => setDetailId(null)} backdropClassName="zc-backdrop zc-conversion-backdrop" panelClassName="zc-conversion-detail">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><h2 id={detailTitleId} style={{ flex: 1 }}>{detail.title}</h2><button aria-label="关闭详情" style={pillBtn(false)} onClick={() => setDetailId(null)}>关闭</button></div>
        <p>{detail.occurred} · {TYPE_LABEL[detail.chain.type]}</p>
        {detail.steps.map((step) => <section key={step.n} style={{ borderBottom: '1px solid var(--border)', padding: '12px 0' }}><b>{step.from} → {step.to}</b><p>{step.rate}</p><p>{step.accounts}</p>{step.fee && <p>{step.fee}</p>}{step.details.map((text, index) => <p key={index}>{text}</p>)}<details><summary>完整汇率</summary>{step.fullRate}</details></section>)}
        <dl className="zc-conversion-fact-list">{detail.calc.map((row, index) => <div key={index}><dt>{row.l}</dt><dd>{row.v}</dd></div>)}</dl>
        <button style={pillBtn(false)} onClick={() => void openEditor(detail.chain.id)}>{detail.chain.operationId ? '整组编辑' : '编辑'}</button>
        <button style={pillBtn(false)} onClick={() => setDeletingChainId(detail.chain.id)}>作废</button>
      </DialogShell>}
      {activityAsset && <DialogShell labelledBy={detailTitleId} onDismiss={() => setActivityAssetId(null)} backdropClassName="zc-backdrop zc-conversion-backdrop" panelClassName="zc-conversion-detail">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><h2 id={detailTitleId} style={{ flex: 1 }}>{activityAsset.code} · 流水与账户</h2><button aria-label="关闭资产流水" style={pillBtn(false)} onClick={() => setActivityAssetId(null)}>关闭</button></div>
        <h3>账户分布</h3>
        {activityAccounts.map((id) => <p key={id}>{snap.accounts.find((account) => account.id === id)?.name ?? '未分配账户'} · {fmtAmount(activityPostings.filter((posting) => (posting.accountId ?? '') === id).reduce((total, posting) => total.plus(posting.amount), D(0)), activityAsset.decimals)} {activityAsset.code}</p>)}
        {activityAccounts.length === 0 && <p>暂无账户余额</p>}
        <h3>涉及该资产的全部转换</h3>
        {allChains.filter((chain) => chain.assetIds.includes(activityAsset.id)).map((chain) => {
          const stepIds = new Set(snap.chains.filter((row) => row.chain.id === chain.chain.id || (chain.chain.operationId && row.chain.operationId === chain.chain.operationId)).flatMap((row) => row.steps.map((step) => step.id)));
          const flow = activityFlow(activityPostings.filter((posting) => posting.source.kind === 'conversion_step' && stepIds.has(posting.source.id)));
          return <button key={chain.chain.id} style={{ ...pillBtn(false), display: 'block', width: '100%', textAlign: 'left', marginBottom: 8 }} onClick={() => { setActivityAssetId(null); setDetailId(chain.chain.id); }}>{chain.occurred} · {chain.title}<br />{flow}</button>;
        })}
        <h3>日常收支与转账</h3>
        {snap.transactions.filter((row) => !row.isDeleted && row.recordState !== 'voided' && (row.assetId === activityAsset.id || row.transferAssetId === activityAsset.id)).map((row) => <p key={row.id}>{row.date} · {{ income: '收入', expense: '支出', transfer: '转账', refund: '退款', adjustment: '余额调整' }[row.type]} · {activityFlow(activityPostings.filter((posting) => posting.source.kind === 'transaction' && posting.source.id === row.id))}{row.note ? ` · ${row.note}` : ''}</p>)}
      </DialogShell>}
      {adding && <AddConversionModal assetPresetCode={adding.assetPresetCode} entry={adding.entry} onClose={() => setAdding(null)} />}
      {editing && <AddConversionModal initial={editing} onClose={() => setEditing(null)} />}
      {editingOperation && <AddConversionModal initialOperation={editingOperation} onClose={() => setEditingOperation(null)} />}
      {openingCost && <CostBasisOpeningModal onClose={() => { setOpeningCost(false); setPendingTrade(null); }}
        onConfirmed={() => { if (pendingTrade) setAdding({ entry: pendingTrade }); setPendingTrade(null); }} />}
      {priceAssetId && reportAsset && <HoldingPriceModal asset={snap.assets.find((asset) => asset.id === priceAssetId)!} quoteAsset={reportAsset}
        holdings={vm.groups.find((group) => group.assetId === priceAssetId)?.holdings ?? '0'} onSave={() => { bump(); setPriceAssetId(null); }} onClose={() => setPriceAssetId(null)} />}
      {deletingChainId && (
        <ConfirmDialog
          title="作废资产转换"
          confirmLabel="作废"
          cancelLabel="取消"
          tone="danger"
          onCancel={() => setDeletingChainId(null)}
          onConfirm={() => removeChain(deletingChainId)}
        >
          {snap.chains.find((row) => row.chain.id === deletingChainId)?.chain.operationId ? '这笔记录属于连续转换，将整组作废。' : ''}作废会重算后续持仓、成本和已实现盈亏；记录仍保留在操作历史中，并可恢复。
        </ConfirmDialog>
      )}
    </div>
  );
}

function ConvertEmptyState({
  assets,
  onSelect,
}: {
  assets: readonly Asset[];
  onSelect: (code: AssetPresetCode) => void;
}) {
  const active = assets.filter((asset) => !asset.isDeleted && asset.isActive && !asset.mergedIntoId);
  const onlyCny = active.length === 1 && active[0]?.code.trim().toUpperCase() === 'CNY';
  const presetCard = (preset: AssetPreset) => {
    const existing = activeAssetByCode(active, preset.code);
    return <button key={preset.code} type="button" onClick={() => onSelect(preset.code)} className="zc-asset-preset-button">
      <AssetIcon code={preset.code} symbol={preset.symbol} size={30} />
      <span><strong>{preset.code} · {preset.name}</strong><small>{existing ? '已有定义 · 直接填写' : '选择时添加资产定义'}</small></span>
    </button>;
  };
  return (
    <section style={{ ...card, padding: 22 }}>
      <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{onlyCny ? '当前只有人民币' : '还没有资产转换记录'}</div>
      <div style={{ marginTop: 7, color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', lineHeight: 1.7 }}>
        选一个常用目标资产开始填写真实转换。系统只会在需要时补充资产定义，不会伪造余额、持仓或交易。
      </div>
      <div className="zc-asset-preset-grid" style={{ marginTop: 16 }}>
        {ASSET_PRESETS.filter((preset) => FEATURED_ASSET_PRESET_CODES.includes(preset.code)).map(presetCard)}
      </div>
      <details className="zc-asset-preset-more">
        <summary>更多常用资产</summary>
        {ASSET_PRESET_GROUPS.map((group) => {
          const rows = ASSET_PRESETS.filter((preset) => group.codes.includes(preset.code) && !FEATURED_ASSET_PRESET_CODES.includes(preset.code));
          return rows.length ? <div key={group.label}>
            <div className="zc-asset-preset-group-title">{group.label}</div>
            <div className="zc-asset-preset-grid">{rows.map(presetCard)}</div>
          </div> : null;
        })}
      </details>
    </section>
  );
}
