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
  it('starts a new ledger with overview, daily cash flow, item assets, account, and settings', () => {
    const preferences = defaultNavigationPreferences();

    expect(orderedNavigationItems(preferences).map((item) => item.id)).toEqual([
      'dashboard',
      'transactions',
      'fixed',
      'account',
      'settings',
    ]);
  });

  it('leaves every other module off until the user enables it', () => {
    const preferences = defaultNavigationPreferences();
    const hidden = orderedNavigationItems(preferences, true)
      .map((item) => item.id)
      .filter((id) => !preferences.visible.includes(id));

    expect(hidden).toEqual(['convert', 'game', 'reports', 'history', 'manage']);
  });

  it('persists enabled modules and their order', () => {
    let preferences = defaultNavigationPreferences();
    preferences = setNavigationItemVisible(preferences, 'manage', true);
    preferences = moveNavigationItem(preferences, 'manage', -1);
    preferences = moveNavigationItem(preferences, 'manage', -1);
    preferences = moveNavigationItem(preferences, 'manage', -1);
    const restored = parseNavigationPreferences(serializeNavigationPreferences(preferences));

    expect(restored.visible).toEqual(['dashboard', 'transactions', 'manage', 'fixed', 'account', 'settings']);
    expect(restored.order.indexOf('manage')).toBeLessThan(restored.order.indexOf('fixed'));
  });

  it('never allows daily transactions or settings to be hidden', () => {
    let preferences = defaultNavigationPreferences();
    preferences = setNavigationItemVisible(preferences, 'transactions', false);
    preferences = setNavigationItemVisible(preferences, 'settings', false);

    expect(preferences.visible).toEqual(['dashboard', 'transactions', 'fixed', 'account', 'settings']);
    expect(parseNavigationPreferences('{"version":1,"order":[],"visible":[]}').visible).toEqual([
      'transactions',
      'account',
      'settings',
    ]);
  });

  it('ignores unknown, duplicate, and malformed saved values', () => {
    const parsed = parseNavigationPreferences(
      JSON.stringify({ version: 1, order: ['dashboard', 'dashboard', 'unknown'], visible: ['dashboard', 'unknown'] }),
    );

    expect(parsed.order[0]).toBe('dashboard');
    expect(new Set(parsed.order).size).toBe(parsed.order.length);
    expect(parsed.visible).toEqual(['dashboard', 'transactions', 'account', 'settings']);
    expect(parseNavigationPreferences('{broken')).toEqual(defaultNavigationPreferences());
    expect(parseNavigationPreferences('{}')).toEqual(defaultNavigationPreferences());
  });

  it('shows the new account page in previously saved navigation', () => {
    const saved = JSON.stringify({ version: 1, order: ['dashboard', 'transactions', 'settings'], visible: ['dashboard', 'transactions', 'settings'] });
    expect(parseNavigationPreferences(saved).visible).toContain('account');
  });

  it('removes the former sync module from saved navigation', () => {
    const saved = JSON.stringify({ version: 1, order: ['dashboard', 'sync', 'settings'], visible: ['dashboard', 'sync', 'settings'] });
    const parsed = parseNavigationPreferences(saved);
    expect(parsed.order).not.toContain('sync');
    expect(parsed.visible).not.toContain('sync');
  });
});
