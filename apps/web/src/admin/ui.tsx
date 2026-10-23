/** Shared presentation pieces for every management page. */
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AdminError } from './client.js';

export const panel: CSSProperties = { padding: 'var(--sp-5)', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', marginTop: 12 };
/** Keeps a jumped-to section clear of the sticky page header. */
export const anchorOffset: CSSProperties = { scrollMarginTop: 16 };
export const row: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };
export const muted: CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' };

/**
 * Whether this role may change anything. A read-only operator (`viewer`) sees every page; the
 * controls that would write are disabled here and refused by the server if they are reached
 * some other way.
 */
export const canWrite = (role: string | undefined): boolean => role !== 'viewer';

export const READ_ONLY_NOTE = '只读运维角色：此项不可用。';

/**
 * Whether the actor may manage this account: disable it, change its role, or end its sessions.
 *
 * Mirrors the server rule in `store.mutateAdmin`: an owner is protected from everyone (only the
 * owner manages their own account, and even that is limited), and an administrator may only touch
 * ordinary members. This was copied into the user list and the user detail page, and the two
 * copies had to agree with a third on the server; bulk actions would have made a fourth. One
 * definition means a rule change lands everywhere or nowhere.
 */
export const canManageAccount = (actorRole: string | undefined, targetRole: string | undefined): boolean => {
  if (!canWrite(actorRole)) return false;
  if (targetRole === 'owner') return false;
  return actorRole === 'owner' || targetRole === 'member';
};

/** Whether the actor may retune this account's quota. Additive and reversible, so owners may do it to themselves. */
export const canEditAccountQuota = (actorRole: string | undefined, targetRole: string | undefined): boolean =>
  canWrite(actorRole) && (actorRole === 'owner' || targetRole === 'member');

/**
 * The one role→label mapping for the whole console.
 *
 * This used to be copied into each page, and the copies drifted: a read-only operator showed as
 * "只读运维" on the overview and as "普通用户" in the user detail and session lists. Keeping a
 * single map means adding a role cannot half-land in the UI.
 */
export const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  viewer: '只读运维',
  member: '普通用户',
};

export function roleLabel(role: string | undefined | null): string {
  return ROLE_LABELS[role ?? ''] ?? '普通用户';
}

