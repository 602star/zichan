import { useEffect, useState } from 'react';
import { localToday, type Setting } from '@zichan/core';
import { useStore } from '../db/store.js';
import { draftSetting, saveLedgerSetting } from '../db/ledger-settings.js';
import { optionalTransactionFields, transactionFormFieldOptions, transactionFormPresetKeys } from '../transactionFormPrefs.js';

export function TransactionFieldSettings({ setting, baseCurrencyAssetId, usesAccounts }: {
  setting?: Setting;
  baseCurrencyAssetId: string;
  usesAccounts: boolean;
}) {
  const { store, bump, preview } = useStore();
  const [keys, setKeys] = useState(() => optionalTransactionFields(setting, usesAccounts));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setKeys(optionalTransactionFields(setting, usesAccounts)); }, [setting, usesAccounts]);
  const options = transactionFormFieldOptions(usesAccounts);
  const save = async (next: string[]) => {
    if (busy || preview) return;
    setKeys(next); setBusy(true); setError('');
    try {
      await saveLedgerSetting(store, setting, draftSetting(baseCurrencyAssetId, localToday()), { transactionFormOptionalFields: next.join(',') }, '调整记账常用字段');
      bump();
    } catch (cause) {
      setKeys(optionalTransactionFields(setting, usesAccounts));
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally { setBusy(false); }
  };
  return <section className="zc-card zc-transaction-field-settings" aria-label="记账常用字段">
    <h2 className="zc-section-title">记账常用字段</h2>
    <p className="zc-caption">记账弹窗默认使用“常用”，勾选的附加字段直接显示。其他字段可在“更多字段”中临时填写，也可选择“完整”显示全部适用字段。顶部高亮项就是当前模式。</p>
    <p className="zc-meta">类型、账户、金额、分类、日期、时间、描述和附件始终显示；编辑时已有内容也会显示。</p>
    <div className="zc-transaction-field-presets">
      <button type="button" className="zc-btn" disabled={busy || !!preview} onClick={() => void save(transactionFormPresetKeys('common', usesAccounts))}>恢复默认常用</button>
      <button type="button" className="zc-btn" disabled={busy || !!preview} onClick={() => void save([])}>清空附加字段</button>
    </div>
    <div className="zc-transaction-field-options">
      {options.map(({ key, label }) => <label key={key}>
        <input type="checkbox" checked={keys.includes(key)} disabled={busy || !!preview} onChange={(event) => void save(event.target.checked ? [...keys, key] : keys.filter((item) => item !== key))} />
        <span>{label}</span>
      </label>)}
    </div>
    {busy && <p role="status" className="zc-meta">正在保存…</p>}
    {error && <p role="alert" className="zc-entry-field-error">{error}</p>}
  </section>;
}
