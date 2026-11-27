import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LedgerOpenSnapshots } from '../src/ledger-open-snapshots.js';
import type { SyncServerStore } from '../src/store.js';

describe('LedgerOpenSnapshots', () => {
  it('includes username in onError and suppresses repeated warm retries within the cooldown window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zichan-snapshots-'));
    const errors: Array<{ message: string; username?: string }> = [];
    let headSeq = 5;
    let custodyLookups = 0;

    const fakeStore = {
      ledgerOpenCandidates: async () => ['alice'],
      getUser: async (username: string) => ({ username, accountId: 'acc-1', disabled: false }),
      getReplica: async () => ({ ledgerId: 'ledger-1', replicaId: 'rep-1', streamEpoch: 'epoch-1', headSeq }),
      getLedgerProtection: async () => ({ mode: 'managed', version: 1, sealedSecret: 'invalid-base64-payload' }),
      getKeyEnvelope: async () => ({ keyringId: 'kr-1', generation: 1 }),
    } as unknown as SyncServerStore;

    const snapshots = new LedgerOpenSnapshots({
      store: fakeStore,
      serverId: 'srv-test',
      directory: dir,
      custodyKey: () => {
        custodyLookups += 1;
        return randomBytes(32);
      },
      onError: (error, context) => {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          username: context?.username,
        });
      },
      retryCooldownMs: 60_000,
    });

    try {
      await snapshots.warm();
      await snapshots.drain();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.username).toBe('alice');
      expect(custodyLookups).toBe(1);

      // A second warm tick for the same headSeq is skipped during cooldown.
      await snapshots.warm();
      await snapshots.drain();
      expect(errors).toHaveLength(1);
      expect(custodyLookups).toBe(1);

      // Once headSeq advances, warm retries immediately.
      headSeq = 6;
      await snapshots.warm();
      await snapshots.drain();
      expect(errors).toHaveLength(2);
      expect(errors[1]?.username).toBe('alice');
      expect(custodyLookups).toBe(2);
    } finally {
      await snapshots.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
