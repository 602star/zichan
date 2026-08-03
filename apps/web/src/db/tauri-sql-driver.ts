import { SerialTaskQueue, type SqlDriver, type SqlParam, type SqlRunResult } from '@zichan/db';
import { tauriInvoke } from '../tauri.js';

function invokeRequired<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const request = tauriInvoke<T>(command, args);
  if (!request) throw new Error(`Tauri command is unavailable: ${command}`);
  return request;
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | '[' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    current += char;
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      const closer = quote === '[' ? ']' : quote;
      if (char === closer) {
        if (quote !== '[' && next === closer) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      current += next;
      index += 1;
      lineComment = true;
    } else if (char === '/' && next === '*') {
      current += next;
      index += 1;
      blockComment = true;
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char;
    } else if (char === ';') {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = '';
    }
  }
  if (quote || blockComment) throw new Error('SQL script contains an unterminated quote or comment');
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

export class TauriSqlDriver implements SqlDriver {
  private readonly nestedQueue = new SerialTaskQueue();
  readonly databaseUrl: string;

  private constructor(
    databaseUrl: string,
    private readonly state = { queue: new SerialTaskQueue(), nextSavepoint: 0 },
    private readonly transactionId?: string,
  ) {
    this.databaseUrl = databaseUrl;
  }

  static async open(databaseKeyHex: string): Promise<TauriSqlDriver> {
    if (!/^[a-f0-9]{64}$/.test(databaseKeyHex)) throw new Error('原生数据库密钥无效');
    const databaseUrl = await invokeRequired<string>('native_sql_database_url');
    await invokeRequired<void>('native_sql_open', { db: databaseUrl, databaseKeyHex });
    await invokeRequired<void>('native_sql_prepare', { db: databaseUrl });
    return new TauriSqlDriver(databaseUrl);
  }

  async dataPath(): Promise<string> {
    return invokeRequired<string>('native_sql_database_path');
  }

  async exec(sql: string): Promise<void> {
    await this.operation(async () => {
      for (const statement of splitSqlStatements(sql)) await this.executeRaw(statement);
    });
  }

  async run(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
    return this.operation(() => this.executeRaw(sql, params));
  }

  private async executeRaw(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
    const changes = await invokeRequired<number>('native_sql_execute', {
      db: this.databaseUrl,
      query: sql,
      values: params,
      transactionId: this.transactionId,
    });
    return { changes };
  }

  async all<R = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<R[]> {
    return this.operation(() => invokeRequired<R[]>('native_sql_select', {
      db: this.databaseUrl,
      query: sql,
      values: params,
      transactionId: this.transactionId,
    }));
  }

  async get<R = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<R | undefined> {
    return (await this.all<R>(sql, params))[0];
  }

  async transaction<T>(fn: (driver: SqlDriver) => Promise<T>): Promise<T> {
    if (!this.transactionId) {
      return this.state.queue.run(async () => {
        const transactionId = await invokeRequired<string>('native_sql_begin', { db: this.databaseUrl });
        const scoped = new TauriSqlDriver(this.databaseUrl, this.state, transactionId);
        try {
          const result = await fn(scoped);
          await invokeRequired<void>('native_sql_commit', { transactionId });
          return result;
        } catch (error) {
          await invokeRequired<void>('native_sql_rollback', { transactionId }).catch(() => undefined);
          throw error;
        }
      });
    }

    return this.nestedQueue.run(async () => {
      const savepoint = `native_sp_${++this.state.nextSavepoint}`;
      await this.executeRaw(`SAVEPOINT ${savepoint}`);
      const scoped = new TauriSqlDriver(this.databaseUrl, this.state, this.transactionId);
      try {
        const result = await fn(scoped);
        await this.executeRaw(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        await this.executeRaw(`ROLLBACK TO ${savepoint}`);
        await this.executeRaw(`RELEASE ${savepoint}`);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.transactionId) return;
    await this.state.queue.run(async () => {
      await invokeRequired<void>('native_sql_close', { db: this.databaseUrl });
    });
  }

  private operation<T>(task: () => Promise<T>): Promise<T> {
    if (this.transactionId) return task();
    return this.state.queue.run(task);
  }
}
