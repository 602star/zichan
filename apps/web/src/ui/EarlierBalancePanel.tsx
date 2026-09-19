import { useId, useState } from 'react';
import { D, normalizeOccurrence, type Account, type Setting } from '@zichan/core';
import { applyEarlierBalance, previewEarlierBalance, type SqlLedgerStore, type EarlierBalanceInput } from '@zichan/db';
import { DialogShell } from './DialogShell.js';
import { btnOutline, btnPrimary } from './styles.js';

export function EarlierBalancePanel({ store, account, setting, onSaved, onClose }: {
  store: SqlLedgerStore; account: Account; setting?: Setting; onSaved: () => void; onClose: () => void;
}) {
  const title = useId();
  const [at, setAt] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewEarlierBalance>> | null>(null);
  const [input, setInput] = useState<EarlierBalanceInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <DialogShell labelledBy={title} onDismiss={onClose} dismissDisabled={busy} panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', width: 'min(540px, calc(100vw - 24px))', maxHeight: '90dvh', overflow: 'auto', padding: 24 }}>
    <h2 id={title}>从更早日期核算</h2>
    <p>{account.name} · 现有余额起点 {account.balanceStartDate}，余额 {account.openingBalance}。</p>
    <p className="zc-meta">先补齐两个起点之间的收支、转账和账户归属，再填写可靠的更早余额。核对一致后才能前移；原余额会保留为核对参照，不会重复累加。</p>
    <label className="zc-field">更早的余额截至时间<input className="zc-input" type="datetime-local" step="1" value={at} onChange={(e) => { setAt(e.target.value); setPreview(null); }} /></label>
    <label className="zc-field">当时实际余额<input className="zc-input" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setPreview(null); }} /></label>
    {preview && <div role="status"><p>按已录入记录推算原起点余额：{preview.reconstructed}</p><p>与原已知余额的差额：{preview.difference}</p>{!D(preview.difference).isZero() && <p>请先补齐漏记、核实账户归属或更早余额，再重新预览。</p>}</div>}
    {error && <p role="alert">{error}</p>}
    <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
      <button style={btnOutline} disabled={busy || !at || amount.trim() === ''} onClick={() => void run(async () => {
        const occurrence = normalizeOccurrence({ date: at.slice(0, 10), time: at.slice(11), timezone: setting?.timezone });
        const next = { accountId: account.id, openingBalance: amount, balanceStartAt: occurrence.occurredAtUtc!, balanceStartDate: occurrence.date };
        setInput(next); setPreview(await previewEarlierBalance(store, next));
      })}>预览核对差额</button>
      {preview && input && <button style={btnPrimary} disabled={busy || !D(preview.difference).isZero()} onClick={() => void run(async () => { await applyEarlierBalance(store, input, preview.signature); onSaved(); })}>确认前移余额起点</button>}
      <button style={btnOutline} disabled={busy} onClick={onClose}>关闭</button>
    </div>
  </DialogShell>;
}
