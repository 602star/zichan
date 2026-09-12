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
  const base = { padding: '5px 11px', borderRadius: 8, fontSize: 12, fontWeight: 800, flexShrink: 0 } as const;
  if (type === 'dca' || type === 'buy') return { ...base, background: 'var(--accent-soft)', color: 'var(--accent)' };
  if (type === 'sell') return { ...base, background: 'rgba(63,143,107,.14)', color: 'var(--positive)' };
  return { ...base, background: 'var(--surface-2)', color: 'var(--fg-muted)' };
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
        <button onClick={() => setAdding({})} style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>+ 新增转换</button>
      </div>
      <DateRangeBar value={dateRange} onChange={setDateRange} />

      {view === 'overview' && vm.groups.length === 0 && (
        <ConvertEmptyState assets={snap.assets} onSelect={(assetPresetCode) => setAdding({ assetPresetCode })} />
      )}

      {showVoided && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 850 }}>已作废转换</div>
          {voidedChains.map((row) => (
            <div key={row.chain.id} className="zc-voided-row" style={{ display: 'grid', gridTemplateColumns: '120px 100px minmax(0, 1fr) 90px', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{row.chain.date}{row.chain.time ? ` ${row.chain.time}` : ''}</span>
              <span style={badgeStyle(row.chain.type)}>{TYPE_LABEL[row.chain.type] ?? row.chain.type}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.chain.title ?? row.steps.map((step) => `${snap.assets.find((asset) => asset.id === step.fromAssetId)?.code ?? '?'} → ${snap.assets.find((asset) => asset.id === step.toAssetId)?.code ?? '?'}`).join(' · ')}</span>
              <button onClick={() => void restoreChain(row.chain.id)} style={{ padding: '6px 10px', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontWeight: 800, cursor: 'pointer' }}>恢复</button>
            </div>
          ))}
          {voidedChains.length === 0 && <div style={{ padding: 18, color: 'var(--fg-subtle)', fontSize: 12 }}>当前筛选范围没有已作废转换。</div>}
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
              <span style={{ fontSize: 18, fontWeight: 800, minWidth: 56 }}>{g.assetCode}</span>
              {g.hasPosition && (
                <>
                  <div><div style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>持仓</div><div style={{ fontSize: 15, fontWeight: 800 }}>{fmtAmount(g.holdings, 6)}</div></div>
                  <div><div style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>现值</div><div style={{ fontSize: 15, fontWeight: 800 }}>{money(g.value)}</div></div>
                  <div><div style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>持仓均价</div><div style={{ fontSize: 15, fontWeight: 800 }}>{g.costBasisKnown ? money(g.avgCost) : '缺少成本汇率'}</div></div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>未实现盈亏</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: g.costBasisKnown ? (g.pnl >= 0 ? 'var(--positive)' : 'var(--negative)') : 'var(--fg-subtle)' }}>
                      {g.costBasisKnown ? <>{signedMoney(g.pnl)} · {g.pnl >= 0 ? '+' : '−'}{num(Math.abs(g.pnlPct), 1)}%</> : '请补记成本币种汇率'}
                    </div>
                  </div>
                </>
              )}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 13, color: 'var(--fg-subtle)', fontWeight: 700 }}>{chains.length}/{g.chains.length} 笔</span>
              <span style={{ fontSize: 13, color: 'var(--fg-subtle)', transition: 'transform .2s', transform: `rotate(${open ? 180 : 0}deg)` }}>▾</span>
            </button>

            {open && (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                {chains.length === 0 && <div style={{ padding: '16px 22px', fontSize: 12, color: 'var(--fg-subtle)' }}>该筛选下无记录</div>}
                {chains.map((c) => {
                  const co = openChain === c.chain.id;
                  return (
                    <div key={c.chain.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <button onClick={() => setOpenChain(co ? null : c.chain.id)} style={{ width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left' }}>
                        <span style={badgeStyle(c.chain.type)}>{TYPE_LABEL[c.chain.type] ?? c.chain.type}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {c.chips.map((chip, i) => (
                            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 800 }}>{chip}</span>
                              {i < c.chips.length - 1 && <span style={{ color: 'var(--fg-subtle)', fontSize: 12 }}>→</span>}
                            </span>
                          ))}
                        </div>
                        <div style={{ flex: 1 }} />
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>{c.result}</div>
                          <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{c.chain.date}</div>
                        </div>
                        <div style={{ textAlign: 'right', minWidth: 92 }}>
                          <div style={{ fontSize: 10, color: 'var(--fg-subtle)', fontWeight: 700 }}>{c.deltaLabel}</div>
                          <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2, color: c.deltaColor }}>{c.delta}</div>
                        </div>
                        <span style={{ fontSize: 13, color: 'var(--fg-subtle)', transition: 'transform .2s', transform: `rotate(${co ? 180 : 0}deg)` }}>▾</span>
                      </button>
                      {co && (
                        <div className="zc-convert-detail-grid" style={{ padding: '4px 22px 20px', background: 'var(--surface-2)', display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 24 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 800, letterSpacing: 0 }}>换算步骤</div>
                            {c.steps.map((s) => (
                              <div key={s.n} style={{ ...card, padding: '14px 16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.n}</span>
                                  <span style={{ fontSize: 14, fontWeight: 800 }}>{s.from}</span>
                                  <span style={{ color: 'var(--fg-subtle)' }}>→</span>
                                  <span style={{ fontSize: 14, fontWeight: 800 }}>{s.to}</span>
                                </div>
                                <div style={{ display: 'flex', gap: 18, marginTop: 9, paddingLeft: 32 }}>
                                  <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>汇率 · {s.rate}</span>
                                  {s.fee && <span style={{ fontSize: 12, color: 'var(--negative)', fontWeight: 600 }}>{s.fee}</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                          <div style={{ ...card, padding: '16px 18px', alignSelf: 'start' }}>
                            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 800, letterSpacing: 0, marginBottom: 6 }}>成本追溯</div>
                            {c.calc.map((r) => (
                              <div key={r.l} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{r.l}</span>
                                <span style={{ fontSize: 13, fontWeight: r.strong ? 800 : 600, color: r.color ?? 'var(--fg)' }}>{r.v}</span>
                              </div>
                            ))}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                              <button onClick={() => setEditing(snap.chains.find((row) => row.chain.id === c.chain.id) ?? null)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontWeight: 700, fontSize: 12, cursor: 'pointer', marginRight: 8 }}>编辑</button>
                              <button onClick={() => setDeletingChainId(c.chain.id)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--negative)', background: 'transparent', color: 'var(--negative)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>作废</button>
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
          renderEntry={(row) => <div className="zc-convert-timeline-entry" style={{ display: 'grid', gridTemplateColumns: '100px 92px 90px minmax(0, 1fr) 150px', gap: 12, alignItems: 'center' }}><span style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>{row.chain.chain.date}</span><span style={badgeStyle(row.chain.chain.type)}>{TYPE_LABEL[row.chain.chain.type]}</span><b>{row.group.assetCode}</b><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.chain.chips.join(' → ')}</span><b style={{ textAlign: 'right', color: row.chain.deltaColor }}>{row.chain.delta}</b></div>}
          renderSummary={(rows) => {
            const buys = rows.filter((row) => row.chain.chain.type === 'buy' || row.chain.chain.type === 'dca').length;
            const sells = rows.filter((row) => row.chain.chain.type === 'sell').length;
            return <span style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>买入 {buys} · 卖出 {sells}</span>;
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
      <div style={{ fontSize: 17, fontWeight: 900 }}>{onlyCny ? '当前只有人民币' : '还没有资产转换记录'}</div>
      <div style={{ marginTop: 7, color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.7 }}>
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
              style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--fg)', padding: '13px 12px', textAlign: 'left', cursor: 'pointer' }}
            >
              <div style={{ fontSize: 15, fontWeight: 900 }}>{preset.code}</div>
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-muted)' }}>{preset.name}</div>
              <div style={{ marginTop: 8, fontSize: 10, color: existing ? 'var(--positive)' : 'var(--accent)', fontWeight: 800 }}>
                {existing ? '已有定义 · 直接填写' : '选择时添加'}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
