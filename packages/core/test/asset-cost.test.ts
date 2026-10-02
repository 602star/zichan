import { describe, expect, it } from 'vitest';
import { D, replayAssetCosts, sum, type AssetCostEvent } from '../src/index.js';

function event(id: string, kind: AssetCostEvent['kind'], quantity: string, valueInBase: string | null, extra: Partial<AssetCostEvent> = {}): AssetCostEvent {
  return { id, sourceId: id, sourceKind: 'transaction', occurredAtUtc: '2026-01-01T00:00:00Z',
    orderKey: id, kind, assetId: 'USD', quantity, valueInBase, realize: kind === 'dispose', ...extra };
}

describe('asset cost replay', () => {
  it('tracks fiat and stablecoins with the same rules as investment assets', () => {
    for (const assetId of ['USD', 'USDT', 'BTC']) {
      const result = replayAssetCosts([
        event('1', 'acquire', '100', '700', { assetId }),
        event('2', 'dispose', '20', '150', { assetId }),
      ], 'CNY');
      expect(result.events[1]).toMatchObject({ costStatus: 'known', costInBase: '140', realizedGainLoss: '10' });
      expect(result.positions[0]).toMatchObject({ quantity: '80', costInBase: '560' });
    }
  });

  it.each([['fifo', '10'], ['lifo', '30'], ['average', '20']] as const)('matches %s without losing costs', (method, cost) => {
    const result = replayAssetCosts([
      event('1', 'acquire', '3', '30'), event('2', 'acquire', '3', '90'),
      event('3', 'dispose', '1', '40', { method }),
    ], 'CNY');
    expect(result.events[2]?.costInBase).toBe(cost);
    expect(sum(result.lots.map((lot) => lot.remainingCostInBase!)).plus(cost).toString()).toBe('120');
  });

  it('manual matching never silently falls back to other lots', () => {
    const result = replayAssetCosts([
      event('1', 'acquire', '1', '7'), event('2', 'acquire', '10', '80'),
      event('3', 'dispose', '2', '18', { method: 'manual', selectedLotIds: ['1:lot:0'] }),
    ], 'CNY');
    expect(result.events[2]).toMatchObject({ costStatus: 'partial', costInBase: null, knownCostInBase: '7', realizedGainLoss: null, knownRealizedGainLoss: '2' });
    expect(result.gaps.find((gap) => gap.reason === 'missing_quantity')?.quantity).toBe('1');
  });

  it('later acquisition settles quantity without repairing historical missing cost', () => {
    const result = replayAssetCosts([
      event('1', 'dispose', '3', '30'), event('2', 'acquire', '5', '40'),
    ], 'CNY');
    expect(result.events[0]).toMatchObject({ costStatus: 'unknown', realizedGainLoss: null });
    expect(result.gaps[0]).toMatchObject({ quantity: '3', outstandingQuantity: '0' });
    expect(result.positions[0]).toMatchObject({ quantity: '2', costInBase: '16' });
    expect(result.consumptions.find((row) => row.reason === 'deficit_settlement')).toMatchObject({ costInBase: '24', realizedGainLoss: null });
  });

  it('a genuine earlier acquisition can resolve the historical gap on replay', () => {
    const sell = event('2', 'dispose', '3', '30');
    expect(replayAssetCosts([sell], 'CNY').events[0]?.realizedGainLoss).toBeNull();
    expect(replayAssetCosts([sell, event('1', 'acquire', '3', '21')], 'CNY').events[1]?.realizedGainLoss).toBe('9');
  });

  it('keeps unknown cost separate from unknown disposal value', () => {
    const result = replayAssetCosts([
      event('1', 'acquire', '2', null), event('2', 'acquire', '2', '14'),
      event('3', 'dispose', '3', '30'), event('4', 'dispose', '1', null),
    ], 'CNY');
    expect(result.events[2]).toMatchObject({ costStatus: 'partial', realizedGainLoss: null, knownRealizedGainLoss: '3' });
    expect(result.events[3]).toMatchObject({ costStatus: 'known', costInBase: '7', realizedGainLoss: null });
  });

  it('restores proportional original costs on repeated refunds; excess stays unknown', () => {
    const result = replayAssetCosts([
      event('1', 'acquire', '2', '10'), event('2', 'acquire', '2', '30'),
      event('3', 'dispose', '4', '44'),
      event('4', 'refund', '1', null, { refundSourceId: '3' }),
      event('5', 'refund', '4', null, { refundSourceId: '3' }),
    ], 'CNY');
    expect(result.events).toHaveLength(5);
    expect(result.events[3]).toMatchObject({ costInBase: '10', realize: true, realizedGainLoss: '-1' });
    expect(result.events[4]).toMatchObject({ costStatus: 'partial', knownCostInBase: '30', costInBase: null, knownRealizedGainLoss: '-3', realizedGainLoss: null });
    expect(result.positions[0]).toMatchObject({ quantity: '5', knownCostInBase: '40', unknownQuantity: '1' });
  });

  it('does not turn inventory adjustments or own-currency spending into investment gains', () => {
    const result = replayAssetCosts([
      event('1', 'acquire', '10', '999', { assetId: 'CNY' }),
      event('2', 'dispose', '4', '999', { assetId: 'CNY' }),
      event('3', 'acquire', '10', '70'), event('4', 'dispose', '2', '100', { realize: false }),
    ], 'CNY');
    expect(result.events[1]?.realizedGainLoss).toBe('0');
    expect(result.events[3]?.realizedGainLoss).toBeNull();
    expect(result.events[3]?.costInBase).toBe('14');
  });

  it('orders instants independently of timezone and input order, and preserves its inputs', () => {
    const input = [event('b', 'dispose', '1', '8', { occurredAtUtc: '2026-01-01T00:30:00Z' }),
      event('a', 'acquire', '1', '7', { occurredAtUtc: '2026-01-01T08:00:00+08:00' })];
    const before = JSON.stringify(input);
    const forward = replayAssetCosts(input, 'CNY');
    expect(forward).toEqual(replayAssetCosts([...input].reverse(), 'CNY'));
    expect(forward.events[1]?.realizedGainLoss).toBe('1');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('allocates the final fractional remainder exactly', () => {
    const result = replayAssetCosts([
      event('1', 'acquire', '1', '1'), event('2', 'acquire', '1', '1'), event('3', 'acquire', '1', '1'),
      event('4', 'dispose', '3', '1'),
    ], 'CNY');
    expect(sum(result.consumptions.map((row) => row.proceedsInBase!)).toString()).toBe('1');
    expect(result.positions[0]?.costInBase).toBe('0');
    expect(D(result.events[3]!.realizedGainLoss!).toString()).toBe('-2');
  });

  it('rejects duplicate IDs and invalid dates or amounts', () => {
    expect(() => replayAssetCosts([event('1', 'acquire', '1', '1'), event('1', 'acquire', '1', '1')], 'CNY')).toThrow('重复');
    expect(() => replayAssetCosts([event('1', 'acquire', 'NaN', '1')], 'CNY')).toThrow('有限');
    expect(() => replayAssetCosts([event('1', 'acquire', '1', '1', { occurredAtUtc: 'bad' })], 'CNY')).toThrow('准确时间');
  });
  it('restores cross-opening refunds without duplicating prior balances or refunding twice', () => {
    const first = replayAssetCosts([event('1', 'acquire', '10', '70'), event('2', 'dispose', '4', '32'),
      event('3', 'refund', '1', null, { refundSourceId: '2' })], 'CNY');
    const historyBefore = JSON.stringify(first.refundHistory);
    const next = replayAssetCosts([event('4', 'acquire', '7', '49'),
      event('5', 'refund', '3', null, { refundSourceId: '2' }),
      event('6', 'refund', '1', null, { refundSourceId: '2' })], 'CNY', first.refundHistory);
    expect(next.events[1]).toMatchObject({ costInBase: '21', realizedGainLoss: '-3' });
    expect(next.events[2]).toMatchObject({ costInBase: null, realizedGainLoss: null });
    expect(next.positions[0]).toMatchObject({ quantity: '11', knownCostInBase: '70', unknownQuantity: '1' });
    expect(JSON.stringify(first.refundHistory)).toBe(historyBefore);
    const changedCurrency = replayAssetCosts([event('7', 'refund', '3', null, { refundSourceId: '2' })], 'EUR', first.refundHistory);
    expect(changedCurrency.events[0]?.costInBase).toBeNull();
  });

});
