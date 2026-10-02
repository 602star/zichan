import { describe, expect, it } from 'vitest';
import { holdingUnitPrice } from '../src/screens/HoldingPriceModal.js';

describe('holding price input', () => {
  it('derives a per-unit quote from the entered holding value without float rounding', () => {
    expect(holdingUnitPrice('80', 'total', '100')).toBe('0.8');
    expect(holdingUnitPrice('2.5', 'total', '0.01')).toBe('250');
    expect(holdingUnitPrice('0.8125', 'unit', '100')).toBe('0.8125');
  });

  it('does not accept a total value without a positive holding', () => {
    expect(() => holdingUnitPrice('10', 'total', '0')).toThrow('当前余额必须大于 0');
    expect(() => holdingUnitPrice('0', 'unit', '100')).toThrow('请输入大于 0');
  });
});
