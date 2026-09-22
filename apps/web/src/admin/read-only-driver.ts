/**
 * A `SqlDriver` that can only read.
 *
 * The preview reuses the real ledger UI, and that UI is built to write: it saves settings,
 * runs scheduled transactions, records history and would happily accept an edit. Pointing a
 * writable store at a preview would take an administrator's keystroke and apply it to a user's
 * ledger — through the operator's own session, with no replica of their own to roll back.
 *
 * The guard therefore lives at the driver, not in the screens. A disabled button is a hint;
 * this is the thing that actually holds, and it holds for every caller including a code path
 * that was never written to check `readOnly`. Reads (`all`/`get`) pass through untouched so
 * every report and dashboard still renders.
 *
 * `transaction` is refused too: callers open one to write, and a read-only transaction that
 * silently succeeded would let the caller believe a save happened.
 */
import type { SqlDriver, SqlParam, SqlRunResult } from '@zichan/db';

/** Thrown for any write attempt. Screens surface `message` verbatim. */
export class ReadOnlyPreviewError extends Error {
  readonly code = 'PREVIEW_READ_ONLY';

  constructor() {
    super('这是只读预览：可以查看全部页面，但不能修改用户的数据。');
    this.name = 'ReadOnlyPreviewError';
  }
}

/** Lets callers branch on a refusal without importing the class (a store wraps the error). */
export function isReadOnlyPreviewError(error: unknown): error is ReadOnlyPreviewError {
  return error instanceof ReadOnlyPreviewError
    || (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'PREVIEW_READ_ONLY');
}

/**
 * Wrap a driver so writes fail loudly.
 *
 * Statements are not inspected: allowing only `SELECT` would need a real SQL parser, and a
 * regex over SQL text is exactly the kind of check that looks like safety while missing the
 * statement that matters. Reads are safe by construction, so they are the ones that pass.
 *
 * The refusals are `async` on purpose. `SqlDriver` promises a `Promise` from every method, and
 * throwing synchronously would escape as an uncaught exception for any caller that used
 * `.catch()` instead of `await` — turning a clear refusal into a page-level crash.
 */
export function readOnlyDriver(inner: SqlDriver): SqlDriver {
  return {
    exec: async (_sql: string): Promise<void> => { throw new ReadOnlyPreviewError(); },
    run: async (_sql: string, _params?: SqlParam[]): Promise<SqlRunResult> => { throw new ReadOnlyPreviewError(); },
    all: <R = Record<string, unknown>>(sql: string, params?: SqlParam[]) => inner.all<R>(sql, params),
    get: <R = Record<string, unknown>>(sql: string, params?: SqlParam[]) => inner.get<R>(sql, params),
    transaction: async <T>(_fn: (driver: SqlDriver) => Promise<T>): Promise<T> => { throw new ReadOnlyPreviewError(); },
    close: () => inner.close(),
  };
}