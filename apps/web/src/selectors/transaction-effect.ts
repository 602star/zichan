import {
  transactionReportingEffect,
  type Transaction,
  type TransactionReportingEffect,
} from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';

/** Web snapshot adapter for the core's single transaction reporting contract. */
export function reportingEffect(snap: Snapshot, transaction: Transaction): TransactionReportingEffect {
  return transactionReportingEffect(transaction, {
    splits: snap.transactionSplits,
    refundAllocations: snap.refundAllocations,
  });
}
