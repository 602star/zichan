import { useState } from 'react';
import { D, defaultFixedFilters, fixedLocationPath, newId, type FixedInventoryFilters, type FixedWorkspacePreferences } from '@zichan/core';
import { organizeFixedAssets, restoreFixedAssetArchive, updateFixedWorkspace } from '@zichan/db';
import type { Snapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { loadFixedInventoryFilters, saveFixedInventoryFilters } from '../fixed-inventory-preferences.js';
import { filterFixedInventory, fixedInventoryCsv, fixedInventoryTable } from '../selectors/fixed-inventory.js';
import type { FixedCardVM } from '../selectors/fixed.js';
import { downloadReportPdf } from '../report-pdf.js';
import { money } from '../format.js';
import { Card, CardAlert, CardEmpty, CardMetric } from './Card.js';
import { CategoryPicker, EntityFormModal, type EntityFormSpec } from './EntityFormModal.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { FixedInventoryCard } from './FixedInventoryCard.js';
import { useCompactView } from './useCompactView.js';

const categoryIcons: Record<string, string> = {
  'fixed-electronics': 'phone', 'fixed-appliance': 'house', 'fixed-vehicle': 'car',
  'fixed-home': 'house', 'fixed-personal': 'shopping', 'fixed-work': 'work',
  'fixed-electronics-game': 'game', 'fixed-electronics-audio': 'music',
  'fixed-personal-instrument': 'music', 'fixed-vehicle-bike': 'bike', 'fixed-vehicle-ebike': 'bike',
};

export function FixedInventory({ items, snap, preferences, onOpen, onNew, onFromExpense, onLocations, onUsage, initialAttention = false }: {
  items: FixedCardVM[]; snap: Snapshot; preferences: FixedWorkspacePreferences;
  onOpen: (item: FixedCardVM) => void; onNew: () => void; onFromExpense: () => void; onLocations: () => void;
  onUsage: (item: FixedCardVM) => void; initialAttention?: boolean;
}) {
  const { store, bump } = useStore();
  const compact = useCompactView();
  const [showFilters, setShowFilters] = useState(false);
  const ledgerId = snap.setting?.id ?? 'unbound';
  const [filters, setFilters] = useState<FixedInventoryFilters>(() => loadFixedInventoryFilters(ledgerId, initialAttention));
  const [selection, setSelection] = useState<string[]>([]);
  const [batch, setBatch] = useState<'location' | 'category' | 'archive' | null>(null);
  const [savingView, setSavingView] = useState(false);
  const [removeView, setRemoveView] = useState<string | null>(null);
  const [legacyRestore, setLegacyRestore] = useState<FixedCardVM | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const [error, setError] = useState('');
  const update = (patch: Partial<FixedInventoryFilters>) => {
    const next = { ...filters, ...patch }; setFilters(next); setSelection([]);
    saveFixedInventoryFilters(ledgerId, next, patch.display !== undefined);
  };
  const rows = filterFixedInventory(items, filters, preferences, showArchived);
  const hasFilters = !!filters.query || filters.categoryId !== 'all' || filters.year !== 'all' || filters.locationId !== 'all' || filters.status !== 'all' || filters.attentionOnly;
  const selected = rows.filter((item) => selection.includes(item.id));
  const roots = items.filter((item) => !item.isComponent && !item.raw.archivedAt);
  const selectedAssets = selected.map((item) => ({ id: item.id, version: item.raw.version }));
  const years = [...new Set((showArchived ? items.filter((item) => item.raw.archivedAt) : roots).map((item) => item.raw.purchaseDate.slice(0, 4)))].sort().reverse();
  const categories = snap.fixedAssetCategories.filter((category) => category.isActive && category.parentId);
  const choose = (id: string) => setSelection((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const run = async (action: () => Promise<void>) => { setError(''); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const restore = (item: FixedCardVM) => {
    if (item.raw.status === 'retired' && !snap.fixedEvents.some((row) => row.fixedAssetId === item.id && ['sale', 'scrap', 'retire', 'gift'].includes(row.type))) { setLegacyRestore(item); return; }
    void run(async () => { await restoreFixedAssetArchive(store, item.id, item.raw.version); bump(); });
  };
  const exportRows = selected.length ? selected : rows;
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([fixedInventoryCsv(exportRows)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `物品清单-${snap.setting?.asOfDate ?? '全部'}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const purchase = (item: FixedCardVM) => `${item.raw.purchaseDate.slice(0, 4)} 年购置 · ${item.locationPath}`;
  const unitCost = (item: FixedCardVM) => {
    const primary = item.metrics.find((metric) => metric.raw.isPrimary) ?? item.metrics[0];
    return primary ? D(primary.total).gt(0) ? <>{money(primary.perUnit, item.currencySymbol)}<small>/ {primary.unitLabel} · 累计 {primary.total} {primary.unitLabel}</small></> : <>尚未记录用量<small>添加用量后计算单位成本</small></>
      : item.perDay === undefined ? <>待补准确日期<small>只记年份，暂不计算日均</small></> : <>{money(item.perDay, item.currencySymbol)}<small>/ 天 · 持有 {item.days} 天</small></>;
  };
  const actions = (item: FixedCardVM) => item.raw.archivedAt ? <button type="button" className="zc-btn" onClick={() => restore(item)}>恢复档案</button> : <button type="button" className="zc-btn zc-btn--sm" onClick={() => item.metrics.length && ['active', 'stored'].includes(item.raw.status) ? onUsage(item) : onOpen(item)}>{item.metrics.length && ['active', 'stored'].includes(item.raw.status) ? '记录使用' : item.sold ? '查看结算' : '查看详情'}</button>;
  const batchSpec: EntityFormSpec<{ value: string }> = {
    title: batch === 'location' ? '批量移动物品' : '批量修改分类',
    fields: [{ key: 'value', label: batch === 'location' ? '目标位置' : '物品分类', type: batch === 'location' ? 'select' : 'category', allowEmpty: batch === 'location',
      options: batch === 'location' ? preferences.locations.filter((row) => !row.archived).map((row) => ({ value: row.id, label: fixedLocationPath(preferences.locations, row.id) }))
        : categories.map((row) => ({ value: row.id, label: row.name, parentId: row.parentId, parentName: snap.fixedAssetCategories.find((parent) => parent.id === row.parentId)?.name })), required: batch === 'category' }],
    toValues: (value) => value, fromValues: (value) => ({ value: value.value ?? '' }),
  };
  const locationControls = <><label className="zc-fixed-check"><input type="checkbox" checked={filters.attentionOnly} onChange={(event) => update({ attentionOnly: event.target.checked })} />只看待处理</label><button type="button" className="zc-btn" onClick={onLocations}>管理位置</button></>;
  return <div className="zc-fixed-inventory">
    <div className="zc-fixed-toolbar zc-fixed-toolbar--head"><div><h2>物品清单</h2><p className="zc-caption">购入、使用、维护与处置，共用一份物品档案。</p></div><div className="zc-fixed-actions"><button type="button" className="zc-btn" onClick={onFromExpense}>从支出登记</button><button type="button" className="zc-btn zc-btn--primary" onClick={onNew}>+ 新增物品</button></div></div>
    {!showArchived && <div className="zc-card-band zc-fixed-summary">{[
      ['整件物品', roots.length, filters.status === 'all' && !filters.attentionOnly, () => update({ status: 'all', attentionOnly: false })],
      ['使用中', roots.filter((item) => item.raw.status === 'active').length, filters.status === 'active' && !filters.attentionOnly, () => update({ status: 'active', attentionOnly: false })],
      ['闲置', roots.filter((item) => item.raw.status === 'stored').length, filters.status === 'stored' && !filters.attentionOnly, () => update({ status: 'stored', attentionOnly: false })],
      ['待处理', roots.filter((item) => item.reminders.length || item.consumables.some((row) => row.needsAttention)).length, filters.attentionOnly, () => update({ attentionOnly: true, status: 'all' })],
    ].map(([label, count, active, action]) => <button type="button" key={String(label)} aria-pressed={Boolean(active)} onClick={action as () => void}><CardMetric label={String(label)} value={`${count} 件`} /></button>)}</div>}
    <div className="zc-fixed-query"><label>查找物品<input className="zc-input" aria-label="搜索物品" placeholder="名称、品牌、型号、条码或位置" value={filters.query} onChange={(event) => update({ query: event.target.value })} /></label>
      <details className="zc-fixed-filter-details" open={!compact || showFilters} onToggle={(event) => { if (compact) setShowFilters(event.currentTarget.open); }}>
        <summary>筛选：分类、年份与位置{filters.year !== 'all' ? ` · ${filters.year} 年` : ''}{filters.locationId !== 'all' ? ` · ${filters.locationId === 'unset' ? '未设置位置' : fixedLocationPath(preferences.locations, filters.locationId)}` : ''}{filters.attentionOnly ? ' · 待处理' : ''}</summary>
        <div className="zc-fixed-filter-fields">
      <label>物品分类<CategoryPicker fieldId="fixed-filter-category" name="fixedCategory" ariaLabel="物品分类" value={filters.categoryId === 'all' ? '' : filters.categoryId} allowEmpty allowParentSelection emptyLabel="全部分类" placeholder="全部分类" defaultShowHidden
        options={categories.map((category) => ({ value: category.id, label: category.name, name: category.name, parentId: category.parentId, parentName: snap.fixedAssetCategories.find((row) => row.id === category.parentId)?.name }))} onChange={(value) => update({ categoryId: value || 'all' })} /></label>
      <label>购置年份<select className="zc-select" aria-label="购置年份" value={filters.year} onChange={(event) => update({ year: event.target.value })}><option value="all">全部年份</option>{years.map((year) => <option key={year} value={year}>{year} 年</option>)}</select></label>
      <label>存放位置<select className="zc-select" aria-label="存放位置" value={filters.locationId} onChange={(event) => update({ locationId: event.target.value })}><option value="all">全部位置（含下级）</option>{preferences.locations.filter((row) => !row.archived).map((row) => <option key={row.id} value={row.id}>{fixedLocationPath(preferences.locations, row.id)}</option>)}<option value="unset">未设置位置</option></select></label>
      </div>{compact && <div className="zc-fixed-actions">{locationControls}</div>}</details>
    </div>
    <div className="zc-fixed-toolbar"><div className="zc-fixed-actions" role="group" aria-label="物品状态">{(['all', 'active', 'stored', 'terminal'] as const).map((status) => <button key={status} type="button" className={filters.status === status ? 'zc-btn is-active' : 'zc-btn'} aria-pressed={filters.status === status} onClick={() => update({ status })}>{{ all: '全部', active: '使用中', stored: '闲置', terminal: '已处置' }[status]}</button>)}</div>
      <div className="zc-fixed-actions">{!compact && locationControls}{hasFilters && <button type="button" className="zc-btn" onClick={() => update({ ...defaultFixedFilters(), display: filters.display, sort: filters.sort })}>清除筛选</button>}</div></div>
    <details className="zc-fixed-view-options"><summary>视图、排序与导出</summary><div className="zc-fixed-actions">
      <label>排序<select className="zc-select" value={filters.sort} onChange={(event) => update({ sort: event.target.value as FixedInventoryFilters['sort'] })}><option value="newest">购入时间：新到旧</option><option value="oldest">购入时间：旧到新</option><option value="net_desc">净投入：按币种从高到低</option><option value="name">名称</option></select></label>
      <label className="zc-fixed-check"><input type="checkbox" disabled={filters.display !== 'list'} checked={showParts} onChange={(event) => setShowParts(event.target.checked)} />清单中展开已归属配件</label>
      <button type="button" className="zc-btn" onClick={() => setSavingView(true)}>保存当前视图</button><button type="button" className="zc-btn" disabled={!exportRows.length} onClick={() => void run(async () => exportCsv())}>导出 CSV</button><button type="button" className="zc-btn" disabled={!exportRows.length} onClick={() => void run(async () => downloadReportPdf('物品清单.pdf', { title: '物品清单', range: `当前${selected.length ? '选中' : '筛选'} ${exportRows.length} 件 · 原币金额，未合并汇总`, table: fixedInventoryTable(exportRows) }))}>导出 PDF</button>
    </div></details>
    {!!preferences.views.length && <div className="zc-fixed-actions" aria-label="常用物品视图">{preferences.views.map((view) => <span key={view.id} className="zc-fixed-saved-view"><button type="button" className="zc-btn" onClick={() => update(view.filters)}>{view.name}</button><button type="button" className="zc-btn" aria-label={`删除视图 ${view.name}`} onClick={() => setRemoveView(view.id)}>删除</button></span>)}</div>}
    {error && <CardAlert tone="danger">{error}</CardAlert>}
    <div className="zc-fixed-toolbar"><div className="zc-fixed-actions"><div role="group" aria-label="物品展示方式" className="zc-fixed-actions">{(['cards', 'list'] as const).map((display) => <button type="button" className="zc-btn" key={display} aria-pressed={filters.display === display} onClick={() => update({ display })}>{display === 'list' ? '清单' : '卡片'}</button>)}</div><span className="zc-caption" role="status">找到 {rows.length} 件{showArchived ? '已归档' : '独立'}物品{selected.length ? ` · 已选 ${selected.length} 件` : ''}</span></div><label className="zc-fixed-check"><input type="checkbox" checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); update({ ...defaultFixedFilters(), display: filters.display, sort: filters.sort }); }} />查看已归档</label>{!!rows.length && !showArchived && <label className="zc-fixed-check"><input type="checkbox" aria-label="全选当前物品" checked={selected.length === rows.length} onChange={(event) => setSelection(event.target.checked ? rows.map((item) => item.id) : [])} />全选当前结果</label>}</div>
    {!!selected.length && !showArchived && <div className="zc-fixed-actions"><button type="button" className="zc-btn" onClick={() => setBatch('location')}>批量移动位置</button><button type="button" className="zc-btn" onClick={() => setBatch('category')}>批量修改分类</button><button type="button" className="zc-btn" onClick={() => setBatch('archive')}>归档所选档案</button><button type="button" className="zc-btn" onClick={() => setSelection([])}>取消选择</button></div>}
    {!rows.length ? <Card><CardEmpty>没有符合条件的物品，可调整筛选或新增一件。</CardEmpty></Card> : filters.display === 'cards' ? <div className="zc-fixed-photo-grid">{rows.map((item) => {
      const category = snap.fixedAssetCategories.find((row) => row.id === item.raw.categoryId);
      const icon = category?.icon || snap.fixedAssetCategories.find((row) => row.id === category?.parentId)?.icon
        || `lucide:${categoryIcons[category?.id ?? ''] ?? categoryIcons[category?.parentId ?? ''] ?? 'package'}`;
      return <FixedInventoryCard key={item.id} item={item} icon={icon} selected={selection.includes(item.id)} onChoose={() => choose(item.id)} onOpen={() => onOpen(item)} onUsage={() => onUsage(item)} onRestore={() => restore(item)} />;
    })}</div>
      : <Card variant="flush"><table className="zc-fixed-inventory-table"><thead><tr><th scope="col" className="is-select"><span className="zc-sr-only">选择</span></th><th scope="col">物品</th><th scope="col">累计净投入</th><th scope="col">参考现值</th><th scope="col">使用成本</th><th scope="col">状态与提醒</th><th scope="col" className="is-actions">操作</th></tr></thead><tbody>{rows.map((item) => <FixedInventoryRows key={item.id} item={item} parts={showParts ? items.filter((part) => part.costOwnerId === item.id) : []} selected={selection.includes(item.id)} onChoose={() => choose(item.id)} onOpen={onOpen} action={actions(item)} unitCost={unitCost(item)} purchase={purchase(item)} />)}</tbody></table></Card>}
    <p className="zc-caption">配件费用随整机归属，不重复汇总。参考现值不抵扣净投入；按天表示持有日均，次数、里程和时长依据实际记录。</p>
    {legacyRestore && <EntityFormModal spec={{ title: '恢复旧物品档案', summary: () => '旧版本归档曾把状态改为已清退，但这份档案没有处置事件。请确认归档前的使用状态；历史费用保持不变。', fields: [{ key: 'status', label: '恢复后的状态', type: 'select', required: true, allowEmpty: true, placeholder: '请确认原来的状态', options: [{ value: 'active', label: '使用中' }, { value: 'stored', label: '闲置' }, { value: 'retired', label: '保留已清退' }] }], toValues: (v: { status: 'active' | 'stored' | 'retired' }) => v, fromValues: (v) => ({ status: v.status as 'active' | 'stored' | 'retired' }) }} onClose={() => setLegacyRestore(null)} onSave={async (v) => { await restoreFixedAssetArchive(store, legacyRestore.id, legacyRestore.raw.version, v.status); bump(); }} />}
    {(batch === 'location' || batch === 'category') && <EntityFormModal spec={batchSpec} onClose={() => setBatch(null)} onSave={async (value) => { await organizeFixedAssets(store, selectedAssets, batch === 'location' ? { locationId: value.value } : { categoryId: value.value }); setSelection([]); bump(); }} />}
    {batch === 'archive' && <ConfirmDialog title="归档所选档案" confirmLabel="归档档案" onCancel={() => setBatch(null)} onConfirm={async () => { await organizeFixedAssets(store, selectedAssets, { archive: true }); setBatch(null); setSelection([]); bump(); }}><p>将隐藏 {selected.length} 件物品档案，保留使用状态、历史成本及关联资金流水。报废、售出等请先记录处置事件；归档不代表已处置。</p></ConfirmDialog>}
    {savingView && <EntityFormModal spec={{ title: '保存物品视图', fields: [{ key: 'name', label: '视图名称', type: 'text', required: true }], toValues: (value: { name: string }) => value, fromValues: (value) => ({ name: value.name?.trim() ?? '' }) }} onClose={() => setSavingView(false)} onSave={async (value) => { await updateFixedWorkspace(store, (current) => ({ ...current, views: [...current.views, { id: newId(), name: value.name, filters }] })); bump(); }} />}
    {removeView && <ConfirmDialog title="删除常用物品视图" confirmLabel="删除视图" onCancel={() => setRemoveView(null)} onConfirm={async () => { await updateFixedWorkspace(store, (current) => ({ ...current, views: current.views.filter((view) => view.id !== removeView) })); setRemoveView(null); bump(); }}><p>仅删除保存的筛选条件，物品记录保留。</p></ConfirmDialog>}
  </div>;
}

function FixedInventoryRows({ item, parts, selected, onChoose, onOpen, action, unitCost, purchase }: {
  item: FixedCardVM; parts: FixedCardVM[]; selected: boolean; onChoose: () => void; onOpen: (item: FixedCardVM) => void;
  action: React.ReactNode; unitCost: React.ReactNode; purchase: string;
}) {
  return <><tr className="zc-fixed-inventory-row" data-fixed-item={item.id}><td><label className="zc-check-target"><input type="checkbox" disabled={!!item.raw.archivedAt} aria-label={`选择 ${item.name}`} checked={selected} onChange={onChoose} /></label></td><td><button type="button" className="zc-workspace-link" onClick={() => onOpen(item)}>{item.name}</button><small>{item.categoryParent} / {item.category}</small><small>{purchase}</small></td>
    <td data-label="累计净投入">{money(item.net, item.currencySymbol)}{item.installedComponents.length > 0 && <small>含已归属配件</small>}</td><td data-label="参考现值">{item.referenceValue !== undefined ? money(item.referenceValue, item.currencySymbol) : '未记录'}</td><td data-label="使用成本">{unitCost}</td><td data-label="状态与提醒">{item.status}{item.reminders.map((reminder) => <small className="zc-fixed-warning" key={reminder.id}>{reminder.label} · {reminder.days < 0 ? `逾期 ${-reminder.days} 天` : `剩 ${reminder.days} 天`}</small>)}{item.consumables.some((row) => row.needsAttention) && <small className="zc-fixed-warning">有耗材待处理</small>}</td><td>{action}</td></tr>
    {parts.map((part) => <tr className="zc-fixed-part-row" key={part.id}><td /><td><button type="button" className="zc-workspace-link" onClick={() => onOpen(part)}>配件：{part.name}</button></td><td colSpan={5}>费用已计入 {item.name}，不另行汇总。{part.installedIn ? ` 当前安装于 ${part.installedIn}` : ' 当前未安装'}</td></tr>)}</>;
}
