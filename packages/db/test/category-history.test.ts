import { describe, expect, it } from 'vitest';
import { openLedger } from '../src/node.js';

describe('expense category history', () => {
  it('aggregates beyond 1000 rows and excludes out-of-range and inactive records', async () => {
    const store = await openLedger();
    try {
      await store.driver.transaction(async (driver) => {
        for (let index = 0; index < 1005; index++) await driver.run(
          `INSERT INTO transactions (id, created_at, updated_at, version, is_deleted, date, time, type, category, amount, asset_id, time_precision)
           VALUES (?, '', '', 1, 0, '2026-11-23', '12:00', 'expense', 'takeaway', '1.00', 'CNY', 'minute')`, [`history-${index}`],
        );
        for (const [id, date, type, state, deleted] of [
          ['old', '2025-01-01', 'expense', 'active', 0], ['future', '2027-01-01', 'expense', 'active', 0],
          ['refund', '2026-11-23', 'refund', 'active', 0], ['void', '2026-11-23', 'expense', 'voided', 0],
          ['deleted', '2026-11-23', 'expense', 'active', 1],
        ]) await driver.run(
          `INSERT INTO transactions (id, created_at, updated_at, version, is_deleted, date, time, type, category, amount, asset_id, record_state)
           VALUES (?, '', '', 1, ?, ?, '12:00', ?, 'food', '1.00', 'CNY', ?)`, [id!, deleted!, date!, type!, state!],
        );
      });
      expect(await store.expenseCategoryHistory({ from: '2026-09-25', to: '2026-11-24' })).toEqual([
        { date: '2026-11-23', time: '12:00', timePrecision: 'minute', category: 'takeaway', count: 1005 },
      ]);
      await expect(store.expenseCategoryHistory({ from: '2026-02-30', to: '2026-11-24' })).rejects.toThrow('日期范围');
    } finally { await store.close(); }
  });
});
