/**
 * @zichan/logger — a tiny structured, leveled logger with pluggable sinks.
 *
 * Platform-agnostic (no Node deps): the same logger runs in web, desktop and
 * mobile shells. Records are structured objects; where they go is decided by the
 * sinks you attach. Child loggers inherit level + sinks and add scope/fields.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

export interface LogRecord {
  time: string; // ISO-8601 UTC
  level: Exclude<LogLevel, 'silent'>;
  msg: string;
  /** Dotted scope, e.g. "db.repository.assets". */
  scope?: string;
  /** Arbitrary structured context. */
  fields?: Record<string, unknown>;
  /** Serialized error, if one was passed. */
  err?: { name: string; message: string; stack?: string };
}

export type Sink = (record: LogRecord) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sinks?: Sink[];
  scope?: string;
  fields?: Record<string, unknown>;
}

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fieldsOrErr?: Record<string, unknown> | Error, err?: Error): void;
  /** Derive a child logger with an extended scope and/or default fields. */
  child(scope: string, fields?: Record<string, unknown>): Logger;
  /** Change the minimum level at runtime (affects this logger and its children). */
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
}

function serializeError(e: Error): NonNullable<LogRecord['err']> {
  return { name: e.name, message: e.message, stack: e.stack };
}

class LoggerImpl implements Logger {
  // Level is boxed in an object so child loggers share live updates with the parent.
  private readonly levelBox: { level: LogLevel };
  private readonly sinks: Sink[];
  private readonly scope?: string;
  private readonly fields?: Record<string, unknown>;

  constructor(opts: LoggerOptions, levelBox?: { level: LogLevel }, sinks?: Sink[]) {
    this.levelBox = levelBox ?? { level: opts.level ?? 'info' };
    this.sinks = sinks ?? opts.sinks ?? [consoleSink()];
    this.scope = opts.scope;
    this.fields = opts.fields;
  }

  private emit(
    level: Exclude<LogLevel, 'silent'>,
    msg: string,
    fields?: Record<string, unknown>,
    err?: Error,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.levelBox.level]) return;
    const merged =
      this.fields || fields ? { ...this.fields, ...fields } : undefined;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      msg,
    };
    if (this.scope) record.scope = this.scope;
    if (merged && Object.keys(merged).length) record.fields = merged;
    if (err) record.err = serializeError(err);
    for (const sink of this.sinks) {
      try { sink(record); } catch {
        // Logging must not abort a ledger transaction or suppress other sinks.
      }
    }
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    this.emit('trace', msg, fields);
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }
  error(
    msg: string,
    fieldsOrErr?: Record<string, unknown> | Error,
    err?: Error,
  ): void {
    if (fieldsOrErr instanceof Error) this.emit('error', msg, undefined, fieldsOrErr);
    else this.emit('error', msg, fieldsOrErr, err);
  }

  child(scope: string, fields?: Record<string, unknown>): Logger {
    return new LoggerImpl(
      {
        scope: this.scope ? `${this.scope}.${scope}` : scope,
        fields: this.fields || fields ? { ...this.fields, ...fields } : undefined,
      },
      this.levelBox,
      this.sinks,
    );
  }

  setLevel(level: LogLevel): void {
    this.levelBox.level = level;
  }
  getLevel(): LogLevel {
    return this.levelBox.level;
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new LoggerImpl(opts);
}

// ─────────────────────────────── Sinks ───────────────────────────────

/** No-op sink — the default for the core so libraries stay silent unless wired. */
export function nullSink(): Sink {
  return () => {};
}

/** The subset of `console` the sink uses — avoids depending on DOM/node libs. */
export interface ConsoleLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Human-readable console sink for development. */
export function consoleSink(
  out: ConsoleLike = (globalThis as unknown as { console: ConsoleLike }).console,
): Sink {
  return (r) => {
    const scope = r.scope ? `[${r.scope}]` : '';
    const extra = r.fields ? ' ' + safeJson(r.fields) : '';
    const errStr = r.err ? ` ${r.err.name}: ${r.err.message}` : '';
    const line = `${r.time} ${r.level.toUpperCase().padEnd(5)} ${scope} ${r.msg}${extra}${errStr}`;
    if (r.level === 'error') out.error(line);
    else if (r.level === 'warn') out.warn(line);
    else if (r.level === 'info') out.info(line);
    else out.debug(line);
  };
}

/** One JSON object per line — for files / log shippers. */
export function jsonSink(write: (line: string) => void): Sink {
  return (r) => write(safeJson(r));
}

/** Collects records in memory — handy for tests and in-app log viewers. */
export function memorySink(store: LogRecord[] = [], capacity = 1000): Sink & { records: LogRecord[] } {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Log capacity must be a positive integer');
  if (store.length > capacity) store.splice(0, store.length - capacity);
  const sink = ((r: LogRecord) => {
    store.push(r);
    if (store.length > capacity) store.splice(0, store.length - capacity);
  }) as Sink & { records: LogRecord[] };
  sink.records = store;
  return sink;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export { LEVEL_ORDER };
