import type { TransactionBrowseInput, TransactionBrowsePage } from '@zichan/db';
import { addDays } from '@zichan/core';

/** Read a complete selected period; SQL pages stay internal to the loader. */
export async function loadTransactionBrowseRange(
  readPage: (input: TransactionBrowseInput) => Promise<TransactionBrowsePage>,
  input: TransactionBrowseInput,
  signal: AbortSignal,
): Promise<TransactionBrowsePage> {
  signal.throwIfAborted();
  let result = await readPage({ ...input, cursor: undefined, limit: 1000 });
  signal.throwIfAborted();
  const cursors = new Set<string>();
  while (result.hasMore) {
    const cursor = result.nextCursor;
    const key = JSON.stringify(cursor);
    if (!cursor || cursors.has(key)) throw new Error('流水读取未能前进，请重试');
    cursors.add(key);
    const page = await readPage({ ...input, cursor, limit: 1000 });
    signal.throwIfAborted();
    result = {
      ...page,
      transactions: [...result.transactions, ...page.transactions],
      transactionSplits: [...result.transactionSplits, ...page.transactionSplits],
      refundAllocations: [...result.refundAllocations, ...page.refundAllocations],
      attachments: [...result.attachments, ...page.attachments],
      reconciliationItems: [...result.reconciliationItems, ...page.reconciliationItems],
      reconciliationSessions: [...new Map([...result.reconciliationSessions, ...page.reconciliationSessions].map((row) => [row.id, row])).values()],
      refundAppliedAmounts: { ...result.refundAppliedAmounts, ...page.refundAppliedAmounts },
      refundsByOriginal: { ...result.refundsByOriginal, ...page.refundsByOriginal },
    };
  }
  return result;
}

/** Calendar dates, rather than elapsed hours, keep the seven-day boundary stable. */
export function isRecentTransactionDay(day: string, today: string): boolean {
  return day >= addDays(today, -6) && day <= today;
}
