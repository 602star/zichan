import { useEffect, useState } from 'react';
import type { Category, Payee } from '@zichan/core';
import { useStore } from '../db/store.js';
import { matchingPayee, normalizedPayeeName, PAYEE_SCENES, PLATFORM_CATALOG, relatedPlatforms, type PlatformEntry } from '../payee-catalog.js';
import { btnOutline } from './styles.js';

export function PayeePicker({ id, payees, categories, payeeId, merchant, categoryId, type, onChange }: {
  id: string; payees: Payee[]; categories: Category[]; payeeId: string; merchant: string;
  categoryId: string; type: string; onChange: (id: string, name: string) => void;
}) {
  const { store, rev } = useStore();
  const [usage, setUsage] = useState<{ payeeId: string; count: number; lastUsed: string }[]>([]);
  const [knownPayees, setKnownPayees] = useState<Payee[]>([]);
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [scene, setScene] = useState<string>('');
  const [historyOrder, setHistoryOrder] = useState<'recent' | 'frequent'>('recent');
  const [usageError, setUsageError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([store.payeeUsage(), store.payees.list({ includeDeleted: true })]).then(([rows, all]) => { if (!cancelled) { setUsage(rows); setKnownPayees(all); setUsageError(false); } })
      .catch(() => { if (!cancelled) setUsageError(true); });
    return () => { cancelled = true; };
  }, [store, rev]);
  const allPayees = [...payees, ...knownPayees.filter((row) => !payees.some((payee) => payee.id === row.id))];
  const selected = allPayees.find((payee) => payee.id === payeeId);
  const value = selected?.name ?? merchant;
  const query = payeeId ? '' : normalizedPayeeName(merchant);
  const active = payees.filter((payee) => !payee.isDeleted && payee.isActive);
  const ownMatches = active.filter((payee) => [payee.name, ...(payee.aliases ?? [])].some((name) => normalizedPayeeName(name).includes(query)));
  const recent = [...usage].sort((a, b) => historyOrder === 'frequent' ? b.count - a.count || b.lastUsed.localeCompare(a.lastUsed) : b.lastUsed.localeCompare(a.lastUsed) || b.count - a.count)
    .flatMap((row) => active.find((payee) => payee.id === row.payeeId) ?? []).slice(0, 6);
  const blocked = query ? matchingPayee(allPayees, merchant) : undefined;
  const isBlocked = blocked && (blocked.isDeleted || !blocked.isActive);
  const available = (entry: PlatformEntry) => {
    const existing = matchingPayee(allPayees, entry.name, entry);
    return !existing || (!existing.isDeleted && existing.isActive);
  };
  const catalog = (query ? PLATFORM_CATALOG.filter((entry) => [entry.name, ...entry.aliases].some((name) => normalizedPayeeName(name).includes(query)))
    : browse ? PLATFORM_CATALOG.filter((entry) => entry.scenes.includes(scene as typeof entry.scenes[number]))
      : type === 'income' ? [] : relatedPlatforms(categoryId, categories))
    .filter(available).filter((entry) => !query || !ownMatches.some((payee) => matchingPayee([payee], entry.name, entry)))
    .slice(0, query || browse ? 20 : 6);
  const choose = (id: string, name: string) => { onChange(id, name); setOpen(false); };
  const chip = { ...btnOutline, padding: '5px 10px', minHeight: 34, whiteSpace: 'normal' as const };
  return <div onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div style={{ display: 'flex', gap: 6 }}>
      <input id={id} className="zc-input" style={{ minWidth: 0, flex: 1 }} value={value}
        placeholder={type === 'income' ? '搜索或输入付款人、公司、平台' : '搜索或输入商家、平台、收款人'}
        onFocus={() => setOpen(true)} onChange={(event) => { onChange('', event.target.value); setOpen(true); }}
        onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } if (event.key === 'Enter') { event.preventDefault(); setOpen(false); } }} />
      {(value || payeeId) && <button type="button" style={chip} aria-label="清除交易对象" onClick={() => onChange('', '')}>清除</button>}
    </div>
    {selected && (!selected.isActive || selected.isDeleted) && <p className="zc-meta">历史交易对象已停用；保留原记录，或重新选择。</p>}
    {open && <div style={{ marginTop: 6, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', maxHeight: 300, overflowY: 'auto' }}>
      {query ? <div className="zc-meta">我的交易对象</div> : <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={chip} aria-pressed={historyOrder === 'recent'} onClick={() => setHistoryOrder('recent')}>最近使用</button>
        <button type="button" style={chip} aria-pressed={historyOrder === 'frequent'} onClick={() => setHistoryOrder('frequent')}>常用对象</button>
      </div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 12px' }}>
        {(query ? ownMatches.slice(0, 20) : recent).map((payee) => <button key={payee.id} type="button" style={chip} onClick={() => choose(payee.id, payee.name)}>{payee.name}</button>)}
        {!query && !recent.length && <span className="zc-meta">使用后会显示在这里，也可以直接输入名称。</span>}
      </div>
      {usageError && <p className="zc-meta">最近使用暂时无法读取，仍可搜索或输入。</p>}
      <button type="button" style={chip} aria-expanded={browse} onClick={() => { setBrowse(!browse); if (!scene) setScene(PAYEE_SCENES[0].id); }}>按场景浏览</button>
      {browse && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {PAYEE_SCENES.map((item) => <button type="button" key={item.id} style={chip} aria-pressed={scene === item.id} onClick={() => setScene(item.id)}>{item.name}</button>)}
      </div>}
      {!!catalog.length && <>
        <p className="zc-meta">{query ? '平台目录' : browse ? PAYEE_SCENES.find((item) => item.id === scene)?.name : '相关平台'}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {catalog.map((entry) => { const existing = matchingPayee(allPayees, entry.name, entry); return <button type="button" key={entry.id} style={chip} onClick={() => choose(existing?.id ?? '', existing?.name ?? entry.name)}>{existing?.name ?? entry.name}</button>; })}
        </div>
      </>}
      {isBlocked ? <p role="status" className="zc-meta">这个交易对象已停用或删除，请在管理页恢复后使用。</p>
        : query && <p className="zc-meta">可以直接填写名称，保存记账时才加入交易对象列表。</p>}
    </div>}
  </div>;
}