export function message(error: unknown): string {
  if (error instanceof AdminError) {
    const labels: Record<string, string> = {
      RECENT_LOGIN_REQUIRED: '敏感操作需要最近 5 分钟内的登录。请退出管理后台并重新登录，再执行此操作。',
      READ_ONLY_ROLE: '只读运维角色只能查看与导出，不能执行管理变更。',
      PROTECTED_ACCOUNT: '此账号受保护，你无权修改。',
      OWNER_REQUIRED: '仅服务器所有者可以执行此操作。',
      ADMIN_REQUIRED: '需要管理员权限。',
      ACCOUNT_DISABLED: '请先启用该账号。',
      INVITE_USED: '邀请码已使用，不能再改变状态。',
      STALE_WRITE: '账号数据已被其他管理员修改，请刷新后再提交。',
      IDEMPOTENCY_KEY_REUSED: '该幂等键已用于不同的请求参数，已拒绝；请刷新后重新发起。',
      IDEMPOTENCY_IN_PROGRESS: '同一幂等键的请求仍在处理中。请刷新核实结果，不要重复提交。',
      IDEMPOTENCY_ACTOR_MISMATCH: '该幂等键已被另一个管理账号占用。请刷新后重新发起。',
      REQUEST_TIMEOUT: '请求超时，服务器可能已完成操作。请先刷新核实结果，再决定是否重试。',
      JOB_TYPE_INVALID: '不支持的任务类型。',
      JOB_PARAMETER_INVALID: '任务参数无效。',
      UNKNOWN_SETTING: '不支持的设置项。',
      BACKUP_RECORD_NOT_FOUND: '未登记该备份记录。',
      CANCELLED: '任务已在安全边界取消。',
      EXECUTION_INTERRUPTED: '服务在任务执行期间退出，未完成的部分不会标记为成功。',
      CURRENT_SESSION: '不能撤销当前正在使用的会话，请用顶部「退出管理后台」结束它。',
      ACCOUNT_CHANGED: '管理账号已改变，请重新登录。',
    };
    const text = labels[error.code] ?? error.message;
    return error.requestId ? `${text}（请求 ${error.requestId}）` : text;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface Resource<T> {
  data?: T;
  error: string;
  loading: boolean;
  /** True when the last refresh failed and the shown data is the previous successful read. */
  stale: boolean;
  loadedAt?: string;
  reload: () => void;
}

/**
 * Loads data for the current view. A late response from a previous view is discarded
 * so navigating away can never fill the new page with old rows.
 */
export function useResource<T>(loader: () => Promise<T>, deps: unknown[]): Resource<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const generation = useRef(0);
  const [state, setState] = useState<{ data?: T; error: string; loading: boolean; stale: boolean; loadedAt?: string }>({
    error: '', loading: true, stale: false,
  });
  const reload = useCallback(() => {
    const id = ++generation.current;
    setState((previous) => ({ ...previous, loading: true }));
    void (async () => {
      try {
        const data = await loaderRef.current();
        if (id !== generation.current) return;
        setState({ data, error: '', loading: false, stale: false, loadedAt: new Date().toISOString() });
      } catch (error) {
        if (id !== generation.current) return;
        setState((previous) => ({ ...previous, loading: false, error: message(error), stale: previous.data !== undefined }));
      }
    })();
  }, []);
  // The caller owns the dependency list: each page decides which filters reload the view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps);
  useEffect(() => () => { generation.current += 1; }, []);
  return { ...state, reload };
}

/** Polls only while the tab is visible, so a background console does not keep the server busy. */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => { if (!document.hidden) callbackRef.current(); }, intervalMs);
    };
    const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
    const onVisibility = () => { if (document.hidden) stop(); else { callbackRef.current(); start(); } };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, intervalMs]);
}

/**
 * Reports the outcome of a write in the page, not in a blocking dialog.
 *
 * `window.alert` could not show the request id, could not be styled, and blocked the tab; every
 * page had its own copy of the same one-liner. This keeps the message next to the control that
 * produced it and renders it with the same `Notice` the read errors use.
 */
export function useActionError(): { error: string; setError: (message: string) => void; clear: () => void } {
  const [error, setError] = useState('');
  return { error, setError, clear: useCallback(() => setError(''), []) };
}

export interface CursorPager {
  cursor: string;
  /** 1-based page number of the current view. */
  page: number;
  hasPrevious: boolean;
  next: (nextCursor: string) => void;
  previous: () => void;
  /** Replaces filters in the URL; the cursor history restarts unless the patch sets `cursor`. */
  apply: (patch: Record<string, string | undefined>) => void;
}

/**
 * Cursor pagination shared by every list page.
 *
 * The trail of visited cursors belongs to the filter set it was built with: changing a filter
 * starts a new trail, while stepping pages keeps it, so "previous" survives more than one step
 * and the page number counts the pages actually visited instead of resetting to one.
 */
export function useCursorPager({ query, path, navigate }: { query: URLSearchParams; path: string; navigate: (to: string) => void }): CursorPager {
  const filters = new URLSearchParams(query);
  const cursor = filters.get('cursor') ?? '';
  filters.delete('cursor');
  const signature = filters.toString();
  const [trail, setTrail] = useState<{ signature: string; cursors: string[] }>({ signature, cursors: cursor ? ['', cursor] : [''] });
  // A view opened straight from a shared link still shows a usable page number.
  const cursors = trail.signature === signature ? trail.cursors : (cursor ? ['', cursor] : ['']);
  const apply = (patch: Record<string, string | undefined>): void => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') next.delete(key); else next.set(key, value);
    }
    if (!('cursor' in patch)) next.delete('cursor');
    navigate(`${path}${next.toString() ? `?${next.toString()}` : ''}`);
  };
  return {
    cursor,
    page: cursors.length,
    hasPrevious: cursors.length > 1,
    next: (nextCursor) => {
      setTrail({ signature, cursors: [...cursors, nextCursor] });
      apply({ cursor: nextCursor });
    },
    previous: () => {
      const shortened = cursors.slice(0, -1);
      setTrail({ signature, cursors: shortened });
      apply({ cursor: shortened.at(-1) });
    },
    apply,
  };
}

