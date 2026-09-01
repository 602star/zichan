import { describe, expect, it } from 'vitest';
import {
  defaultNavigationPreferences,
  moveNavigationItem,
  orderedNavigationItems,
  parseNavigationPreferences,
  serializeNavigationPreferences,
  setNavigationItemVisible,
} from '../src/navigationPreferences.js';

describe('navigation preferences', () => {
  it('starts a lightweight ledger with only the daily modules and settings visible', () => {
    const preferences = defaultNavigationPreferences('spending');

    expect(orderedNavigationItems(preferences).map((item) => item.id)).toEqual([
      'transactions',
      'reports',
      'settings',
    ]);
  });

  it('persists enabled modules and their order', () => {
    let preferences = defaultNavigationPreferences('spending');
    preferences = setNavigationItemVisible(preferences, 'fixed', true);
    preferences = moveNavigationItem(preferences, 'fixed', -1);
    preferences = moveNavigationItem(preferences, 'fixed', -1);
    const restored = parseNavigationPreferences(serializeNavigationPreferences(preferences), 'spending');

    expect(restored.visible).toContain('fixed');
    expect(restored.order.indexOf('fixed')).toBeLessThan(restored.order.indexOf('transactions'));
  });

  it('never allows daily transactions or settings to be hidden', () => {
    let preferences = defaultNavigationPreferences('spending');
    preferences = setNavigationItemVisible(preferences, 'transactions', false);
    preferences = setNavigationItemVisible(preferences, 'settings', false);

    expect(preferences.visible).toEqual(['transactions', 'reports', 'settings']);
    expect(parseNavigationPreferences('{"version":1,"order":[],"visible":[]}', 'spending').visible).toEqual([
      'transactions',
      'settings',
    ]);
  });

  it('ignores unknown, duplicate, and malformed saved values', () => {
    const parsed = parseNavigationPreferences(
      JSON.stringify({ version: 1, order: ['fixed', 'fixed', 'unknown'], visible: ['fixed', 'unknown'] }),
      'spending',
    );

    expect(parsed.order[0]).toBe('fixed');
    expect(new Set(parsed.order).size).toBe(parsed.order.length);
    expect(parsed.visible).toEqual(['fixed', 'transactions', 'settings']);
    expect(parseNavigationPreferences('{broken', 'spending')).toEqual(defaultNavigationPreferences('spending'));
    expect(parseNavigationPreferences('{}', 'spending')).toEqual(defaultNavigationPreferences('spending'));
  });
});
