import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushStartupTimings, queueStartupTiming } from '../src/startup-timing-upload.js';
import { newSyncConnection } from '../src/sync-config.js';

vi.mock('../src/sync-auth.js', () => ({ authenticateSyncProfile: async () => 'test-token', hasAccountSession: () => true }));
vi.mock('../src/credential-vault.js', () => ({ runtimeCredential: () => ({ sessionId: 'session' }) }));
afterEach(() => { vi.unstubAllGlobals(); });
describe('startup telemetry delivery', () => {
  it('retains HTTP failures, serializes concurrent uploads and removes samples only after success', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value) });
    vi.stubGlobal('navigator', {});
    const profile = newSyncConnection('https://timing.example');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    queueStartupTiming(profile.baseUrl, { version: 1, startedAt: '', totalMs: 1100, stages: [], counts: {} });
    await expect(flushStartupTimings(profile)).rejects.toThrow('503');
    expect([...values.values()].join('')).toContain('1100');
    await Promise.all([flushStartupTimings(profile), flushStartupTimings(profile)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect([...values.values()]).toEqual(['[]']);
  });
});
