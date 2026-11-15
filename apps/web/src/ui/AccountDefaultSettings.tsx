import { useEffect, useId, useState } from 'react';
import { defaultTransactionAccount, isLegacyExternalAccount, type Account, type Setting } from '@zichan/core';
import { setDefaultTransactionAccounts } from '@zichan/db';
import { useStore } from '../db/store.js';
import { Card } from './Card.js';
import { ValuePicker } from './ValuePicker.js';

export function AccountDefaultSettings({ accounts, setting }: { accounts: Account[]; setting?: Setting }) {
  const { store, preview, bump } = useStore();
  const id = useId();
  const readOnly = !!preview;
  const currentExpense = defaultTransactionAccount(accounts, setting, 'expense') ?? '';
  const currentIncome = defaultTransactionAccount(accounts, setting, 'income') ?? '';
  const [expense, setExpense] = useState(currentExpense);
  const [income, setIncome] = useState(currentIncome);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { setExpense(currentExpense); setIncome(currentIncome); }, [currentExpense, currentIncome]);
  const options = accounts.filter((account) => !account.isDeleted && account.isActive !== false && !account.archivedAt && !isLegacyExternalAccount(account))
    .map((account) => ({ value: account.id, label: account.name }));
  async function save() {
    if (busy || preview) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await setDefaultTransactionAccounts(store, { expenseAccountId: expense, incomeAccountId: income, expectedVersion: setting?.version });
      bump(); setNotice('默认收支账户已保存');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <Card title="默认收支账户" note="未手动选择账户时使用" className="zc-account-defaults"
    action={<button type="button" className="zc-btn zc-btn--primary" disabled={readOnly || busy || !expense || !income || (expense === currentExpense && income === currentIncome)} onClick={() => void save()}>{busy ? '正在保存…' : '保存默认设置'}</button>}>
    <div className="zc-account-default-grid">
      <label className="zc-field" htmlFor={`${id}-expense`}><span>默认支出账户</span><ValuePicker id={`${id}-expense`} label="默认支出账户" value={expense} options={options} disabled={busy || readOnly} onChange={(value) => { setExpense(value); setNotice(''); }} /></label>
      <label className="zc-field" htmlFor={`${id}-income`}><span>默认收入账户</span><ValuePicker id={`${id}-income`} label="默认收入账户" value={income} options={options} disabled={busy || readOnly} onChange={(value) => { setIncome(value); setNotice(''); }} /></label>
    </div>
    <p className="zc-caption zc-account-default-note">只影响之后的新收支，已有记录保持原账户。支出和收入可以使用同一个账户。</p>
    {error && <p role="alert" className="zc-account-error">{error}</p>}
    {notice && <p role="status" className="zc-caption">{notice}</p>}
  </Card>;
}