/**
 * A titled section of a page.
 *
 * `id` is what makes the section addressable: a long page can offer a jump list
 * (`PanelIndex`), and a link from elsewhere can point at one section instead of
 * the top of the page. It is derived from the title rather than asked for
 * separately, because a second name for the same section is a second thing to
 * keep in step - and a duplicate id would silently break the jump target.
 */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="zc-admin-page-header">
    <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
    {actions ? <div className="zc-admin-page-actions">{actions}</div> : null}
  </div>;
}

export function FilterBar({ children, note }: { children: ReactNode; note?: string }) {
  return <section id={sectionId('筛选')} className="zc-admin-filterbar" aria-label="筛选">
    {children}
    {note ? <p className="zc-admin-filter-note">{note}</p> : null}
  </section>;
}

export function Panel({ title, id, action, children, note, className }: { title?: string; id?: string; action?: ReactNode; children: ReactNode; note?: string; className?: string }) {
  const anchor = id ?? (title ? sectionId(title) : undefined);
  return (
    <section className={['zc-admin-panel', className].filter(Boolean).join(' ')} id={anchor} style={anchor ? anchorOffset : undefined}>
      {(title || action) && (
        <div className="zc-admin-panel-header">
          {title ? <strong>{title}</strong> : <span />}
          {action}
        </div>
      )}
      {children}
      {note ? <p style={{ ...muted, marginTop: 10 }}>{note}</p> : null}
    </section>
  );
}

/**
 * Turn a section title into a usable fragment id.
 *
 * Titles are Chinese, and a fragment has to survive being typed into an address
 * bar and pasted into a chat message, so anything that is not a letter, a digit
 * or a hyphen is dropped rather than percent-encoded. Two titles that differ only
 * in punctuation would collide; `PanelIndex` de-duplicates the list it renders,
 * so a collision costs a shared jump target rather than a broken link.
 */
export function sectionId(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  return slug ? `section-${slug}` : 'section';
}

export interface PageSection {
  id: string;
  label: string;
}

/**
 * A jump list for a page with several sections.
 *
 * Rendered only when a page actually has enough sections to be worth scanning:
 * three links above a two-panel page would be more chrome than content. This is
 * the in-page half of the same problem the breadcrumbs solve between pages -
 * on a narrow screen the sidebar is behind a toggle, so the only way to reach
 * the bottom of a long page was to scroll through everything above it.
 */
export function PanelIndex({ sections }: { sections: PageSection[] }) {
  const seen = new Set<string>();
  const unique = sections.filter((section) => {
    if (!section.id || seen.has(section.id)) return false;
    seen.add(section.id);
    return true;
  });
  if (unique.length < 3) return null;
  return (
    <nav aria-label="页内跳转" className="zc-admin-panel-index" style={{ ...row, gap: 8, marginBottom: 12 }}>
      {unique.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          onClick={(event) => {
            // Scroll without letting the hash change the URL: the console's routes
            // are its own, and a stray fragment would be read back as a route.
            event.preventDefault();
            document.getElementById(section.id)?.scrollIntoView({ block: 'start' });
          }}
          style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}
        >{section.label}</a>
      ))}
    </nav>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className="zc-admin-stat" data-tone={tone}>
      <div className="zc-admin-stat-label">{label}</div>
      <div className="zc-admin-stat-value">{value}</div>
      {hint ? <div className="zc-admin-stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'muted' }) {
  const background = tone === 'ok' ? 'var(--ok-surface)' : tone === 'warn' ? 'var(--warn-surface)'
    : tone === 'bad' ? 'var(--danger-surface)' : 'var(--surface-muted)';
  return <span style={{ background, borderRadius: 'var(--r-pill)', padding: '2px 8px', fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap' }}>{children}</span>;
}

export function Notice({ children, tone }: { children: ReactNode; tone?: 'bad' | 'warn' | 'info' }) {
  const background = tone === 'bad' ? 'var(--danger-surface)' : tone === 'warn' ? 'var(--warn-surface)' : 'var(--surface-muted)';
  return <p style={{ background, borderRadius: 'var(--r-sm)', padding: '8px 10px', margin: '8px 0 0' }}>{children}</p>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)' }}>
      <span style={muted}>{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ padding: '0 8px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', ...props.style }} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ padding: '0 8px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', ...props.style }} />;
}

