/**
 * ID generation. Uses a ULID-like scheme: a 48-bit timestamp prefix (sortable by
 * creation time) + a Web Crypto random suffix. Kept dependency-free so the
 * core stays portable across web/desktop/mobile.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

function randomChar(bytes: Uint8Array, index: number): string {
  return CROCKFORD[bytes[index]! % CROCKFORD.length]!;
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
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += randomChar(bytes, i);
  return encodeTime(now, 10) + rand;
}

/** Prefixed id, e.g. prefixedId('asset') => 'asset_01J...'. Handy for debugging. */
export function prefixedId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${newId(now)}`;
}
