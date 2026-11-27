import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { D, isValidDay, localToday, newId, type Asset, type PriceMark } from '@zichan/core';
import { useStore } from '../db/store.js';
import { sanitizeNumericInput } from '../form-number.js';
import { amount, significant } from '../format.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DateTimeInput } from '../ui/DateTimeInput.js';
import { DialogShell } from '../ui/DialogShell.js';

/** A total holding value is entered as a quote; PriceMark remains a per-unit market price. */
export function holdingUnitPrice(input: string, mode: 'total' | 'unit', holdings: string): string {
  const entered = D(sanitizeNumericInput(input));
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
  const [discardOpen, setDiscardOpen] = useState(false);
  const symbol = quoteAsset.symbol ?? `${quoteAsset.code} `;
  const dirty = entered.trim().length > 0;
  let unitPrice: string | null = null;
  if (entered.trim()) {
    try { unitPrice = holdingUnitPrice(entered, mode, holdings); } catch { /* Show field guidance until save. */ }
  }

  function requestClose() {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  }

  async function save() {
    if (busy) return;
    setError('');
    const cleaned = sanitizeNumericInput(entered);
    if (cleaned !== entered) setEntered(cleaned);
    setBusy(true);
    try {
      if (!isValidDay(date) || date > localToday()) throw new Error('价格日期必须是今天或更早的有效日期');
      if (asset.id === quoteAsset.id) throw new Error('记账币种自身的价格固定为 1');
      const price = holdingUnitPrice(cleaned, mode, holdings);
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

  return <DialogShell
    labelledBy={titleId}
    onDismiss={requestClose}
    dismissDisabled={busy}
    onSaveShortcut={() => void save()}
    backdropClassName="zc-backdrop zc-conversion-backdrop"
    panelClassName="zc-conversion-detail"
    header={<>
      <div className="zc-modal-header">
        <h2 id={titleId} className="zc-modal-title">补充 {asset.code} 现值 / 价格</h2>
        <button type="button" className="zc-dialog-close" aria-label="关闭" title="关闭 (Esc)" disabled={busy} onClick={requestClose}><X size={20} aria-hidden="true" /></button>
      </div>
    </>}
    footer={<>
      {error && <div role="alert" className="zc-modal-footer-error">{error}</div>}
      <div className="zc-modal-footer zc-modal-footer--end">
        <button type="button" className="zc-btn" disabled={busy} onClick={requestClose}>取消</button>
        <button type="button" className="zc-btn zc-btn--primary" title="保存价格 (Ctrl+Enter)" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存价格'}</button>
      </div>
    </>}
  >
    <p>当前余额 {amount(holdings, asset.decimals)} {asset.code}。价格按 {quoteAsset.code} 计价；这条行情用于现值和报表折算，不会改变历史取得成本。</p>
    {canEnterTotal && <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="zc-label">填写方式</span>
      <select className="zc-select" aria-label="填写方式" value={mode} onChange={(event) => { setMode(event.target.value as 'total' | 'unit'); setEntered(''); setError(''); }}>
        <option value="total">当前持仓总现值</option>
        <option value="unit">每单位现价</option>
      </select>
    </label>}
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="zc-label">{mode === 'total' ? `当前持仓总现值（${quoteAsset.code}）` : `每 1 ${asset.code} 现价（${quoteAsset.code}）`}</span>
      <input
        className="zc-input"
        aria-label={mode === 'total' ? '当前持仓总现值' : '每单位现价'}
        aria-invalid={error.includes('金额') || undefined}
        inputMode="decimal"
        value={entered}
        onChange={(event) => { setError(''); setEntered(event.target.value); }}
        onBlur={(event) => {
          const cleaned = sanitizeNumericInput(event.target.value);
          if (cleaned !== event.target.value) setEntered(cleaned);
        }}
        onKeyDown={(event) => { if (event.key === 'Enter') void save(); }}
      />
    </label>
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="zc-label">价格日期</span>
      <DateTimeInput className="zc-input" aria-label="价格日期" type="date" max={localToday()} value={date} onChange={(next) => { setError(''); setDate(next); }} required />
    </label>
    {unitPrice && <p role="status">将保存：1 {asset.code} = {symbol}{significant(unitPrice)}{mode === 'unit' && canEnterTotal ? ` · 当前持仓现值 ${symbol}${significant(D(holdings).times(unitPrice))}` : ''}</p>}
    {discardOpen && (
      <ConfirmDialog
        title="放弃未保存的价格"
        confirmLabel="放弃并关闭"
        cancelLabel="继续填写"
        tone="danger"
        onCancel={() => setDiscardOpen(false)}
        onConfirm={onClose}
      >
        当前填写的价格尚未保存，确定放弃并关闭吗？
      </ConfirmDialog>
    )}
  </DialogShell>;
}
