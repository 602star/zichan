import { EntityIcon } from './EntityIcon.js';
import { useEffect, useState, useId } from 'react';
import { DialogShell } from './DialogShell.js';
import type { Category, Payee } from '@zichan/core';
import { useStore } from '../db/store.js';
import { matchingPayee, normalizedPayeeName, PAYEE_SCENES, PLATFORM_CATALOG, relatedPlatforms, type PlatformEntry } from '../payee-catalog.js';
import { btnOutline } from './styles.js';

export function PayeePicker({ id, payees, categories, payeeId, merchant, categoryId, type, textOnly = false, onChange }: {
  id: string; payees: Payee[]; categories: Category[]; payeeId: string; merchant: string;
  categoryId: string; type: string; textOnly?: boolean; onChange: (id: string, name: string) => void;
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
  const chip = { ...btnOutline, display: 'inline-flex' as const, alignItems: 'center', gap: 6, padding: '5px 10px', minHeight: 34, whiteSpace: 'normal' as const };
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
        {(query ? ownMatches.slice(0, 20) : recent).map((payee) => <button key={payee.id} type="button" style={chip} onClick={() => choose(payee.id, payee.name)}><EntityIcon icon={payee.icon} platformId={payee.id} platformName={payee.name} fallback="store" /><span>{payee.name}</span></button>)}
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
          {catalog.map((entry) => { const existing = matchingPayee(allPayees, entry.name, entry); return <button type="button" key={entry.id} style={chip} onClick={() => choose(existing?.id ?? '', existing?.name ?? entry.name)}><EntityIcon icon={existing?.icon} platformId={entry.id} platformName={entry.name} fallback="store" /><span>{existing?.name ?? entry.name}</span></button>; })}
        </div>
      </>}
      {isBlocked ? <p role="status" className="zc-meta">这个交易对象已停用或删除，请在管理页恢复后使用。</p>
        : query && !textOnly && <p className="zc-meta">可以直接填写名称，保存时加入交易对象列表。</p>}
    </div>}
  </div>;
}

/** Search and icons for existing references; typing never creates or changes a selection. */
export function ExistingPayeePicker({ payees, value, onChange, label, emptyLabel = '请选择交易对象', emptyValue = '', allowInactive = true, clearLabel, disabled }: {
  payees: Payee[]; value: string; onChange: (id: string) => void; label: string;
  emptyLabel?: string; emptyValue?: string; allowInactive?: boolean; clearLabel?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const titleId = useId();
  const selected = payees.find((payee) => payee.id === value);
  const choose = (id: string) => { onChange(id); setOpen(false); };
  const options = payees.filter((payee) => !payee.isDeleted && (allowInactive || payee.isActive))
    .filter((payee) => [payee.name, ...(payee.aliases ?? [])].some((name) => normalizedPayeeName(name).includes(normalizedPayeeName(query))));
  return <>
    <button type="button" className="zc-select zc-existing-payee-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
      onClick={() => { setQuery(''); setOpen(true); }}>
      {selected && <EntityIcon icon={selected.icon} platformId={selected.id} platformName={selected.name} fallback="store" />}
      <span>{value === emptyValue ? emptyLabel : selected?.name ?? (value ? `历史对象 ${value}` : clearLabel ?? emptyLabel)}</span><span aria-hidden="true">▾</span>
    </button>
    {open && <DialogShell labelledBy={titleId} onDismiss={() => setOpen(false)} backdropStyle={{ zIndex: 1300 }} panelClassName="zc-existing-payee-dialog">
      <div className="zc-existing-payee-heading"><b id={titleId}>{label}</b><button type="button" style={btnOutline} aria-label="关闭交易对象选择" onClick={() => setOpen(false)}>×</button></div>
      <input className="zc-input" aria-label="搜索已有交易对象" placeholder="搜索名称或别名" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div role="listbox" aria-label="已有交易对象" className="zc-existing-payee-options">
        <button type="button" role="option" aria-selected={value === emptyValue} onClick={() => choose(emptyValue)}>{emptyLabel}</button>
        {clearLabel && emptyValue !== '' && <button type="button" role="option" aria-selected={value === ''} onClick={() => choose('')}>{clearLabel}</button>}
        {options.map((payee) => <button type="button" role="option" aria-selected={value === payee.id} key={payee.id} onClick={() => choose(payee.id)}>
          <EntityIcon icon={payee.icon} platformId={payee.id} platformName={payee.name} fallback="store" /><span>{payee.name}{!payee.isActive ? '（已停用）' : ''}</span>
        </button>)}
        {!options.length && <p className="zc-meta">没有匹配的已有交易对象</p>}
      </div>
    </DialogShell>}
  </>;
}
