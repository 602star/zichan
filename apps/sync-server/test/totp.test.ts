import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  currentStep,
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUrl,
  totpAtStep,
  verifyTotp,
} from '../src/totp.js';

/**
 * The published RFC 6238 test vectors use ASCII "12345678901234567890" as the SHA-1 secret,
 * which is exactly this base32 value. Pinning them keeps "our own implementation agrees with
 * itself" from passing as correctness.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const rfcVector = (seconds: number): string | undefined => totpAtStep(RFC_SECRET, Math.floor(seconds / 30));

describe('base32', () => {
  it('round-trips and rejects values that are not base32', () => {
    const secret = generateMfaSecret();
    expect(base32Encode(base32Decode(secret)!)).toBe(secret);
    expect(base32Decode('not base32!')).toBeUndefined();
    expect(base32Decode('')).toBeUndefined();
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vectors (6 digits)', () => {
    // RFC 6238 lists 8-digit values; the last six digits are the 6-digit code.
    expect(rfcVector(59)).toBe('287082');
    expect(rfcVector(1_111_111_109)).toBe('081804');
    expect(rfcVector(1_111_111_111)).toBe('050471');
  });

  it('accepts one step of clock drift, and only within the window', () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(verifyTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step - 1)!, now)).toEqual({ step: step - 1 });
    expect(verifyTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step + 1)!, now)).toEqual({ step: step + 1 });
    expect(verifyTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step - 2)!, now)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step + 2)!, now)).toBeUndefined();
  });

  it('refuses a code that was already consumed inside its window', () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    const code = totpAtStep(RFC_SECRET, step)!;
    expect(verifyTotp(RFC_SECRET, code, now, step - 1)).toEqual({ step });
    // The same code, now that its step is recorded as used.
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeUndefined();
  });

  it('rejects malformed submissions without touching the comparison', () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(verifyTotp(RFC_SECRET, '', now)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, '12345', now)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBeUndefined();
    // Spaces are tolerated because authenticator apps display "123 456".
    const spaced = totpAtStep(RFC_SECRET, step)!.replace(/(\d{3})(\d{3})/, '$1 $2');
    expect(verifyTotp(RFC_SECRET, spaced, now)).toEqual({ step });
  });

  it('builds an otpauth URI an authenticator app can read', () => {
    const url = new URL(otpauthUrl({ issuer: 'Zichan', account: 'owner', secret: RFC_SECRET }));
    expect(url.protocol).toBe('otpauth:');
    expect(url.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(url.searchParams.get('issuer')).toBe('Zichan');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  it('generates distinct codes and stores only their hashes', () => {
    const { codes, hashes } = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    expect(hashes).toHaveLength(10);
    for (const code of codes) expect(looksLikeRecoveryCode(code)).toBe(true);
    // A hash must not contain the code it came from.
    codes.forEach((code, index) => {
      expect(hashes[index]).toHaveLength(64);
      expect(hashes[index]).not.toContain(code.replace('-', ''));
    });
  });

  it('accepts the same code with or without the dash and in any case', () => {
    const base = hashRecoveryCode('ABCD-2345');
    expect(hashRecoveryCode('abcd2345')).toBe(base);
    expect(hashRecoveryCode(' ABCD-2345 ')).toBe(base);
    expect(hashRecoveryCode('ABCD-2346')).not.toBe(base);
  });
});
