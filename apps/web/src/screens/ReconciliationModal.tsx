import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { D, isLegacyExternalAccount, isSystemDefaultAccount, localToday, dayOfInstant, type ReconciliationItem, type ReconciliationSession, type Transaction } from '@zichan/core';
import { closeReconciliation, previewReconciliation, undoLatestReconciliation, type ReconciliationPreview, type SqlLedgerStore } from '@zichan/db';
import type { Snapshot } from '../db/snapshot.js';
import { num } from '../format.js';
import { categoryLabel } from '../transactionMeta.js';
import { CardAlert, CardEmpty, CardFact, CardGroup, CardMetric } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DateTimeInput } from '../ui/DateTimeInput.js';
import { ValuePicker } from '../ui/ValuePicker.js';
import { WorkspaceDialog } from '../ui/WorkspaceDialog.js';

export function latestStatementDate(statementDay: number | undefined, today = localToday()): string {
  if (!statementDay) return today;
  const [year, month, day] = today.split('-').map(Number);
  const currentMonth = new Date(Date.UTC(year!, month! - 1, 1));
  const currentMonthLastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (day! < Math.min(statementDay, currentMonthLastDay)) currentMonth.setUTCMonth(currentMonth.getUTCMonth() - 1);
  const targetYear = currentMonth.getUTCFullYear();
  const targetMonth = currentMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(statementDay, lastDay)).padStart(2, '0')}`;
}

interface Props {
  store: SqlLedgerStore; snap: Snapshot; session?: ReconciliationSession;
  initialAccountId: string; initialAssetId: string; readVersion?: number; readOnly?: boolean;
  onClose: () => void; onChanged: () => void;
}
interface PreviewRead { key: string; context: string; result?: ReconciliationPreview; error?: string; }

/** Compare a real statement with explicitly confirmed postings; never guess a balance. */
export function ReconciliationModal(props: Props) {
  const titleId = useId();
  const { store, snap, session } = props;
  const today = () => dayOfInstant(new Date(), snap.setting?.timezone);
  const [accountId, setAccountId] = useState(session?.accountId ?? props.initialAccountId);
  const [assetId, setAssetId] = useState(session?.assetId ?? props.initialAssetId);
  const initialAccount = snap.accounts.find((row) => row.id === (session?.accountId ?? props.initialAccountId));
  const [statementDate, setStatementDate] = useState(session?.statementDate ?? latestStatementDate(initialAccount?.statementDay, today()));
  const [statementBalance, setStatementBalance] = useState(session?.statementBalance ?? '');
  const [note, setNote] = useState(session?.note ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewRead, setPreviewRead] = useState<PreviewRead | null>(null);
  const [adjustmentFor, setAdjustmentFor] = useState<string | null>(null);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [sessionItems, setSessionItems] = useState<ReconciliationItem[]>([]);
  const [sessionTransactions, setSessionTransactions] = useState<Record<string, Transaction>>({});
  const [sessionLoading, setSessionLoading] = useState(!!session);
  const [undoOpen, setUndoOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const fingerprint = JSON.stringify([accountId, assetId, statementDate, statementBalance, selectedIds, note, adjustmentFor]);
  const [initialFingerprint] = useState(fingerprint);
  const dirty = !session && fingerprint !== initialFingerprint;
  const context = JSON.stringify([accountId, assetId, statementDate, props.readVersion, retry]);
  const requestKey = JSON.stringify([context, statementBalance, selectedIds]);
  const hasInputs = !!(accountId && assetId && statementDate && statementBalance.trim());
  const preview = previewRead?.key === requestKey ? previewRead.result : undefined;
  const readError = previewRead?.key === requestKey ? previewRead.error : undefined;
  // Keep the same candidate controls while their checked amounts are recalculated.
  const candidates = useMemo(() => previewRead?.context === context ? previewRead.result?.candidates ?? [] : [], [context, previewRead]);
  const calculating = !session && hasInputs && previewRead?.key !== requestKey;
  const asset = snap.assets.find((row) => row.id === assetId);
  const account = snap.accounts.find((row) => row.id === accountId);
  const money = (value: string) => `${num(value, asset?.decimals ?? 8)} ${asset?.code ?? ''}`;
  const signedMoney = (value: string) => `${D(value).gt(0) ? '+' : ''}${money(value)}`;

  useEffect(() => {
    if (session || !hasInputs) return;
    let cancelled = false;
    void previewReconciliation(store, { accountId, assetId, statementDate, statementBalance, selectedTransactionIds: selectedIds })
      .then((result) => { if (!cancelled) setPreviewRead({ key: requestKey, context, result }); })
      .catch((cause: unknown) => { if (!cancelled) setPreviewRead({ key: requestKey, context, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { cancelled = true; };
  }, [accountId, assetId, context, hasInputs, requestKey, selectedIds, session, statementBalance, statementDate, store]);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setSessionLoading(true);
    void (async () => {
      const items = await store.reconciliationItems.list({ where: { reconciliationId: session.id } });
      const transactions = await Promise.all(items.map((item) => store.transactions.get(item.transactionId)));
      if (cancelled) return;
      setSessionItems(items);
      setSessionTransactions(Object.fromEntries(transactions.filter((row): row is Transaction => !!row).map((row) => [row.id, row])));
    })().catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setSessionLoading(false); });
    return () => { cancelled = true; };
  }, [retry, session, store]);

  const visibleCandidates = useMemo(() => {
    const query = search.trim().toLowerCase();
    return candidates.filter(({ transaction }) => !query || [transaction.date, transaction.description, transaction.merchant,
      categoryLabel(transaction.category, snap.categories), transaction.amount].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [candidates, search, snap.categories]);
  const selectedRows = candidates.filter((row) => selectedIds.includes(row.transaction.id));
  const staleSelection = !!preview && selectedRows.length !== selectedIds.length;
  const difference = preview ? D(preview.difference) : session ? D(session.difference) : undefined;
  const createAdjustment = adjustmentFor === requestKey && !!preview && !difference?.isZero();
  const canFinish = !!preview && !calculating && !staleSelection && (!!difference?.isZero() || createAdjustment) && !busy && !props.readOnly;
  const openingNote = preview?.previousSession ? `上次已核对至 ${preview.previousSession.statementDate}`
    : account?.openingAssetId === assetId && account.openingBalance !== undefined ? `账户起始余额 · ${account.balanceStartDate ?? ''}` : '未设该币种起始余额，按 0 开始';
  function changeSelection(next: string[]) { setSelectedIds(next); setAdjustmentFor(null); setError(''); }
  function resetCriteria() { changeSelection([]); setSearch(''); setAdjustmentOpen(false); }
  function requestClose() { if (!flight.current) { if (dirty) setDiscardOpen(true); else props.onClose(); } }
  async function finish() {
    if (!canFinish || flight.current) return;
    flight.current = true; setBusy(true); setError('');
    try {
      await closeReconciliation(store, { accountId, assetId, statementDate, statementBalance,
        selectedTransactionIds: selectedIds, createAdjustment, expectedDifference: preview!.difference, note: note.trim() || undefined });
      props.onChanged(); props.onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setAdjustmentFor(null); setRetry((value) => value + 1); }
    finally { flight.current = false; setBusy(false); }
  }
  async function undo() {
    if (!session || flight.current || props.readOnly) return;
    flight.current = true; setBusy(true); setError('');
    try { await undoLatestReconciliation(store, session.id); props.onChanged(); props.onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { flight.current = false; setBusy(false); }
  }

  return <WorkspaceDialog workspace="page" navigationBlocked={dirty || busy} labelledBy={titleId} onDismiss={requestClose} dismissDisabled={busy}
    panelClassName="zc-entity-modal zc-reconciliation-modal"
    panelStyle={{ width: 'min(1120px, calc(100vw - 24px))', maxHeight: '92dvh', overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}
      header={<>
        <div className="zc-reconciliation-head"><div><h2 id={titleId}>{session ? '对账详情' : '核对账单'}</h2><p className="zc-caption">对照银行或钱包账单确认已有流水，不会再次记录同一笔收支。</p></div>
      <button type="button" className="zc-btn zc-btn--icon" aria-label="关闭" onClick={requestClose} disabled={busy}><X size={20} aria-hidden="true" /></button></div>
      </>}
      footer={<>
        <div className="zc-reconciliation-footer"><p className="zc-caption">{session ? '已核对流水受保护；更正时须从该账户、币种的最新一期开始撤销。' : createAdjustment ? `完成时将新增 ${money(difference!.abs().toString())} 的余额调整。` : '完成仅保存核对结果，不新增收支。'}</p>
      <div className="zc-mobile-shortcuts">{session && <button type="button" className="zc-btn zc-btn--danger" disabled={busy || props.readOnly} onClick={() => setUndoOpen(true)}>撤销本次对账</button>}<button type="button" className="zc-btn" disabled={busy} onClick={requestClose}>关闭</button>
        {!session && <button type="button" className="zc-btn zc-btn--primary" disabled={!canFinish} onClick={() => void finish()}>{busy ? '正在完成…' : createAdjustment ? '创建调整并完成对账' : '完成对账'}</button>}</div></div>
      </>}
    >

    <div className="zc-reconciliation-body">
      <CardGroup><h3>填写实际余额</h3><p className="zc-caption">填写银行或钱包在所选截止日的余额。信用卡账单欠款填负数，不填可用额度；每次只核对一个账户的一种币种。</p>
        <fieldset className="zc-reconciliation-inputs" disabled={busy || !!session || props.readOnly}>
          <div className="zc-field"><label htmlFor={`${titleId}-account`}>账户</label><ValuePicker id={`${titleId}-account`} label="账户" value={accountId} disabled={busy || !!session || props.readOnly}
            options={snap.accounts.filter((row) => (!row.isDeleted && !isLegacyExternalAccount(row) && !isSystemDefaultAccount(row) && row.isActive !== false && !row.archivedAt) || (!!session && row.id === accountId)).map((row) => ({ value: row.id, label: row.name }))}
            onChange={(id) => { setAccountId(id); setStatementDate(latestStatementDate(snap.accounts.find((row) => row.id === id)?.statementDay, today())); setStatementBalance(''); resetCriteria(); }} /></div>
          <div className="zc-field"><label htmlFor={`${titleId}-asset`}>币种</label><ValuePicker id={`${titleId}-asset`} label="币种" value={assetId} disabled={busy || !!session || props.readOnly}
            options={snap.assets.filter((row) => (!row.isDeleted && row.isActive) || row.id === assetId).map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))}
            onChange={(id) => { setAssetId(id); setStatementBalance(''); resetCriteria(); }} /></div>
          <label className="zc-field">账单截止日<DateTimeInput className="zc-input" aria-label="账单截止日" disabled={busy || !!session || props.readOnly} type="date" value={statementDate} onChange={(value) => { setStatementDate(value); resetCriteria(); }} /></label>
          <label className="zc-field">账单期末余额<input className="zc-input" aria-label="账单期末余额" disabled={busy || !!session || props.readOnly} inputMode="decimal" placeholder="请填写实际余额，0 也需填写" value={statementBalance} onChange={(event) => { setStatementBalance(event.target.value); setAdjustmentFor(null); setError(''); }} /></label>
        </fieldset>
      </CardGroup>
      {!session && <CardGroup><h3>勾选账单上已有的流水</h3><p className="zc-caption">只勾选这张账单中能对应上的记录。未勾选的流水仍计入账本余额，可以留到下次核对。</p>
        {!hasInputs ? <CardEmpty>先填写账单期末余额，再开始逐笔核对。</CardEmpty> : <>
          <div className="zc-reconciliation-tools"><input className="zc-input" aria-label="搜索对账记录" placeholder="搜索日期、摘要、分类或金额" value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} />
            <button type="button" className="zc-btn" disabled={busy || !visibleCandidates.length} onClick={() => changeSelection([...new Set([...selectedIds, ...visibleCandidates.map((row) => row.transaction.id)])])}>勾选当前列表</button>
            <button type="button" className="zc-btn" disabled={busy || !selectedIds.length} onClick={() => changeSelection([])}>清空全部勾选</button></div>
          <p className="zc-caption">已勾选 {selectedRows.length} / {candidates.length} 笔{search && ` · 当前搜索 ${visibleCandidates.length} 笔`}</p>
          <div className="zc-reconciliation-rows">{visibleCandidates.map(({ transaction, postingAmount }) => <label key={transaction.id} className="zc-reconciliation-candidate">
            <span className="zc-check-target"><input type="checkbox" disabled={busy || props.readOnly} checked={selectedIds.includes(transaction.id)} onChange={(event) => changeSelection(event.target.checked ? [...selectedIds, transaction.id] : selectedIds.filter((id) => id !== transaction.id))} /></span>
            <span>{transaction.date}</span><span>{transaction.description || transaction.merchant || categoryLabel(transaction.category, snap.categories)}</span><span className={D(postingAmount).lt(0) ? 'is-negative' : ''}>{signedMoney(postingAmount)}</span><span>{transaction.status === 'pending' ? '待核实' : '已记录'}</span>
          </label>)}</div>
          {!visibleCandidates.length && !calculating && !readError && <CardEmpty>{search ? '没有匹配的流水，请清除搜索后查看。' : '本次没有待核对流水，请检查账户、币种和截止日期。'}</CardEmpty>}
          {selectedRows.some((row) => row.transaction.status === 'pending') && <p className="zc-caption">勾选的“待核实”流水将在完成对账后改为已核实。</p>}
        </>}
        {!!preview?.excluded?.beforeOpening && <p className="zc-caption">{preview.excluded.beforeOpening} 笔已包含在账户起始余额中，不重复核对。</p>}
        {!!preview?.excluded?.alreadyReconciled && <p className="zc-caption">{preview.excluded.alreadyReconciled} 笔已在以前的账单中核对，本次不重复计入。</p>}
        {!!preview?.excluded?.afterStatement && <p className="zc-caption">{preview.excluded.afterStatement} 笔晚于本次截止日，留待后续核对。</p>}
        {!!preview?.conversionEntries.length && <details className="zc-reconciliation-conversions"><summary>期间资产转换 · 自动计入 {preview.conversionTotal} {asset?.code}</summary><p className="zc-caption">买卖、换汇的账户实扣与到账已自动计入，不能再作为收支重复勾选。</p>
          {preview.conversionEntries.map((row) => <div className="zc-reconciliation-session-row" key={row.id}><span>{row.date}</span><span>资产转换</span><span>{signedMoney(row.postingAmount)}</span></div>)}</details>}
      </CardGroup>}
      <CardGroup><h3>{session ? '已完成的核对结果' : '核对余额与差额'}</h3>
        <div className="zc-card-band is-inset zc-reconciliation-summary">
          <CardMetric label="余额基准" value={session ? money(session.openingBalance) : preview ? money(preview.openingBalance) : '—'} note={session ? '保存时使用的起始或上期余额' : openingNote} />
          <CardMetric label={session ? '本次净变化' : '勾选流水净额'} value={session ? signedMoney(session.selectedTotal) : preview ? signedMoney(D(preview.selectedTotal).minus(preview.conversionTotal).toString()) : '—'} note={session ? '包含资产转换和本次余额调整' : '收入、退款加；支出减；转账按方向'} />
          <CardMetric label="本次核对余额" value={session ? money(session.clearedBalance) : preview ? money(preview.clearedBalance) : '—'} note={session ? '余额基准 + 本次净变化' : '余额基准 + 勾选流水 + 资产转换'} />
          <CardMetric label="差额" value={difference ? money(difference.toString()) : '—'} tone={difference && !difference.isZero() ? 'negative' : 'default'} note="账单期末余额 − 本次核对余额" />
        </div>
        {calculating && <p role="status" className="zc-caption">正在重新计算，请稍候…</p>}
        {readError && <CardAlert tone="danger" role="alert">核对读取失败：{readError}。<button type="button" className="zc-workspace-link" onClick={() => setRetry((value) => value + 1)}>重新计算</button></CardAlert>}
        {staleSelection && <CardAlert tone="warning">部分勾选流水已变化，请清空勾选后重新核对。</CardAlert>}
        {!session && preview && !staleSelection && (difference?.isZero() ? <p className="zc-reconciliation-result" role="status">金额已对齐，核对无误后可完成。{selectedRows.length < candidates.length ? `仍有 ${candidates.length - selectedRows.length} 笔未勾选，保留到后续核对。` : '不会新增收支或再次增减余额。'}</p>
          : <CardAlert tone="warning">账单余额比本次核对余额{difference!.gt(0) ? '多' : '少'} {money(difference!.abs().toString())}。先检查漏记、重复、币种和勾选范围；需要补记时可关闭本页处理后再核对。</CardAlert>)}
        {!session && preview && !difference?.isZero() && <details className="zc-reconciliation-adjustment" open={adjustmentOpen} onToggle={(event) => setAdjustmentOpen(event.currentTarget.open)}><summary>核对后仍有差额：用余额调整处理</summary><p className="zc-caption">这会新增一笔“对账余额调整”，让账户余额{difference!.gt(0) ? '增加' : '减少'} {money(difference!.abs().toString())}，不计入日常收入或支出。请先确认差额原因，避免用调整掩盖漏记。</p>
          <label className="zc-check-row-inline"><span className="zc-check-target"><input type="checkbox" aria-label="我确认用余额调整处理差额" checked={createAdjustment} disabled={busy || props.readOnly} onChange={(event) => setAdjustmentFor(event.target.checked ? requestKey : null)} /></span>我确认用余额调整处理差额</label><p className="zc-caption">修改金额、日期、币种或勾选内容后，需要重新确认。</p></details>}
      </CardGroup>
      {session && <CardGroup><h3>本次确认的记录</h3>
        {sessionLoading ? <p role="status">正在读取对账明细…</p> : sessionItems.map((item) => { const transaction = sessionTransactions[item.transactionId]; return <div className="zc-reconciliation-session-row" key={item.id}><span>{transaction?.date ?? '—'}</span><span>{transaction?.description || transaction?.merchant || (transaction ? categoryLabel(transaction.category, snap.categories) : '原流水已不可用')}</span><span>{signedMoney(item.postingAmount)}</span></div>; })}
        {session.conversionTotal !== undefined && <CardFact label="本次自动计入的资产转换净额" value={money(session.conversionTotal)} />}
        {session.adjustmentTransactionId && <p className="zc-caption">本次含余额调整，已列在上方记录中；撤销本次对账时，这笔调整会作废。</p>}
      </CardGroup>}
      <label className="zc-field zc-reconciliation-note">备注<textarea className="zc-input" aria-label="备注" disabled={busy || !!session || props.readOnly} value={note} onChange={(event) => setNote(event.target.value)} placeholder="可记录账单来源或差额原因" /></label>
      {error && <CardAlert tone="danger" role="alert">{error}</CardAlert>}
    </div>

    {discardOpen && <ConfirmDialog title="关闭未完成的对账" confirmLabel="放弃本次核对" cancelLabel="继续核对" onCancel={() => setDiscardOpen(false)} onConfirm={props.onClose}>输入和勾选尚未保存。放弃后不会改动流水、账户余额或已完成的对账。</ConfirmDialog>}
    {undoOpen && session && <ConfirmDialog title="撤销本次对账" confirmLabel="确认撤销" cancelLabel="取消" tone="danger" busy={busy} onCancel={() => setUndoOpen(false)} onConfirm={undo}>撤销 {session.statementDate} 的核对结果；相关流水恢复对账前状态，本次余额调整（如有）同时作废。</ConfirmDialog>}
  </WorkspaceDialog>;
}
