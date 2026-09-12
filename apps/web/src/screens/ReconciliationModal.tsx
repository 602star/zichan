import { useEffect, useId, useMemo, useState } from 'react';
import {
  D,
  localToday,
  type ReconciliationItem,
  type ReconciliationSession,
  type Transaction,
} from '@zichan/core';
import {
  closeReconciliation,
  previewReconciliation,
  undoLatestReconciliation,
  type ReconciliationPreview,
  type SqlLedgerStore,
} from '@zichan/db';
import type { Snapshot } from '../db/snapshot.js';
import { categoryLabel } from '../transactionMeta.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DialogShell } from '../ui/DialogShell.js';

const inputStyle = {
  width: '100%', height: 40, border: '1px solid var(--border)', borderRadius: 8,
  background: 'var(--surface)', color: 'var(--fg)', padding: '0 11px', fontSize: 13,
} as const;
const button = {
  minHeight: 38, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--fg-muted)', fontWeight: 800, cursor: 'pointer',
} as const;
const primary = { ...button, borderColor: 'var(--accent)', background: 'var(--accent)', color: '#fff' } as const;

export function latestStatementDate(statementDay: number | undefined, today = localToday()): string {
  if (!statementDay) return today;
  const [year, month, day] = today.split('-').map(Number);
  const currentMonth = new Date(Date.UTC(year!, month! - 1, 1));
  const currentMonthLastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const currentStatementDay = Math.min(statementDay, currentMonthLastDay);
  if (day! < currentStatementDay) currentMonth.setUTCMonth(currentMonth.getUTCMonth() - 1);
  const targetYear = currentMonth.getUTCFullYear();
  const targetMonth = currentMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(statementDay, lastDay)).padStart(2, '0')}`;
}

interface Props {
  store: SqlLedgerStore;
  snap: Snapshot;
  session?: ReconciliationSession;
  initialAccountId: string;
  initialAssetId: string;
  onClose: () => void;
  onChanged: () => void;
}

export function ReconciliationModal(props: Props) {
  const titleId = useId();
  const { store, snap, session } = props;
  const [accountId, setAccountId] = useState(session?.accountId ?? props.initialAccountId);
  const [assetId, setAssetId] = useState(session?.assetId ?? props.initialAssetId);
  const initialAccount = snap.accounts.find((account) => account.id === (session?.accountId ?? props.initialAccountId));
  const [statementDate, setStatementDate] = useState(
    session?.statementDate ?? latestStatementDate(initialAccount?.statementDay),
  );
  const [statementBalance, setStatementBalance] = useState(session?.statementBalance ?? '0');
  const [note, setNote] = useState(session?.note ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ReconciliationPreview | null>(null);
  const [createAdjustment, setCreateAdjustment] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionItems, setSessionItems] = useState<ReconciliationItem[]>([]);
  const [sessionTransactions, setSessionTransactions] = useState<Record<string, Transaction>>({});
  const [undoOpen, setUndoOpen] = useState(false);

  useEffect(() => {
    if (session) return;
    let cancelled = false;
    setError('');
    void previewReconciliation(store, {
      accountId, assetId, statementDate, statementBalance,
      selectedTransactionIds: selectedIds,
    }).then((result) => {
      if (!cancelled) setPreview(result);
    }).catch((reason) => {
      if (!cancelled) {
        setPreview(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { cancelled = true; };
  }, [accountId, assetId, selectedIds, session, statementBalance, statementDate, store]);
  useEffect(() => {
    if (!session) {
      setSessionItems([]);
      setSessionTransactions({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const items = await store.reconciliationItems.list({ where: { reconciliationId: session.id } });
      const transactions = await Promise.all(items.map((item) => store.transactions.get(item.transactionId)));
      if (cancelled) return;
      setSessionItems(items);
      setSessionTransactions(Object.fromEntries(
        transactions.filter((row): row is Transaction => !!row).map((row) => [row.id, row]),
      ));
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [session, store]);
  const visibleCandidates = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return preview?.candidates ?? [];
    return (preview?.candidates ?? []).filter(({ transaction }) => [
      transaction.date, transaction.description, transaction.merchant,
      categoryLabel(transaction.category, snap.categories), transaction.amount,
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [preview, search, snap.categories]);

  async function finish() {
    setBusy(true);
    setError('');
    try {
      await closeReconciliation(store, {
        accountId, assetId, statementDate, statementBalance,
        selectedTransactionIds: selectedIds,
        createAdjustment,
        note: note.trim() || undefined,
      });
      props.onChanged();
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      await undoLatestReconciliation(store, session.id);
      props.onChanged();
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }

  const difference = D(preview?.difference ?? session?.difference ?? 0);
  return (
    <DialogShell
      labelledBy={titleId}
      onDismiss={props.onClose}
      dismissDisabled={busy}
      backdropStyle={{ zIndex: 90, background: 'rgba(33, 30, 27, .42)' }}
      panelClassName="zc-reconciliation-modal"
      panelStyle={{ width: 'min(1120px, 96vw)', maxHeight: '92dvh', overflow: 'hidden', background: 'var(--surface)', color: 'var(--fg)', borderRadius: 8, boxShadow: '0 24px 70px rgba(0,0,0,.24)', display: 'flex', flexDirection: 'column' }}
    >
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
          <div><div id={titleId} style={{ fontSize: 18, fontWeight: 900 }}>{session ? '对账详情' : '银行对账'}</div><div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-subtle)' }}>按银行账单逐笔核对账户分录</div></div>
          <button type="button" data-dialog-initial-focus onClick={props.onClose} disabled={busy} aria-label="关闭" style={{ ...button, minWidth: 40, padding: 0 }}>×</button>
        </div>

        <div style={{ overflowY: 'auto', padding: 24 }}>
          <div className="zc-reconciliation-inputs" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr', gap: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 800 }}>账户<select disabled={!!session} value={accountId} onChange={(event) => {
              const nextId = event.target.value;
              setAccountId(nextId);
              setStatementDate(latestStatementDate(snap.accounts.find((account) => account.id === nextId)?.statementDay));
              setSelectedIds([]);
            }} style={{ ...inputStyle, marginTop: 6 }}>{snap.accounts.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
            <label style={{ fontSize: 12, fontWeight: 800 }}>币种<select disabled={!!session} value={assetId} onChange={(event) => { setAssetId(event.target.value); setSelectedIds([]); }} style={{ ...inputStyle, marginTop: 6 }}>{snap.assets.map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
            <label style={{ fontSize: 12, fontWeight: 800 }}>账单截止日<input disabled={!!session} type="date" value={statementDate} onChange={(event) => { setStatementDate(event.target.value); setSelectedIds([]); }} style={{ ...inputStyle, marginTop: 6 }} /></label>
            <label style={{ fontSize: 12, fontWeight: 800 }}>银行期末余额<input disabled={!!session} inputMode="decimal" value={statementBalance} onChange={(event) => setStatementBalance(event.target.value)} style={{ ...inputStyle, marginTop: 6 }} /></label>
          </div>

          <div className="zc-reconciliation-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', marginTop: 18, borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
            {[
              ['上次期末', session?.openingBalance ?? preview?.openingBalance ?? '0'],
              ['本次勾选', session?.selectedTotal ?? preview?.selectedTotal ?? '0'],
              ['核对后余额', session?.clearedBalance ?? preview?.clearedBalance ?? '0'],
              ['差额', session?.difference ?? preview?.difference ?? '0'],
            ].map(([label, value]) => <div key={label} style={{ padding: '14px 12px' }}><div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 800 }}>{label}</div><div style={{ marginTop: 5, fontSize: 18, fontWeight: 900, color: label === '差额' && !D(value).isZero() ? 'var(--negative)' : 'var(--fg)' }}>{value}</div></div>)}
          </div>

          {!session && (
            <>
              <div style={{ display: 'flex', gap: 10, marginTop: 18, alignItems: 'center' }}>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索日期、摘要、商户、分类或金额" style={{ ...inputStyle, flex: 1 }} />
                <button type="button" onClick={() => setSelectedIds(preview?.candidates.filter((row) => row.transaction.status !== 'pending').map((row) => row.transaction.id) ?? [])} style={button}>勾选已清算</button>
                <button type="button" onClick={() => setSelectedIds([])} style={button}>清空</button>
              </div>
              <div style={{ marginTop: 10, borderTop: '1px solid var(--border)' }}>
                {visibleCandidates.map(({ transaction, postingAmount }) => (
                  <label key={transaction.id} className="zc-reconciliation-candidate" style={{ minHeight: 48, display: 'grid', gridTemplateColumns: '28px 100px minmax(0, 1fr) 130px 90px', gap: 10, alignItems: 'center', borderBottom: '1px solid var(--border)', fontSize: 12, cursor: 'pointer' }}>
                    <span className="zc-check-target"><input type="checkbox" checked={selectedIds.includes(transaction.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, transaction.id] : current.filter((id) => id !== transaction.id))} /></span>
                    <span style={{ color: 'var(--fg-subtle)' }}>{transaction.date}</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{transaction.description ?? transaction.merchant ?? categoryLabel(transaction.category, snap.categories)}</span>
                    <b style={{ textAlign: 'right' }}>{postingAmount}</b>
                    <span style={{ color: transaction.status === 'pending' ? 'var(--warning)' : 'var(--fg-subtle)' }}>{transaction.status === 'pending' ? '待清算' : '已清算'}</span>
                  </label>
                ))}
                {visibleCandidates.length === 0 && <div style={{ padding: 24, color: 'var(--fg-subtle)', fontSize: 13, textAlign: 'center' }}>没有可核对的流水</div>}
              </div>
            </>
          )}

          {session && (
            <div style={{ marginTop: 18, borderTop: '1px solid var(--border)' }}>
              {sessionItems.map((item) => {
                const transaction = sessionTransactions[item.transactionId];
                return <div key={item.id} className="zc-reconciliation-session-row" style={{ minHeight: 46, display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr) 130px', gap: 12, alignItems: 'center', borderBottom: '1px solid var(--border)', fontSize: 12 }}><span>{transaction?.date ?? '—'}</span><span>{transaction?.description ?? transaction?.merchant ?? transaction?.category ?? item.transactionId}</span><b style={{ textAlign: 'right' }}>{item.postingAmount}</b></div>;
              })}
            </div>
          )}

          <label style={{ display: 'block', marginTop: 16, fontSize: 12, fontWeight: 800 }}>备注<textarea disabled={!!session} value={note} onChange={(event) => setNote(event.target.value)} style={{ ...inputStyle, minHeight: 70, padding: 10, marginTop: 6, resize: 'vertical' }} /></label>
          {error && <div role="alert" style={{ marginTop: 12, color: 'var(--negative)', fontSize: 12, fontWeight: 800 }}>{error}</div>}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          {session
            ? <button type="button" disabled={busy} onClick={() => setUndoOpen(true)} style={{ ...button, color: 'var(--negative)', borderColor: 'var(--negative)' }}>{busy ? '处理中…' : '撤销本次对账'}</button>
            : <label className="zc-check-row-inline" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, fontWeight: 800, color: difference.isZero() ? 'var(--fg-subtle)' : 'var(--fg)' }}><span className="zc-check-target"><input type="checkbox" disabled={difference.isZero()} checked={createAdjustment && !difference.isZero()} onChange={(event) => setCreateAdjustment(event.target.checked)} /></span>创建 {difference.abs().toString()} 的余额调整流水</label>}
          <div style={{ display: 'flex', gap: 8 }}><button type="button" disabled={busy} onClick={props.onClose} style={button}>关闭</button>{!session && <button type="button" disabled={busy || !preview || (!difference.isZero() && !createAdjustment)} onClick={() => void finish()} style={primary}>{busy ? '正在完成…' : '完成对账'}</button>}</div>
        </div>
        {undoOpen && session && (
          <ConfirmDialog
            title="撤销本次对账"
            confirmLabel="确认撤销"
            cancelLabel="取消"
            tone="danger"
            busy={busy}
            onCancel={() => setUndoOpen(false)}
            onConfirm={undo}
          >
            确定撤销 {session.statementDate} 的对账？相关流水将恢复到对账前状态。
          </ConfirmDialog>
        )}
    </DialogShell>
  );
}
