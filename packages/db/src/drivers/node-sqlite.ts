/**
 * SqlDriver backed by Node's built-in `node:sqlite`. Used for tests and the
 * desktop-node path. Synchronous under the hood; wrapped in resolved promises to
 * satisfy the async port. Fine for a local single-writer ledger.
 *
 * The builtin is loaded via `process.getBuiltinModule` (Node ≥ 22.3) rather than
 * a static import, so web/bundler toolchains that don't know this new builtin
 * never try to resolve it. This file is node-only and never imported on web.
 */
import { SerialTaskQueue, type SqlDriver, type SqlParam, type SqlRunResult } from '../driver.js';

interface StatementLike {
  run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}
type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseLike;
};

function loadSqlite(): SqliteModule {
  const proc = (globalThis as unknown as {
    process?: { getBuiltinModule?: (id: string) => SqliteModule };
  }).process;
  if (!proc?.getBuiltinModule) {
    throw new Error('node:sqlite requires Node ≥ 22.3 (process.getBuiltinModule unavailable)');
  }
  return proc.getBuiltinModule('node:sqlite');
}

export class NodeSqliteDriver implements SqlDriver {
  private readonly nestedQueue = new SerialTaskQueue();

  constructor(
    filename = ':memory:',
    private readonly state: { db: DatabaseLike; queue: SerialTaskQueue; nextSavepoint: number } | null = null,
    private readonly transactionScoped = false,
  ) {
    if (!this.state) {
      const { DatabaseSync } = loadSqlite();
      const db = new DatabaseSync(filename);
      this.state = { db, queue: new SerialTaskQueue(), nextSavepoint: 0 };
      try {
        db.exec('PRAGMA foreign_keys = ON;');
      } catch {
        // ignore pragma failures on exotic builds
      }
    }
  }

  async exec(sql: string): Promise<void> {
    await this.operation(async () => { this.state!.db.exec(sql); });
  }

  async run(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
    return this.operation(async () => {
      const result = this.state!.db.prepare(sql).run(...params);
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid: typeof result.lastInsertRowid === 'bigint'
          ? result.lastInsertRowid.toString()
          : result.lastInsertRowid,
      };
    });
  }

  async all<R = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<R[]> {
    return this.operation(async () => this.state!.db.prepare(sql).all(...params) as R[]);
  }

  async get<R = Record<string, unknown>>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<R | undefined> {
    return this.operation(async () => this.state!.db.prepare(sql).get(...params) as R | undefined);
  }

  async transaction<T>(fn: (driver: SqlDriver) => Promise<T>): Promise<T> {
    if (!this.transactionScoped) {
      return this.state!.queue.run(async () => {
        this.state!.db.exec('BEGIN');
        const scoped = new NodeSqliteDriver(':memory:', this.state, true);
        try {
          const result = await fn(scoped);
          this.state!.db.exec('COMMIT');
          return result;
        } catch (error) {
          this.state!.db.exec('ROLLBACK');
          throw error;
        }
      });
    }

    return this.nestedQueue.run(async () => {
      const savepoint = `node_sp_${++this.state!.nextSavepoint}`;
      this.state!.db.exec(`SAVEPOINT ${savepoint}`);
      const scoped = new NodeSqliteDriver(':memory:', this.state, true);
      try {
        const result = await fn(scoped);
        this.state!.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.state!.db.exec(`ROLLBACK TO ${savepoint}`);
        this.state!.db.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.transactionScoped) return;
    await this.state!.queue.run(async () => { this.state!.db.close(); });
  }

  private operation<T>(task: () => Promise<T>): Promise<T> {
    if (this.transactionScoped) return task();
    return this.state!.queue.run(task);
  }
}
