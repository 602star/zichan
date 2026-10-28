import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';
import { describe, expect, it } from 'vitest';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { SyncServerStore } from '../src/store.js';

describe('replica inventory federated identity', () => {
  it('uses the account binding when its scope is the sync group rather than the ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-federated-inventory-'));
    const dbPath = join(root, 'server.sqlite');
    const blob = new EncryptedBlobStore({ dataDir: root });
    const store = new SyncServerStore(dbPath, 'open', 'srv-local-inventory', undefined, blob.ready);
    const driver = new NodeSqliteDriver(dbPath);
    try {
      await store.register('owner', 'opaque-owner', undefined, true);
      const ledgerId = 'ledger-federated-inventory';
      await store.bindReplica('owner', ledgerId);
      await store.putKeyEnvelope('owner', ledgerId, 'keyring-federated-inventory', 1,
        { ledgerId, keyringId: 'keyring-federated-inventory', generation: 1 });
      const account = await store.getUser('owner');
      expect(account).toBeDefined();
      const at = new Date().toISOString();
      await driver.run(`INSERT INTO federated_account_bindings
        (local_username, issuer_node_id, subject_account_id, ledger_id, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      ['owner', 'srv-issuer-inventory', account!.accountId, 'group-federated-inventory', at, at]);

      const inventory = await store.replicaInventory('owner', ledgerId);
      expect(inventory.issuerNodeId).toBe('srv-issuer-inventory');
      expect(inventory.subjectAccountId).toBe(account!.accountId);
    } finally {
      await driver.close();
      await store.close();
      await blob.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
