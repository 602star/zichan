/**
 * Two-factor authentication for management accounts (TOTP, RFC 6238).
 *
 * Implemented on `node:crypto` alone: the console already depends on the platform, and a
 * hand-rolled HMAC-free scheme would be the only thing worse than one more dependency.
 *
 * Two properties matter beyond "the code matches":
 * - a code is accepted once per time step, so a code observed by someone else cannot be
 *   replayed inside its validity window;
 * - recovery codes are stored as hashes and consumed one at a time, so a lost device does not
 *   lock the only administrator out and a database copy does not reveal the codes.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 20 bytes = 160 bits, the size RFC 4226 recommends for HMAC-SHA1 secrets. */
const SECRET_BYTES = 20;
const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side: a clock a little off still works, and nothing older does. */
const DEFAULT_WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Uint8Array | undefined {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!cleaned || /[^A-Z2-7]/.test(cleaned)) return undefined;
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of cleaned) {
    value = (value << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

/** New enrollment secret. Returned to the operator exactly once, at enrollment time. */
export function generateMfaSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The code for one time step, without any drift allowance — kept separate so tests can pin it. */
export function totpAtStep(secret: string, step: number, digits = DIGITS): string | undefined {
  const key = base32Decode(secret);
  if (!key) return undefined;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function currentStep(atMs: number): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

export function totpCode(secret: string, atMs: number): string | undefined {
  return totpAtStep(secret, currentStep(atMs));
}

export interface TotpMatch {
  /** Time step the code belongs to; persisted so the same code cannot be used twice. */
  step: number;
}

/**
 * Verifies a code and returns the step it belongs to, or `undefined`. `lastStep` is the highest
 * step already consumed: anything at or below it is rejected, which is what stops replay.
 */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number,
  lastStep = -1,
  window = DEFAULT_WINDOW,
): TotpMatch | undefined {
  const submitted = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(submitted)) return undefined;
  const step = currentStep(atMs);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidateStep = step + offset;
    const expected = totpAtStep(secret, candidateStep);
    if (!expected) return undefined;
    if (candidateStep <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) return { step: candidateStep };
  }
  return undefined;
}

export function otpauthUrl(input: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const query = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** Recovery codes are compared by hash; dashes and case are ignored so typing is forgiving. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES)).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** True for anything shaped like a recovery code, so the two paths never get confused. */
export function looksLikeRecoveryCode(value: string): boolean {
  return /^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$/.test(value.trim());
}
