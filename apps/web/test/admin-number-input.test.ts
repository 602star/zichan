import { describe, expect, it } from 'vitest';
import { quotaBytesFromGiB, settingNumber } from '../src/admin/number-input.js';

describe('admin numeric drafts', () => {
  it('rejects invalid quota syntax, range and excessive precision instead of sending null', () => {
    for (const value of ['', 'abc', '1GiB', 'NaN', 'Infinity', '1e999', '0x10', '-1', '0', '1024.0000000001', `1.${'0'.repeat(31)}`]) {
      expect(() => quotaBytesFromGiB(value)).toThrow();
    }
    expect(quotaBytesFromGiB('0.0009765625')).toBe(1048576);
    expect(quotaBytesFromGiB('1024')).toBe(1099511627776);
    expect(quotaBytesFromGiB('0.1')).toBe(107374182);
    expect(quotaBytesFromGiB('1.000000000931322574615478515625')).toBe(1073741825);
  });
  it('refuses blank, invalid and out-of-range settings while allowing bounded decimals', () => {
    for (const value of ['', 'abc', '1GiB', '1e999', '-1', '101']) expect(() => settingNumber(value, 0, 100)).toThrow();
    expect(settingNumber('0.5', 0, 1)).toBe(0.5);
    expect(settingNumber('0', 0, 1)).toBe(0);
  });
});
