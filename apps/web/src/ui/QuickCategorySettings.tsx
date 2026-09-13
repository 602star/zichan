import { useEffect, useMemo, useRef, useState } from 'react';
import type { Category, TransactionCategoryType } from '@zichan/core';
import {
  categoryPreferenceUpdates,
  moveCategoryBefore,
  moveCategoryId,
  reorderCategoryIds,
  resetCategoryPreferences,
  sortCategorySiblings,
} from '../categoryPreferences.js';
import { allCategories, categoryIsHidden } from '../transactionMeta.js';
import { btnOutline, btnPrimary, btnSmall } from './styles.js';

interface QuickCategorySettingsProps {
  categories: Category[];
  onSave: (updates: Category[]) => Promise<void>;
}

type DragState = { id: string; scope: string } | null;

function isCatalogOnly(category: Category): boolean {
  return (category as Category & { catalogOnly?: boolean }).catalogOnly === true;
}

export function QuickCategorySettings({ categories, onSave }: QuickCategorySettingsProps) {
  const catalog = useMemo(
    () => allCategories(categories, { includeCatalog: true }).map((category) => ({ ...category })),
    [categories],
  );
  const signature = useMemo(
    () => catalog.map((category) => `${category.id}:${category.version}:${category.isHidden}:${category.sortOrder}:${isCatalogOnly(category)}`).join('|'),
    [catalog],
  );
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [baseline, setBaseline] = useState<Category[]>(catalog);
  const [draft, setDraft] = useState<Category[]>(catalog);
  const [type, setType] = useState<TransactionCategoryType>('expense');
  const [parentId, setParentId] = useState('');
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<DragState>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const next = catalogRef.current.map((category) => ({ ...category }));
    setBaseline(next);
    setDraft(next);
    setSelectedIds(new Set());
  }, [signature]);

  const parents = sortCategorySiblings(draft.filter((category) => !category.parentId && category.type === type));
  const activeParent = parents.find((parent) => parent.id === parentId) ?? parents[0];
  const allChildren = draft.filter((category) => category.parentId && category.type === type);
  const enabledChildren = allChildren.filter((category) => !isCatalogOnly(category));
  const children = activeParent
    ? sortCategorySiblings(enabledChildren.filter((category) => category.parentId === activeParent.id))
    : [];
  const frequent = children.filter((category) => !categoryIsHidden(category));
  const hidden = children.filter(categoryIsHidden);
  const parentById = new Map(draft.filter((category) => !category.parentId).map((parent) => [parent.id, parent]));
  const q = query.trim().toLocaleLowerCase();
  const searchRows = q
    ? allChildren.filter((category) => {
      const parent = parentById.get(category.parentId ?? '');
      return `${parent?.name ?? ''} ${category.name} ${category.id}`.toLocaleLowerCase().includes(q);
    }).sort((a, b) => {
      const score = (category: Category) => {
        const name = category.name.toLocaleLowerCase();
        const id = category.id.toLocaleLowerCase();
        const parent = parentById.get(category.parentId ?? '')?.name.toLocaleLowerCase() ?? '';
        if (name === q || id === q) return 0;
        if (name.startsWith(q) || id.startsWith(q)) return 1;
        if (name.includes(q)) return 2;
        if (id.includes(q)) return 3;
        if (parent.includes(q)) return 4;
        return 5;
      };
      return score(a) - score(b)
        || Number(categoryIsHidden(a)) - Number(categoryIsHidden(b))
        || (parentById.get(a.parentId ?? '')?.sortOrder ?? 9999) - (parentById.get(b.parentId ?? '')?.sortOrder ?? 9999)
        || (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999);
    })
    : [];
  const currentRows = q ? searchRows : children;
  const updates = categoryPreferenceUpdates(baseline, draft);
  const dirty = updates.length > 0;

  const setCategories = (update: (rows: Category[]) => Category[]) => {
    setDraft((rows) => update(rows));
    setNotice('');
  };

  const selectType = (next: TransactionCategoryType) => {
    const nextParents = sortCategorySiblings(draft.filter((category) => !category.parentId && category.type === next));
    setType(next);
    setParentId(nextParents[0]?.id ?? '');
    setSelectedIds(new Set());
    setQuery('');
  };

  const chooseParent = (id: string) => {
    setParentId(id);
    setSelectedIds(new Set());
    setQuery('');
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setVisibility = (ids: Iterable<string>, visible: boolean) => {
    const idSet = new Set(ids);
    setCategories((rows) => rows.map((category) => idSet.has(category.id) ? { ...category, isHidden: !visible } : category));
  };

  const moveParent = (id: string, action: 'up' | 'down' | 'top') => {
    const ids = parents.map((parent) => parent.id);
    setCategories((rows) => reorderCategoryIds(rows, moveCategoryId(ids, id, action)));
  };

  const moveChild = (category: Category, action: 'up' | 'down' | 'top') => {
    const group = categoryIsHidden(category) ? hidden : frequent;
    const ids = group.map((row) => row.id);
    setCategories((rows) => reorderCategoryIds(rows, moveCategoryId(ids, category.id, action)));
  };

  const dropParent = (targetId: string) => {
    if (!dragging || dragging.scope !== `parents:${type}`) return;
    const ids = parents.map((parent) => parent.id);
    setCategories((rows) => reorderCategoryIds(rows, moveCategoryBefore(ids, dragging.id, targetId)));
    setDragging(null);
  };

  const dropChild = (target: Category) => {
    const scope = `children:${target.parentId}:${categoryIsHidden(target) ? 'hidden' : 'frequent'}`;
    if (!dragging || dragging.scope !== scope) return;
    const group = categoryIsHidden(target) ? hidden : frequent;
    const ids = group.map((row) => row.id);
    setCategories((rows) => reorderCategoryIds(rows, moveCategoryBefore(ids, dragging.id, target.id)));
    setDragging(null);
  };

  const pinToTop = (category: Category) => {
    const siblings = sortCategorySiblings(draft.filter((row) => row.parentId === category.parentId && row.type === category.type && !categoryIsHidden(row)));
    const ids = [category.id, ...siblings.filter((row) => row.id !== category.id).map((row) => row.id)];
    setCategories((rows) => reorderCategoryIds(rows.map((row) => row.id === category.id ? { ...row, isHidden: false } : row), ids));
  };

  const resetCurrent = () => {
    if (!activeParent) return;
    setCategories((rows) => resetCategoryPreferences(rows, activeParent.id));
    setSelectedIds(new Set());
  };

  const resetAll = () => {
    setCategories((rows) => resetCategoryPreferences(rows));
    setSelectedIds(new Set());
  };

  const cancel = () => {
    setDraft(baseline.map((category) => ({ ...category })));
    setSelectedIds(new Set());
    setNotice('已取消未保存修改');
  };

  const save = async () => {
    const changed = categoryPreferenceUpdates(baseline, draft);
    if (changed.length === 0) return;
    setBusy(true);
    try {
      await onSave(changed);
      setBaseline(draft.map((category) => ({ ...category })));
      setSelectedIds(new Set());
      setNotice(`已保存 ${changed.length} 项分类设置`);
    } finally {
      setBusy(false);
    }
  };

  const selectedInCurrent = currentRows.filter((category) => selectedIds.has(category.id));
  const allCurrentSelected = currentRows.length > 0 && currentRows.every((category) => selectedIds.has(category.id));

  return (
    <div data-testid="quick-category-settings">
      <div className="zc-category-pref-head">
        <div>
          <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>快速记账分类</div>
          <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
            <button type="button" onClick={() => selectType('expense')} style={segmentButton(type === 'expense')}>支出</button>
            <button type="button" onClick={() => selectType('income')} style={segmentButton(type === 'income')}>收入</button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {dirty && <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--accent)', fontWeight: 'var(--fw-medium)' }}>未保存 {updates.length} 项</span>}
          <button type="button" onClick={resetAll} style={outlineButton}>恢复全部默认</button>
          <button type="button" onClick={cancel} disabled={!dirty || busy} style={outlineButton}>取消修改</button>
          <button type="button" onClick={() => void save()} disabled={!dirty || busy} style={primaryButton}>{busy ? '保存中…' : '保存分类设置'}</button>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <input
          aria-label="搜索快速记账分类"
          className="zc-input"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setSelectedIds(new Set()); }}
          placeholder="搜索分类名称或 ID"
        />
      </div>

      <div className="zc-category-pref-layout">
        <div className="zc-category-pref-parents">
          <div className="zc-category-pref-section-title">一级分类</div>
          {parents.map((parent, index) => {
            const rows = enabledChildren.filter((category) => category.parentId === parent.id);
            const visibleCount = rows.filter((category) => !categoryIsHidden(category)).length;
            const active = parent.id === activeParent?.id && !q;
            return (
              <div
                key={parent.id}
                draggable
                onDragStart={() => setDragging({ id: parent.id, scope: `parents:${type}` })}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => dropParent(parent.id)}
                className={`zc-category-pref-parent${active ? ' is-active' : ''}`}
              >
                <span className="zc-category-drag" title="拖动排序">⋮⋮</span>
                <button type="button" onClick={() => chooseParent(parent.id)} className="zc-category-pref-parent-main">
                  <span style={{ width: 9, height: 9, borderRadius: 'var(--r-sm)', background: parent.color ?? 'var(--fg-subtle)', flex: '0 0 auto' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{parent.name}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' }}>{visibleCount}/{rows.length}</span>
                </button>
                <OrderButtons
                  name={parent.name}
                  index={index}
                  total={parents.length}
                  onMove={(action) => moveParent(parent.id, action)}
                />
              </div>
            );
          })}
        </div>

        <div className="zc-category-pref-children">
          <div className="zc-category-pref-batch">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-medium)' }}>
              <input
                type="checkbox"
                aria-label="全选当前分类"
                checked={allCurrentSelected}
                onChange={(event) => setSelectedIds((current) => {
                  const next = new Set(current);
                  for (const category of currentRows) {
                    if (event.target.checked) next.add(category.id);
                    else next.delete(category.id);
                  }
                  return next;
                })}
              />
              已选 {selectedInCurrent.length}
            </label>
            <span style={{ flex: '1 1 auto' }} />
            <button type="button" disabled={selectedInCurrent.length === 0} onClick={() => setVisibility(selectedIds, true)} style={smallButton}>设为高频</button>
            <button type="button" disabled={selectedInCurrent.length === 0} onClick={() => setVisibility(selectedIds, false)} style={smallButton}>设为隐藏</button>
            {!q && <button type="button" onClick={resetCurrent} style={smallButton}>恢复本组默认</button>}
          </div>

          {q ? (
            <div>
              <div className="zc-category-pref-section-title">搜索结果 · {searchRows.length}</div>
              {searchRows.map((category) => (
                <SearchCategoryRow
                  key={category.id}
                  category={category}
                  parentName={parentById.get(category.parentId ?? '')?.name ?? '父级缺失'}
                  selected={selectedIds.has(category.id)}
                  onSelect={() => toggleSelected(category.id)}
                  onToggle={() => setVisibility([category.id], categoryIsHidden(category))}
                  onPin={() => pinToTop(category)}
                />
              ))}
              {searchRows.length === 0 && <EmptyRow text="没有匹配的分类" />}
            </div>
          ) : (
            <>
              <CategoryGroup
                title="高频分类"
                rows={frequent}
                selectedIds={selectedIds}
                dragging={dragging}
                onSelect={toggleSelected}
                onToggle={(category) => setVisibility([category.id], false)}
                onMove={moveChild}
                onDragStart={(category) => setDragging({ id: category.id, scope: `children:${category.parentId}:frequent` })}
                onDrop={dropChild}
              />
              <CategoryGroup
                title="隐藏分类"
                rows={hidden}
                selectedIds={selectedIds}
                dragging={dragging}
                onSelect={toggleSelected}
                onToggle={(category) => setVisibility([category.id], true)}
                onMove={moveChild}
                onDragStart={(category) => setDragging({ id: category.id, scope: `children:${category.parentId}:hidden` })}
                onDrop={dropChild}
              />
            </>
          )}
        </div>
      </div>
      {notice && <div style={{ marginTop: 10, fontSize: 'var(--fs-caption)', color: 'var(--positive)', fontWeight: 'var(--fw-medium)' }}>{notice}</div>}
    </div>
  );
}

