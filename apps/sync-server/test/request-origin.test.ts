import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { createRequestOrigin } from '../src/request-origin.js';

const request = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as IncomingMessage;

describe('request origin trust', () => {
  it('ignores all forwarded headers from an untrusted peer', () => {
    const origin = createRequestOrigin(['127.0.0.1']);
    const req = request('203.0.113.9', { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' });
    expect(origin.clientIp(req)).toBe('203.0.113.9');
    expect(origin.trustedPeer(req)).toBe(false);
    expect(origin.secureTransport(req, false)).toBe(false);
  });
  it('walks trusted hops right-to-left and stops at the first untrusted hop', () => {
    const origin = createRequestOrigin(['10.1.0.0/16']);
    const req = request('10.1.0.2', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9, 10.1.0.3' });
    expect(origin.trustedPeer(req)).toBe(true);
    expect(origin.clientIp(req)).toBe('203.0.113.9');
    expect(origin.secureTransport(req, false)).toBe(false);
  });
  it('never treats a loopback address in XFF as a direct local connection', () => {
    const origin = createRequestOrigin(['loopback']);
    for (const proto of ['', 'https,http', 'https, http']) {
      expect(origin.secureTransport(request('::ffff:127.0.0.1', { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': proto }), false)).toBe(false);
    }
    expect(origin.secureTransport(request('::1', { 'x-forwarded-proto': 'https' }), false)).toBe(true);
    expect(createRequestOrigin([]).secureTransport(request('::1'), false)).toBe(true);
  });
  it('supports IPv6 CIDR and falls back on malformed forwarding chains', () => {
    const origin = createRequestOrigin(['fd00::/8']);
    expect(origin.clientIp(request('fd00::1', { 'x-forwarded-for': '2001:db8::1, fd00::2' }))).toBe('2001:db8::1');
    expect(origin.clientIp(request('fd00::1', { 'x-forwarded-for': 'bad, fd00::2' }))).toBe('fd00::1');
    expect(() => createRequestOrigin(['10.0.0.1/33'])).toThrow('Invalid');
    expect(() => createRequestOrigin(['unknown'])).toThrow('Invalid');
  });
});
