import { describe, expect, it } from 'vitest';
import { isSecretKey, isSecretValue, redactForExport, redactText } from '../src/log-redaction.js';

/**
 * The export is the one path that takes free-form diagnostic detail out of the console, and an
 * attached file cannot be recalled the way a screenshot can. These tests pin the two properties
 * that matter: secrets go, correlation ids stay.
 */
describe('log export redaction', () => {
  it('removes a secret by key name, at any depth', () => {
    const redacted = redactForExport({
      requestId: 'req-0123456789abcdef',
      inviteCode: 'abc',
      nested: { password: 'hunter2', deeper: { authorization: 'Bearer x' } },
    }) as Record<string, unknown>;
    expect(redacted['inviteCode']).toBe('[已脱敏]');
    expect((redacted['nested'] as Record<string, unknown>)['password']).toBe('[已脱敏]');
    expect(((redacted['nested'] as Record<string, unknown>)['deeper'] as Record<string, unknown>)['authorization']).toBe('[已脱敏]');
    // The correlation id is the reason the export exists; removing it would defeat the purpose.
    expect(redacted['requestId']).toBe('req-0123456789abcdef');
  });

  it('removes a credential-shaped value even under an innocent key', () => {
    // This is the case a key-name-only rule misses: the secret ends up inside a free-form field.
    const hex = 'a'.repeat(64);
    const base64 = 'B'.repeat(43);
    const redacted = redactForExport({ message: 'ok', detail: { path: hex, label: base64 } }) as Record<string, unknown>;
    const detail = redacted['detail'] as Record<string, unknown>;
    expect(detail['path']).toBe('[已脱敏]');
    expect(detail['label']).toBe('[已脱敏]');
    // Prose is not a credential just because it is long.
    expect(redactForExport('同步失败，请检查网络或服务器状态。')).toBe('同步失败，请检查网络或服务器状态。');
  });

  it('keeps the identifiers the console correlates on', () => {
    // If these were stripped the export could not be matched to the console, which is its point.
    for (const value of [
      'account-0123456789abcdef0123456789abcdef',
      'req-0123456789abcdef',
      'job-0123456789abcdef',
      'rep-0123456789abcdef',
      'epoch-0123456789abcdef',
      '2026-09-19T14:00:29.342Z',
      'victim',
      '127.0.0.1',
    ]) {
      expect(isSecretValue(value)).toBe(false);
    }
  });

  it('redacts whole tokens in a free-form string without touching ordinary words', () => {
    const text = `failed for ${'f'.repeat(64)} from 127.0.0.1 at 2026-09-19T14:00:29.342Z`;
    const redacted = redactText(text);
    expect(redacted).toContain('[已脱敏]');
    expect(redacted).toContain('127.0.0.1');
    expect(redacted).toContain('2026-09-19T14:00:29.342Z');
  });

  it('stops walking absurdly deep structures instead of recursing without bound', () => {
    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let index = 0; index < 12; index += 1) deep = { nested: deep };
    expect(JSON.stringify(redactForExport(deep))).toContain('[层级过深]');
  });

  it('treats a secret-shaped key as secret regardless of casing or position', () => {
    for (const key of ['password', 'PasswordHash', 'resetCode', 'invite_code', 'apiKey', 'api_key', 'privateKey', 'accessToken', 'authorization', 'cookie']) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ['username', 'accountId', 'requestId', 'jobId', 'level', 'status', 'path']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});
