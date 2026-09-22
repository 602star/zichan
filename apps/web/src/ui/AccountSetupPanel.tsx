import { ACCOUNT_KINDS } from '../account-fields.js';
import { EarlierBalancePanel } from './EarlierBalancePanel.js';
import { useId, useState } from 'react';
import { D, newId, dayOfInstant, normalizeOccurrence, type Account, type Asset, type Setting } from '@zichan/core';
import { createFundAccount, saveAccountDetails, type SqlLedgerStore } from '@zichan/db';
import { DialogShell } from './DialogShell.js';
import { btnOutline, btnPrimary } from './styles.js';

export function AccountSetupPanel({ store, assets, accounts = [], setting, initial, onSaved, onClose }: {
  store: SqlLedgerStore; assets: Asset[]; accounts?: Account[]; setting?: Setting; initial?: Account;
  onSaved: (account: Account) => void; onClose: () => void;
}) {
  const title = useId();
  const [id] = useState(() => initial?.id ?? newId());
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<Account['kind']>(initial?.kind ?? 'bank');
  const [amount, setAmount] = useState('');
  const [assetId, setAssetId] = useState(setting?.transactionDefaultAssetId ?? setting?.baseCurrencyAssetId ?? assets[0]?.id ?? '');
  const [at, setAt] = useState(() => { const d = new Date(); const zone = setting?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone; const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d); return `${dayOfInstant(d, zone)}T${time}`; });
  const [expense, setExpense] = useState(!!initial && setting?.expenseDefaultAccountId === initial.id);
  const [income, setIncome] = useState(!!initial && setting?.incomeDefaultAccountId === initial.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statementDay, setStatementDay] = useState(String(initial?.statementDay ?? 1));
  const [paymentDay, setPaymentDay] = useState(String(initial?.paymentDueDay ?? 20));
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [details, setDetails] = useState({ platform: initial?.platform ?? '', note: initial?.note ?? '', creditLimit: initial?.creditLimit ?? '',
    loanPrincipal: initial?.loanPrincipal ?? '', annualInterestRate: initial?.annualInterestRate ?? '', loanStartDate: initial?.loanStartDate ?? '', loanEndDate: initial?.loanEndDate ?? '' });
  const [active, setActive] = useState(initial?.isActive !== false);
  const detailField = (key: keyof typeof details, label: string, type = 'text') => <label className="zc-field">{label}<input className="zc-input" type={type} value={details[key]} onChange={(event) => setDetails((value) => ({ ...value, [key]: event.target.value }))} /></label>;
  return <DialogShell labelledBy={title} onDismiss={onClose} dismissDisabled={busy} panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', width: 'min(540px, calc(100vw - 24px))', maxHeight: '90dvh', overflow: 'auto', padding: 24 }}>
    <h2 id={title}>{initial ? '编辑账户' : '添加银行卡或钱包'}</h2>
    <p className="zc-meta">{initial ? '编辑账户资料和默认用途。余额起点通过单独的核对流程调整。' : '以前的收支会完整保留。从填写的余额起点开始分账户记账，旧记录可以稍后整理。'}</p>
    <form onSubmit={(event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void (async () => {
      try {
        if (!name.trim() || (!initial && amount.trim() === '')) throw new Error('请填写账户名称和当前余额');
        if (!active && (expense || income)) throw new Error('停用账户前请取消默认付款和收款用途');
        const occurrence = normalizeOccurrence({ date: at.slice(0, 10), time: at.slice(11), timezone: setting?.timezone });
        const account: Account = {
          id, createdAt: '', updatedAt: '', version: 1, isDeleted: false, ...initial, isActive: active,
          name: name.trim(), kind, openingBalance: initial?.openingBalance ?? (initial ? undefined : D(amount).toString()), openingAssetId: initial?.openingAssetId ?? assetId,
          platform: details.platform.trim(), note: details.note.trim(),
          creditLimit: kind === 'credit_card' && details.creditLimit.trim() ? D(details.creditLimit).toString() : undefined,
          loanPrincipal: kind === 'loan' && details.loanPrincipal.trim() ? D(details.loanPrincipal).toString() : undefined,
          annualInterestRate: kind === 'loan' && details.annualInterestRate.trim() ? D(details.annualInterestRate).toString() : undefined,
          loanStartDate: kind === 'loan' ? details.loanStartDate || undefined : undefined,
          loanEndDate: kind === 'loan' ? details.loanEndDate || undefined : undefined,
          balanceStartAt: occurrence.occurredAtUtc, balanceStartDate: occurrence.date,
          statementDay: kind === 'credit_card' ? Number(statementDay) : undefined,
          paymentDueDay: kind === 'credit_card' ? Number(paymentDay) : undefined,
        };
        const input = { account, defaultExpense: expense, defaultIncome: income };
        const saved = initial ? await saveAccountDetails(store, input) : await createFundAccount(store, input);
        onSaved(saved);
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setBusy(false); }
    })(); }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <label className="zc-field">账户类型<select className="zc-select" value={kind} onChange={(e) => setKind(e.target.value as Account['kind'])}>
        {ACCOUNT_KINDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <label className="zc-field">账户名称<input autoFocus className="zc-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：微信零钱" required /></label>
      {!initial && <label className="zc-field">当前余额<input className="zc-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>}
      {(kind === 'credit_card' || kind === 'loan') && <p className="zc-meta">欠款请填负数，例如欠款 500 元填写 -500。</p>}
      {kind === 'credit_card' && <div><label>账单日<input className="zc-input" type="number" min="1" max="31" value={statementDay} onChange={(e) => setStatementDay(e.target.value)} /></label><label>还款日<input className="zc-input" type="number" min="1" max="31" value={paymentDay} onChange={(e) => setPaymentDay(e.target.value)} /></label></div>}
      {!initial && <>
      <label className="zc-field">币种<select className="zc-select" value={assetId} onChange={(e) => setAssetId(e.target.value)}>{assets.filter((a) => a.isActive && !a.isDeleted).map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select></label>
      <label className="zc-field">余额截至<input className="zc-input" type="datetime-local" step="1" value={at} onChange={(e) => setAt(e.target.value)} required /></label>
      <p className="zc-meta">这笔余额作为计算起点，不算收入。时间按账本时区 {setting?.timezone ?? '当前设备时区'} 记录。</p>
      </>}
      {initial && <div className="zc-meta">余额起点：{initial.balanceStartDate ?? '未设置'} · {initial.openingBalance ?? '—'} {assets.find((asset) => asset.id === initial.openingAssetId)?.code}
        {initial.balanceStartAt && <button type="button" style={btnOutline} onClick={() => setBalanceOpen(true)}>修正余额起点（从更早日期核算）</button>}
      </div>}
      <details open={!!initial && Object.values(details).some(Boolean)}><summary>更多信息</summary>
        {detailField('platform', '平台')}{detailField('note', '备注')}
        {kind === 'credit_card' && detailField('creditLimit', '信用额度')}
        {kind === 'loan' && <>{detailField('loanPrincipal', '贷款本金')}{detailField('annualInterestRate', '年利率（%）')}{detailField('loanStartDate', '贷款开始日期', 'date')}{detailField('loanEndDate', '贷款结束日期', 'date')}</>}
      </details>
      {initial && <label><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />启用</label>}
      <p className="zc-meta">当前默认付款：{setting?.expenseDefaultAccountId === id ? name : accounts.find((row) => row.id === setting?.expenseDefaultAccountId)?.name ?? '未设置'}；默认收款：{setting?.incomeDefaultAccountId === id ? name : accounts.find((row) => row.id === setting?.incomeDefaultAccountId)?.name ?? '未设置'}。取消当前默认用途将恢复到系统默认收支账户。</p>
      <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={expense} onChange={(e) => setExpense(e.target.checked)} />今后支出默认使用这个账户</label>
      <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={income} onChange={(e) => setIncome(e.target.checked)} />今后收入默认使用这个账户</label>
      {error && <p role="alert" style={{ color: 'var(--negative)' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}><button type="submit" style={btnPrimary} disabled={busy}>{busy ? '正在保存…' : initial ? '保存' : '保存并开始使用'}</button><button type="button" style={btnOutline} disabled={busy} onClick={onClose}>取消</button></div>
      </fieldset>
    </form>
    {initial && balanceOpen && <EarlierBalancePanel store={store} account={initial} setting={setting} onClose={() => setBalanceOpen(false)} onSaved={() => { setBalanceOpen(false); onSaved(initial); }} />}
  </DialogShell>;
}
