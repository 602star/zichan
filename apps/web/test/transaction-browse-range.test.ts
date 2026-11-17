import { describe, expect, it, vi } from 'vitest';
import { D } from '@zichan/core';
import { createLedgerStore, type TransactionBrowsePage } from '@zichan/db';
import { createLogger, nullSink } from '@zichan/logger';
import { SqlJsDriver } from '../src/db/sqljs-driver.js';
import { isRecentTransactionDay, loadTransactionBrowseRange } from '../src/transaction-browse-range.js';

function page(patch: Partial<TransactionBrowsePage> = {}): TransactionBrowsePage {
  return { transactions: [], transactionSplits: [], refundAllocations: [], attachments: [], reconciliationItems: [], reconciliationSessions: [], refundAppliedAmounts: {}, refundsByOriginal: {}, totalCount: 0, hasMore: false, ...patch };
}

describe('complete transaction period', () => {
  it('loads an entire month beyond both the former 100-row cutoff and SQL 1000-row ceiling', async () => {
    const driver = await SqlJsDriver.open(null);
    try {
      const store = await createLedgerStore(driver, { logger: createLogger({ level: 'error', sinks: [nullSink()] }) });
      await driver.transaction(async (scope) => {
        for (let index = 0; index < 1106; index += 1) {
          await scope.run('INSERT INTO transactions (id, date, type, category, amount, asset_id, account_id, record_state, is_deleted, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [`month-${String(index).padStart(4, '0')}`, index === 1105 ? '2026-10-31' : '2026-11-17', 'expense', 'food', '0.10', 'CNY', 'bank', 'active', 0, 1]);
        }
      });
      const result = await loadTransactionBrowseRange((input) => store.transactionBrowsePage(input), { from: '2026-11-01', to: '2026-11-30', recordState: 'active' }, new AbortController().signal);
      expect(result.transactions).toHaveLength(1105);
      expect(new Set(result.transactions.map((row) => row.id)).size).toBe(1105);
      expect(result.transactions.every((row) => row.date.startsWith('2026-11'))).toBe(true);
      expect(result.transactions.reduce((sum, row) => sum.plus(row.amount), D(0)).toFixed(2)).toBe('110.50');
      expect(result.totalCount).toBe(1105);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    } finally { await driver.close(); }
  });

  it('preserves earlier-page attachments and refund data and deduplicates shared reconciliation sessions', async () => {
    const session = { id: 'session' } as TransactionBrowsePage['reconciliationSessions'][number];
    const attachment = { id: 'receipt' } as TransactionBrowsePage['attachments'][number];
    const read = vi.fn()
      .mockResolvedValueOnce(page({ attachments: [attachment], reconciliationSessions: [session], refundAppliedAmounts: { original: ['0.10'] }, hasMore: true, nextCursor: { value: 'a', id: 'a' } }))
      .mockResolvedValueOnce(page({ reconciliationSessions: [session], refundAppliedAmounts: { second: ['0.20'] } }));
    const result = await loadTransactionBrowseRange(read, { accountId: 'bank', search: '午餐' }, new AbortController().signal);
    expect(result.attachments).toEqual([attachment]);
    expect(result.reconciliationSessions).toEqual([session]);
    expect(result.refundAppliedAmounts).toEqual({ original: ['0.10'], second: ['0.20'] });
    expect(read.mock.calls[1]?.[0]).toMatchObject({ accountId: 'bank', search: '午餐', cursor: { value: 'a', id: 'a' } });
  });

  it('stops an obsolete query before requesting another page', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => {
      controller.abort();
      return page({ hasMore: true, nextCursor: { value: 'a', id: 'a' } });
    });
    await expect(loadTransactionBrowseRange(read, {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reports a later-page failure instead of returning a partial month as complete', async () => {
    const read = vi.fn().mockResolvedValueOnce(page({ hasMore: true, nextCursor: { value: 'a', id: 'a' } })).mockRejectedValueOnce(new Error('读取失败'));
    await expect(loadTransactionBrowseRange(read, {}, new AbortController().signal)).rejects.toThrow('读取失败');
  });
});

describe('recent seven transaction calendar days', () => {
  it.each([
    ['2026-11-17', '2026-11-11', true], ['2026-11-17', '2026-11-10', false],
    ['2026-11-17', '2026-11-17', true], ['2026-11-17', '2026-11-18', false],
    ['2026-03-01', '2026-02-23', true], ['2026-03-01', '2026-02-22', false],
    ['2028-03-01', '2028-02-24', true], ['2028-03-01', '2028-02-23', false],
    ['2027-01-02', '2026-12-27', true], ['2027-01-02', '2026-12-26', false],
  ])('today %s, record %s => %s', (today, day, expanded) => {
    expect(isRecentTransactionDay(day, today)).toBe(expanded);
  });
});
