import { describe, it, expect } from 'vitest';
import { money, signedMoney, pct, amount, num, setBaseSymbol, significant } from '../src/format.js';

describe('format', () => {
  it('money groups and fixes 2 decimals', () => {
    expect(money('1281.07')).toBe('£1,281.07');
    expect(money('0')).toBe('£0.00');
    expect(money('9007199254740992.01')).toBe('£9,007,199,254,740,992.01');
  });

  it('signedMoney prefixes + / − (U+2212)', () => {
    expect(signedMoney('90')).toBe('+£90.00');
    expect(signedMoney('-5')).toBe('−£5.00');
    expect(signedMoney('0')).toBe('£0.00');
    expect(signedMoney('-9007199254740992.01')).toBe('−£9,007,199,254,740,992.01');
  });

  it('pct from a 0..1 weight', () => {
    expect(pct(0.164)).toBe('16.4%');
  });

  it('amount trims trailing zeros to the asset precision', () => {
    expect(amount('0.00000001', 8)).toBe('0.00000001');
    expect(amount('0.00331700', 8)).toBe('0.003317');
    expect(num('1234.5', 2)).toBe('1,234.50');
    expect(num('9007199254740992.01', 2)).toBe('9,007,199,254,740,992.01');
  });

  it('unit prices preserve significant digits without rounding tiny values to zero', () => {
    expect(significant('0.000000000123456789')).toBe('0.00000000012345679');
    expect(significant('11.009009009')).toBe('11.009009');
    expect(significant('12345.678901')).toBe('12,345.679');
  });

  it('setBaseSymbol changes the default money symbol', () => {
    setBaseSymbol('$');
    expect(money('10')).toBe('$10.00');
    setBaseSymbol('£'); // restore for other tests
    expect(money('10')).toBe('£10.00');
  });
});
