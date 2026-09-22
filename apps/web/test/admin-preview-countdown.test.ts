import { describe, expect, it } from 'vitest';
import { remainingLabel } from '../src/admin/PreviewPage.js';

/**
 * The countdown is the only thing telling an operator their access is about to end, and the only
 * thing telling them it already has. Both directions matter: a label that keeps counting past the
 * deadline would present a dead session as a live one, and one that ends early would send them
 * away from a session that still works.
 */
describe('preview countdown', () => {
  const at = (iso: string) => Date.parse(iso);
  const now = at('2026-09-22T12:00:00.000Z');

  it('counts down in minutes and seconds', () => {
    expect(remainingLabel('2026-09-22T12:10:00.000Z', now)).toBe('10:00');
    expect(remainingLabel('2026-09-22T12:00:09.000Z', now)).toBe('0:09');
    expect(remainingLabel('2026-09-22T12:01:05.000Z', now)).toBe('1:05');
  });

  it('reports expiry instead of a negative or frozen time', () => {
    // Exactly at the deadline the session is already gone: the server treats `now >= expiresAt`
    // as expired, so showing "0:00" would claim a session that no longer exists.
    expect(remainingLabel('2026-09-22T12:00:00.000Z', now)).toBeNull();
    expect(remainingLabel('2026-09-22T11:59:59.000Z', now)).toBeNull();
  });

  it('treats an unparseable deadline as expired rather than as unlimited time', () => {
    // A server that sent something unexpected must not produce "剩余 NaN:NaN" and leave the page
    // looking live. Expired is the safe reading: it offers to reopen.
    expect(remainingLabel('not-a-date', now)).toBeNull();
    expect(remainingLabel('', now)).toBeNull();
  });
});