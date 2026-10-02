import { useId, useState } from 'react';
import { D, localToday, normalizeOccurrence, sum } from '@zichan/core';
import { confirmCostBasisOpening, previewCostBasisOpening, type CostOpeningPreview } from '@zichan/db';
import { useStore } from '../db/store.js';
import { useSnapshot } from '../db/snapshot.js';
import { moduleCurrencyId } from '../currencyPreferences.js';
import { amount, significant } from '../format.js';
import { DialogShell } from '../ui/DialogShell.js';
import { btnOutline, btnPrimary } from '../ui/styles.js';

export function CostBasisOpeningModal({ onClose, onConfirmed }: { onClose: () => void; onConfirmed?: () => void }) {
  const { store, bump } = useStore();
  const snap = useSnapshot('convert');
  const titleId = useId();
  const [date, setDate] = useState(localToday);
  const [time, setTime] = useState(() => new Date().toTimeString().slice(0, 8));
  const [currency, setCurrency] = useState('');
  const [preview, setPreview] = useState<CostOpeningPreview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!snap) return null;
  const baseId = currency || snap.costState?.baseCurrencyAssetId || moduleCurrencyId(snap.setting, 'investment', snap.assets[0]?.id ?? '');
  const code = (id: string) => snap.assets.find((asset) => asset.id === id)?.code ?? '未知资产';
  const timezone = snap.setting?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function calculate() {
    setBusy(true); setError('');
    try {
      const occurrence = normalizeOccurrence({ date, time, timezone });
      if (!occurrence.occurredAtUtc) throw new Error('请填写准确时间');
      setPreview(await previewCostBasisOpening(store, occurrence.occurredAtUtc, baseId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  function review() {
    setError('');
    try {
      for (const item of preview?.opening.items ?? []) {
        if (item.costInBase !== null && (!item.costInBase.trim() || !D(item.costInBase).isFinite() || D(item.costInBase).lt(0))) throw new Error(`${code(item.assetId)} 的原始成本必须是有效非负数，或明确保留为未知`);
      }
      setReviewing(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true); setError('');
    try { await confirmCostBasisOpening(store, preview); bump(); onConfirmed?.(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setReviewing(false); setBusy(false); }
  }
  const changeCost = (id: string, costInBase: string | null) => setPreview((current) => current && ({ ...current, opening: { ...current.opening,
    items: current.opening.items.map((item) => item.id === id ? { ...item, costInBase } : item) } }));
  return <DialogShell labelledBy={titleId} onDismiss={onClose} dismissDisabled={busy} panelClassName="zc-cost-opening">
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><h2 id={titleId} style={{ flex: 1 }}>核对成本起点</h2><button aria-label="关闭成本起点" style={btnOutline} disabled={busy} onClick={onClose}>关闭</button></div>
    <p>起点只承接成本，不会增加余额。核算币种将固定，之后修改报表币种不会改写成本。</p>
    {snap.costState && <p>已有核算期间将保留原来的价值与盈亏口径。本次确认建立新的核算期间。</p>}
    {!preview ? <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <label>起点日期<input aria-label="成本起点日期" className="zc-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>准确时间<input aria-label="成本起点时间" className="zc-input" type="time" step="1" value={time} onChange={(event) => setTime(event.target.value)} /></label>
        <label>核算币种<select aria-label="成本核算币种" className="zc-select" value={baseId} onChange={(event) => setCurrency(event.target.value)}>{snap.assets.filter((asset) => asset.isActive && !asset.isDeleted && asset.type !== 'game' && asset.type !== 'fixed').map((asset) => <option key={asset.id} value={asset.id}>{asset.code} · {asset.name}</option>)}</select></label>
      </div>
      <p>时区：{timezone}。起点当天只有日期的流水，需要先补充准确时间以明确先后关系。</p>
      <button style={btnPrimary} disabled={busy} onClick={() => void calculate()}>{busy ? '核对中…' : '核对余额与已有成本'}</button>
    </> : <>
      <p>{date} {time} · {timezone} · 核算币种 {code(preview.opening.baseCurrencyAssetId)}</p>
      <p>下面是该时间点的真实余额。要让持仓成本显示，请为对应批次填写实际原始总成本；不知道的部分可保留为“未知”，现值或今天的行情不能代替历史成本。</p>
      {preview.assets.map((row) => {
        const asset = snap.assets.find((item) => item.id === row.assetId);
        const items = preview.opening.items.filter((item) => item.assetId === row.assetId);
        return <section key={row.assetId} style={{ padding: '14px 0', borderTop: '1px solid var(--border)' }}>
          <h3>{code(row.assetId)} · 真实余额 {amount(row.quantity, asset?.decimals ?? 8)}</h3>
          {row.accountBalances.map((balance) => <p key={balance.accountId ?? 'unassigned'}>{snap.accounts.find((account) => account.id === balance.accountId)?.name ?? '未分配账户'} · {amount(balance.quantity, asset?.decimals ?? 8)}</p>)}
          {D(row.quantity).lt(0) && <p role="status">负余额 {amount(D(row.quantity).abs(), asset?.decimals ?? 8)}，会保留数量缺口。</p>}
          {items.map((item, index) => reviewing ? <p key={item.id}>批次 {index + 1} · {amount(item.quantity, asset?.decimals ?? 8)} · {item.costInBase === null ? '未知成本' : `${significant(item.costInBase)} ${code(baseId)}`}</p> : <div key={item.id} style={{ padding: 10, background: 'var(--surface-2)', marginBottom: 8 }}>
            <div>批次 {index + 1} · {amount(item.quantity, asset?.decimals ?? 8)} · 取得时间 {item.acquiredAtUtc}{item.sourceLotId ? ' · 可追溯批次建议' : ''}</div>
            <label><input type="checkbox" aria-label={`${code(row.assetId)} 批次 ${index + 1} 保留未知成本`} checked={item.costInBase === null}
              disabled={row.assetId === baseId || D(item.quantity).lte(0)} onChange={(event) => changeCost(item.id, event.target.checked ? null : '')} />保留未知成本</label>
            <label style={{ display: 'block' }}>原始总成本（{code(baseId)}）<input aria-label={`${code(row.assetId)} 批次 ${index + 1} 原始成本`} className="zc-input" inputMode="decimal" value={item.costInBase ?? ''}
              placeholder={item.costInBase === null ? '填写实际成本后自动取消“未知成本”' : undefined}
              disabled={row.assetId === baseId || D(item.quantity).lte(0)} onChange={(event) => changeCost(item.id, event.target.value)} /></label>
          </div>)}
        </section>;
      })}
      {preview.assets.length === 0 && <p>此时点没有金融资产余额；确认后，新发生的金融流水将使用统一成本核算。</p>}
      {reviewing && <p>已知总成本 {significant(sum(preview.opening.items.map((item) => item.costInBase ?? '0')))} {code(baseId)}；{preview.opening.items.filter((item) => item.costInBase === null).length} 个批次保留未知成本。未知部分不会显示为零盈亏。</p>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
        <button style={btnOutline} disabled={busy} onClick={() => { if (reviewing) setReviewing(false); else setPreview(null); }}>{reviewing ? '返回修改成本' : '重新选择起点'}</button>
        <button style={btnPrimary} disabled={busy} onClick={reviewing ? () => void confirm() : review}>{busy ? '保存中…' : reviewing ? '确认成本起点' : '预览启用结果'}</button>
      </div>
    </>}
    {error && <p role="alert" style={{ color: 'var(--negative)' }}>{error}</p>}
  </DialogShell>;
}
