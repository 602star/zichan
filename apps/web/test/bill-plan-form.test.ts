import { describe, expect, it } from 'vitest';
import { listScheduleOccurrences } from '@zichan/core';
import { scheduledTransactionForm } from '../src/forms.js';
import { makeSnapshot } from './fixtures.js';

describe('independent bill and repayment plans', () => {
  const snap = makeSnapshot();
  const values = { name: '借款还款', type: 'expense', category: snap.categories.find((row) => row.type === 'expense' && row.parentId)?.id ?? 'food', amount: '123456789.12', assetId: snap.assets[0]!.id,
    frequency: 'monthly', anchorDate: '2026-01-31', anchorMode: 'calendar_day', timezone: 'Asia/Shanghai', autoCreate: 'false', status: 'active', catchUpPolicy: 'all', linkAccount: 'false' };

  it('creates without a user-managed account or immediate posting', () => {
    const spec = scheduledTransactionForm(snap);
    const row = spec.fromValues({ ...values, accountId: 'ignored' });
    expect(row).toMatchObject({ amount: '123456789.12', accountId: undefined, autoCreate: false });
    expect(spec.fields.find((field) => field.key === 'accountId')?.required).not.toBe(true);
    expect(spec.fields.find((field) => field.key === 'accountId')?.visibleWhen?.(values)).toBe(false);
  });

  it('represents one-off bills using the existing bounded recurrence without a schema reset', () => {
    const spec = scheduledTransactionForm(snap);
    const row = spec.fromValues({ ...values, frequency: 'once' });
    expect(row).toMatchObject({ frequency: 'daily', endDate: '2026-01-31' });
    expect(listScheduleOccurrences(row, { max: 10 }).map((item) => item.date)).toEqual(['2026-01-31']);
    expect(spec.toValues(row).frequency).toBe('once');
  });

  it('bounds installment periods across short months and validates their count', () => {
    const spec = scheduledTransactionForm(snap);
    const row = spec.fromValues({ ...values, limitMode: 'count', periodCount: '3' });
    expect(row.endDate).toBe('2026-03-31');
    expect(listScheduleOccurrences(row, { max: 10 }).map((item) => item.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(spec.validate?.({ ...values, limitMode: 'count', periodCount: '0' }, undefined)).toMatchObject({ periodCount: expect.any(String) });
    expect(spec.toValues(row)).toMatchObject({ endDate: '2026-03-31', limitMode: 'count', periodCount: '3' });
  });
});
