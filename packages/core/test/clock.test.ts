import { describe, expect, it } from 'vitest';
import { dayOfInstant, fixedClock, localToday, systemClock } from '../src/index.js';

/*
 * The zone is pinned to Asia/Shanghai by vitest.config.ts, so the machine-calendar
 * paths below are deterministic too.
 */

describe('fixedClock', () => {
  it('reports the ledger day while the UTC date is still yesterday', () => {
    // 00:30 in Beijing is 16:30 the previous day in UTC — the window where a
    // UTC-derived "today" silently disagrees with the user's calendar.
    const clock = fixedClock('2026-09-14T00:30:00+08:00', 'Asia/Shanghai');
    expect(clock.day()).toBe('2026-09-14');
    expect(clock.instant().slice(0, 10)).toBe('2026-09-13');
  });

  it('keeps the day stable across the rest of the local day', () => {
    for (const time of ['08:00', '12:00', '23:59']) {
      expect(fixedClock(`2026-09-14T${time}:00+08:00`, 'Asia/Shanghai').day()).toBe('2026-09-14');
    }
  });

  it('gives two devices in different zones the same ledger day', () => {
    /*
     * Same instant, one ledger zone. Without a zone the answer follows the
     * device, which is how one ledger ends up with two "todays".
     */
    const at = '2026-09-14T00:30:00+08:00';
    expect(fixedClock(at, 'Asia/Shanghai').day()).toBe('2026-09-14');
    expect(fixedClock(at, 'UTC').day()).toBe('2026-09-13');
    expect(fixedClock(at, 'America/New_York').day()).toBe('2026-09-13');
  });

  it('falls back to the machine calendar for an absent or unknown zone', () => {
    const at = '2026-09-14T00:30:00+08:00';
    expect(fixedClock(at).day()).toBe(localToday(new Date(at)));
    expect(fixedClock(at, 'Not/AZone').day()).toBe(localToday(new Date(at)));
  });

  it('does not advance between reads', () => {
    const clock = fixedClock('2026-09-14T23:59:59+08:00', 'Asia/Shanghai');
    expect(clock.day()).toBe(clock.day());
    expect(clock.instant()).toBe(clock.instant());
  });

  it('exposes the fixed instant for arithmetic', () => {
    const clock = fixedClock(1_760_000_000_000, 'Asia/Shanghai');
    expect(clock.now().getTime()).toBe(1_760_000_000_000);
    expect(clock.instant()).toBe(new Date(1_760_000_000_000).toISOString());
  });

  it('rejects an unparseable instant instead of returning Invalid Date', () => {
    expect(() => fixedClock('not-a-date')).toThrow('invalid instant');
  });
});

describe('systemClock', () => {
  it('resolves the day in the given zone', () => {
    expect(systemClock('Asia/Shanghai').day()).toBe(dayOfInstant(new Date(), 'Asia/Shanghai'));
  });

  it('matches the local day when no zone is given', () => {
    expect(systemClock().day()).toBe(localToday());
  });

  it('reports an ISO-8601 UTC instant', () => {
    expect(systemClock().instant()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('exposes the configured zone', () => {
    expect(systemClock('Asia/Shanghai').timeZone()).toBe('Asia/Shanghai');
    expect(systemClock().timeZone()).toBeUndefined();
  });
});
