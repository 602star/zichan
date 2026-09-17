/**
 * Idempotency keys for management writes.
 *
 * The server only accepts `[A-Za-z0-9._:-]{8,128}` and answers 400
 * `INVALID_IDEMPOTENCY_KEY` for anything else. Keys are built from a token plus a random
 * suffix so a retried write replays the first result instead of repeating the work — the
 * token therefore has to be sanitised, because page paths and base64url identifiers
 * (session ids, invite codes, alert keys) can contain `/`, `_` or `+`.
 */
export const ADMIN_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function adminIdempotencyKey(token: string, random: () => number = Math.random): string {
  const prefix = token.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 96) || 'admin';
  const key = `${prefix}-${Date.now().toString(36)}-${Math.floor(random() * 0x100000000).toString(36)}`;
  if (!ADMIN_IDEMPOTENCY_KEY_PATTERN.test(key)) throw new Error('生成的幂等键不符合服务端格式');
  return key;
}
