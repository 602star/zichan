import { describe, expect, it } from 'vitest';
import { cursorMatchesSort, isKnownSort, readCursor, resolveSort, type SortOption } from '../src/list-sort.js';

/**
 * The failure modes this module exists to prevent are all silent:
 *
 * - a cursor that does not follow the sort key skips rows and repeats others;
 * - a cursor from one ordering reused under another returns a stable, plausible, wrong page;
 * - a numeric key compared as a string stops paging, because SQLite orders by type first;
 * - an unknown sort name reaching SQL as an expression.
 */
const options: Record<string, SortOption> = {
  created: { expr: 'u.created_at', tiebreaker: 'u.username' },
  name: { expr: 'u.username', tiebreaker: 'u.username' },
  size: { expr: 'COALESCE(SUM(c.cipher_bytes), 0)', tiebreaker: 'u.username', numeric: true },
  sync: { expr: "COALESCE((SELECT MAX(e.at) FROM sync_events e WHERE e.username = u.username), '')", tiebreaker: 'u.username' },
};

describe('cursor list sorting', () => {
  it('falls back to the default instead of failing on an unknown sort name', () => {
    // Page and server deploy separately: a page that knows a newer sort must not break the list.
    const resolved = resolveSort(options, 'not-a-sort', 'created', null);
    expect(resolved.key).toBe('created');
    expect(resolved.direction).toBe('desc');
    expect(isKnownSort(options, 'not-a-sort')).toBe(false);
    expect(isKnownSort(options, 'created')).toBe(true);
    // A name every object inherits must not count as a known sort: `in` would accept these, and the
    // lookup would then return a function where an ordering expression was expected.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(isKnownSort(options, inherited)).toBe(false);
      expect(resolveSort(options, inherited, 'created', null).key).toBe('created');
    }
  });

  it('builds the cursor from the same expression it orders by', () => {
    const byName = resolveSort(options, 'name', 'created', 'asc');
    expect(byName.orderBy).toBe('u.username ASC, u.username ASC');
    expect(byName.cursor('alice', 'alice').sql).toBe('(u.username > ? OR (u.username = ? AND u.username > ?))');

    const byCreated = resolveSort(options, 'created', 'created', 'desc');
    expect(byCreated.orderBy).toBe('u.created_at DESC, u.username DESC');
    expect(byCreated.cursor('2026-01-01T00:00:00.000Z', 'bob').sql)
      .toBe('(u.created_at < ? OR (u.created_at = ? AND u.username < ?))');
  });

  it('reverses the comparison when the direction flips', () => {
    expect(resolveSort(options, 'name', 'created', 'asc').cursor('m', 'm').sql).toContain('>');
    expect(resolveSort(options, 'name', 'created', 'desc').cursor('m', 'm').sql).toContain('<');
    expect(resolveSort(options, 'name', 'created', 'desc').cursor('m', 'm').params).toEqual(['m', 'm', 'm']);
  });

  it('accepts only the two known directions', () => {
    expect(resolveSort(options, 'name', 'created', 'ascending').direction).toBe('desc');
    expect(resolveSort(options, 'name', 'created', 'ASC').direction).toBe('desc');
    expect(resolveSort(options, 'name', 'created', 'asc').direction).toBe('asc');
  });

  it('orders nullable columns through a coalesced expression', () => {
    // `col > NULL` is NULL, not true: a page whose last row had a NULL sort value stops paging
    // with no error at all.
    const resolved = resolveSort(options, 'sync', 'created', 'desc');
    expect(resolved.orderBy.startsWith('COALESCE((SELECT MAX(e.at)')).toBe(true);
    expect(resolved.orderBy).toContain("'')");
  });

  it('restores a numeric key as a number, because SQLite orders by type before value', () => {
    // `12345 > '9999'` is false: every integer sorts before every string. A cursor's value is a
    // string on the wire, so without this the second page would silently be empty.
    const numeric = resolveSort(options, 'size', 'created', 'desc');
    expect(numeric.value('12345')).toBe(12345);
    expect(typeof numeric.value('12345')).toBe('number');
    const textual = resolveSort(options, 'name', 'created', 'desc');
    expect(textual.value('12345')).toBe('12345');
  });

  it('writes the sort into the cursor and refuses one that names a different sort', () => {
    const byName = resolveSort(options, 'name', 'created', 'asc');
    const byCreated = resolveSort(options, 'created', 'created', 'desc');
    const cursor = byName.write('alice', 'alice');
    expect(cursor).toBe('name~asc~alice|alice');

    const parsed = readCursor(cursor)!;
    expect(parsed).toEqual({ value: 'alice', id: 'alice', sort: { key: 'name', direction: 'asc' } });
    expect(cursorMatchesSort(parsed, byName)).toBe(true);
    // Reinterpreting it under the other ordering is what must not happen.
    expect(cursorMatchesSort(parsed, byCreated)).toBe(false);
  });

  it('keeps the id after the first separator, so a pipe inside it cannot truncate the cursor', () => {
    expect(readCursor('name~asc~alice|weird|id')).toEqual({ value: 'alice', id: 'weird|id', sort: { key: 'name', direction: 'asc' } });
  });

  it('rejects a malformed cursor instead of reinterpreting it', () => {
    expect(readCursor('a|weird|id')).toBeUndefined();
    expect(readCursor('name~asc|no-value')).toBeUndefined();
    expect(readCursor('name~asc~too~many|x')).toBeUndefined();
    expect(readCursor('~asc~x|id')).toBeUndefined();
    expect(readCursor('no-separator')).toBeUndefined();
    expect(readCursor(undefined)).toBeUndefined();
  });
});
