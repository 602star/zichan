/**
 * SqlDriver backed by sql.js (SQLite compiled to WASM). Lets the browser reuse
 * the exact @zichan/db schema + repository. The database lives in memory and is
 * exported to IndexedDB (debounced) after each mutation for durability.
 */
import initSqlJs, { type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { SerialTaskQueue, type SqlDriver, type SqlParam, type SqlRunResult } from '@zichan/db';

type Persist = (bytes: Uint8Array) => void | Promise<void>;
type CloseHook = () => void | Promise<void>;

function runtimeWasmUrl(): string {
  if (typeof window === 'undefined' && typeof self === 'undefined') {
    const local = new URL('../../../../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url);
    const path = decodeURIComponent(local.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  }
  return wasmUrl;
}

interface SqlJsState {
  db: Database;
  onPersist?: Persist;
  queue: SerialTaskQueue;
  nextSavepoint: number;
  onClose?: CloseHook;
  closed: boolean;
  dirty: boolean;
}

export class SqlJsDriver implements SqlDriver {
  private readonly nestedQueue = new SerialTaskQueue();

  private constructor(
    private readonly state: SqlJsState,
    private readonly transactionScoped = false,
  ) {}

  static async open(bytes: Uint8Array | null, onPersist?: Persist, onClose?: CloseHook): Promise<SqlJsDriver> {
    const SQL = await initSqlJs({ locateFile: runtimeWasmUrl });
    const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    return new SqlJsDriver({ db, onPersist, onClose, queue: new SerialTaskQueue(), nextSavepoint: 0, closed: false, dirty: false });
  }

  private async persist(): Promise<void> {
    if (!this.state.dirty) return;
    if (this.state.onPersist) await this.state.onPersist(this.state.db.export());
    this.state.dirty = false;
  }

  async exec(sql: string): Promise<void> {
    await this.operation(async () => {
      this.state.db.run(sql);
      if (!this.transactionScoped) {
        this.state.dirty = true;
        await this.persist();
      }
    });
  }

  async run(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
    return this.operation(async () => {
      this.state.db.run(sql, params as (string | number | null)[]);
      const changes = this.state.db.getRowsModified();
      if (!this.transactionScoped) {
        this.state.dirty = true;
        await this.persist();
      }
      return { changes };
    });
  }

  async all<R = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<R[]> {
    return this.operation(async () => {
      const stmt = this.state.db.prepare(sql);
      try {
        stmt.bind(params as (string | number | null)[]);
        const out: R[] = [];
        while (stmt.step()) out.push(stmt.getAsObject() as R);
        return out;
      } finally {
        stmt.free();
      }
    });
  }

  async get<R = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<R | undefined> {
    return (await this.all<R>(sql, params))[0];
  }

  async transaction<T>(fn: (driver: SqlDriver) => Promise<T>): Promise<T> {
    if (!this.transactionScoped) {
      return this.state.queue.run(async () => {
        this.state.db.run('BEGIN');
        const scoped = new SqlJsDriver(this.state, true);
        let result: T;
        try {
          result = await fn(scoped);
          this.state.db.run('COMMIT');
          this.state.dirty = true;
        } catch (error) {
          this.state.db.run('ROLLBACK');
          throw error;
        }
        await this.persist();
        return result;
      });
    }

    return this.nestedQueue.run(async () => {
      const savepoint = `web_sp_${++this.state.nextSavepoint}`;
      this.state.db.run(`SAVEPOINT ${savepoint}`);
      const scoped = new SqlJsDriver(this.state, true);
      try {
        const result = await fn(scoped);
        this.state.db.run(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.state.db.run(`ROLLBACK TO ${savepoint}`);
        this.state.db.run(`RELEASE ${savepoint}`);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.transactionScoped) return;
    await this.state.queue.run(async () => {
      if (this.state.closed) return;
      try {
        await this.persist();
      } finally {
        try {
          this.state.db.close();
        } finally {
          this.state.closed = true;
          await this.state.onClose?.();
        }
      }
    });
  }

  private operation<T>(task: () => Promise<T>): Promise<T> {
    if (this.transactionScoped) return task();
    return this.state.queue.run(task);
  }
}
