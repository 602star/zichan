import { useEffect, useMemo, useState } from 'react';
import { D, isTransactionActive, type Attachment, type RefundAllocation, type Transaction, type TransactionSplit } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import type { Snapshot } from './db/snapshot.js';

interface RefundContext {
  key: string; original: Transaction; refunds: Transaction[];
  splits: TransactionSplit[]; allocations: RefundAllocation[]; attachments: Attachment[];
}
const merge = <T extends { id: string }>(left: T[], right: T[]) => [...new Map([...left, ...right].map((row) => [row.id, row])).values()];

/** Refund editing must not depend on the original expense being in the current filtered page. */
export function useTransactionEditor(store: SqlLedgerStore, snapshot: Snapshot | null, transaction: Transaction | null, revision: number) {
  const originalId = transaction?.type === 'refund' ? transaction.refundForId : undefined;
  const transactionId = transaction?.id;
  const key = originalId ? `${transactionId}:${originalId}` : '';
  const [context, setContext] = useState<RefundContext | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!originalId || !transactionId) return;
    let cancelled = false;
    setFailure(null);
    void Promise.all([
      store.transactions.get(originalId),
      store.transactions.list({ where: { refundForId: originalId } }),
      store.transactionSplits.list({ where: { transactionId: originalId } }),
      store.refundAllocations.list({ where: { refundTransactionId: transactionId } }),
      store.attachments.list({ where: { entityType: 'transaction', entityId: transactionId } }),
    ]).then(([original, refunds, splits, allocations, attachments]) => {
      if (!original || original.type !== 'expense' || !isTransactionActive(original)) throw new Error('关联原支出不可用，请先核实原记录');
      if (!cancelled) setContext({ key, original, refunds: refunds.filter(isTransactionActive), splits, allocations, attachments });
    }).catch((cause: unknown) => {
      if (!cancelled) setFailure({ key, message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { cancelled = true; };
  }, [key, originalId, transactionId, revision, retry, store]);
  const current = key && context?.key === key ? context : undefined;
  const editorSnapshot = useMemo(() => {
    if (!snapshot || !current || !transaction) return snapshot;
    return { ...snapshot,
      transactions: merge(snapshot.transactions, [current.original, transaction]),
      transactionSplits: merge(snapshot.transactionSplits, current.splits),
      refundAllocations: merge(snapshot.refundAllocations, current.allocations),
      attachments: merge(snapshot.attachments, current.attachments),
    };
  }, [snapshot, current, transaction]);
  const applied = current?.refunds.filter((row) => row.id !== transactionId)
    .reduce((total, row) => total.plus(row.refundAppliedAmount ?? row.amount), D(0)) ?? D(0);
  const remaining = current ? D(current.original.amount).minus(applied) : undefined;
  return {
    snapshot: editorSnapshot,
    remaining: remaining ? (remaining.gt(0) ? remaining : D(0)).toString() : undefined,
    loading: !!key && !current && failure?.key !== key,
    error: !current && failure?.key === key ? failure.message : '',
    retry: () => setRetry((value) => value + 1),
  };
}
