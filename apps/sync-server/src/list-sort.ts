/**
 * Server-side sorting for cursor-paginated admin lists.
 *
 * Three rules make this safe, and each one prevents a silent failure:
 *
 * 1. **The cursor must follow the sort key.** A cursor that still means "older than this
 *    timestamp" while the rows are ordered by name skips rows and repeats others, and the page
 *    looks perfectly fine while doing it. Every option therefore names its own ordering
 *    expression, and the cursor is built from it.
 *
 * 2. **A cursor says which sort it belongs to.** Otherwise a cursor from one ordering, pasted
 *    into a URL asking for another, produces a plausible-looking wrong page. Carrying the sort
 *    in the cursor turns that into an explicit error. A cursor without a sort is accepted as the
 *    default ordering, so cursors issued before this existed keep working.
 *
 * 3. **Only whitelisted expressions reach SQL.** The sort name arrives in a query string, so it
 *    selects an entry from a fixed map; it is never interpolated. The direction is one of two
 *    literals.
 *
 * Each ordering expression must be NULL-safe (wrap nullable columns in COALESCE). SQLite puts
 * NULLs first in ASC and last in DESC, and `col > NULL` is NULL rather than true, so a page whose
 * last row had a NULL sort value would silently stop paging. Coalescing gives every row a total
 * position instead.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortOption {
  /**
   * Expression used both for `ORDER BY` and for the cursor comparison. NULL-safe, and it must be
   * usable in a `WHERE` clause (an aggregate is not; use a correlated subquery instead).
   */
  expr: string;
  /** Unique column that makes the ordering total, so a cursor never lands mid-tie. */
  tiebreaker: string;
  /**
   * Set when the expression yields a number. A cursor is a string on the wire, so it has to be
   * converted back before it reaches SQLite, which orders by type before value: `12345 > '9999'`
   * is false, because every integer sorts before every string.
   */
  numeric?: boolean;
  /**
   * Selected column carrying this expression's value, used to build the next cursor.
   *
   * Naming it here keeps the cursor tied to the ordering instead of relying on a second list of
   * column names that would drift the first time a sort is added.
   */
  column: string;
}

export interface ResolvedSort {
  key: string;
  direction: SortDirection;
  /** Selected column holding the sort value, for building the next cursor. */
  column: string;
  /** Converts a cursor's value back to the type the ordering expression expects. */
  value: (raw: string) => string | number;
  /** Full `ORDER BY ...` clause, without the leading keyword. */
  orderBy: string;
  /** `WHERE` fragment placing the next page after this cursor. */
  cursor: (value: string | number, id: string) => { sql: string; params: (string | number)[] };
  /** `sort~dir~value|id`; the leading part is what makes a stale cursor detectable. */
  write: (value: string | number, id: string) => string;
}

/**
 * Whether a sort name is one this list understands.
 *
 * A lookup on the caller's own map with `hasOwnProperty`, not `in`: a name like `constructor` or
 * `toString` is present on every object through its prototype, and `in` would accept it as a sort.
 */
export function isKnownSort(options: Record<string, SortOption>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, name);
}

/**
 * Resolves the requested sort against the allowed set.
 *
 * An unknown name falls back to the default rather than failing: the console and the server are
 * deployed separately, and a page that knows a newer sort must not break every list against a
 * server that does not. The response echoes the sort actually used, so the page can show the
 * truth either way.
 */
export function resolveSort(
  options: Record<string, SortOption>,
  requested: string | null | undefined,
  fallback: string,
  requestedDirection: string | null | undefined,
  fallbackDirection: SortDirection = 'desc',
): ResolvedSort {
  // The name selects an entry from the caller's fixed map, so a query string can never reach SQL as
  // an expression; the direction collapses to one of two literals.
  const key = requested && isKnownSort(options, requested) ? requested : fallback;
  const direction: SortDirection = requestedDirection === 'asc' || requestedDirection === 'desc'
    ? requestedDirection
    : fallbackDirection;
  const option = options[key]!;
  const comparison = direction === 'asc' ? '>' : '<';
  const order = direction === 'asc' ? 'ASC' : 'DESC';
  return {
    key,
    direction,
    column: option.column,
    value: (raw) => (option.numeric ? Number(raw) : raw),
    orderBy: `${option.expr} ${order}, ${option.tiebreaker} ${order}`,
    cursor: (value, id) => ({
      sql: `(${option.expr} ${comparison} ? OR (${option.expr} = ? AND ${option.tiebreaker} ${comparison} ?))`,
      params: [value, value, id],
    }),
    write: (value, id) => `${key}~${direction}~${String(value)}|${id}`,
  };
}

export interface ParsedCursor {
  value: string;
  id: string;
  /** Absent for a cursor issued before cursors carried their sort. */
  sort?: { key: string; direction: string };
}

/**
 * Splits a cursor into its parts.
 *
 * The id is taken after the *first* `|` so an id containing a pipe cannot truncate the cursor.
 * `sort~dir~value|id` is what this module writes; `value|id` is what cursors issued before it
 * carried a sort look like, and those are still accepted.
 *
 * Anything else is rejected rather than reinterpreted. A malformed cursor read as a legacy value
 * would be compared against the ordering expression and return a page that is stable, plausible
 * and wrong — the exact outcome rule 2 exists to prevent.
 */
export function readCursor(cursor: string | undefined): ParsedCursor | undefined {
  if (!cursor) return undefined;
  const separator = cursor.indexOf('|');
  if (separator < 0) return undefined;
  const head = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (!head.includes('~')) return { value: head, id };
  const parts = head.split('~');
  if (parts.length !== 3 || !parts[0] || !parts[1]) return undefined;
  return { sort: { key: parts[0], direction: parts[1] }, value: parts[2]!, id };
}

/**
 * Whether a cursor may be used with the sort the caller resolved.
 *
 * A cursor that names a different sort is refused instead of being reinterpreted: reinterpreting
 * it returns a page that is stable, plausible, and wrong.
 */
export function cursorMatchesSort(cursor: ParsedCursor, sort: ResolvedSort): boolean {
  if (!cursor.sort) return true;
  return cursor.sort.key === sort.key && cursor.sort.direction === sort.direction;
}

/**
 * Reads the next cursor's sort value out of the last row of a page.
 *
 * Shared rather than repeated per list, because each list writing its own conversion is how one of
 * them ends up stringifying a number: the cursor is a string on the wire, and SQLite orders by type
 * before value, so `12345 > '9999'` is false and the following page comes back empty. A NULL —
 * coalesced away in the ordering, but not necessarily in the selected column — becomes an empty
 * string rather than the text "null".
 */
export function cursorValue(row: Record<string, unknown>, sort: ResolvedSort): string | number {
  const value = row[sort.column];
  return typeof value === 'number' ? value : String(value ?? '');
}