/**
 * Copies a value and says whether it worked.
 *
 * The invitation code already had a copy button, and it reported nothing: a click that worked and a
 * click that did nothing looked identical, and `navigator.clipboard` is absent entirely on an
 * insecure origin (the console is served over plain HTTP on a LAN by default). Both cases now show
 * an outcome instead of leaving the operator to paste and find out.
 */
export function CopyValue({ value, label = '复制', copiedLabel = '已复制' }: { value: string; label?: string; copiedLabel?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (): Promise<void> => {
    let next: 'ok' | 'failed' = 'ok';
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard) throw new Error('clipboard unavailable');
      await clipboard.writeText(value);
    } catch {
      next = 'failed';
    }
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2_000);
  };
  return (
    <Button onClick={() => { void copy(); }} title={value} aria-label={`${label} ${value}`}>
      {state === 'ok' ? copiedLabel : state === 'failed' ? '复制失败' : label}
    </Button>
  );
}

export function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={['zc-admin-button', props.className].filter(Boolean).join(' ')}
    >{children}</button>
  );
}

/**
 * The trail back up from a page.
 *
 * Every page already has a real URL, but a page reached by following a link — a user detail opened
 * from a quota alert, say — offered no way back except the browser button, and on a narrow screen
 * the sidebar is collapsed behind a toggle. The trail is derived from the route in one place rather
 * than written into each page, so a page cannot ship without one.
 *
 * The last crumb is the current page and is rendered as text, not a link: a link to where you
 * already are is a control that does nothing.
 */
