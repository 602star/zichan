import { describe, expect, it } from 'vitest';
import { sanitizeNumericInput } from '../src/form-number.js';
import { holdingUnitPrice } from '../src/screens/HoldingPriceModal.js';

describe('sanitizeNumericInput', () => {
  it('cleans grouping commas, spaces, and currency prefixes/suffixes', () => {
    expect(sanitizeNumericInput('  1,234.50 ')).toBe('1234.50');
    expect(sanitizeNumericInput('¥1,234.50')).toBe('1234.50');
    expect(sanitizeNumericInput('US$ 9,800')).toBe('9800');
    expect(sanitizeNumericInput('-¥1,200.50')).toBe('-1200.50');
    expect(sanitizeNumericInput('500元')).toBe('500');
    expect(sanitizeNumericInput('1,000,000')).toBe('1000000');
  });

  it('normalizes full-width digits, decimal dots, and signs', () => {
    expect(sanitizeNumericInput('１２３．４５')).toBe('123.45');
    expect(sanitizeNumericInput('１，２３４。５')).toBe('1234.5');
    expect(sanitizeNumericInput('－８８．５')).toBe('-88.5');
  });

  it('keeps non-numeric text intact so validation reports an error', () => {
    expect(sanitizeNumericInput('abc')).toBe('abc');
    expect(sanitizeNumericInput('12,34')).toBe('12,34');
    expect(sanitizeNumericInput('   ')).toBe('');
  });

  it('works with holdingUnitPrice decimal calculations', () => {
    expect(holdingUnitPrice('¥1,200.00', 'total', '4')).toBe('300');
    expect(holdingUnitPrice('３００．５', 'unit', '4')).toBe('300.5');
  });
});
