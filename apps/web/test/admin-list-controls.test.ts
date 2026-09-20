import { describe, expect, it } from 'vitest';
import { PAGE_SIZES, listParamsQuery, readListParams, sortState } from '../src/admin/list-controls.js';

/**
 * The URL is the only state these controls own, so these pin the parsing that everything else
 * depends on: a value the page does not understand must fall back rather than reach the server
 * as-is, and the parameter names must be written in exactly one place.
 */
describe('list controls', () => {
  it('reads the sort, direction and page size from the URL', () => {
    const query = new URLSearchParams('sort=name&dir=asc&limit=50');
    expect(readListParams(query, { sort: 'created', dir: 'desc', limit: 25 }))
      .toEqual({ sort: 'name', direction: 'asc', limit: 50 });
  });

  it('falls back to the defaults for anything the page does not understand', () => {
    // A page size the server would clamp, or a direction that is not one of the two, must not be
    // forwarded as-is: the server would answer a different question than the URL claims.
    expect(readListParams(new URLSearchParams('dir=sideways'), { sort: 'created', dir: 'desc', limit: 25 }))
      .toEqual({ sort: 'created', direction: 'desc', limit: 25 });
    expect(readListParams(new URLSearchParams('limit=7'), { sort: 'created', dir: 'desc', limit: 25 }))
      .toEqual({ sort: 'created', direction: 'desc', limit: 25 });
    expect(readListParams(new URLSearchParams('limit=9999'), { sort: 'created', dir: 'desc', limit: 25 }))
      .toEqual({ sort: 'created', direction: 'desc', limit: 25 });
    expect(readListParams(new URLSearchParams(), { sort: 'created', dir: 'desc', limit: 25 }))
      .toEqual({ sort: 'created', direction: 'desc', limit: 25 });
  });

  it('accepts every offered page size', () => {
    for (const size of PAGE_SIZES) {
      expect(readListParams(new URLSearchParams(`limit=${size}`), { sort: 'created', dir: 'desc', limit: 25 }).limit).toBe(size);
    }
  });

  it('writes the parameters the server reads', () => {
    expect(listParamsQuery({ sort: 'lastLogin', direction: 'desc', limit: 100 }))
      .toBe('sort=lastLogin&dir=desc&limit=100');
    // Round-trips through the reader, which is what keeps the two halves from drifting.
    expect(readListParams(new URLSearchParams(listParamsQuery({ sort: 'name', direction: 'asc', limit: 50 })), { sort: 'created', dir: 'desc', limit: 25 }))
      .toEqual({ sort: 'name', direction: 'asc', limit: 50 });
  });

  it('accepts a page size a page offers beyond the shared defaults', () => {
    // The run log offers 500; validating against the default set alone would ignore the choice and
    // serve the default page size while the URL claimed otherwise.
    const sizes = [50, 100, 200, 500];
    expect(readListParams(new URLSearchParams('limit=500'), { sort: 'at', dir: 'desc', limit: 100 }, sizes).limit).toBe(500);
    // A size the page does not offer still falls back.
    expect(readListParams(new URLSearchParams('limit=25'), { sort: 'at', dir: 'desc', limit: 100 }, sizes).limit).toBe(100);
  });

  it('reports the sorted state where assistive technology looks for it', () => {
    const choice = { key: 'state', label: '状态' };
    // A header that is clickable but never announces its ordered state is the failure mode: the
    // click works, and nothing says the column is ordered or which way.
    expect(sortState(choice, 'state', 'asc')).toBe('ascending');
    expect(sortState(choice, 'state', 'desc')).toBe('descending');
    // Only the column actually being sorted claims the state.
    expect(sortState(choice, 'created', 'asc')).toBeUndefined();
    expect(sortState({ key: 'created', label: '创建时间' }, 'state', 'asc')).toBeUndefined();
  });
});