export function Breadcrumbs({ crumbs, onNavigate }: {
  crumbs: { label: string; href?: string }[];
  onNavigate?: (href: string) => void;
}) {
  // A single crumb is just the page title, which the page already shows.
  if (crumbs.length < 2) return null;
  return (
    <nav aria-label="面包屑" className="zc-admin-breadcrumbs" style={{ ...row, gap: 6, marginBottom: 10, fontSize: 'var(--fs-sm)' }}>
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <Fragment key={`${crumb.label}-${String(index)}`}>
            {index ? <span aria-hidden="true" style={muted}>›</span> : null}
            {last || !crumb.href ? (
              <span aria-current={last ? 'page' : undefined} style={last ? { color: 'var(--text-primary)' } : muted}>{crumb.label}</span>
            ) : (
              <a
                href={crumb.href}
                onClick={onNavigate ? (event) => { event.preventDefault(); onNavigate(crumb.href!); } : undefined}
              >{crumb.label}</a>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Hidden on narrow screens to keep the table readable on a phone. */
  secondary?: boolean;
  /** Replaces the header text, e.g. with a sort button. The plain `header` stays for screen readers. */
  headerNode?: ReactNode;
  /**
   * Sort state of this column, when it is sortable. Exposed as `aria-sort` on the header cell,
   * which is where assistive technology looks for it — a button whose name is just the column
   * label gives no hint that the column is ordered, or in which direction.
   */
  ariaSort?: 'ascending' | 'descending';
  /**
   * Columns that may be hidden by the operator. A column that is not optional cannot be turned
   * off: an identity or action column is why the table exists, and hiding it leaves a grid of
   * values nobody can act on.
   */
  optional?: boolean;
}

/**
 * Remembers which optional columns are hidden, per table.
 *
 * Kept in localStorage rather than the URL: a link someone shares should show the data, not the
 * sender's column layout, and the choice is about the person rather than about this view.
 */
export function useHiddenColumns(table: string, columns: { key: string; optional?: boolean }[]): {
  hidden: string[];
  toggle: (key: string) => void;
  reset: () => void;
} {
  const storageKey = `zichan.admin.columns.${table}`;
  const optionalKeys = columns.filter((column) => column.optional).map((column) => column.key);
  const read = (): string[] => {
    try {
      const raw = globalThis.localStorage?.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Drop keys this table no longer has, so a renamed column cannot come back as a phantom.
      return parsed.filter((key): key is string => typeof key === 'string' && optionalKeys.includes(key));
    } catch { return []; }
  };
  const [hidden, setHidden] = useState<string[]>(read);
  const write = (next: string[]): void => {
    setHidden(next);
    try { globalThis.localStorage?.setItem(storageKey, JSON.stringify(next)); } catch { /* A full or blocked store must not break the page. */ }
  };
  return {
    hidden,
    toggle: (key) => write(hidden.includes(key) ? hidden.filter((item) => item !== key) : [...hidden, key]),
    reset: () => write([]),
  };
}

/**
 * Row selection for a paged table.
 *
 * Selection is scoped to the rows currently loaded, and that scope is stated in the UI: a cursor
 * page cannot select "everything matching the filter", and a control that implies it can would be
 * the most dangerous kind of wrong — the operator would believe a whole filter was handled when
 * only one page was.
 *
 * Keys are dropped when the page changes rather than carried across pages. Carrying them would let
 * an invisible selection from a previous page be acted on, which is the same problem one step
 * removed.
 */
export function useRowSelection(rows: { accountId: string }[]): {
  selected: string[];
  toggle: (key: string) => void;
  setAll: (keys: string[]) => void;
  clear: () => void;
  /** Rows that are selected and still present on this page. */
  selectedRows: typeof rows;
} {
  const [selected, setSelected] = useState<string[]>([]);
  const pageKeys = rows.map((row) => row.accountId);
  const pageKey = pageKeys.join('|');
  const lastPageKey = useRef(pageKey);
  if (lastPageKey.current !== pageKey) {
    // Render-phase reset: a selection that outlives its rows is a selection the operator cannot see.
    lastPageKey.current = pageKey;
    if (selected.length) setSelected([]);
  }
  const visible = selected.filter((key) => pageKeys.includes(key));
  return {
    selected: visible,
    toggle: (key) => setSelected(visible.includes(key) ? visible.filter((item) => item !== key) : [...visible, key]),
    setAll: (keys) => setSelected(keys),
    clear: () => setSelected([]),
    selectedRows: rows.filter((row) => visible.includes(row.accountId)),
  };
}

/** The column-visibility control, rendered next to a table's other controls. */
export function ColumnPicker({ columns, hidden, onToggle, onReset, label = '列显示' }: {
  columns: { key: string; header: string; optional?: boolean }[];
  hidden: string[];
  onToggle: (key: string) => void;
  onReset: () => void;
  label?: string;
}) {
  const optional = columns.filter((column) => column.optional);
  if (!optional.length) return null;
  return (
    <details style={{ display: 'inline-block' }}>
      <summary style={{ cursor: 'pointer', ...muted }}>{label}{hidden.length ? `（已隐藏 ${hidden.length} 项）` : ''}</summary>
      <div style={{ ...row, marginTop: 6, maxWidth: 420 }}>
        {optional.map((column) => (
          <label key={column.key} style={{ ...muted, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={!hidden.includes(column.key)} onChange={() => onToggle(column.key)} />
            {column.header}
          </label>
        ))}
        {hidden.length ? <Button onClick={onReset}>全部显示</Button> : null}
      </div>
    </details>
  );
}

export function DataTable<T>({ columns, rows, rowKey, empty, onRowClick, activeKey, renderExpanded, hiddenColumns = [], selection }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: string;
  onRowClick?: (row: T) => void;
  activeKey?: string;
  /** Rendered in a full-width row directly under the active row. */
  renderExpanded?: (row: T) => ReactNode;
  /** Keys of optional columns the operator turned off. */
  hiddenColumns?: string[];
  /**
   * Turns on row selection. The checkbox column is added by the table rather than by each page, so
   * the header checkbox and the row checkboxes cannot disagree about which rows are selectable.
   */
  selection?: {
    selected: string[];
    onToggle: (key: string) => void;
    onToggleAll: (keys: string[]) => void;
    /** Rows the actor may act on. Rows outside this set render a disabled checkbox with a reason. */
    selectable: (row: T) => boolean;
    /** Why a row cannot be selected; shown on the disabled checkbox. */
    reason?: (row: T) => string | undefined;
    label?: string;
  };
}) {
  if (!rows.length) return <p style={muted}>{empty}</p>;
  const visible = columns.filter((column) => !hiddenColumns.includes(column.key));
  const selectableKeys = selection ? rows.filter(selection.selectable).map(rowKey) : [];
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selection!.selected.includes(key));
  return (
    <div>
      <div className="zc-admin-table" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {selection ? (
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', width: 1, ...muted }}>
                <input
                  type="checkbox"
                  aria-label={selection.label ?? '选择本页可操作的账号'}
                  checked={allSelected}
                  // Nothing selectable on this page is a real state, not an error: a page of owners
                  // has no bulk action to offer, and a checkbox that cannot be used must say so.
                  disabled={selectableKeys.length === 0}
                  onChange={() => selection.onToggleAll(allSelected ? [] : selectableKeys)}
                />
              </th>
            ) : null}
            {visible.map((column) => (
              <th key={column.key} className={column.secondary ? 'zc-admin-secondary' : undefined} aria-sort={column.ariaSort} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', ...muted }}>{column.headerNode ?? column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const key = rowKey(item);
            const allowed = selection ? selection.selectable(item) : false;
            const why = selection?.reason?.(item);
            return (
              <Fragment key={key}>
                <tr
                  data-active={activeKey === key ? 'true' : undefined}
                  onClick={onRowClick ? () => onRowClick(item) : undefined}
                  style={{ cursor: onRowClick ? 'pointer' : undefined, background: activeKey === key ? 'var(--surface-muted)' : undefined }}
                >
                  {selection ? (
                    <td className="zc-admin-selection-cell" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${key}`}
                        checked={selection.selected.includes(key)}
                        disabled={!allowed}
                        title={!allowed ? why : undefined}
                        onChange={() => selection.onToggle(key)}
                      />
                    </td>
                  ) : null}
                  {visible.map((column) => (
                    <td key={column.key} data-label={column.header} data-column={column.key} className={column.secondary ? 'zc-admin-secondary' : undefined} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>{column.render(item)}</td>
                  ))}
                </tr>
                {renderExpanded && activeKey === key ? (
                  <tr>
                    <td colSpan={visible.length + (selection ? 1 : 0)} style={{ padding: '10px 8px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)' }}>
                      {renderExpanded(item)}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Pager({ hasNext, hasPrevious, onNext, onPrevious, page }: { hasNext: boolean; hasPrevious: boolean; onNext: () => void; onPrevious: () => void; page?: number }) {
  return (
    <div style={{ ...row, marginTop: 10, justifyContent: 'flex-end' }}>
      {page ? <span style={muted}>第 {page} 页</span> : null}
      <Button disabled={!hasPrevious} onClick={onPrevious}>上一页</Button>
      <Button disabled={!hasNext} onClick={onNext}>下一页</Button>
    </div>
  );
}

export function Loading({ loading, error, stale, loadedAt }: { loading: boolean; error: string; stale?: boolean; loadedAt?: string }) {
  return (
    <>
      {error ? <Notice tone="bad">{error}{stale ? '（显示的是上一次成功读取的数据，已过期）' : ''}</Notice> : null}
      {!error && stale ? <Notice tone="warn">数据已过期。</Notice> : null}
      {loading ? <p style={muted}>正在读取…</p> : null}
      {!loading && loadedAt ? <p style={muted}>最后读取：{new Date(loadedAt).toLocaleTimeString()}</p> : null}
    </>
  );
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '暂无数据';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${Number(amount.toFixed(unit === 0 ? 0 : 1))} ${units[unit]}`;
}

export function quotaLimit(value: number | null): string {
  return value === null ? '无限' : bytes(value);
}

export function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '暂无数据';
}
