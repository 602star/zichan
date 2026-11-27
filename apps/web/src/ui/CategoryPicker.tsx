import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { DialogShell } from './DialogShell.js';
import { EntityIcon, categoryIconValue, categoryOptionIcon } from './EntityIcon.js';

export interface FieldOption {
  groupName?: string;
  icon?: string;
  parentId?: string;
  parentIcon?: string;
  parentColor?: string;
  color?: string;
  value: string;
  label: string;
  /**
   * 分类选项自带的结构：自己的名字与父级名（见 `@zichan/core` 的 `CategoryOption`）。
   *
   * 面板要分左右两栏，就直接用它们；`label` 是「一级 / 二级」拼出来的字符串，
   * 而分类名是自由文本，反解会切坏（叶子名里本来就可能带斜杠）。
   */
  name?: string;
  parentName?: string;
  hidden?: boolean;
  /** Present in the immutable system catalog but not enabled in this ledger yet. */
  catalogOnly?: boolean;
  /**
   * 已停用（如扩展包被停用）。与 hidden 不同：停用的分类默认根本不进选项池，
   * 只有读路径（筛选 / 查询）会显式把它带进来，并靠这个标记显示徽标。
   */
  inactive?: boolean;
}

/*
 * 把选项拆成面板要的两栏。
 *
 * 选项自带结构（`name` / `parentName`）时直接用。退回解析 `label` 只是为了兼容
 * 手搓选项的调用点：`label` 的两段是拼出来的，而分类名是用户可编辑的自由文本，
 * 叶子名本身就可能带斜杠（目录里的「打车/网约车」）。按 `/` 反解会把它切成两级，
 * 重拼时再各补一个空格，面板里就变成了「打车 / 网约车」；父级名带斜杠时更糟，
 * 会凭空造出一个一级分组（「学习/培训」变成一级「学习」、二级「培训 / 教材」）。
 */
export function splitCategoryLabel(option: FieldOption): { parent: string; child: string } {
  if (option.name !== undefined) return { parent: option.parentName ?? '其他', child: option.name };
  const parts = option.label.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { parent: parts[0]!, child: parts.slice(1).join(' / ') };
  return { parent: '其他', child: option.label };
}

function categoryGroups(options: FieldOption[], search: string, selectedValue: string, showHidden: boolean): { parent: string; children: FieldOption[] }[] {
  const q = search.trim().toLowerCase();
  const grouped = new Map<string, FieldOption[]>();
  for (const option of options) {
    if (option.catalogOnly && !q && option.value !== selectedValue) continue;
    if (option.hidden && !showHidden && !q && option.value !== selectedValue) continue;
    const parsed = splitCategoryLabel(option);
    const hit = !q || option.label.toLowerCase().includes(q) || parsed.parent.toLowerCase().includes(q) || parsed.child.toLowerCase().includes(q);
    if (!hit) continue;
    const rows = grouped.get(parsed.parent) ?? [];
    rows.push(option);
    grouped.set(parsed.parent, rows);
  }
  return [...grouped.entries()].map(([parent, children]) => ({ parent, children }));
}

