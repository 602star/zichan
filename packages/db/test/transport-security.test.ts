import { createLedgerKeyEnvelope } from '@zichan/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSecureSyncUrl, httpCommitTransport, isLocalNetworkSyncUrl } from '../src/http-transport.js';

afterEach(() => vi.unstubAllGlobals());

describe('sync transport security', () => {
  it('allows HTTPS and explicit local network HTTP endpoints', () => {
    expect(() => assertSecureSyncUrl('https://ledger.example.com/zichan')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://localhost:8787')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://192.168.1.20:8787')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://[fd00::20]:8787')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://[fe90::20]:8787')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://[febf::20]:8787')).not.toThrow();
    expect(isLocalNetworkSyncUrl('https://192.168.1.20:8787')).toBe(true);
    expect(isLocalNetworkSyncUrl('https://ledger.example.com')).toBe(false);
  });

  it('rejects public HTTP endpoints and URL credentials', () => {
    expect(() => assertSecureSyncUrl('http://ledger.example.com')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://fcorp.example.com')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://fdomain.example.com')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://8.8.8.8:8787')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://[fec0::20]:8787')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('https://owner:secret@ledger.example.com')).toThrow('不能包含用户名或密码');
  });

  it('allows a reviewed host over plain HTTP without treating it as private', () => {
    expect(() => assertSecureSyncUrl('http://test.ojco.de')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://test.ojco.de:8787/zichan')).not.toThrow();
    expect(() => assertSecureSyncUrl('https://test.ojco.de')).not.toThrow();
    // Classification must not follow the transport exception. This host is on
    // the public internet, so it must not be stored as device-local or merged
    // into a device's scope just because it was granted plain-HTTP transport.
    expect(isLocalNetworkSyncUrl('http://test.ojco.de')).toBe(false);
  });

  it('keeps the plain-HTTP exception list exact', () => {
    expect(() => assertSecureSyncUrl('http://ojco.de')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://eviltest.ojco.de')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://sub.test.ojco.de')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://test.ojco.de.evil.example')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://ledger.example.com')).toThrow('公网同步必须使用 HTTPS');
  });

  it('never binds an unbound replica during destructive-join preflight', async () => {
    const ledgerId = 'ledger-existing-0001';
    const keys = await createLedgerKeyEnvelope(ledgerId, 'remote-password');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      serverId: 'server-existing',
      bound: false,
      headSeq: 0,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = httpCommitTransport({
      baseUrl: 'https://ledger.example.test',
      token: 'token',
      cryptoSession: keys.session,
      keyEnvelope: keys.envelope,
      requireExistingReplica: true,
    });

    await expect(transport.connect(ledgerId)).rejects.toThrow('尚未绑定远端账本');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({ method: 'POST' });
  });

  it('never repairs a key envelope that changes during destructive-join preflight', async () => {
    const ledgerId = 'ledger-existing-0002';
    const keys = await createLedgerKeyEnvelope(ledgerId, 'remote-password');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.endsWith('/api/v3/replica')
        ? { serverId: 'server-existing', bound: true, ledgerId, replicaId: 'replica-existing', streamEpoch: 'epoch-existing', headSeq: 0 }
        : { envelope: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = httpCommitTransport({
      baseUrl: 'https://ledger.example.test',
      token: 'token',
      cryptoSession: keys.session,
      keyEnvelope: keys.envelope,
      requireExistingReplica: true,
    });

    await expect(transport.connect(ledgerId)).rejects.toThrow('密钥封套在预检期间消失');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
});
