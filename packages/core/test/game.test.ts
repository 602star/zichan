import { describe, it, expect } from 'vitest';
import { seasonSummary, seasonDays, round, type GameRecord, type GameSeason } from '../src/index.js';

// Prototype season S2 · 灰烬余烬 (see 资产记账系统.dc.html SEASONS.s2).
const s2: GameSeason = {
  id: 's2', gameId: 'g1', name: 'S2 · 灰烬余烬', status: 'active',
  startDate: '2025-12-20', hours: '42',
  createdAt: '', updatedAt: '', version: 1, isDeleted: false,
};

function rec(
  recordType: GameRecord['recordType'], settlementAmount: string, currency?: string, qty?: string,
): GameRecord {
  return {
    id: Math.random().toString(36), date: '2026-01-01', gameId: 'g1', seasonId: 's2',
    recordType, settlementAssetId: 'GBP', settlementAmount,
    gameCurrencyName: currency, gameCurrencyAmount: qty,
    createdAt: '', updatedAt: '', version: 1, isDeleted: false,
  };
}

const s2Records: GameRecord[] = [
  rec('buy_currency', '16.0', '初火', '4000'),
  rec('produce', '0', '初火', '6200'),
  rec('sell_equipment', '24.0'),
  rec('sell_material', '9.5'),
  rec('topup', '8.0'),
  rec('sell_currency', '31.6', '初火', '8000'),
  rec('fee', '2.1'),
];

describe('seasonSummary — matches prototype S2 numbers', () => {
  const sum = seasonSummary(s2Records, s2, { asOf: '2026-03-04' });

  it('income = sells + other income = £65.10', () => {
    expect(round(sum.incomeBase, 2)).toBe('65.10');
  });
  it('expense = buys + topup + fee = £26.10', () => {
    expect(round(sum.expenseBase, 2)).toBe('26.10');
  });
  it('net = £39.00', () => {
    expect(round(sum.netBase, 2)).toBe('39.00');
  });
  it('season length = 75 days as of 2026-03-04', () => {
    expect(sum.days).toBe(75);
    expect(seasonDays(s2, '2026-03-04')).toBe(75);
  });
  it('per-hour = £0.93, per-day = £0.52', () => {
    expect(round(sum.perHour, 2)).toBe('0.93'); // 39 / 42h
    expect(round(sum.perDay, 2)).toBe('0.52'); // 39 / 75d
  });
  it('reference balance = 2,200 初火 (buy + produce − sell), may go negative elsewhere', () => {
    expect(round(sum.referenceBalance, 0)).toBe('2200');
  });
});
