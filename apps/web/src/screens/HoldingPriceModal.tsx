import { useId, useState } from 'react';
import { D, isValidDay, localToday, newId, type Asset, type PriceMark } from '@zichan/core';
import { useStore } from '../db/store.js';
import { amount, significant } from '../format.js';
import { DialogShell } from '../ui/DialogShell.js';
import { btnOutline, btnPrimary } from '../ui/styles.js';

/** A total holding value is entered as a quote; PriceMark remains a per-unit market price. */
export function holdingUnitPrice(input: string, mode: 'total' | 'unit', holdings: string): string {
  const entered = D(input);
  if (!entered.isFinite() || entered.lte(0)) throw new Error('请输入大于 0 的金额');
  if (mode === 'unit') return entered.toString();
  const quantity = D(holdings);
  if (!quantity.isFinite() || quantity.lte(0)) throw new Error('当前余额必须大于 0，才能按持仓现值折算单价');
  return entered.div(quantity).toString();
}

export function HoldingPriceModal({ asset, quoteAsset, holdings, onSave, onClose }: {
  asset: Asset;
  quoteAsset: Asset;
  holdings: string;
  onSave: () => void;
  onClose: () => void;
}) {
  const { store } = useStore();
  const titleId = useId();
  const canEnterTotal = D(holdings).gt(0);
  const [mode, setMode] = useState<'total' | 'unit'>(canEnterTotal ? 'total' : 'unit');
  const [entered, setEntered] = useState('');
  const [date, setDate] = useState(localToday);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const symbol = quoteAsset.symbol ?? `${quoteAsset.code} `;
  let unitPrice: string | null = null;
  if (entered.trim()) {
    try { unitPrice = holdingUnitPrice(entered, mode, holdings); } catch { /* Show field guidance until save. */ }
  }

  async function save() {
    setError('');
    setBusy(true);
    try {
      if (!isValidDay(date) || date > localToday()) throw new Error('价格日期必须是今天或更早的有效日期');
      if (asset.id === quoteAsset.id) throw new Error('记账币种自身的价格固定为 1');
      const price = holdingUnitPrice(entered, mode, holdings);
      const matching = (await store.priceMarks.list()).find((mark) => !mark.isDeleted && mark.assetId === asset.id
        && mark.quoteAssetId === quoteAsset.id && mark.date === date);
      const mark: PriceMark = matching ? { ...matching, price, source: 'manual' }
        : { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
          assetId: asset.id, quoteAssetId: quoteAsset.id, date, price, source: 'manual' };
      await store.priceMarks.put(mark);
      onSave();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return <DialogShell labelledBy={titleId} onDismiss={onClose} dismissDisabled={busy}
    backdropClassName="zc-backdrop zc-conversion-backdrop" panelClassName="zc-conversion-detail">
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <h2 id={titleId} style={{ flex: 1 }}>补充 {asset.code} 现值 / 价格</h2>
      <button style={btnOutline} disabled={busy} onClick={onClose}>关闭</button>
    </div>
    <p>当前余额 {amount(holdings, asset.decimals)} {asset.code}。价格按 {quoteAsset.code} 计价；这条行情用于现值和报表折算，不会改变历史取得成本。</p>
    {canEnterTotal && <label style={{ display: 'block', marginBottom: 12 }}>填写方式
      <select className="zc-select" aria-label="填写方式" value={mode} onChange={(event) => { setMode(event.target.value as 'total' | 'unit'); setEntered(''); }}>
        <option value="total">当前持仓总现值</option>
        <option value="unit">每单位现价</option>
      </select>
    </label>}
    <label style={{ display: 'block', marginBottom: 12 }}>{mode === 'total' ? `当前持仓总现值（${quoteAsset.code}）` : `每 1 ${asset.code} 现价（${quoteAsset.code}）`}
      <input className="zc-input" aria-label={mode === 'total' ? '当前持仓总现值' : '每单位现价'} inputMode="decimal" value={entered} onChange={(event) => setEntered(event.target.value)} />
    </label>
    <label style={{ display: 'block', marginBottom: 12 }}>价格日期
      <input className="zc-input" aria-label="价格日期" type="date" max={localToday()} value={date} onChange={(event) => setDate(event.target.value)} />
    </label>
    {unitPrice && <p role="status">将保存：1 {asset.code} = {symbol}{significant(unitPrice)}{mode === 'unit' && canEnterTotal ? ` · 当前持仓现值 ${symbol}${significant(D(holdings).times(unitPrice))}` : ''}</p>}
    {error && <p role="alert" style={{ color: 'var(--negative)' }}>{error}</p>}
    <button style={btnPrimary} disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存价格'}</button>
  </DialogShell>;
}
