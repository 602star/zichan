import { describe, it, expect } from 'vitest';
import { createLogger, memorySink, jsonSink } from '../src/index.js';

describe('logger', () => {
  it('isolates failed sinks from callers and healthy sinks', () => {
    const sink = memorySink();
    const logger = createLogger({ sinks: [() => { throw new Error('disk full'); }, sink] });
    expect(() => logger.child('db').info('committed')).not.toThrow();
    expect(sink.records[0]?.msg).toBe('committed');
  });
  it('bounds memory retention and validates its capacity', () => {
    const sink = memorySink([], 2);
    const logger = createLogger({ sinks: [sink] });
    for (const msg of ['a', 'b', 'c']) logger.info(msg);
    expect(sink.records.map((record) => record.msg)).toEqual(['b', 'c']);
    expect(() => memorySink([], 0)).toThrow('positive integer');
  });
  it('filters records below the configured level', () => {
    const sink = memorySink();
    const log = createLogger({ level: 'info', sinks: [sink] });
    log.debug('hidden');
    log.info('shown');
    log.warn('also shown');
    expect(sink.records.map((r) => r.msg)).toEqual(['shown', 'also shown']);
  });

  it('child loggers compose scope and inherit fields', () => {
    const sink = memorySink();
    const root = createLogger({ level: 'trace', sinks: [sink], scope: 'db', fields: { deviceId: 'd1' } });
    const child = root.child('repository', { table: 'assets' });
    child.info('put', { id: 'a1' });
    const rec = sink.records[0]!;
    expect(rec.scope).toBe('db.repository');
    expect(rec.fields).toEqual({ deviceId: 'd1', table: 'assets', id: 'a1' });
  });

  it('setLevel propagates to existing children (shared level box)', () => {
    const sink = memorySink();
    const root = createLogger({ level: 'info', sinks: [sink] });
    const child = root.child('x');
    root.setLevel('error');
    child.info('suppressed');
    child.error('kept');
    expect(sink.records.map((r) => r.msg)).toEqual(['kept']);
  });

  it('serializes errors passed to error()', () => {
    const sink = memorySink();
    const log = createLogger({ level: 'info', sinks: [sink] });
    log.error('boom', new Error('kaboom'));
    expect(sink.records[0]!.err?.message).toBe('kaboom');
    expect(sink.records[0]!.err?.name).toBe('Error');
  });

  it('jsonSink emits one parseable object per record', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sinks: [jsonSink((l) => lines.push(l))] });
    log.info('hello', { a: 1 });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.msg).toBe('hello');
    expect(parsed.fields).toEqual({ a: 1 });
    expect(parsed.level).toBe('info');
  });
});
