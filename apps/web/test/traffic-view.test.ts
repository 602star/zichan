import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('first party page analytics privacy and idempotence', () => {
  it('does not create identifiers or send events when the visitor opts out', async () => {
    const setItem = vi.fn(); const fetch = vi.fn();
    vi.stubGlobal('window', { crypto: globalThis.crypto, localStorage: { getItem: () => null, setItem } });
    vi.stubGlobal('navigator', { doNotTrack: '1' }); vi.stubGlobal('fetch', fetch);
    const { reportPageView } = await import('../src/traffic-view.js');
    reportPageView('https://example.test', '/app/transactions');
    expect(setItem).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('adds event identifiers and suppresses duplicate StrictMode entries without suppressing navigation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { crypto: globalThis.crypto, localStorage: { getItem: () => '12345678-1234-1234-1234-123456789abc', setItem: vi.fn() } });
    vi.stubGlobal('navigator', {}); vi.stubGlobal('fetch', fetch);
    const { reportPageView } = await import('../src/traffic-view.js');
    reportPageView('https://example.test', '/app/transactions');
    reportPageView('https://example.test', '/app/transactions');
    reportPageView('https://example.test', '/app/fixed');
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetch.mock.calls[0]![1].body as string) as Record<string, string>;
    const second = JSON.parse(fetch.mock.calls[1]![1].body as string) as Record<string, string>;
    expect(first['eventId']).toMatch(/^[a-f0-9-]{36}$/);
    expect(second['eventId']).not.toBe(first['eventId']);
    expect(first['page']).toBe('/app/transactions');
    expect(first).not.toHaveProperty('userId');
  });
});