function CategoryGroup(props: {
  title: string;
  rows: Category[];
  selectedIds: Set<string>;
  dragging: DragState;
  onSelect: (id: string) => void;
  onToggle: (category: Category) => void;
  onMove: (category: Category, action: 'up' | 'down' | 'top') => void;
  onDragStart: (category: Category) => void;
  onDrop: (category: Category) => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="zc-category-pref-section-title">{props.title} · {props.rows.length}</div>
      {props.rows.map((category, index) => (
        <div
          key={category.id}
          draggable
          onDragStart={() => props.onDragStart(category)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => props.onDrop(category)}
          className={`zc-category-pref-row${props.dragging?.id === category.id ? ' is-dragging' : ''}`}
        >
          <input aria-label={`选择 ${category.name}`} type="checkbox" checked={props.selectedIds.has(category.id)} onChange={() => props.onSelect(category.id)} />
          <span className="zc-category-drag" title="拖动排序">⋮⋮</span>
          <span style={{ width: 9, height: 9, borderRadius: 'var(--r-sm)', background: category.color ?? 'var(--fg-subtle)', flex: '0 0 auto' }} />
          <span className="zc-category-pref-name">{category.name}<small>{category.id}</small></span>
          <label className="zc-category-pref-toggle">
            <input aria-label={`快速显示 ${category.name}`} type="checkbox" checked={!categoryIsHidden(category)} onChange={() => props.onToggle(category)} />
            快速显示
          </label>
          <OrderButtons name={category.name} index={index} total={props.rows.length} onMove={(action) => props.onMove(category, action)} />
        </div>
      ))}
      {props.rows.length === 0 && <EmptyRow text="暂无分类" />}
    </div>
  );
}

