import { describe, expect, it, vi } from 'vitest';
import { persistDraftBeforeClose } from '../src/ui/EntityFormModal.js';
import { runSynchronousFlight } from '../src/ui/VaultUnlockPrompt.js';

describe('UI asynchronous action contracts', () => {
  it('keeps only one synchronous flight until the action settles', async () => {
    let finish: (() => void) | undefined;
    const operation = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const ref = { current: null as Promise<void> | null };

    const first = runSynchronousFlight(ref, operation);
    const second = runSynchronousFlight(ref, operation);

    expect(second).toBe(first);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    finish?.();
    await first;
    expect(ref.current).toBeNull();
  });

  it('releases a failed flight so the user can retry', async () => {
    const ref = { current: null as Promise<void> | null };
    const failure = new Error('解锁失败');

    await expect(runSynchronousFlight(ref, async () => { throw failure; })).rejects.toBe(failure);
    expect(ref.current).toBeNull();
    await expect(runSynchronousFlight(ref, async () => undefined)).resolves.toBeUndefined();
  });

  it('closes a dirty form only after its draft is persisted', async () => {
    const close = vi.fn();
    const failure = new Error('草稿写入失败');

    await expect(persistDraftBeforeClose(async () => { throw failure; }, close)).rejects.toBe(failure);
    expect(close).not.toHaveBeenCalled();

    await persistDraftBeforeClose(async () => undefined, close);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
