import { useCallback, useEffect, useId, useState } from 'react';
import { D, accountBalanceTiming, isDefaultAccount, type Account, type Asset, type Category, type Transaction } from '@zichan/core';
import { assignTransactionAccounts, previewAccountAssignment, saveTransactionAggregate, type SqlLedgerStore } from '@zichan/db';
import { categoryLabel } from '../transactionMeta.js';
import { CategoryPicker } from './EntityFormModal.js';
import { DialogShell } from './DialogShell.js';
import { btnOutline, btnPrimary } from './styles.js';

export function AccountHistoryPanel({ store, accounts, assets, categories, timeZone, initialAccountId, onChanged, onClose }: {
  store: SqlLedgerStore; accounts: Account[]; assets: Asset[]; categories: Category[]; timeZone?: string; initialAccountId?: string; onChanged: () => void; onClose: () => void;
}) {
  const title = useId();
  const funds = accounts.filter((a) => !isDefaultAccount(a) && a.kind !== 'other' && a.isActive !== false);
  const [target, setTarget] = useState(initialAccountId ?? funds[0]?.id ?? '');
  const [rows, setRows] = useState<Transaction[]>([]);
  const [category, setCategory] = useState('');
  const [filter, setFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [timing, setTiming] = useState<Record<string, 'before' | 'after'>>({});
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewAccountAssignment>> | null>(null);
  const [undo, setUndo] = useState<{ before: Transaction; version: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reload = useCallback(async () => setRows((await store.transactions.list()).filter((t) => t.recordState !== 'voided' && accounts.some((a) => a.id === t.accountId && isDefaultAccount(a)))), [store, accounts]);
  useEffect(() => { void reload().catch((e: unknown) => setError(String(e))); }, [reload]);
  const account = funds.find((a) => a.id === target);
  const visible = rows.filter((t) => (!category || t.category === category) && (!from || t.date >= from) && (!to || t.date <= to) && `${t.description ?? ''} ${categoryLabel(t.category, categories)} ${t.amount}`.includes(filter));
  const input = rows.filter((t) => selected[t.id]).map((t) => ({ id: t.id, version: t.version, timing: timing[t.id] }));
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  return <DialogShell labelledBy={title} onDismiss={onClose} dismissDisabled={busy} panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', width: 'min(760px, calc(100vw - 24px))', maxHeight: '90dvh', overflow: 'auto', padding: 24 }}>
    <h2 id={title}>整理以前的记录</h2><p className="zc-meta">选择确定来自这个账户的记录。余额起点之前只补归属，之后正常计算余额；收支总额不会重复增加。</p>
    <label>归入账户<select className="zc-select" value={target} onChange={(e) => { setTarget(e.target.value); setTiming({}); setPreview(null); }}>{funds.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    {account?.balanceStartAt && <p>余额起点：{new Date(account.balanceStartAt).toLocaleString('zh-CN', { timeZone })} · {account.openingBalance} {assets.find((a) => a.id === account.openingAssetId)?.code}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><input aria-label="筛选历史记录" className="zc-input" placeholder="备注、分类或金额" value={filter} onChange={(e) => setFilter(e.target.value)} /><input aria-label="开始日期" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input aria-label="结束日期" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
    <CategoryPicker fieldId={`${title}-category`} name="historyCategory" ariaLabel="历史记录分类" value={category}
      allowEmpty emptyLabel="全部分类" placeholder="全部分类" defaultShowHidden
      options={[...new Set(rows.map((t) => t.category))].map((id) => {
        const item = categories.find((entry) => entry.id === id);
        return { value: id, icon: item?.icon, parentId: item?.parentId, parentIcon: categories.find((entry) => entry.id === item?.parentId)?.icon, color: item?.color, label: categoryLabel(id, categories), name: item?.name ?? id,
          parentName: categories.find((entry) => entry.id === item?.parentId)?.name ?? '其他', inactive: item?.isActive === false };
      })} onChange={setCategory} />
    <button style={btnOutline} disabled={busy} onClick={() => { setSelected(Object.fromEntries(visible.map((t) => [t.id, true]))); setPreview(null); }}>选择筛选结果（{visible.length} 笔）</button>
    <div style={{ maxHeight: 280, overflow: 'auto', marginTop: 12 }}>{visible.map((t) => <div key={t.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <label><input type="checkbox" checked={!!selected[t.id]} disabled={busy} onChange={(e) => { setSelected({ ...selected, [t.id]: e.target.checked }); setPreview(null); }} />{t.date} · {t.description || categoryLabel(t.category, categories)} · {t.amount} {assets.find((a) => a.id === t.assetId)?.code}</label>
      {account && account.openingAssetId === t.assetId && accountBalanceTiming(account, { ...t, balanceTiming: undefined, balanceTimingAccountId: undefined }) === 'unknown' && <select aria-label={`记录 ${t.id} 与余额起点的关系`} className="zc-select" value={timing[t.id] ?? ''} onChange={(e) => { setTiming({ ...timing, [t.id]: e.target.value as 'before' | 'after' }); setPreview(null); }}><option value="">请确认发生在余额起点之前还是之后</option><option value="before">之前，已经包含在起始余额里</option><option value="after">之后，需要计算余额变化</option></select>}
    </div>)}</div>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" style={{ color: 'var(--negative)' }}>{error}</p>}
    {preview && <div role="status"><p>将整理 {preview.changes.length} 笔，收支总额不变。</p>{Object.entries(preview.impacts).filter(([, value]) => !D(value).isZero()).map(([key, value]) => { const [id, asset] = key.split('|'); return <p key={key}>{accounts.find((a) => a.id === id)?.name}余额变化：{D(value).isPositive() ? '+' : ''}{value} {assets.find((a) => a.id === asset)?.code}</p>; })}{Object.values(preview.impacts).every((v) => D(v).isZero()) && <p>这些记录只补充账户归属，当前余额不变。</p>}</div>}
    <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
      {!preview ? <button style={btnPrimary} disabled={busy || !input.length || !target} onClick={() => void run(async () => setPreview(await previewAccountAssignment(store, target, input)))}>预览 {input.length} 笔调整</button> : <button style={btnPrimary} disabled={busy} onClick={() => void run(async () => {
        const result = await assignTransactionAccounts(store, target, input, preview.targetVersion);
        const saved = result.changes.map((c, index) => ({ before: c.before, version: result.saved[index]!.transaction.version }));
        setUndo(saved); setPreview(null); setSelected({}); setNotice(`已整理 ${saved.length} 笔记录`); await reload(); onChanged();
      })}>确认整理</button>}
      {undo && <button style={btnOutline} disabled={busy} onClick={() => void run(async () => {
        await store.runInAuditBatch('撤销账户归属整理', async (tx) => { for (const item of undo) {
          const current = await tx.transactions.get(item.before.id);
          if (!current || current.version !== item.version) throw new Error('记录后来已变化，请刷新后单独调整');
          await saveTransactionAggregate(tx, { transaction: { ...item.before, version: current.version }, expectedVersion: current.version,
            splits: await tx.transactionSplits.list({ where: { transactionId: current.id } }) });
        } });
        setUndo(null); setNotice('已撤销整理'); await reload(); onChanged();
      })}>撤销刚才的整理</button>}
      <button style={btnOutline} disabled={busy} onClick={onClose}>完成</button>
    </div>
  </DialogShell>;
}
