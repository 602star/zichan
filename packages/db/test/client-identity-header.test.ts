import { describe, expect, it, afterEach } from 'vitest';
import { httpCommitTransport } from '../src/http-transport.js';
import { CLIENT_IDENTITY_HEADER, createLedgerCryptoSession, formatClientIdentity } from '@zichan/core';

const ledgerId = 'ledger-0000000000000001';

/**
 * The client half of the client-identity feature. The server-side test proves the value is
 * recorded when it arrives; this proves the client actually produces and sends it — the half
 * that silently does nothing if the wiring is wrong, because syncing still works either way.
 */
async function captureFirstRequestHeaders(overrides: { clientIdentity?: { kind: string; version: string; protocol: string } }) {
  const sent: Record<string, string>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    sent.push({ ...(init?.headers ?? {}) });
    return new Response(
      JSON.stringify({ serverId: 'srv-x', bound: true, ledgerId, replicaId: 'replica-x', streamEpoch: 'epoch-1', headSeq: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const transport = httpCommitTransport({
      baseUrl: 'https://ledger.example.test',
      token: 'test-token',
      cryptoSession: createLedgerCryptoSession(ledgerId),
      keyEnvelope: { v: 1, ledgerId, keyringId: 'keyring-0000000000001', generation: 1 },
      ...overrides,
    });
    await transport.connect(ledgerId);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent[0] ?? {};
}

afterEach(() => { /* fetch is restored inside each helper call. */ });

describe('client identity on relay requests', () => {
  it('reports the build on every request when the transport is given one', async () => {
    const headers = await captureFirstRequestHeaders({ clientIdentity: { kind: 'desktop', version: '1.2.3', protocol: '3' } });
    expect(headers[CLIENT_IDENTITY_HEADER]).toBe(formatClientIdentity({ kind: 'desktop', version: '1.2.3', protocol: '3' }));
  });

  it('sends no header, and still authorizes, when there is no identity to report', async () => {
    // Absent is not the same as wrong: an older build has no identity to send, and it must keep
    // syncing exactly as before rather than being refused.
    const headers = await captureFirstRequestHeaders({});
    expect(headers[CLIENT_IDENTITY_HEADER]).toBeUndefined();
    expect(typeof headers['Authorization']).toBe('string');
  });

  it('drops an unusable identity instead of failing the sync request', async () => {
    // A diagnostic header must never be able to break syncing, so a malformed value is dropped.
    const headers = await captureFirstRequestHeaders({ clientIdentity: { kind: 'Web', version: '1.2.3', protocol: '3' } });
    expect(headers[CLIENT_IDENTITY_HEADER]).toBeUndefined();
    expect(typeof headers['Authorization']).toBe('string');
  });
});
