import type { SqlLedgerStore } from '@zichan/db';
import { createLocalOrderPrivateStore } from '../db/local-order-private.js';

const recoveries = new WeakMap<SqlLedgerStore, Promise<void>>();
/** Recover local-only associations after commit/crash; soft-deleted and voided rows keep their records for undo. */
export function reconcileLocalOrders(store: SqlLedgerStore): Promise<void> {
  const existing = recoveries.get(store); if (existing) return existing;
  const job = (async () => {
    const local = createLocalOrderPrivateStore(await store.getLedgerId());
    for (const row of await local.list()) {
      if (!row.transactionId) continue;
      const transaction = await store.transactions.get(row.transactionId);
      if (transaction && !transaction.isDeleted && transaction.recordState !== 'voided' && row.state === 'pending') await local.link([row.captureId], row.transactionId);
      else if (!transaction && row.state === 'linked') await local.remove(row.captureId);
    }
  })();
  recoveries.set(store, job);
  void job.finally(() => { if (recoveries.get(store) === job) recoveries.delete(store); }).catch(() => undefined);
  return job;
}
