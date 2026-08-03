import { describe, it, expect } from 'vitest';
import {
  postingsFromChain,
  postingsFromGameRecord,
  gameRecordReportingPostings,
  computeBalances,
  balanceOf,
  round,
  type ChainWithSteps,
  type GameRecord,
} from '../src/index.js';

function gameRecord(p: Partial<GameRecord> & Pick<GameRecord, 'recordType'>): GameRecord {
  return {
    id: Math.random().toString(36), date: '2026-01-01', gameId: 'g1', recordType: p.recordType,
    createdAt: '', updatedAt: '', version: 1, isDeleted: false, ...p,
  } as GameRecord;
}

describe('balance engine', () => {
  it('a GBP→USDT→BTC buy leaves correct per-asset balances (fee counted once)', () => {
    const chain: ChainWithSteps = {
      chain: { id: 'c1', date: '2026-03-02', type: 'dca', baseCurrencyAssetId: 'GBP',
        createdAt: '', updatedAt: '', version: 1, isDeleted: false },
      steps: [
        { id: 's1', chainId: 'c1', order: 1, fromAssetId: 'GBP', fromAmount: '250',
          toAssetId: 'USDT', toAmount: '312.10', fees: [{ id: 'f1', assetId: 'GBP', amount: '1.50', treatment: 'source_extra' }] },
        { id: 's2', chainId: 'c1', order: 2, fromAssetId: 'USDT', fromAmount: '311.50',
          toAssetId: 'BTC', toAmount: '0.003317', fees: [{ id: 'f2', assetId: 'USDT', amount: '0.60', treatment: 'source_extra' }] },
      ],
    };
    const p = postingsFromChain(chain);
    // GBP: -250 (principal) -1.50 (fee, same asset) = -251.50
    expect(round(balanceOf(p, 'GBP'), 2)).toBe('-251.50');
    // USDT: +312.10 -311.50 (principal) -0.60 (fee, same asset) = 0.00
    expect(round(balanceOf(p, 'USDT'), 2)).toBe('0.00');
    expect(round(balanceOf(p, 'BTC'), 6)).toBe('0.003317');
  });

  it('fee in the target asset is not double-subtracted', () => {
    const chain: ChainWithSteps = {
      chain: { id: 'c', date: '2026-01-01', type: 'exchange', baseCurrencyAssetId: 'GBP',
        createdAt: '', updatedAt: '', version: 1, isDeleted: false },
      steps: [
        { id: 's1', chainId: 'c', order: 1, fromAssetId: 'USDT', fromAmount: '150',
          toAssetId: 'GBP', toAmount: '119', fees: [{ id: 'f', assetId: 'GBP', amount: '0.60', treatment: 'target_deducted' }] },
      ],
    };
    const p = postingsFromChain(chain);
    // Stored target amount is gross; the posting is the actual net receipt.
    expect(round(balanceOf(p, 'GBP'), 2)).toBe('118.40');
    expect(round(balanceOf(p, 'USDT'), 2)).toBe('-150.00');
  });

  it('per-account balances split correctly', () => {
    const chain: ChainWithSteps = {
      chain: { id: 'c', date: '2026-01-01', type: 'exchange', baseCurrencyAssetId: 'GBP',
        createdAt: '', updatedAt: '', version: 1, isDeleted: false },
      steps: [
        { id: 's1', chainId: 'c', order: 1, fromAssetId: 'GBP', fromAmount: '100', accountFromId: 'bank',
          toAssetId: 'USDT', toAmount: '123', accountToId: 'binance' },
      ],
    };
    const bals = computeBalances(postingsFromChain(chain), { perAccount: true });
    const gbp = bals.find((b) => b.assetId === 'GBP');
    const usdt = bals.find((b) => b.assetId === 'USDT');
    expect(gbp?.accountId).toBe('bank');
    expect(round(gbp!.amount, 2)).toBe('-100.00');
    expect(usdt?.accountId).toBe('binance');
    expect(round(usdt!.amount, 2)).toBe('123.00');
  });

  it('game records only affect reports; balances require a normalized linked transaction', () => {
    const rec = gameRecord({
      recordType: 'buy_currency', gameCurrencyName: '初火', gameCurrencyAmount: '4000',
      settlementAssetId: 'GBP', settlementAmount: '16',
    });
    const p = postingsFromGameRecord(rec);
    expect(p).toEqual([]);
    const reporting = gameRecordReportingPostings(rec);
    expect(reporting.some((x) => x.assetId === '初火')).toBe(false);
    expect(round(balanceOf(reporting, 'GBP'), 2)).toBe('-16.00');
  });
});
