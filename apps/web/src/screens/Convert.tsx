import { useMemo, useState } from 'react';
import { restoreConversion, voidConversion } from '@zichan/db';
import { isDateInRange, localToday, type Asset, type ChainWithSteps, type ConversionType } from '@zichan/core';
import { useSnapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { buildConvert, type ConvertChainVM } from '../selectors/convert.js';
import { money, signedMoney, amount as fmtAmount, num } from '../format.js';
import { card, pillBtn } from '../ui/styles.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { AddConversionModal } from './AddConversionModal.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue, type TimelineViewMode } from '../ui/DateRangeBar.js';
import { TimelineExplorer } from '../ui/TimelineExplorer.js';
import { useUndo } from '../ui/UndoToast.js';
import {
  activeAssetByCode,
  ASSET_PRESETS,
  type AssetPresetCode,
} from '../assetPresets.js';

const TYPE_LABEL: Record<string, string> = {
  dca: '定投', buy: '买入', sell: '卖出', exchange: '换汇', deposit: '入金', withdraw: '提现',
};
const TYPE_OPTS: [ConversionType, string][] = [
  ['dca', '定投'], ['buy', '买入'], ['sell', '卖出'], ['exchange', '换汇'], ['deposit', '入金'], ['withdraw', '提现'],
];

