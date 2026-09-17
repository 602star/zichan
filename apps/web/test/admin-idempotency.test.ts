import { describe, expect, it } from 'vitest';
import { ADMIN_IDEMPOTENCY_KEY_PATTERN, adminIdempotencyKey } from '../src/admin/idempotency.js';

/**
 * The server answers 400 `INVALID_IDEMPOTENCY_KEY` for anything outside
 * `[A-Za-z0-9._:-]{8,128}`, and a rejected key turns a normal management write into a
 * failed one (this happened for `/blobs` and for base64url invite codes).
 */
describe('management idempotency keys', () => {
  const tokens = [
    '/blobs', '/commits', '/role', '/state', 'job-database.integrity-check', 'job-blobs.verify',
    'cancel-job-7f3a9b', 'retry-job-7f3a9b', 'revoke-1c0ffee0-0000-4000-8000-abcdefabcdef',
    'invite-XTkDxxmkl_AFtAPX-disable', 'registration-closed', 'settings',
    'ack-capacity:commit:account-9f2', 'password-reset-issue-account-9f2', 'password-reset-revoke-account-9f2',
    'storage.cleanup-all', 'backup.verify-bk-2026-09-17T10:00:00.000Z',
  ];

  it('builds keys the server accepts, whatever the token looks like', () => {
    for (const token of tokens) {
      const key = adminIdempotencyKey(token, () => 0.5);
      expect(ADMIN_IDEMPOTENCY_KEY_PATTERN.test(key), `${token} -> ${key}`).toBe(true);
      expect(key).toContain(token.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[-.]+|[-.]+$/g, ''));
    }
  });

  it('replaces characters that only exist in paths and base64url identifiers', () => {
    const key = adminIdempotencyKey('/accounts/account-1/commits', () => 0.5);
    expect(key).not.toContain('/');
    expect(ADMIN_IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
  });

  it('keeps the key inside the server length bound for very long tokens', () => {
    const key = adminIdempotencyKey('x'.repeat(400), () => 0.5);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(ADMIN_IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
  });

  it('never produces an empty or too short key for punctuation-only tokens', () => {
    const key = adminIdempotencyKey('///', () => 0.5);
    expect(key.startsWith('admin-')).toBe(true);
    expect(ADMIN_IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
  });
});
