import { newId } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import { createLocalOrderPrivateStore, type LocalOrderRecord } from '../db/local-order-private.js';

/** Private pending intents precede the public ledger transaction; only opaque IDs cross this coordinator. */
export async function saveWithLocalOrders<T>(options: {
  store: SqlLedgerStore; records: LocalOrderRecord[]; candidate: T; save: (candidate: T) => Promise<void> | void;
  transactionId?: string; creating: boolean;
}): Promise<{ transactionId?: string; pending: boolean }> {
  const { store, save, creating } = options;
  if (!options.records.length) { await save(options.candidate); return { pending: false }; }
  const privateStore = createLocalOrderPrivateStore(await store.getLedgerId());
  const selectedIds = new Set(options.records.map((row) => row.captureId));
  const records = (await privateStore.list()).filter((row) => selectedIds.has(row.captureId));
  if (records.length !== selectedIds.size) throw new Error('本机订单草稿已变化，请重新打开；尚未保存流水。');
  const existingIds = [...new Set(records.map((row) => row.transactionId).filter((id): id is string => !!id))];
  if (existingIds.length > 1) throw new Error('本机订单草稿关联了不同流水，请分别恢复。');
  const transactionId = options.transactionId ?? existingIds[0] ?? newId();
  if (existingIds.some((id) => id !== transactionId)) throw new Error('本机订单草稿与当前流水不一致，请重新打开。');
  const ids = records.map((row) => row.captureId);
  const before = await store.transactions.get(transactionId);
  if (before && (before.isDeleted || before.recordState === 'voided')) throw new Error('关联流水已删除或作废，请先恢复原流水，或明确放弃本机保留信息后重新记账。');
  // A prior attempt may have committed before a crash or attachment finalization error.
  const alreadySaved = creating && !!before && records.some((row) => row.state !== 'draft' && row.transactionId === transactionId);
  if (!alreadySaved) {
    await privateStore.bind(ids, transactionId);
    const candidate = { ...options.candidate, id: transactionId };
    try { await save(candidate); }
    catch (cause) {
      const current = await store.transactions.get(transactionId);
      if (!current || (before && current.version === before.version)) throw cause;
      // The public transaction exists. Never create another transaction on retry.
      return { transactionId, pending: true };
    }
  }
  try { await privateStore.link(ids, transactionId); return { transactionId, pending: false }; }
  catch { return { transactionId, pending: true }; }
}