function badgeStyle(type: string) {
  const base = { padding: '5px 11px', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', flexShrink: 0 } as const;
  if (type === 'dca' || type === 'buy') return { ...base, background: 'var(--accent-soft)', color: 'var(--accent)' };
  if (type === 'sell') return { ...base, background: 'rgba(63,143,107,.14)', color: 'var(--positive)' };
  return { ...base, background: 'var(--surface-2)', color: 'var(--text-secondary)' };
}

export function Convert() {
  const snap = useSnapshot('convert');
  const { store, bump } = useStore();
  const undo = useUndo(store, bump);
  const [openGroup, setOpenGroup] = useState<Record<string, boolean>>({});
  const [openChain, setOpenChain] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ assetPresetCode?: AssetPresetCode } | null>(null);
  const [editing, setEditing] = useState<ChainWithSteps | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [view, setView] = useState<'overview' | TimelineViewMode>('overview');
  const [focusDate, setFocusDate] = useState(localToday);
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const [ctype, setCtype] = useState('');
  const [deletingChainId, setDeletingChainId] = useState<string | null>(null);
  const vm = useMemo(() => (snap ? buildConvert(snap) : null), [snap]);
  if (!snap || !vm) return null;

  async function removeChain(id: string) {
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
    const saved = await restoreConversion(store, id);
    bump();
    undo.offer('资产转换已恢复', async () => {
      const current = await store.conversionChains.get(saved.id);
      if (!current || current.version !== saved.version) throw new Error('该转换后来又被修改，不能直接撤销恢复');
      await voidConversion(store, saved.id, '撤销刚才的恢复');
      bump();
    });
  }

  const firstGroup = vm.groups[0]?.assetId;
  const filterChains = (chains: ConvertChainVM[]) =>
    chains.filter((c) => isDateInRange(c.chain.date, dateRange) && (!ctype || c.chain.type === ctype));
  const timeline = vm.groups.flatMap((group) => filterChains(group.chains).map((chain) => ({ group, chain })));
  const voidedChains = snap.chains
    .filter((row) => row.chain.recordState === 'voided')
    .filter((row) => isDateInRange(row.chain.date, dateRange) && (!ctype || row.chain.type === ctype))
    .sort((a, b) => b.chain.date.localeCompare(a.chain.date) || (b.chain.time ?? '').localeCompare(a.chain.time ?? ''));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {(['overview', 'list', 'year', 'month', 'day'] as const).map((mode) => <button key={mode} onClick={() => setView(mode)} style={pillBtn(view === mode)}>{mode === 'overview' ? '持仓概览' : mode === 'list' ? '时间线' : mode === 'year' ? '年度' : mode === 'month' ? '月历' : '单日'}</button>)}
        <div style={{ flex: 1 }} />
        <select className="zc-select" value={ctype} onChange={(e) => setCtype(e.target.value)} style={{ width: 130 }}>
          <option value="">历史 · 全部操作</option>
          {TYPE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button onClick={() => setShowVoided((value) => !value)} style={pillBtn(showVoided)}>作废记录 {snap.chains.filter((row) => row.chain.recordState === 'voided').length}</button>
        <button onClick={() => setAdding({})} style={{ padding: '10px 16px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-body)', cursor: 'pointer' }}>+ 新增转换</button>
      </div>
      <DateRangeBar value={dateRange} onChange={setDateRange} />

      {view === 'overview' && vm.groups.length === 0 && (
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
              <button onClick={() => void restoreChain(row.chain.id)} style={{ padding: '6px 10px', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontWeight: 'var(--fw-bold)', cursor: 'pointer' }}>恢复</button>
            </div>
          ))}
          {voidedChains.length === 0 && <div style={{ padding: 18, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>当前筛选范围没有已作废转换。</div>}
        </div>
      )}

      {view === 'overview' ? vm.groups.map((g) => {
        const open = openGroup[g.assetId] ?? g.assetId === firstGroup;
        const chains = filterChains(g.chains);
        return (
          <div key={g.assetId} style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <button
              onClick={() => setOpenGroup((s) => ({ ...s, [g.assetId]: !open }))}
              style={{ width: '100%', border: 'none', background: g.hasPosition ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', padding: '16px 22px', display: 'flex', alignItems: 'center', gap: 20, textAlign: 'left', flexWrap: 'wrap' }}
            >
              <span style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)', minWidth: 56 }}>{g.assetCode}</span>
              {g.hasPosition && (
                <>
                  <div><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>持仓</div><div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{fmtAmount(g.holdings, 6)}</div></div>
                  <div><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>现值</div><div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{money(g.value)}</div></div>
                  <div><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>持仓均价</div><div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{g.costBasisKnown ? money(g.avgCost) : '缺少成本汇率'}</div></div>
                  <div>
                    <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>未实现盈亏</div>
                    <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', color: g.costBasisKnown ? (g.pnl >= 0 ? 'var(--positive)' : 'var(--negative)') : 'var(--fg-subtle)' }}>
                      {g.costBasisKnown ? <>{signedMoney(g.pnl)} · {g.pnl >= 0 ? '+' : '−'}{num(Math.abs(g.pnlPct), 1)}%</> : '请补记成本币种汇率'}
                    </div>
                  </div>
                </>
              )}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 'var(--fs-body)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-bold)' }}>{chains.length}/{g.chains.length} 笔</span>
              <span style={{ fontSize: 'var(--fs-body)', color: 'var(--text-tertiary)', transition: 'transform .2s', transform: `rotate(${open ? 180 : 0}deg)` }}>▾</span>
            </button>

            {open && (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                {chains.length === 0 && <div style={{ padding: '16px 22px', fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>该筛选下无记录</div>}
                {chains.map((c) => {
                  const co = openChain === c.chain.id;
                  return (
                    <div key={c.chain.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <button onClick={() => setOpenChain(co ? null : c.chain.id)} style={{ width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left' }}>
                        <span style={badgeStyle(c.chain.type)}>{TYPE_LABEL[c.chain.type] ?? c.chain.type}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {c.chips.map((chip, i) => (
                            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '3px 9px', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)' }}>{chip}</span>
                              {i < c.chips.length - 1 && <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>→</span>}
                            </span>
                          ))}
                        </div>
                        <div style={{ flex: 1 }} />
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{c.result}</div>
                          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 2 }}>{c.chain.date}</div>
                        </div>
                        <div style={{ textAlign: 'right', minWidth: 92 }}>
                          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>{c.deltaLabel}</div>
                          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', marginTop: 2, color: c.deltaColor }}>{c.delta}</div>
                        </div>
                        <span style={{ fontSize: 'var(--fs-body)', color: 'var(--text-tertiary)', transition: 'transform .2s', transform: `rotate(${co ? 180 : 0}deg)` }}>▾</span>
                      </button>
                      {co && (
                        <div className="zc-convert-detail-grid" style={{ padding: '4px 22px 20px', background: 'var(--surface-2)', display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 24 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', letterSpacing: 0 }}>换算步骤</div>
                            {c.steps.map((s) => (
                              <div key={s.n} style={{ ...card, padding: '14px 16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ width: 22, height: 22, borderRadius: 'var(--r-round)', background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.n}</span>
                                  <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{s.from}</span>
                                  <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                                  <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{s.to}</span>
                                </div>
                                <div style={{ display: 'flex', gap: 18, marginTop: 9, paddingLeft: 32 }}>
                                  <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>汇率 · {s.rate}</span>
                                  {s.fee && <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--negative)', fontWeight: 'var(--fw-medium)' }}>{s.fee}</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                          <div style={{ ...card, padding: '16px 18px', alignSelf: 'start' }}>
                            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', letterSpacing: 0, marginBottom: 6 }}>成本追溯</div>
                            {c.calc.map((r) => (
                              <div key={r.l} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                                <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{r.l}</span>
                                <span style={{ fontSize: 'var(--fs-body)', fontWeight: r.strong ? 'var(--fw-bold)' : 'var(--fw-medium)', color: r.color ?? 'var(--fg)' }}>{r.v}</span>
                              </div>
                            ))}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                              <button onClick={() => setEditing(snap.chains.find((row) => row.chain.id === c.chain.id) ?? null)} style={{ padding: '6px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontWeight: 'var(--fw-medium)', fontSize: 'var(--fs-caption)', cursor: 'pointer', marginRight: 8 }}>编辑</button>
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
          keyOf={(row) => row.chain.chain.id}
          renderCompact={(row) => <>{row.chain.chain.date.slice(8)} · <b>{TYPE_LABEL[row.chain.chain.type]}</b> · {row.group.assetCode} · {row.chain.result}</>}
          renderEntry={(row) => <div className="zc-convert-timeline-entry" style={{ display: 'grid', gridTemplateColumns: '100px 92px 90px minmax(0, 1fr) 150px', gap: 12, alignItems: 'center' }}><span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' }}>{row.chain.chain.date}</span><span style={badgeStyle(row.chain.chain.type)}>{TYPE_LABEL[row.chain.chain.type]}</span><b>{row.group.assetCode}</b><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.chain.chips.join(' → ')}</span><b style={{ textAlign: 'right', color: row.chain.deltaColor }}>{row.chain.delta}</b></div>}
          renderSummary={(rows) => {
            const buys = rows.filter((row) => row.chain.chain.type === 'buy' || row.chain.chain.type === 'dca').length;
            const sells = rows.filter((row) => row.chain.chain.type === 'sell').length;
            return <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>买入 {buys} · 卖出 {sells}</span>;
          }}
          onOpen={(row) => { setOpenGroup((current) => ({ ...current, [row.group.assetId]: true })); setOpenChain(row.chain.chain.id); setView('overview'); }}
          emptyText="该时间范围内没有资产转换记录。"
        />
      )}

      {adding && <AddConversionModal assetPresetCode={adding.assetPresetCode} onClose={() => setAdding(null)} />}
      {editing && <AddConversionModal initial={editing} onClose={() => setEditing(null)} />}
      {deletingChainId && (
        <ConfirmDialog
          title="作废资产转换"
          confirmLabel="作废"
          cancelLabel="取消"
          tone="danger"
          onCancel={() => setDeletingChainId(null)}
          onConfirm={() => removeChain(deletingChainId)}
        >
          作废会重算后续持仓、成本和已实现盈亏；记录仍保留在操作历史中，并可恢复。确定继续？
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
  return (
    <section style={{ ...card, padding: 22 }}>
      <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{onlyCny ? '当前只有人民币' : '还没有资产转换记录'}</div>
      <div style={{ marginTop: 7, color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', lineHeight: 1.7 }}>
        选一个常用目标资产开始填写真实转换。系统只会在需要时补充资产定义，不会伪造余额、持仓或交易。
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 10, marginTop: 16 }}>
        {ASSET_PRESETS.map((preset) => {
          const existing = activeAssetByCode(active, preset.code);
          return (
            <button
              key={preset.code}
              type="button"
              onClick={() => onSelect(preset.code)}
              style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-primary)', padding: '13px 12px', textAlign: 'left', cursor: 'pointer' }}
            >
              <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{preset.code}</div>
              <div style={{ marginTop: 4, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{preset.name}</div>
              <div style={{ marginTop: 8, fontSize: 'var(--fs-meta)', color: existing ? 'var(--positive)' : 'var(--accent)', fontWeight: 'var(--fw-medium)' }}>
                {existing ? '已有定义 · 直接填写' : '选择时添加'}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
