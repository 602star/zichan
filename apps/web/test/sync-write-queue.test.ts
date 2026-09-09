import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSyncLifecycle } from '../src/background-sync.js';

vi.mock('../src/sync-config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sync-config.js')>(),
  loadAutoSync: () => ({ enabled: false, minutes: 5 }),
  SYNC_CONFIG_CHANGED_EVENT: 'config',
}));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('writes during lifecycle synchronization', () => {
  async function fixture() {
    vi.useFakeTimers();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    let write = () => {};
    let finish!: (value: null) => void;
    const first = new Promise<null>((resolve) => { finish = resolve; });
    const runner = vi.fn().mockReturnValueOnce(first).mockResolvedValue(null);
    const applied = vi.fn();
    const dispose = installSyncLifecycle({ subscribe: (listener: () => void) => { write = listener; return () => {}; } } as never, applied, runner);
    await Promise.resolve();
    return { write: () => write(), finish: () => finish(null), runner, dispose, applied };
  }

  it('coalesces multiple writes into one follow-up without overlapping runs', async () => {
    const f = await fixture();
    try {
      f.write(); f.write(); f.write();
      expect(f.runner).toHaveBeenCalledTimes(1);
      f.finish();
      await vi.waitFor(() => expect(f.runner).toHaveBeenCalledTimes(2));
      expect(f.runner.mock.calls[1]?.[1]).toBe('write');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.runner).toHaveBeenCalledTimes(2);
    } finally { f.dispose(); }
  });

  it('does not restart a disposed ledger lifecycle', async () => {
    const f = await fixture();
    f.write(); f.dispose(); f.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect(f.applied).not.toHaveBeenCalled();
  });
});
