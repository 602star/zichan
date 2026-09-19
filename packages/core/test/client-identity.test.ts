import { describe, expect, it } from 'vitest';
import { CLIENT_IDENTITY_HEADER, SYNC_PROTOCOL_VERSION, formatClientIdentity, parseClientIdentity } from '../src/client-identity.js';

/**
 * The client identity is self-reported and purely informational, so the important properties are
 * about how it fails: an unreadable value must read as "not reported" rather than as a plausible
 * but wrong client, and a value that cannot be produced must never be sent.
 */
describe('client identity header', () => {
  it('round-trips a well-formed identity', () => {
    const identity = { kind: 'web', version: '0.1.0', protocol: SYNC_PROTOCOL_VERSION };
    expect(parseClientIdentity(formatClientIdentity(identity))).toEqual(identity);
  });

  it('carries a protocol generation so a mismatch can be named', () => {
    expect(formatClientIdentity({ kind: 'desktop', version: '1.2.3', protocol: '3' }))
      .toBe('zichan-client/1 kind=desktop version=1.2.3 protocol=3');
  });

  it('treats a missing or unreadable value as no identification at all', () => {
    // Absent is not the same as old: every one of these has to come back as "unknown",
    // otherwise historical events would be reported as running an ancient build.
    expect(parseClientIdentity(undefined)).toBeUndefined();
    expect(parseClientIdentity(null)).toBeUndefined();
    expect(parseClientIdentity('')).toBeUndefined();
    expect(parseClientIdentity('   ')).toBeUndefined();
    expect(parseClientIdentity('curl/8.0')).toBeUndefined();
    // A different format tag is a different format, not a partial match.
    expect(parseClientIdentity('zichan-client/2 kind=web version=0.1.0 protocol=3')).toBeUndefined();
  });

  it('rejects a partial identity rather than pairing a version with the wrong client', () => {
    expect(parseClientIdentity('zichan-client/1 version=0.1.0 protocol=3')).toBeUndefined();
    expect(parseClientIdentity('zichan-client/1 kind=web protocol=3')).toBeUndefined();
    expect(parseClientIdentity('zichan-client/1 kind=web version=0.1.0')).toBeUndefined();
  });

  it('rejects values that do not match the expected shape', () => {
    expect(parseClientIdentity('zichan-client/1 kind=WEB version=0.1.0 protocol=3')).toBeUndefined();
    expect(parseClientIdentity('zichan-client/1 kind=web version=0.1.0 protocol=3; DROP TABLE x')).toBeUndefined();
    expect(parseClientIdentity('zichan-client/1 kind=web version=0.1.0 protocol=')).toBeUndefined();
    expect(parseClientIdentity(`zichan-client/1 kind=web version=${'9'.repeat(64)} protocol=3`)).toBeUndefined();
    // A header long enough to be an attack rather than an identification.
    expect(parseClientIdentity(`zichan-client/1 kind=web version=0.1.0 protocol=3 ${'x'.repeat(300)}`)).toBeUndefined();
  });

  it('refuses to format a value it would then have to reject', () => {
    expect(() => formatClientIdentity({ kind: 'Web', version: '0.1.0', protocol: '3' })).toThrow();
    expect(() => formatClientIdentity({ kind: 'web', version: '', protocol: '3' })).toThrow();
    expect(() => formatClientIdentity({ kind: 'web', version: '0.1.0', protocol: 'v 3' })).toThrow();
  });

  it('keeps the header name stable for the CORS allowlist', () => {
    // The server has to allow this exact header by name, so renaming it silently would strip
    // the value from every cross-origin request without failing anything.
    expect(CLIENT_IDENTITY_HEADER).toBe('X-Zichan-Client');
  });
});