export function CategoryPicker(props: {
  fieldId: string;
  name: string;
  value: string;
  options: FieldOption[];
  allowEmpty?: boolean;
  allowParentSelection?: boolean;
  defaultShowHidden?: boolean;
  onChange: (value: string) => void;
  emptyLabel?: string;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  triggerStyle?: CSSProperties;
}) {
  const {
    fieldId, name, value, options, allowEmpty, allowParentSelection = false, defaultShowHidden = false, onChange,
    emptyLabel = '不选择', placeholder = '选择分类', ariaLabel, invalid, describedBy, triggerStyle,
  } = props;
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeParent, setActiveParent] = useState('');
  const [childrenStep, setChildrenStep] = useState(false);
  const [compact, setCompact] = useState(false);
  const [showHidden, setShowHidden] = useState(defaultShowHidden);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const selected = options.find((option) => option.value === value);
  const selectedParts = selected ? splitCategoryLabel(selected) : undefined;
  const selectedParentSample = !selected && allowParentSelection && value
    ? options.find((option) => option.parentId === value)
    : undefined;
  const selectedParentName = selectedParentSample ? splitCategoryLabel(selectedParentSample).parent : undefined;
  const groups = categoryGroups(options, search, value, showHidden);
  const hiddenCount = options.filter((option) => option.hidden && !option.catalogOnly).length;
  const groupParentId = (group: { children: FieldOption[] } | undefined) => group?.children.find((child) => child.parentId)?.parentId;
  const activeGroup = groups.find((group) => group.parent === activeParent)
    ?? groups.find((group) => group.children.some((child) => child.value === value) || (allowParentSelection && !!value && groupParentId(group) === value))
    ?? groups[0];
  const activeGroupParentId = groupParentId(activeGroup);
  const searching = Boolean(search.trim());
  const parentRowCount = groups.length + (allowEmpty ? 1 : 0);
  const choose = (next: string) => { onChange(next); setOpen(false); };

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const vw = viewport?.width ?? window.innerWidth;
      const vh = viewport?.height ?? window.innerHeight;
      const ox = viewport?.offsetLeft ?? 0;
      const oy = viewport?.offsetTop ?? 0;
      const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
      const width = Math.min(640, vw - 24);
      setCompact(width < 360);

      // Size vertically to fit every top-level parent category without scrolling.
      const rowHeight = coarse ? 46 : 36;
      const headerHeight = width < 420 && hiddenCount > 0 ? 96 : 58;
      const desiredHeight = Math.min(620, vh - 24, Math.max(320, headerHeight + Math.max(parentRowCount, 6) * rowHeight + 12));
      const below = oy + vh - rect.bottom - 14;
      const above = rect.top - oy - 14;
      const left = Math.max(ox + 12, Math.min(rect.left, ox + vw - width - 12));

      if (below >= desiredHeight) {
        setPlacement({ width, maxHeight: Math.min(620, below), left, top: Math.max(oy + 12, rect.bottom + 6) });
      } else if (above >= desiredHeight) {
        setPlacement({
          width,
          maxHeight: Math.min(620, above),
          left,
          bottom: Math.max(window.innerHeight - (oy + vh) + 12, window.innerHeight - rect.top + 6),
        });
      } else {
        // Trigger sits near the middle of the viewport: float cleanly within viewport bounds
        // so all top-level categories remain visible without forcing scroll.
        const maxHeight = Math.max(240, Math.min(620, vh - 24));
        const clampedTop = Math.max(oy + 12, Math.min(rect.bottom + 6, oy + vh - desiredHeight - 12));
        setPlacement({ width, maxHeight, left, top: clampedTop });
      }
    };
    position();
    const panel = document.getElementById(titleId)?.closest('[role="dialog"]');
    const observer = new ResizeObserver(position);
    if (panel) observer.observe(panel);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open, titleId, searching, activeParent, childrenStep, parentRowCount, hiddenCount]);

  const optionRow = (option: FieldOption, parent: string) => {
    const parsed = splitCategoryLabel(option);
    return <button key={option.value} type="button" role="option" aria-selected={value === option.value}
      onClick={() => choose(option.value)} className={`zc-category-child-btn${value === option.value ? ' is-active' : ''}`}>
      <EntityIcon icon={categoryOptionIcon(option)} color={option.color} />
      <span className="zc-category-option-text">{searching && <small>{parent} › </small>}{parsed.child}</span>
      {option.catalogOnly ? <span className="zc-category-badge">未启用</span>
        : option.inactive ? <span className="zc-category-badge is-inactive">已停用</span>
          : option.hidden && <span className="zc-category-badge">隐藏</span>}
    </button>;
  };

  return <div style={{ minWidth: 0 }}>
    <button ref={trigger} id={fieldId} name={name} type="button" className="zc-select zc-category-trigger"
      aria-haspopup="dialog" aria-expanded={open}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      onClick={() => { setSearch(''); setChildrenStep(Boolean(selected || selectedParentSample)); setActiveParent(selectedParts?.parent ?? selectedParentName ?? ''); setOpen(true); }}
      style={{ ...triggerStyle, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', whiteSpace: 'normal', height: 'auto' }}>
      {selected ? <EntityIcon icon={categoryOptionIcon(selected)} color={selected.color} />
        : selectedParentSample && <EntityIcon icon={selectedParentSample.parentIcon || categoryIconValue(selectedParentSample.parentId ?? '')} color={selectedParentSample.parentColor ?? selectedParentSample.color} />}
      <span className="zc-category-option-text">
        {selected ? <><small>{selectedParts?.parent} › </small><b>{selectedParts?.child}</b></>
          : selectedParentName ? <><b>{selectedParentName}</b><small> · 全部</small></>
            : placeholder}
      </span>
      <span aria-hidden="true">{open ? '▲' : '▼'}</span>
    </button>
    {open && <DialogShell labelledBy={titleId} onDismiss={() => setOpen(false)}
      initialFocusRef={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? closeButton : undefined}
      backdropClassName="zc-category-backdrop" panelClassName="zc-category-picker-panel"
      panelStyle={{ position: 'fixed', ...placement }}
      header={<>
        <span id={titleId} className="zc-category-accessible-title">选择分类</span>
        <div className="zc-category-picker-search">
          <input className="zc-input" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索分类" aria-label="搜索分类" />
          {hiddenCount > 0 && <button type="button" className="zc-category-scope" aria-pressed={showHidden}
            onClick={() => setShowHidden((current) => !current)}>{showHidden ? '只看高频' : `显示隐藏 (${hiddenCount})`}</button>}
          <button ref={closeButton} type="button" className="zc-category-close" aria-label="关闭分类选择" onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button>
        </div>
      </>}
    >
      {searching ? <div className="zc-category-picker-list zc-category-search-results" role="listbox" aria-label="分类搜索结果">
        {allowParentSelection && groups.map((group) => {
          const pid = groupParentId(group);
          if (!pid || !group.parent.toLowerCase().includes(search.trim().toLowerCase())) return null;
          return <button key={`parent:${pid}`} type="button" role="option" aria-selected={value === pid}
            onClick={() => choose(pid)} className={`zc-category-child-btn zc-category-parent-all-btn${value === pid ? ' is-active' : ''}`}>
            <EntityIcon icon={group.children[0]?.parentIcon || categoryIconValue(pid)} color={group.children[0]?.parentColor ?? group.children[0]?.color} />
            <span className="zc-category-option-text"><b>{group.parent}</b><small> · 全部</small></span>
          </button>;
        })}
        {groups.flatMap((group) => group.children.map((option) => optionRow(option, group.parent)))}
        {!groups.length && <p className="zc-meta" style={{ padding: '12px 14px' }}>没有匹配分类</p>}
      </div> : <>
        <div className="zc-category-step-nav">
          {childrenStep ? <button type="button" className="zc-btn" onClick={() => setChildrenStep(false)}>返回一级分类</button> : <span>选择一级分类</span>}
          {childrenStep && <strong className="zc-category-option-text">{activeGroup?.parent}</strong>}
        </div>
        <div className={`zc-category-picker-grid${childrenStep ? ' is-children' : ''}`}>
          <div className="zc-category-picker-list zc-category-parents" hidden={compact && childrenStep}>
            {allowEmpty && <button type="button" onClick={() => choose('')} className={`zc-category-parent-btn${!value ? ' is-active' : ''}`}>{emptyLabel}</button>}
            {groups.map((group) => <button key={group.parent} type="button" aria-pressed={activeGroup?.parent === group.parent}
              onClick={() => { setActiveParent(group.parent); setChildrenStep(true); }} className={`zc-category-parent-btn${activeGroup?.parent === group.parent ? ' is-active' : ''}`}>
              <EntityIcon icon={group.children[0]?.parentIcon || categoryIconValue(group.children[0]?.parentId ?? '')} color={group.children[0]?.parentColor ?? group.children[0]?.color} />
              <span className="zc-category-option-text">{group.parent}</span>
            </button>)}
            {!groups.length && <p className="zc-meta" style={{ padding: '12px 14px' }}>没有可选分类</p>}
          </div>
          <div className="zc-category-picker-list zc-category-children" hidden={compact && !childrenStep} role="listbox" aria-label={activeGroup?.parent ?? '二级分类'}>
            {allowParentSelection && activeGroup && activeGroupParentId && (
              <button
                type="button"
                role="option"
                aria-selected={value === activeGroupParentId}
                onClick={() => choose(activeGroupParentId)}
                className={`zc-category-child-btn zc-category-parent-all-btn${value === activeGroupParentId ? ' is-active' : ''}`}
              >
                <EntityIcon icon={activeGroup.children[0]?.parentIcon || categoryIconValue(activeGroupParentId)} color={activeGroup.children[0]?.parentColor ?? activeGroup.children[0]?.color} />
                <span className="zc-category-option-text"><b>{activeGroup.parent}</b><small> · 全部二级分类</small></span>
              </button>
            )}
            {activeGroup?.children.map((option) => optionRow(option, activeGroup.parent))}
          </div>
        </div>
      </>}
    </DialogShell>}
  </div>;
}
