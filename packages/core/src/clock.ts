/**
 * Injectable source of "now", split into the two shapes §0.6 needs.
 *
 * Production call sites read the wall clock, which makes the interesting cases
 * untestable: "what does the dashboard show at 00:30 Beijing" cannot be
 * expressed against `new Date()`. Routing those reads through a `Clock` turns
 * each one into a table-driven test.
 *
 * `instant()` and `day()` exist as separate methods on purpose. They are
 * different concepts with different types, and collapsing them is the mistake
 * this module exists to prevent.
 */
import { dayOfInstant, localToday, toInstant } from './dates.js';

export interface Clock {
  /** Wall-clock instant as an ISO-8601 UTC string. */
  instant(): string;
  /** Current business day, resolved in the clock's zone. */
  day(): string;
  /** The underlying instant, for callers that need arithmetic or `Date` methods. */
  now(): Date;
  /** IANA zone this clock resolves the calendar in; absent means the machine's. */
  timeZone(): string | undefined;
}

/**
 * The real clock.
 *
 * Pass a zone to make `day()` independent of the device: a ledger opened in
 * London and in Shanghai must agree on which day it is, so the zone belongs to
 * the ledger rather than to the machine reading it.
 */
export function systemClock(timeZone?: string): Clock {
  return {
    instant: () => new Date().toISOString(),
    day: () => (timeZone === undefined ? localToday() : dayOfInstant(new Date(), timeZone)),
    now: () => new Date(),
    timeZone: () => timeZone,
  };
}

/** A clock frozen at one instant, for tests. */
export function fixedClock(at: string | number | Date, timeZone?: string): Clock {
  const value = toInstant(at);
  return {
    instant: () => value.toISOString(),
    day: () => (timeZone === undefined ? localToday(value) : dayOfInstant(value, timeZone)),
    now: () => new Date(value.getTime()),
    timeZone: () => timeZone,
  };
}
