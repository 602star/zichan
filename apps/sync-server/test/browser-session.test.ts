import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestOrigin } from '../src/request-origin.js';
import { createBrowserSessionCookies } from '../src/browser-session.js';

const request = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as IncomingMessage;

describe('browser session origin and cookies', () => {
  it('separates administration and ledger cookies and rejects cross-origin admin refresh', () => {
    const cookies = createBrowserSessionCookies('/ledger', () => 'https://ledger.example');
    const regular = `session-${'a'.repeat(32)}.${'b'.repeat(43)}`;
    const admin = `session-${'c'.repeat(32)}.${'d'.repeat(43)}`;
    const req = request('127.0.0.1', { origin: 'https://ledger.example', 'x-zichan-session': 'admin-cookie', cookie: `zichan_session=${regular}; zichan_admin_session=${admin}` });
    expect(cookies.requested(req)).toBe(true);
    expect(cookies.read(req)).toBe(admin);
    expect(cookies.read(request('127.0.0.1', { cookie: String(req.headers.cookie) }))).toBe(regular);
    expect(() => cookies.requested(request('127.0.0.1', { origin: 'https://attacker.example', 'x-zichan-session': 'admin-cookie' }))).toThrow();
  });
  it('requires HTTPS from a trusted proxy and preserves the public host and port', () => {
    const origin = createRequestOrigin(['loopback']);
    const req = request('127.0.0.1', { host: 'ledger.example:9443', origin: 'https://ledger.example:9443', 'x-forwarded-proto': 'https', 'x-zichan-session': 'cookie' });
    const cookies = createBrowserSessionCookies('/zichan', origin.browserOrigin);
    expect(cookies.requested(req)).toBe(true);
    let header = '';
    cookies.write(req, { setHeader: (_key: string, value: string) => { header = value; } } as ServerResponse, 'opaque-token');
    expect(header).toContain('; Secure');
    expect(header).toContain('Path=/zichan/api/auth');
    for (const proto of ['http', 'https,http', '']) {
      expect(() => cookies.requested(request('127.0.0.1', { ...req.headers, 'x-forwarded-proto': proto } as Record<string, string>))).toThrow();
    }
  });

  it('does not offer insecure cookies to a LAN client or a non-loopback host', () => {
    const origin = createRequestOrigin([]);
    expect(origin.browserOrigin(request('192.168.1.7', { host: '192.168.1.2:8787' }))).toBeUndefined();
    expect(origin.browserOrigin(request('127.0.0.1', { host: 'ledger.example', 'x-forwarded-proto': 'https' }))).toBeUndefined();
    expect(origin.browserOrigin(request('::1', { host: '[::1]:8787' }))).toBe('http://[::1]:8787');
  });

  it('offers LAN HTTP browser cookies only when insecure transport is explicitly enabled', () => {
    const lan = request('192.168.1.7', { host: '192.168.1.2:8787' });
    expect(createRequestOrigin([], true).browserOrigin(lan)).toBe('http://192.168.1.2:8787');
    expect(createRequestOrigin([]).browserOrigin(lan)).toBeUndefined();
    // A trusted proxy must still attest the protocol; a missing header stays rejected.
    expect(createRequestOrigin(['loopback'], true).browserOrigin(request('127.0.0.1', { host: 'ledger.example' }))).toBeUndefined();
  });

  it('accepts a same-origin browser behind a host-to-bridge proxy without trusting its forwarded headers', () => {
    const origin = createRequestOrigin(['127.0.0.1'], true);
    const headers = {
      host: 'ledger.example', origin: 'https://ledger.example',
      'x-forwarded-proto': 'https', 'x-zichan-session': 'admin-cookie',
    };
    const req = request('172.18.0.1', headers);
    const cookies = createBrowserSessionCookies('', origin.browserOrigin);
    expect(origin.trustedPeer(req)).toBe(false);
    expect(cookies.requested(req)).toBe(true);
    let cookie = '';
    cookies.write(req, { setHeader: (_key: string, value: string) => { cookie = value; } } as ServerResponse, 'token');
    expect(cookie).toContain('; Secure');
    expect(() => cookies.requested(request('172.18.0.1', { ...headers, origin: 'https://attacker.example' }))).toThrow();
    expect(() => cookies.requested(request('172.18.0.1', { ...headers, host: '127.0.0.1:8787' }))).toThrow();
    expect(createRequestOrigin(['127.0.0.1']).browserOrigin(req)).toBeUndefined();
    expect(origin.secureTransport(req, false)).toBe(false);
  });

  it('rejects duplicate cookies and never implicitly selects cookie authentication', () => {
    const cookies = createBrowserSessionCookies('', () => 'https://ledger.example');
    const token = `session-${'a'.repeat(32)}.${'b'.repeat(43)}`;
    const req = request('127.0.0.1', { cookie: `zichan_session=${token}` });
    expect(cookies.requested(req)).toBe(false);
    expect(cookies.read(req)).toBe(token);
    expect(cookies.read(request('127.0.0.1', { cookie: `${req.headers.cookie}; ${req.headers.cookie}` }))).toBeUndefined();
    expect(() => cookies.requested(request('127.0.0.1', { 'x-zichan-session': 'something-else' }))).toThrow();
  });

  it('encodes Unicode mount paths into a valid ASCII Cookie header', () => {
    const cookies = createBrowserSessionCookies('/账本-2026', () => 'https://ledger.example');
    let header = '';
    cookies.write(request('127.0.0.1', {}), { setHeader: (_key: string, value: string) => { header = value; } } as ServerResponse, 'token');
    expect(header).toContain('Path=/%E8%B4%A6%E6%9C%AC-2026/api/auth');
    expect(header).not.toContain('账本');
  });
});
