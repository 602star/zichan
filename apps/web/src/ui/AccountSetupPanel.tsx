import { useId, useState } from 'react';
import { D, newId, dayOfInstant, normalizeOccurrence, type Account, type Asset, type Setting } from '@zichan/core';
import { createFundAccount, type SqlLedgerStore } from '@zichan/db';
import { DialogShell } from './DialogShell.js';
import { btnOutline, btnPrimary } from './styles.js';

export function AccountSetupPanel({ store, assets, setting, onSaved, onClose }: {
  store: SqlLedgerStore; assets: Asset[]; setting?: Setting;
  onSaved: (account: Account) => void; onClose: () => void;
}) {
  const title = useId();
  const [id] = useState(newId);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Account['kind']>('bank');
  const [amount, setAmount] = useState('');
  const [assetId, setAssetId] = useState(setting?.transactionDefaultAssetId ?? setting?.baseCurrencyAssetId ?? assets[0]?.id ?? '');
  const [at, setAt] = useState(() => { const d = new Date(); const zone = setting?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone; const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d); return `${dayOfInstant(d, zone)}T${time}`; });
  const [expense, setExpense] = useState(false);
  const [income, setIncome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statementDay, setStatementDay] = useState('1');
  const [paymentDay, setPaymentDay] = useState('20');
  return <DialogShell labelledBy={title} onDismiss={onClose} dismissDisabled={busy} panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', width: 'min(540px, calc(100vw - 24px))', maxHeight: '90dvh', overflow: 'auto', padding: 24 }}>
    <h2 id={title}>添加银行卡或钱包</h2>
    <p className="zc-meta">以前的收支会完整保留。从填写的余额起点开始分账户记账，旧记录可以稍后整理。</p>
    <form onSubmit={(event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void (async () => {
      try {
        if (!name.trim() || amount.trim() === '') throw new Error('请填写账户名称和当前余额');
        const occurrence = normalizeOccurrence({ date: at.slice(0, 10), time: at.slice(11), timezone: setting?.timezone });
        const saved = await createFundAccount(store, { account: {
          id, createdAt: '', updatedAt: '', version: 1, isDeleted: false, isActive: true,
          name: name.trim(), kind, openingBalance: D(amount).toString(), openingAssetId: assetId,
          balanceStartAt: occurrence.occurredAtUtc, balanceStartDate: occurrence.date,
          statementDay: kind === 'credit_card' ? Number(statementDay) : undefined,
          paymentDueDay: kind === 'credit_card' ? Number(paymentDay) : undefined,
        }, defaultExpense: expense, defaultIncome: income });
        onSaved(saved);
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setBusy(false); }
    })(); }}>
      <label className="zc-field">账户类型<select className="zc-select" value={kind} onChange={(e) => setKind(e.target.value as Account['kind'])}>
        <option value="bank">银行卡</option><option value="wallet">微信 / 支付宝 / 钱包</option><option value="cash">现金</option><option value="credit_card">信用卡</option><option value="loan">贷款</option><option value="exchange">投资账户</option>
      </select></label>
      <label className="zc-field">账户名称<input autoFocus className="zc-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：微信零钱" required /></label>
      <label className="zc-field">当前余额<input className="zc-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
      {(kind === 'credit_card' || kind === 'loan') && <p className="zc-meta">欠款请填负数，例如欠款 500 元填写 -500。</p>}
      {kind === 'credit_card' && <div><label>账单日<input className="zc-input" type="number" min="1" max="31" value={statementDay} onChange={(e) => setStatementDay(e.target.value)} /></label><label>还款日<input className="zc-input" type="number" min="1" max="31" value={paymentDay} onChange={(e) => setPaymentDay(e.target.value)} /></label></div>}
      <label className="zc-field">币种<select className="zc-select" value={assetId} onChange={(e) => setAssetId(e.target.value)}>{assets.filter((a) => a.isActive && !a.isDeleted).map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select></label>
      <label className="zc-field">余额截至<input className="zc-input" type="datetime-local" step="1" value={at} onChange={(e) => setAt(e.target.value)} required /></label>
      <p className="zc-meta">这笔余额作为计算起点，不算收入。时间按账本时区 {setting?.timezone ?? '当前设备时区'} 记录。</p>
      <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={expense} onChange={(e) => setExpense(e.target.checked)} />今后支出默认使用这个账户</label>
      <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={income} onChange={(e) => setIncome(e.target.checked)} />今后收入默认使用这个账户</label>
      {error && <p role="alert" style={{ color: 'var(--negative)' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}><button type="submit" style={btnPrimary} disabled={busy}>{busy ? '正在保存…' : '保存并开始使用'}</button><button type="button" style={btnOutline} disabled={busy} onClick={onClose}>稍后添加，先开始</button></div>
    </form>
  </DialogShell>;
}
