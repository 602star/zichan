import { describe, expect, it } from 'vitest';
import { buildDashboardAgenda } from '../src/selectors/dashboard-agenda.js';
import { makeSnapshot } from './fixtures.js';

function fixture() {
  const snap = makeSnapshot();
  const base = snap.assets[0]!;
  snap.accounts = [{ ...base, id: 'card', name: '日常信用卡', kind: 'credit_card', isActive: true, statementDay: 10, paymentDueDay: 20 }];
  snap.scheduledTransactions = [{ ...base, id: 'rent', name: '房租', type: 'expense', category: 'housing', amount: '123456789.12', assetId: base.id,
    accountId: 'card', frequency: 'monthly', anchorDate: '2026-11-15', anchorMode: 'calendar_day', timezone: 'Asia/Shanghai', autoCreate: false, catchUpPolicy: 'latest', status: 'active' }];
  return snap;
}

describe('dashboard bills and payment calendar', () => {
  it('preserves exact native amounts and distinguishes pending bookkeeping from card payment dates', () => {
    const items = buildDashboardAgenda(fixture(), '2026-11-15');
    expect(items[0]).toMatchObject({ title: '房租', amount: '123456789.12', status: 'today', detail: expect.stringContaining('待登记') });
    expect(items[1]).toMatchObject({ date: '2026-11-20', days: 5, kind: 'repayment', detail: expect.stringContaining('应还金额请核对账单'), target: { screen: 'transactions', tab: 'accounts', id: 'card' } });
    expect(items[1]?.amount).toBeUndefined();
  });

  it('advances handled schedule occurrences and never calls an unknown card payment overdue', () => {
    const snap = fixture();
    snap.scheduledExecutions = [{ ...snap.assets[0]!, id: 'done', scheduleId: 'rent', occurrenceIndex: 0, occurrenceDate: '2026-11-15', status: 'created' }];
    const items = buildDashboardAgenda(snap, '2026-11-21');
    expect(items.find((item) => item.kind === 'scheduled')?.date).toBe('2026-12-15');
    expect(items.find((item) => item.kind === 'repayment')).toMatchObject({ date: '2026-12-20', status: 'upcoming' });
  });

  it('clamps monthly due days in leap February and crosses December correctly', () => {
    const snap = fixture();
    snap.scheduledTransactions = [];
    snap.accounts[0]!.paymentDueDay = 31;
    expect(buildDashboardAgenda(snap, '2028-02-28')[0]?.date).toBe('2028-02-29');
    expect(buildDashboardAgenda(snap, '2027-02-28')[0]?.date).toBe('2027-02-28');
    snap.accounts[0]!.paymentDueDay = 5;
    expect(buildDashboardAgenda(snap, '2026-12-31')[0]?.date).toBe('2027-01-05');
  });

  it('keeps failed and late schedules actionable while omitting paused, archived and distant entries', () => {
    const snap = fixture();
    snap.scheduledExecutions = [{ ...snap.assets[0]!, id: 'failed', scheduleId: 'rent', occurrenceIndex: 0, occurrenceDate: '2026-11-15', status: 'failed', lastError: '账户已归档' }];
    expect(buildDashboardAgenda(snap, '2026-11-16')[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('账户已归档') });
    snap.scheduledExecutions = [];
    expect(buildDashboardAgenda(snap, '2026-11-16')[0]?.statusLabel).toBe('计划日已过 1 天');
    snap.scheduledTransactions[0]!.status = 'paused';
    snap.accounts[0]!.isActive = false;
    expect(buildDashboardAgenda(snap, '2026-11-16')).toEqual([]);
    snap.scheduledTransactions[0]!.status = 'active';
    snap.scheduledTransactions[0]!.anchorDate = '2027-01-01';
    expect(buildDashboardAgenda(snap, '2026-11-16')).toEqual([]);
  });
});
