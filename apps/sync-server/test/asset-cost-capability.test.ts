import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SyncServerStore } from '../src/store.js';

describe('ledger minimum client capability', () => {
  it('atomically freezes the requirement and rejects legacy writes after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-cost-capability-'));
    const path = join(dir, 'server.sqlite');
    let store = new SyncServerStore(path, 'open', 'server-cost');
    try {
      await store.register('owner', 'opaque-record', undefined, true);
      await store.bindReplica('owner', 'ledger-cost-000001');
      await expect(store.pushCommits('owner', [], [], [])).resolves.toBeDefined();
      await expect(store.pushCommits('owner', [], [], ['asset-cost-v2'])).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
      await expect(store.pushCommits('owner', [], [], [])).resolves.toBeDefined();
      await store.pushCommits('owner', [], ['asset-cost-v2'], ['asset-cost-v2']);
      await store.close();
      store = new SyncServerStore(path, 'closed', 'server-cost');
      await expect(store.pushCommits('owner', [])).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
      await expect(store.pushCommits('owner', [], ['asset-cost-v2'])).resolves.toBeDefined();
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
