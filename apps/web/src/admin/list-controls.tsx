/**
 * Sort and page-size controls shared by the cursor-paginated admin lists.
 *
 * Both write into the URL, for the same reason every other filter does: a refresh, a back
 * navigation and a shared link all have to land on the same view.
 *
 * Sorting is applied by the server, never in the browser. Re-sorting the rows that happen to be
 * on screen would reorder twenty-five of them and present the result as "the newest accounts" —
 * a page that is wrong in a way nobody can see.
 */
import type { AdminClient } from './client.js';
import type { ReactNode } from 'react';
import { Field, Select, muted, row } from './ui.js';

export const PAGE_SIZES = [25, 50, 100];

export interface SortChoice {
  key: string;
  label: string;
  /** Which direction the column is most useful in first. Defaults to descending. */
  first?: 'asc' | 'desc';
}

/**
 * A sortable header.
 *
 * Clicking the active column flips the direction; clicking another column starts at that column's
 * natural direction (newest first for a timestamp, ascending for a name). Anything else would make
 * "sort by name" open on the last page of the alphabet.
 *
 * The accessible name is the column label plus what the click does, and it does *not* start with
 * "按…排序": the console has selects labelled with the very same words ("状态", "类型"), and a
 * header named "按状态排序" reads as another filter to anyone looking the column up by name. The
 * ordered state itself is announced through `aria-sort` on the header cell, which is where
 * assistive technology looks for it.
 */
export function SortHeader({ choice, sort, direction, onSort }: {
  choice: SortChoice;
  sort: string;
  direction: string;
  onSort: (next: { sort: string; dir: string }) => void;
}) {
  const active = sort === choice.key;
  const nextDirection = active ? (direction === 'asc' ? 'desc' : 'asc') : (choice.first ?? 'desc');
  return (
    <button
      type="button"
      onClick={() => onSort({ sort: choice.key, dir: nextDirection })}
      title={active ? `当前${direction === 'asc' ? '升序' : '降序'}，点击改为${direction === 'asc' ? '降序' : '升序'}` : '点击排序'}
      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer', color: 'inherit', display: 'inline-flex', gap: 4, alignItems: 'center' }}
    >
      {choice.label}
      <span aria-hidden="true" style={{ opacity: active ? 1 : 0.25 }}>{active && direction === 'asc' ? '↑' : '↓'}</span>
    </button>
  );
}

/** The `aria-sort` value for a header cell, so the ordered state is where assistive tech looks. */
export function sortState(choice: SortChoice, sort: string, direction: string): 'ascending' | 'descending' | undefined {
  if (sort !== choice.key) return undefined;
  return direction === 'asc' ? 'ascending' : 'descending';
}

/**
 * The two props a sortable column needs, as one spreadable value.
 *
 * Kept together because a header that is clickable but never announces its ordered state is the
 * failure mode: `headerNode` alone gives a button, and only `ariaSort` says the column is ordered
 * and which way. Splitting them across a call site is how one of them gets dropped.
 */
export function sortableHeader(
  choice: SortChoice,
  sort: string,
  direction: string,
  onSort: (next: { sort: string; dir: string }) => void,
): { headerNode: ReactNode; ariaSort: 'ascending' | 'descending' | undefined } {
  return {
    headerNode: <SortHeader choice={choice} sort={sort} direction={direction} onSort={onSort} />,
    ariaSort: sortState(choice, sort, direction),
  };
}

/** Page size, written to the URL so the choice survives a refresh. */
export function PageSizeSelect({ value, onApply, sizes = PAGE_SIZES }: {
  value: number;
  onApply: (size: number) => void;
  sizes?: number[];
}) {
  return (
    <Field label="每页条数">
      <Select value={String(value)} onChange={(event) => onApply(Number(event.target.value))} aria-label="每页条数">
        {sizes.map((size) => <option key={size} value={size}>{size} 条</option>)}
      </Select>
    </Field>
  );
}

/**
 * Reads `sort`/`dir`/`limit` from the URL with the same defaults the server uses.
 *
 * `sizes` must be the set the page actually offers. A list that offers 200 but validates against
 * the default set silently ignores the choice and serves the default page size instead — the URL
 * says 200, the table shows 25, and nothing reports the disagreement.
 */
export function readListParams(query: URLSearchParams, defaults: { sort: string; dir: string; limit: number }, sizes: number[] = PAGE_SIZES): {
  sort: string;
  direction: string;
  limit: number;
} {
  const direction = query.get('dir') === 'asc' ? 'asc' : query.get('dir') === 'desc' ? 'desc' : defaults.dir;
  const limit = sizes.includes(Number(query.get('limit'))) ? Number(query.get('limit')) : defaults.limit;
  return { sort: query.get('sort') || defaults.sort, direction, limit };
}

/** The query-string fragment every list appends, so one place decides the parameter names. */
export function listParamsQuery(params: { sort: string; direction: string; limit: number }): string {
  return `sort=${encodeURIComponent(params.sort)}&dir=${params.direction}&limit=${params.limit}`;
}

/** Explains why a header click reloads instead of reordering what is already on screen. */
export function SortNote({ count }: { count?: number }) {
  return (
    <p style={muted}>
      排序由服务端执行{count === undefined ? '' : `（本次匹配 ${count} 条）`}：只重排当前页会得到一份看起来对、实际错的结果。
    </p>
  );
}

export { row };
export type { AdminClient };
