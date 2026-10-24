import { describe, expect, it } from 'vitest';
import { nextTabValue } from '../src/ui/useTabSet.js';

describe('tab keyboard navigation', () => {
  const tabs = ['first', 'middle', 'last'] as const;

  it('moves in either direction and wraps at the ends', () => {
    expect(nextTabValue(tabs, 'first', 'ArrowRight')).toBe('middle');
    expect(nextTabValue(tabs, 'last', 'ArrowRight')).toBe('first');
    expect(nextTabValue(tabs, 'first', 'ArrowLeft')).toBe('last');
  });

  it('jumps to the first or last tab', () => {
    expect(nextTabValue(tabs, 'middle', 'Home')).toBe('first');
    expect(nextTabValue(tabs, 'middle', 'End')).toBe('last');
    expect(nextTabValue([], 'first', 'Home')).toBeNull();
  });
});
