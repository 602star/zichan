import { describe, expect, it } from 'vitest';
import { latestStatementDate } from '../src/screens/ReconciliationModal.js';

describe('latestStatementDate', () => {
  it('clamps month-end statement days before deciding the latest cycle', () => {
    expect(latestStatementDate(31, '2026-02-28')).toBe('2026-02-28');
    expect(latestStatementDate(31, '2026-04-30')).toBe('2026-04-30');
    expect(latestStatementDate(31, '2026-04-29')).toBe('2026-03-31');
  });

  it('uses the current month on and after the configured statement day', () => {
    expect(latestStatementDate(15, '2026-07-14')).toBe('2026-06-15');
    expect(latestStatementDate(15, '2026-07-15')).toBe('2026-07-15');
    expect(latestStatementDate(15, '2026-07-23')).toBe('2026-07-15');
  });
});
