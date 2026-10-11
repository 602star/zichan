import { describe, expect, it, vi } from 'vitest';
import type { EncryptedBlobStore } from '../src/blob-store.js';
import type { NodeIdentity } from '../src/node-identity.js';
import { createNodeReplicationWorker } from '../src/node-replication.js';
import type { SyncServerStore } from '../src/store.js';

describe('node replication maintenance pause', () => {
  it('drains an active pass, blocks new passes, and resumes scheduling afterward', async () => {
    let release!: (value: never[]) => void;
    const pending = new Promise<never[]>((resolve) => { release = resolve; });
    const pendingNodeRevocations = vi.fn().mockImplementationOnce(() => pending)
      .mockResolvedValue([]);
    const store = { pendingNodeRevocations,
      listNodeReplicationLinks: vi.fn().mockResolvedValue([]),
      listReplicaSlots: vi.fn().mockResolvedValue([]) } as unknown as SyncServerStore;
    const worker = createNodeReplicationWorker(store, {} as EncryptedBlobStore,
      () => ({} as NodeIdentity));
    const first = worker.run();
    let paused = false;
    const pause = worker.pause().then(() => { paused = true; });
    await Promise.resolve();
    expect(paused).toBe(false);
    release([]);
    await Promise.all([first, pause]);
    expect(paused).toBe(true);
    expect(pendingNodeRevocations).toHaveBeenCalledTimes(1);
    await worker.run();
    expect(pendingNodeRevocations).toHaveBeenCalledTimes(1);
    worker.resume();
    await worker.run();
    expect(pendingNodeRevocations).toHaveBeenCalledTimes(2);
  });
});
