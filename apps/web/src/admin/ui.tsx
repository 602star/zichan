/** Shared presentation pieces for every management page. */
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AdminError } from './client.js';

export const panel: CSSProperties = { padding: 16, borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', marginTop: 12 };
export const row: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };
export const muted: CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' };

export function message(error: unknown): string {
  if (error instanceof AdminError) {
    const labels: Record<string, string> = {
      RECENT_LOGIN_REQUIRED: '敏感操作需要最近 5 分钟内的登录。请退出管理后台并重新登录，再执行此操作。',
      PROTECTED_ACCOUNT: '此账号受保护，你无权修改。',
      OWNER_REQUIRED: '仅服务器所有者可以执行此操作。',
      ADMIN_REQUIRED: '需要管理员权限。',
      ACCOUNT_DISABLED: '请先启用该账号。',
      INVITE_USED: '邀请码已使用，不能再改变状态。',
      STALE_WRITE: '账号数据已被其他管理员修改，请刷新后再提交。',
      IDEMPOTENCY_KEY_REUSED: '该幂等键已用于不同的请求参数，已拒绝；请刷新后重新发起。',
      REQUEST_TIMEOUT: '请求超时，服务器可能已完成操作。请先刷新核实结果，再决定是否重试。',
      JOB_TYPE_INVALID: '不支持的任务类型。',
      JOB_PARAMETER_INVALID: '任务参数无效。',
      INVALID_SETTING: '设置取值无效。',
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

export function Panel({ title, action, children, note }: { title?: string; action?: ReactNode; children: ReactNode; note?: string }) {
  return (
    <section style={panel}>
      {(title || action) && (
        <div style={{ ...row, justifyContent: 'space-between', marginBottom: 12 }}>
          {title ? <strong>{title}</strong> : <span />}
          {action}
        </div>
      )}
      {children}
      {note ? <p style={{ ...muted, marginTop: 10 }}>{note}</p> : null}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'var(--danger, #b3261e)' : tone === 'warn' ? 'var(--warning, #8a5a00)' : undefined;
  return (
    <div style={{ padding: 14, borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: 'var(--fs-display)', fontWeight: 'var(--fw-bold)', color }}>{value}</div>
      {hint ? <div style={muted}>{hint}</div> : null}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'muted' }) {
  const background = tone === 'ok' ? 'var(--ok-surface, #e6f4ea)' : tone === 'warn' ? 'var(--warn-surface, #fef7e0)'
    : tone === 'bad' ? 'var(--danger-surface, #fce8e6)' : 'var(--surface-muted, #f1f3f4)';
  return <span style={{ background, borderRadius: 'var(--r-pill)', padding: '2px 8px', fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap' }}>{children}</span>;
}

export function Notice({ children, tone }: { children: ReactNode; tone?: 'bad' | 'warn' | 'info' }) {
  const background = tone === 'bad' ? 'var(--danger-surface, #fce8e6)' : tone === 'warn' ? 'var(--warn-surface, #fef7e0)' : 'var(--surface-muted, #f1f3f4)';
  return <p style={{ background, borderRadius: 'var(--r-sm, 6px)', padding: '8px 10px', margin: '8px 0 0' }}>{children}</p>;
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
  return <input {...props} style={{ minHeight: 36, padding: '0 8px', borderRadius: 'var(--r-sm, 6px)', border: '1px solid var(--border)', background: 'var(--surface)', ...props.style }} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ minHeight: 36, padding: '0 8px', borderRadius: 'var(--r-sm, 6px)', border: '1px solid var(--border)', background: 'var(--surface)', ...props.style }} />;
}

export function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      style={{
        minHeight: 36, padding: '0 12px', borderRadius: 'var(--r-sm, 6px)', border: '1px solid var(--border)',
        background: props.disabled ? 'var(--surface-muted, #f1f3f4)' : 'var(--surface)', cursor: props.disabled ? 'default' : 'pointer',
        ...props.style,
      }}
    >{children}</button>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Hidden on narrow screens to keep the table readable on a phone. */
  secondary?: boolean;
}

export function DataTable<T>({ columns, rows, rowKey, empty, onRowClick, activeKey, renderExpanded }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: string;
  onRowClick?: (row: T) => void;
  activeKey?: string;
  /** Rendered in a full-width row directly under the active row. */
  renderExpanded?: (row: T) => ReactNode;
}) {
  if (!rows.length) return <p style={muted}>{empty}</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.secondary ? 'zc-admin-secondary' : undefined} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', ...muted }}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const key = rowKey(item);
            return (
              <Fragment key={key}>
                <tr
                  data-active={activeKey === key ? 'true' : undefined}
                  onClick={onRowClick ? () => onRowClick(item) : undefined}
                  style={{ cursor: onRowClick ? 'pointer' : undefined, background: activeKey === key ? 'var(--surface-muted, #f1f3f4)' : undefined }}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={column.secondary ? 'zc-admin-secondary' : undefined} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>{column.render(item)}</td>
                  ))}
                </tr>
                {renderExpanded && activeKey === key ? (
                  <tr>
                    <td colSpan={columns.length} style={{ padding: '10px 8px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted, #f1f3f4)' }}>
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

export function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '暂无数据';
}
