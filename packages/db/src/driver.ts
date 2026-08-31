/**
 * SQL driver port. `@zichan/db` speaks to storage through this narrow async
 * interface, so the same repository runs on any SQLite binding: node:sqlite
 * (desktop/tests), wa-sqlite/OPFS (web), or a dedicated Rust SQL bridge
 * (native shells).
 */

export type SqlParam = string | number | null;

/** Result of a data-changing statement. `changes` is used for atomic CAS writes. */
export interface SqlRunResult {
  changes: number;
  lastInsertRowid?: string | number;
}

/** FIFO mutex used by async drivers so root operations cannot enter an active transaction. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export interface SqlDriver {
  /** Execute one or more statements without parameters (DDL, pragmas). */
  exec(sql: string): Promise<void>;
  /** Run a parameterized statement and report how many rows changed. */
  run(sql: string, params?: SqlParam[]): Promise<SqlRunResult>;
  /** Query rows. */
  all<R = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<R[]>;
  /** Query a single row, or undefined. */
  get<R = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<R | undefined>;
  /** Run `fn` inside a transaction and pass a connection-bound driver scope. */
  transaction<T>(fn: (driver: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
