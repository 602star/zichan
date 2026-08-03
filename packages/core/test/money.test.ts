import { describe, expect, it } from 'vitest';
import { groupMoney, money, sumMoney } from '../src/index.js';

describe('currency-safe money aggregation', () => {
  it('uses exact decimal arithmetic for one currency', () => {
    expect(sumMoney([money('0.1', 'CNY'), money('0.2', 'CNY')])).toEqual({ amount: '0.3', assetId: 'CNY' });
  });

  it('rejects direct addition across currencies and can group them explicitly', () => {
    const values = [money('10', 'CNY'), money('2', 'USD'), money('5', 'CNY')];
    expect(() => sumMoney(values)).toThrow('禁止跨币种直接相加');
    expect([...groupMoney(values)]).toEqual([
      ['CNY', { amount: '15', assetId: 'CNY' }],
      ['USD', { amount: '2', assetId: 'USD' }],
    ]);
  });
});
