import { withCashflowPayee } from '../payee-recording.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  localToday,
  newId,
  type Game as GameEntity,
  type GameRecordType,
  type GameRecord,
  type GameSeason,
} from '@zichan/core';
import {
  deleteGameRecord,
  restoreDeletedGameRecord,
  saveGameRecordAggregate,
  type GameCashflowDraft,
  type SqlLedgerStore,
} from '@zichan/db';
import { useSnapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { EntityFormModal } from '../ui/EntityFormModal.js';
import { gameAccountForm, gameRecordForm, gameSeasonForm, type GameRecordFormValue } from '../forms.js';
import { ALL_GAME_RECORDS, UNASSIGNED_GAME_RECORDS, buildGameSeason } from '../selectors/game.js';
import { money, signedMoney, num } from '../format.js';
import { amountColor, btnOutline, btnPrimary, card, pillBtn, tag as tagStyle } from '../ui/styles.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue, type TimelineViewMode } from '../ui/DateRangeBar.js';
import { TimelineExplorer } from '../ui/TimelineExplorer.js';
import { useUndo } from '../ui/UndoToast.js';

const REC_LABEL: Record<GameRecordType, string> = {
  buy_currency: '买入游戏币', sell_currency: '游戏币卖出', produce: '游戏产出', consume: '游戏消耗',
  sell_equipment: '装备卖出', sell_material: '材料卖出', topup: '充值', withdraw: '提现', fee: '手续费',
  account_cost: '账号成本', boosting_cost: '代练成本', other_expense: '其他支出', other_income: '其他收入',
};

function recBadge(type: GameRecordType) {
  const base = { padding: '3px 9px', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', flexShrink: 0, whiteSpace: 'nowrap' } as const;
  if (type === 'buy_currency' || type === 'topup') return { ...base, background: 'var(--accent-soft)', color: 'var(--accent)' };
  if (type === 'fee') return { ...base, background: 'rgba(194,96,74,.13)', color: 'var(--negative)' };
  if (type === 'produce' || type === 'consume') return { ...base, background: 'var(--surface-2)', color: 'var(--text-tertiary)' };
  return { ...base, background: 'rgba(63,143,107,.13)', color: 'var(--positive)' };
}

function cashflowDraft(value: GameRecordFormValue, role: 'settlement' | 'fee', usesAccounts: boolean): GameCashflowDraft {
  const mode = role === 'settlement'
    ? value.settlementCashflowMode ?? 'record_only'
    : value.feeCashflowMode ?? 'record_only';
  const linkedTransactionId = role === 'settlement'
    ? value.settlementTransactionId
    : value.feeTransactionId;
  const categoryId = role === 'settlement' ? value.settlementCategoryId : value.feeCategoryId;
  const accountId = role === 'settlement' ? value.settlementAccountId : value.feeAccountId;
  const merchant = role === 'settlement' ? value.settlementMerchant : value.feeMerchant;
  const payeeId = role === 'settlement' ? value.settlementPayeeId : value.feePayeeId;
  return {
    mode,
    linkedTransactionId,
    createTransaction: mode === 'create_transaction' && categoryId
      ? { categoryId, accountId: usesAccounts ? accountId : undefined, merchant, payeeId, description: value.note }
      : undefined,
  };
}

export async function createGameWithDefaultSeason(
  store: SqlLedgerStore,
  rawName: string,
  startDate = localToday(),
): Promise<{ game: GameEntity; season: GameSeason }> {
  const name = rawName.trim();
  if (!name) throw new Error('请输入游戏名称');
  return store.runInAuditBatch(`创建游戏“${name}”和当前赛季`, async (transactionStore) => {
    const game = await transactionStore.games.put({
      id: newId(),
      createdAt: '',
      updatedAt: '',
      version: 1,
      isDeleted: false,
      name,
      enableSeason: true,
      isActive: true,
    });
    const season = await transactionStore.gameSeasons.put({
      id: newId(),
      createdAt: '',
      updatedAt: '',
      version: 1,
      isDeleted: false,
      gameId: game.id,
      name: '当前赛季',
      status: 'active',
      startDate,
    });
    return { game, season };
  });
}

async function createDefaultSeason(
  store: SqlLedgerStore,
  game: GameEntity,
  startDate = localToday(),
): Promise<GameSeason> {
  return store.runInAuditBatch(`为游戏“${game.name}”创建当前赛季`, (transactionStore) =>
    transactionStore.gameSeasons.put({
      id: newId(),
      createdAt: '',
      updatedAt: '',
      version: 1,
      isDeleted: false,
      gameId: game.id,
      name: '当前赛季',
      status: 'active',
      startDate,
    }));
}

function gameRecordEntity(value: GameRecordFormValue): GameRecord {
  const {
    settlementCashflowMode: _settlementMode,
    settlementTransactionId: _settlementTransaction,
    settlementCategoryId: _settlementCategory,
    settlementAccountId: _settlementAccount,
    settlementMerchant: _settlementMerchant,
    settlementPayeeId: _settlementPayeeId,
    feeCashflowMode: _feeMode,
    feeTransactionId: _feeTransaction,
    feeCategoryId: _feeCategory,
    feeAccountId: _feeAccount,
    feeMerchant: _feeMerchant,
    feePayeeId: _feePayeeId,
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
  const [addAccount, setAddAccount] = useState(false);
  const [preferredAccountId, setPreferredAccountId] = useState<string>();
  const [saveNotice, setSaveNotice] = useState('');
  const [savedRecordId, setSavedRecordId] = useState<string | null>(null);
  const [view, setView] = useState<'overview' | TimelineViewMode>('overview');
  const [focusDate, setFocusDate] = useState(localToday);
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const [accountFilter, setAccountFilter] = useState('');
  const [recordTypeFilter, setRecordTypeFilter] = useState<'all' | GameRecordType>('all');
  const [newGameName, setNewGameName] = useState('');
  const [creatingGame, setCreatingGame] = useState(false);
  const [createGameError, setCreateGameError] = useState('');
  const createGameFlight = useRef(false);
  const activeGames = snap?.games.filter((game) => !game.isDeleted && game.isActive !== false && !game.mergedIntoId) ?? [];
  const selectedGameId = activeGames.some((game) => game.id === gameId) ? gameId! : activeGames[0]?.id ?? '';
  const selectedGame = activeGames.find((game) => game.id === selectedGameId);
  const vm = useMemo(() => (snap && selectedGameId
    ? buildGameSeason(snap, selectedGameId, seasonId, { dateRange, accountId: accountFilter || undefined, recordType: recordTypeFilter })
    : null), [accountFilter, dateRange, recordTypeFilter, seasonId, selectedGameId, snap]);
  useEffect(() => {
    if (!savedRecordId) return;
    const row = document.getElementById(`game-record-${savedRecordId}`);
    if (row) { row.scrollIntoView({ block: 'nearest' }); setSavedRecordId(null); }
  }, [snap, savedRecordId]);
  if (!snap) return null;

  const startFirstGame = async () => {
    if (createGameFlight.current) return;
    createGameFlight.current = true;
    setCreatingGame(true);
    setCreateGameError('');
    try {
      const created = selectedGame
        ? { game: selectedGame, season: await createDefaultSeason(store, selectedGame) }
        : await createGameWithDefaultSeason(store, newGameName);
      setGameId(created.game.id);
      setSeasonId(created.season.id);
      bump();
    } catch (error) {
      setCreateGameError(error instanceof Error ? error.message : String(error));
    } finally {
      createGameFlight.current = false;
      setCreatingGame(false);
    }
  };

  if (!vm) {
    return (
      <div style={{ ...card, maxWidth: 620, margin: '8vh auto 0', padding: 28 }}>
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--accent)', fontWeight: 'var(--fw-medium)' }}>首次使用</div>
        <h2 style={{ margin: '8px 0 0', fontSize: 'var(--fs-display)' }}>{selectedGame ? '创建当前赛季' : '开始记录游戏'}</h2>
        <p style={{ margin: '10px 0 20px', color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', lineHeight: 1.65 }}>
          {selectedGame
            ? `“${selectedGame.name}”还没有赛季。创建后即可直接添加记录，游戏账号仍可留空。`
            : '只需填写游戏名称。系统会同时创建一个从今天开始的“当前赛季”，游戏账号以后需要时再添加。'}
        </p>
        <form onSubmit={(event) => { event.preventDefault(); void startFirstGame(); }}>
          {!selectedGame && (
            <label style={{ display: 'block', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
              游戏名称
              <input
                autoFocus
                value={newGameName}
                onChange={(event) => setNewGameName(event.target.value)}
                placeholder="例如：最终幻想 XIV"
                className="zc-input"
                style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 7 }}
              />
            </label>
          )}
          {createGameError && <div role="alert" style={{ marginTop: 10, color: 'var(--negative)', fontSize: 'var(--fs-caption)' }}>{createGameError}</div>}
          <button
            type="submit"
            disabled={creatingGame || (!selectedGame && !newGameName.trim())}
            style={{ ...primaryBtn, minHeight: 42, marginTop: 18, opacity: creatingGame || (!selectedGame && !newGameName.trim()) ? 0.55 : 1 }}
          >
            {creatingGame ? '正在创建…' : selectedGame ? '创建并进入' : '开始记录'}
          </button>
        </form>
      </div>
    );
  }
  const usesAccounts = true;
  const accountOptions = snap.gameAccounts.filter((account) =>
    !account.isDeleted && !account.archivedAt && !account.mergedIntoId && account.gameId === selectedGameId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      {vm.missingRateAssetCodes.length > 0 && (
        <div style={{ ...card, padding: '12px 14px', borderColor: 'var(--warning)', color: 'var(--warning)', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>
          缺少 {vm.missingRateAssetCodes.join('、')} → {vm.reportCurrencyCode} 的价格标记；相关游戏记录未计入赛季汇总。
        </div>
      )}
      <div className="zc-game-header" style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {activeGames.length > 1 ? (
          <select
            className="zc-select"
            aria-label="当前游戏"
            value={selectedGameId}
            onChange={(e) => { setGameId(e.target.value); setSeasonId(null); setAccountFilter(''); setPreferredAccountId(undefined); }}
            style={{ width: 180, fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-title)' }}
          >
            {activeGames.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{vm.gameName}</div>
        )}
        {vm.gameTags && <span style={tagStyle}>{vm.gameTags}</span>}
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>账号 · {vm.accountNames}</span>
        <div style={{ flex: 1 }} />
        <div className="zc-game-season-tabs" style={{ display: 'flex', gap: 8 }}>
          {[{ id: ALL_GAME_RECORDS, name: '全部记录', status: '' }, { id: UNASSIGNED_GAME_RECORDS, name: '未分配赛季', status: String(vm.unassignedCount) }, ...vm.tabs].map((t) => {
            const active = t.id === vm.activeId;
            return (
              <button key={t.id} aria-pressed={active} onClick={() => setSeasonId(t.id)} style={{
                padding: '9px 15px', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', cursor: 'pointer',
                background: active ? 'var(--accent-soft)' : 'var(--surface)',
                color: active ? 'var(--accent)' : 'var(--fg-muted)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              }}>
                {t.name}<span style={{ fontSize: 'var(--fs-meta)', opacity: 0.7, marginLeft: 7 }}>{t.status}</span>
              </button>
            );
          })}
        </div>
        <div className="zc-game-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setAddAccount(true)} style={outlineBtn}>+ 账号</button>
          <button onClick={() => setAddSeason(true)} style={outlineBtn}>+ 赛季</button>
          <button onClick={() => setEditRec('new')} style={primaryBtn}>+ 记录</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['overview', 'list', 'year', 'month', 'day'] as const).map((mode) => <button key={mode} onClick={() => setView(mode)} style={pillBtn(view === mode)}>{mode === 'overview' ? '赛季概览' : mode === 'list' ? '记录流' : mode === 'year' ? '年度' : mode === 'month' ? '月历' : '单日'}</button>)}
        <div style={{ flex: 1 }} />
        {accountOptions.length > 0 && <select aria-label="游戏账号筛选" className="zc-select" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)} style={{ width: 150 }}><option value="">全部账号</option>{accountOptions.map((account) => <option key={account.id} value={account.id}>{account.accountName}</option>)}</select>}
        <select aria-label="游戏记录类型筛选" className="zc-select" value={recordTypeFilter} onChange={(event) => setRecordTypeFilter(event.target.value as typeof recordTypeFilter)} style={{ width: 150 }}><option value="all">全部记录类型</option>{Object.entries(REC_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      <DateRangeBar value={dateRange} onChange={setDateRange} />
      {(accountFilter || recordTypeFilter !== 'all') && <button style={{ ...outlineBtn, alignSelf: 'flex-start' }} onClick={() => { setAccountFilter(''); setRecordTypeFilter('all'); }}>清除其他筛选</button>}
      {saveNotice && <div role="status" className="zc-meta">{saveNotice}</div>}
      {vm.activeId === UNASSIGNED_GAME_RECORDS && <p className="zc-meta">这些记录尚未分配赛季。点击记录编辑，即可选择所属赛季；不会自动改动历史归属。</p>}

      {view === 'overview' ? <><div className="zc-game-overview-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 18, minWidth: 0 }}>
        <div style={card}>
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>{vm.scopeName} · 净收益（{vm.reportCurrencyCode}）</div>
          <div style={{ fontSize: 'var(--fs-hero)', fontWeight: 'var(--fw-bold)', marginTop: 8, letterSpacing: 0, color: vm.net >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
            {signedMoney(vm.net)}
          </div>
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4, fontWeight: 'var(--fw-regular)' }}>{vm.range}</div>
          <div className="zc-game-kpi-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 20 }}>
            {[
              ['收入', money(vm.income), 'var(--positive)'],
              ['支出', money(vm.expense), 'var(--negative)'],
              ['每小时收益', vm.filtered || !vm.season ? '—' : money(vm.perHour), 'var(--fg)'],
              ['每日收益', vm.season ? money(vm.perDay) : '—', 'var(--fg)'],
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: 14 }}>
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>{l}</div>
                <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)', marginTop: 4, color: c }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 14, borderTop: '1px dashed var(--border)' }}>
            <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>游戏时长 · {vm.season ? `${vm.hours} h` : '—'}</span>
            <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>记录余额（参考） · {num(vm.refBalance, 2)} {vm.refCurrencyLabel}</span>
          </div>
        </div>

        <div style={{ ...card, padding: '22px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}> {vm.scopeName} · 记录流</div>
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>不强制库存 · 允许卖出 &gt; 买入</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {!vm.records.length && <p className="zc-meta">当前范围没有记录，可查看“全部记录”或调整筛选。</p>}
            {vm.records.map((r) => (
              <div id={`game-record-${r.raw.id}`} className="zc-game-record-row" key={r.raw.id} role="button" tabIndex={0} aria-label={`编辑游戏记录 ${r.item || REC_LABEL[r.type]}`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEditRec(r.raw); } }} onClick={() => setEditRec(r.raw)} title="点击编辑" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', width: 38, flexShrink: 0 }}>{r.date.slice(5)}</div>
                <span style={recBadge(r.type)}>{REC_LABEL[r.type]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-medium)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.item || REC_LABEL[r.type]}</div>
                  <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 2 }}>{r.nativeAmount}{!vm.season && ` · ${r.seasonName}`}</div>
                </div>
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', width: 64, textAlign: 'right', flexShrink: 0 }}>{r.acc}</div>
                <div style={{ fontSize: 'var(--fs-body)', width: 74, textAlign: 'right', ...amountColor(r.amt) }}>
                  {r.amt === 0 ? money(0) : signedMoney(r.amt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="zc-game-detail-grid" style={{ display: 'grid', gridTemplateColumns: accountOptions.length > 0 ? '1fr 1fr' : '1fr', gap: 18 }}>
        {accountOptions.length > 0 && <EfficiencyPanel title="账号效率" rows={vm.byAccount.map((r) => ({ ...r, label: r.label }))} />}
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
          renderEntry={(record) => <div className="zc-game-timeline-entry" style={{ display: 'grid', gridTemplateColumns: '100px 130px minmax(0, 1fr) 100px 130px', gap: 12, alignItems: 'center' }}><span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' }}>{record.date}</span><span style={recBadge(record.type)}>{REC_LABEL[record.type]}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.item || REC_LABEL[record.type]}</span><span style={{ color: 'var(--text-tertiary)', textAlign: 'right' }}>{record.acc}</span><b style={{ textAlign: 'right', ...amountColor(record.amt) }}>{record.amt === 0 ? money(0) : signedMoney(record.amt)}</b></div>}
          renderSummary={(rows) => {
            const income = rows.filter((row) => row.amt > 0).reduce((total, row) => total + row.amt, 0);
            const expense = Math.abs(rows.filter((row) => row.amt < 0).reduce((total, row) => total + row.amt, 0));
            return <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>收 {money(income)} · 支 {money(expense)}</span>;
          }}
          onOpen={(record) => setEditRec(record.raw)}
          emptyText="该时间范围内没有游戏记录。"
        />
      )}

      {editRec !== null && (
        <EntityFormModal
          spec={gameRecordForm(snap, { gameId: selectedGameId, seasonId: vm.season?.id, gameAccountId: accountFilter || (accountOptions.some((a) => a.id === preferredAccountId) ? preferredAccountId : undefined) })}
          initial={editRec === 'new' ? undefined : editRec}
          onSave={async (value) => {
            const saved = await store.runInAuditBatch('保存游戏记录与交易对象', async (transactionStore) => saveGameRecordAggregate(transactionStore, {
              record: gameRecordEntity(value),
              settlement: await withCashflowPayee(transactionStore, cashflowDraft(value, 'settlement', usesAccounts)),
              fee: await withCashflowPayee(transactionStore, cashflowDraft(value, 'fee', usesAccounts)),
              expectedVersion: editRec === 'new' ? undefined : editRec.version,
            }));
            setSavedRecordId(saved.record.id);
            setGameId(saved.record.gameId);
            setSeasonId(saved.record.seasonId || UNASSIGNED_GAME_RECORDS);
            setDateRange(dateRangeValue('all'));
            setAccountFilter('');
            setRecordTypeFilter('all');
            setFocusDate(saved.record.date);
            setView('overview');
            setSaveNotice('已定位到保存的记录，并重置日期、账号和类型筛选。');
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
      {addAccount && <EntityFormModal spec={gameAccountForm(snap, selectedGameId)}
        onSave={async (value) => {
          await store.runInAuditBatch(`新增游戏账号“${value.accountName}”`, (tx) => tx.gameAccounts.put(value));
          setGameId(value.gameId);
          setAccountFilter('');
          setPreferredAccountId(value.id);
          setSaveNotice(`已添加账号“${value.accountName}”，新增记录时会默认选用。`);
          bump();
        }} onClose={() => setAddAccount(false)} />}
      {addSeason && (
        <EntityFormModal
          spec={gameSeasonForm(snap, selectedGameId)}
          onSave={async (e) => {
            await store.runInAuditBatch(
              `新增游戏赛季“${e.name}”`,
              (transactionStore) => transactionStore.gameSeasons.put(e),
            );
            setGameId(e.gameId);
            setSeasonId(e.id);
            setDateRange(dateRangeValue('all'));
            setAccountFilter('');
            setRecordTypeFilter('all');
            setView('overview');
            bump();
          }}
          onClose={() => setAddSeason(false)}
        />
      )}
    </div>
  );
}

const outlineBtn = btnOutline;
const primaryBtn = btnPrimary;

function EfficiencyPanel(props: {
  title: string;
  rows: { id: string; label: string; income: number; expense: number; net: number; records: number }[];
}) {
  const max = Math.max(...props.rows.map((r) => Math.abs(r.net)), 1);
  return (
    <div style={card}>
      <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', marginBottom: 12 }}>{props.title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {props.rows.map((r) => (
          <div key={r.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 5 }}>
              <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
              <span style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', ...amountColor(r.net) }}>{signedMoney(r.net)}</span>
            </div>
            <div style={{ height: 7, background: 'var(--surface-2)', borderRadius: 'var(--r-pill)', overflow: 'hidden' }}>
              <div style={{ height: 7, width: `${Math.abs(r.net) / max * 100}%`, background: r.net >= 0 ? 'var(--positive)' : 'var(--negative)', borderRadius: 'var(--r-pill)' }} />
            </div>
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 4 }}>
              收入 {money(r.income)} · 支出 {money(r.expense)} · {r.records} 条
            </div>
          </div>
        ))}
        {props.rows.length === 0 && <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>暂无记录</div>}
      </div>
    </div>
  );
}
