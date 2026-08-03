import { useMemo, useState } from 'react';
import { localToday, type GameRecordType, type GameRecord } from '@zichan/core';
import {
  deleteGameRecord,
  restoreDeletedGameRecord,
  saveGameRecordAggregate,
  type GameCashflowDraft,
} from '@zichan/db';
import { useSnapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { EntityFormModal } from '../ui/EntityFormModal.js';
import { gameRecordForm, gameSeasonForm, type GameRecordFormValue } from '../forms.js';
import { buildGameSeason } from '../selectors/game.js';
import { money, signedMoney, num } from '../format.js';
import { card, tag as tagStyle, amountColor, pillBtn } from '../ui/styles.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue, type TimelineViewMode } from '../ui/DateRangeBar.js';
import { TimelineExplorer } from '../ui/TimelineExplorer.js';
import { useUndo } from '../ui/UndoToast.js';

const REC_LABEL: Record<GameRecordType, string> = {
  buy_currency: '买入游戏币', sell_currency: '游戏币卖出', produce: '游戏产出', consume: '游戏消耗',
  sell_equipment: '装备卖出', sell_material: '材料卖出', topup: '充值', withdraw: '提现', fee: '手续费',
  account_cost: '账号成本', boosting_cost: '代练成本', other_expense: '其他支出', other_income: '其他收入',
};

function recBadge(type: GameRecordType) {
  const base = { padding: '3px 9px', borderRadius: 7, fontSize: 11, fontWeight: 700, flexShrink: 0, whiteSpace: 'nowrap' } as const;
  if (type === 'buy_currency' || type === 'topup') return { ...base, background: 'var(--accent-soft)', color: 'var(--accent)' };
  if (type === 'fee') return { ...base, background: 'rgba(194,96,74,.13)', color: 'var(--negative)' };
  if (type === 'produce' || type === 'consume') return { ...base, background: 'var(--surface-2)', color: 'var(--fg-subtle)' };
  return { ...base, background: 'rgba(63,143,107,.13)', color: 'var(--positive)' };
}

function cashflowDraft(value: GameRecordFormValue, role: 'settlement' | 'fee'): GameCashflowDraft {
  const mode = role === 'settlement'
    ? value.settlementCashflowMode ?? 'record_only'
    : value.feeCashflowMode ?? 'record_only';
  const linkedTransactionId = role === 'settlement'
    ? value.settlementTransactionId
    : value.feeTransactionId;
  const categoryId = role === 'settlement' ? value.settlementCategoryId : value.feeCategoryId;
  const accountId = role === 'settlement' ? value.settlementAccountId : value.feeAccountId;
  const merchant = role === 'settlement' ? value.settlementMerchant : value.feeMerchant;
  return {
    mode,
    linkedTransactionId,
    createTransaction: mode === 'create_transaction' && categoryId && accountId
      ? { categoryId, accountId, merchant, description: value.note }
      : undefined,
  };
}

function gameRecordEntity(value: GameRecordFormValue): GameRecord {
  const {
    settlementCashflowMode: _settlementMode,
    settlementTransactionId: _settlementTransaction,
    settlementCategoryId: _settlementCategory,
    settlementAccountId: _settlementAccount,
    settlementMerchant: _settlementMerchant,
    feeCashflowMode: _feeMode,
    feeTransactionId: _feeTransaction,
    feeCategoryId: _feeCategory,
    feeAccountId: _feeAccount,
    feeMerchant: _feeMerchant,
    ...record
  } = value;
  return record;
}

export function Game() {
  const snap = useSnapshot('game');
  const { store, bump } = useStore();
  const undo = useUndo(store, bump);
  const [gameId, setGameId] = useState<string | null>(null);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [editRec, setEditRec] = useState<GameRecord | 'new' | null>(null);
  const [addSeason, setAddSeason] = useState(false);
  const [view, setView] = useState<'overview' | TimelineViewMode>('overview');
  const [focusDate, setFocusDate] = useState(localToday);
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const [accountFilter, setAccountFilter] = useState('');
  const [recordTypeFilter, setRecordTypeFilter] = useState<'all' | GameRecordType>('all');
  const vm = useMemo(() => (snap ? buildGameSeason(snap, gameId, seasonId, { dateRange, accountId: accountFilter || undefined, recordType: recordTypeFilter }) : null), [accountFilter, dateRange, gameId, recordTypeFilter, seasonId, snap]);
  if (!snap || !vm) return null;
  const selectedGameId = gameId ?? snap.games.find((game) => !game.isDeleted && game.isActive !== false && !game.mergedIntoId)?.id ?? '';
  const accountOptions = snap.gameAccounts.filter((account) =>
    !account.isDeleted && !account.archivedAt && !account.mergedIntoId && account.gameId === selectedGameId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      {vm.missingRateAssetCodes.length > 0 && (
        <div style={{ ...card, padding: '12px 14px', borderColor: 'var(--warning)', color: 'var(--warning)', fontSize: 13, fontWeight: 700 }}>
          缺少 {vm.missingRateAssetCodes.join('、')} → {vm.reportCurrencyCode} 的价格标记；相关游戏记录未计入赛季汇总。
        </div>
      )}
      <div className="zc-game-header" style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {snap.games.filter((g) => !g.isDeleted && g.isActive !== false && !g.mergedIntoId).length > 1 ? (
          <select
            className="zc-select"
            value={gameId ?? snap.games.find((g) => !g.isDeleted && g.isActive !== false && !g.mergedIntoId)?.id ?? ''}
            onChange={(e) => { setGameId(e.target.value); setSeasonId(null); setAccountFilter(''); }}
            style={{ width: 180, fontWeight: 800, fontSize: 15 }}
          >
            {snap.games.filter((g) => !g.isDeleted && g.isActive !== false && !g.mergedIntoId).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: 15, fontWeight: 800 }}>{vm.gameName}</div>
        )}
        <span style={tagStyle}>{vm.gameTags}</span>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>账号 · {vm.accountNames}</span>
        <div style={{ flex: 1 }} />
        <div className="zc-game-season-tabs" style={{ display: 'flex', gap: 8 }}>
          {vm.tabs.map((t) => {
            const active = t.id === vm.activeId;
            return (
              <button key={t.id} onClick={() => setSeasonId(t.id)} style={{
                padding: '9px 15px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                background: active ? 'var(--accent-soft)' : 'var(--surface)',
                color: active ? 'var(--accent)' : 'var(--fg-muted)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              }}>
                {t.name}<span style={{ fontSize: 11, opacity: 0.7, marginLeft: 7 }}>{t.status}</span>
              </button>
            );
          })}
          <button onClick={() => setAddSeason(true)} style={outlineBtn}>+ 赛季</button>
          <button onClick={() => setEditRec('new')} style={primaryBtn}>+ 记录</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['overview', 'list', 'year', 'month', 'day'] as const).map((mode) => <button key={mode} onClick={() => setView(mode)} style={pillBtn(view === mode)}>{mode === 'overview' ? '赛季概览' : mode === 'list' ? '记录流' : mode === 'year' ? '年度' : mode === 'month' ? '月历' : '单日'}</button>)}
        <div style={{ flex: 1 }} />
        <select aria-label="游戏账号筛选" className="zc-select" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)} style={{ width: 150 }}><option value="">全部账号</option>{accountOptions.map((account) => <option key={account.id} value={account.id}>{account.accountName}</option>)}</select>
        <select aria-label="游戏记录类型筛选" className="zc-select" value={recordTypeFilter} onChange={(event) => setRecordTypeFilter(event.target.value as typeof recordTypeFilter)} style={{ width: 150 }}><option value="all">全部记录类型</option>{Object.entries(REC_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      <DateRangeBar value={dateRange} onChange={setDateRange} />

      {view === 'overview' ? <><div className="zc-game-overview-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 18, minWidth: 0 }}>
        <div style={card}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 700 }}>{vm.season.name} · 赛季净收益（{vm.reportCurrencyCode}）</div>
          <div style={{ fontSize: 40, fontWeight: 800, marginTop: 8, letterSpacing: 0, color: vm.net >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
            {signedMoney(vm.net)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4, fontWeight: 500 }}>{vm.range}</div>
          <div className="zc-game-kpi-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 20 }}>
            {[
              ['赛季收入', money(vm.income), 'var(--positive)'],
              ['赛季支出', money(vm.expense), 'var(--negative)'],
              ['每小时收益', vm.filtered ? '—' : money(vm.perHour), 'var(--fg)'],
              ['每日收益', money(vm.perDay), 'var(--fg)'],
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>{l}</div>
                <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, color: c }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 14, borderTop: '1px dashed var(--border)' }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>游戏时长 · {vm.hours} h</span>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>记录余额（参考） · {num(vm.refBalance, 2)} {vm.refCurrencyLabel}</span>
          </div>
        </div>

        <div style={{ ...card, padding: '22px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>赛季记录流</div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 600 }}>不强制库存 · 允许卖出 &gt; 买入</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {vm.records.map((r, i) => (
              <div key={i} onClick={() => setEditRec(r.raw)} title="点击编辑" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 700, width: 38, flexShrink: 0 }}>{r.date.slice(5)}</div>
                <span style={recBadge(r.type)}>{REC_LABEL[r.type]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.item || REC_LABEL[r.type]}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{r.nativeAmount}</div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', width: 64, textAlign: 'right', flexShrink: 0 }}>{r.acc}</div>
                <div style={{ fontSize: 13, width: 74, textAlign: 'right', ...amountColor(r.amt) }}>
                  {r.amt === 0 ? money(0) : signedMoney(r.amt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="zc-game-detail-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <EfficiencyPanel title="账号效率" rows={vm.byAccount.map((r) => ({ ...r, label: r.label }))} />
        <EfficiencyPanel title="类型拆分" rows={vm.byType.map((r) => ({ ...r, label: REC_LABEL[r.id as GameRecordType] ?? r.label }))} />
      </div></> : (
        <TimelineExplorer
          items={vm.records}
          view={view}
          focusDate={focusDate}
          onFocusDate={setFocusDate}
          onViewChange={setView}
          dateOf={(record) => record.date}
          keyOf={(record) => record.raw.id}
          renderCompact={(record) => <>{record.date.slice(8)} · <b>{REC_LABEL[record.type]}</b> · {record.item || record.nativeAmount}</>}
          renderEntry={(record) => <div className="zc-game-timeline-entry" style={{ display: 'grid', gridTemplateColumns: '100px 130px minmax(0, 1fr) 100px 130px', gap: 12, alignItems: 'center' }}><span style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>{record.date}</span><span style={recBadge(record.type)}>{REC_LABEL[record.type]}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.item || REC_LABEL[record.type]}</span><span style={{ color: 'var(--fg-subtle)', textAlign: 'right' }}>{record.acc}</span><b style={{ textAlign: 'right', ...amountColor(record.amt) }}>{record.amt === 0 ? money(0) : signedMoney(record.amt)}</b></div>}
          renderSummary={(rows) => {
            const income = rows.filter((row) => row.amt > 0).reduce((total, row) => total + row.amt, 0);
            const expense = Math.abs(rows.filter((row) => row.amt < 0).reduce((total, row) => total + row.amt, 0));
            return <span style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>收 {money(income)} · 支 {money(expense)}</span>;
          }}
          onOpen={(record) => setEditRec(record.raw)}
          emptyText="该时间范围内没有游戏记录。"
        />
      )}

      {editRec !== null && (
        <EntityFormModal
          spec={gameRecordForm(snap)}
          initial={editRec === 'new' ? undefined : editRec}
          onSave={async (value) => {
            const saved = await saveGameRecordAggregate(store, {
              record: gameRecordEntity(value),
              settlement: cashflowDraft(value, 'settlement'),
              fee: cashflowDraft(value, 'fee'),
              expectedVersion: editRec === 'new' ? undefined : editRec.version,
            });
            bump();
            if (editRec === 'new') {
              undo.offer('游戏记录已保存', async () => {
                const current = await store.gameRecords.get(saved.record.id);
                if (!current || current.isDeleted) throw new Error('游戏记录不存在');
                await deleteGameRecord(store, current.id, current.version);
                bump();
              });
            }
          }}
          onDelete={editRec !== 'new' ? async () => {
            const compensation = await deleteGameRecord(store, editRec.id, editRec.version);
            bump();
            undo.offer('游戏记录已删除，关联创建的流水已作废', async () => {
              await restoreDeletedGameRecord(store, compensation);
              bump();
            });
          } : undefined}
          onClose={() => setEditRec(null)}
        />
      )}
      {addSeason && (
        <EntityFormModal
          spec={gameSeasonForm(snap)}
          onSave={async (e) => {
            await store.runInAuditBatch(
              `新增游戏赛季“${e.name}”`,
              (transactionStore) => transactionStore.gameSeasons.put(e),
            );
            bump();
          }}
          onClose={() => setAddSeason(false)}
        />
      )}
    </div>
  );
}

const outlineBtn = { padding: '9px 15px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: 'var(--surface)', color: 'var(--fg-muted)', border: '1px solid var(--border)' } as const;
const primaryBtn = { padding: '9px 15px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' } as const;

function EfficiencyPanel(props: {
  title: string;
  rows: { id: string; label: string; income: number; expense: number; net: number; records: number }[];
}) {
  const max = Math.max(...props.rows.map((r) => Math.abs(r.net)), 1);
  return (
    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>{props.title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {props.rows.map((r) => (
          <div key={r.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 5 }}>
              <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
              <span style={{ fontSize: 13, fontWeight: 800, ...amountColor(r.net) }}>{signedMoney(r.net)}</span>
            </div>
            <div style={{ height: 7, background: 'var(--surface-2)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ height: 7, width: `${Math.abs(r.net) / max * 100}%`, background: r.net >= 0 ? 'var(--positive)' : 'var(--negative)', borderRadius: 99 }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>
              收入 {money(r.income)} · 支出 {money(r.expense)} · {r.records} 条
            </div>
          </div>
        ))}
        {props.rows.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>暂无记录</div>}
      </div>
    </div>
  );
}
