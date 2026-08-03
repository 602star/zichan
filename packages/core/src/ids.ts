/**
 * ID generation. Uses a ULID-like scheme: a 48-bit timestamp prefix (sortable by
 * creation time) + random suffix. Falls back to crypto.randomUUID when needed.
 * Kept dependency-free so the core stays portable across web/desktop/mobile.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChar(): string {
  return CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)]!;
}

function encodeTime(now: number, len: number): string {
  let out = '';
  let t = now;
  for (let i = len - 1; i >= 0; i--) {
    const mod = t % 32;
    out = CROCKFORD[mod]! + out;
    t = (t - mod) / 32;
  }
  return out;
}

/** Monotonic-ish, time-sortable 26-char id. */
export function newId(now: number = Date.now()): string {
  let rand = '';
  for (let i = 0; i < 16; i++) rand += randomChar();
  return encodeTime(now, 10) + rand;
}

/** Prefixed id, e.g. prefixedId('asset') => 'asset_01J...'. Handy for debugging. */
export function prefixedId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${newId(now)}`;
}
