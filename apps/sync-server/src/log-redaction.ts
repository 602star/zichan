/**
 * Redaction for exported run logs.
 *
 * The run log is the one place where free-form diagnostic detail accumulates, and an export is
 * the one path that takes it out of the console: a screenshot in a ticket can be recalled, an
 * attached file cannot. The audit export already refuses to emit invite codes, reset codes,
 * tokens and keys; this applies the same rule to logs and does it **by shape**, not by trusting
 * every current log call site to stay clean.
 *
 * Two independent passes, because either one alone leaks:
 *
 *  - **By key name** — a field called `token`, `inviteCode`, `password` or similar is replaced
 *    wherever it appears, at any depth. This catches the case where someone later adds a log line
 *    that carries a secret in a field it should not.
 *  - **By value shape** — a value that looks like a credential is replaced even under an innocent
 *    key. This catches the case where a secret ends up inside a `message`, a `path` or a free-form
 *    string.
 *
 * What is deliberately *not* redacted: account ids, usernames, job ids, request ids, device ids
 * and ISO timestamps. They are long hex-ish strings too, and removing them would make the export
 * useless for its purpose — correlating a failure with the console. Only values whose length
 * matches a secret's are removed.
 */

/** Key names whose value is never exported, matched case-insensitively as a substring. */
const SECRET_KEY = /(pass|secret|token|credential|invite|reset|apikey|api_key|private|authorization|cookie)/i;

/**
 * Value shapes that are credentials regardless of the key they sit under.
 *
 * The lengths are the important part. A random secret in this codebase is at least 32 hex
 * characters (16 bytes) or a 43-character base64url reset code; account ids, job ids and request
 * ids are prefixed and shorter, so they survive. Being *more* aggressive here would silently
 * strip the correlation ids the export exists to carry.
 */
const SECRET_VALUE = [
  /^[a-f0-9]{32,}$/i,                      // hex secret (sha-256, key material)
  /^[A-Za-z0-9_-]{43}$/,                   // base64url reset code
  /^[A-Za-z0-9_-]{64,}$/,                  // long opaque secret
];

const REDACTED = '[已脱敏]';

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function isSecretValue(value: unknown): boolean {
  return typeof value === 'string' && SECRET_VALUE.some((pattern) => pattern.test(value));
}

/**
 * Returns a copy with secret-keyed fields and credential-shaped values replaced.
 *
 * Depth-limited: a diagnostic detail is a small record, so anything deeper than a few levels is
 * not real data and is replaced wholesale rather than walked.
 */
export function redactForExport(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return isSecretValue(value) ? REDACTED : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[层级过深]';
  if (Array.isArray(value)) return value.map((entry) => redactForExport(entry, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSecretKey(key) ? REDACTED : redactForExport(entry, depth + 1);
  }
  return result;
}

/**
 * Redacts a free-form string by shape only.
 *
 * Used for the message and the rendered summary, which have no keys to inspect. Whole-token
 * matching keeps ordinary prose intact: a sentence is not a credential just because it is long.
 */
export function redactText(text: string): string {
  return text.replace(/\S+/g, (token) => (isSecretValue(token) ? REDACTED : token));
}
