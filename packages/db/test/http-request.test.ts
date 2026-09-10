import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError, requestJson } from '../src/http-request.js';
import { fetchAuthMe, refreshAccountSession } from '../src/http-transport.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded JSON requests', () => {
  it.each(['headers', 'body'])('aborts stalled %s without replaying a write', async (stage) => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => stage === 'headers' ? new Promise(() => {})
      : { ok: true, status: 200, json: () => new Promise(() => {}) });
    vi.stubGlobal('fetch', fetcher);
    const pending = requestJson('https://example.com/api', { method: 'POST' }, { timeoutMs: 50 });
    const failed = expect(pending).rejects.toMatchObject({ kind: 'timeout', message: expect.stringContaining('未自动重复提交') });
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string, { signal: AbortSignal }])[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels immediately, including signals aborted before the call', async () => {
    const fetcher = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const pending = requestJson('https://example.com', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('取消');
    await expect(requestJson('https://example.com', {}, { signal: controller.signal })).rejects.toThrow('取消');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes network, HTTP and malformed successful responses', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('<html>unavailable</html>', { status: 503 }))
      .mockResolvedValueOnce(new Response('<html>app</html>'));
    vi.stubGlobal('fetch', fetcher);
    await expect(requestJson('https://example.com')).rejects.toMatchObject({ kind: 'network' });
    await expect(fetchAuthMe('https://example.com', 'token')).rejects.toMatchObject({ kind: 'http', status: 503 });
    await expect(requestJson('https://example.com')).rejects.not.toBeInstanceOf(HttpRequestError);
  });

  it('bounds refresh-session and account reads by default', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const refresh = expect(refreshAccountSession('https://example.com', 'refresh')).rejects.toMatchObject({ kind: 'timeout' });
    const me = expect(fetchAuthMe('https://example.com', 'access')).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([refresh, me]);
  });
});