function SearchCategoryRow(props: {
  category: Category;
  parentName: string;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onPin: () => void;
}) {
  const hidden = categoryIsHidden(props.category);
  return (
    <div className="zc-category-pref-row is-search-result">
      <input aria-label={`选择 ${props.category.name}`} type="checkbox" checked={props.selected} onChange={props.onSelect} />
      <span style={{ width: 9, height: 9, borderRadius: 'var(--r-sm)', background: props.category.color ?? 'var(--fg-subtle)' }} />
      <span className="zc-category-pref-name">{props.parentName} / {props.category.name}<small>{props.category.id}</small></span>
      <span className={`zc-category-state${hidden ? '' : ' is-frequent'}`}>
        {isCatalogOnly(props.category) ? '未启用' : hidden ? '隐藏' : '高频'}
      </span>
      <button type="button" onClick={props.onToggle} style={smallButton}>
        {isCatalogOnly(props.category) ? '启用并设高频' : hidden ? '设为高频' : '设为隐藏'}
      </button>
      <button type="button" onClick={props.onPin} style={smallButton}>置顶</button>
    </div>
  );
}

function OrderButtons({ name, index, total, onMove }: {
  name: string;
  index: number;
  total: number;
  onMove: (action: 'up' | 'down' | 'top') => void;
}) {
  return (
    <span className="zc-category-order-buttons">
      <button type="button" aria-label={`${name}置顶`} title="置顶" disabled={index === 0} onClick={() => onMove('top')}>⇈</button>
      <button type="button" aria-label={`${name}上移`} title="上移" disabled={index === 0} onClick={() => onMove('up')}>↑</button>
      <button type="button" aria-label={`${name}下移`} title="下移" disabled={index === total - 1} onClick={() => onMove('down')}>↓</button>
    </span>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div style={{ padding: '16px 10px', color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>{text}</div>;
}

function segmentButton(active: boolean) {
  return {
    minWidth: 70,
    height: 32,
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-sm)',
    background: active ? 'var(--accent)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--fg-muted)',
    fontSize: 'var(--fs-caption)',
    fontWeight: 'var(--fw-medium)',
    cursor: 'pointer',
  } as const;
}

const outlineButton = btnOutline;
const primaryButton = btnPrimary;
const smallButton = btnSmall;
