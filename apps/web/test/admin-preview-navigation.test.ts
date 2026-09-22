import { describe, expect, it } from 'vitest';
import { clampPreviewScreen, previewNavigation, PREVIEW_HIDDEN_SCREENS } from '../src/App.js';
import { defaultNavigationPreferences, NAVIGATION_ITEMS, type NavigationPreferences } from '../src/navigationPreferences.js';

/**
 * A preview shows one user's ledger through the ordinary ledger UI. Two of those screens do not
 * describe a ledger at all — 设置 lists this machine's backup files and storage estimate, 同步
 * lists the connections saved in this browser — so in a preview they would report the operator's
 * own machine as the user's state.
 *
 * The rule is therefore "hide and redirect", and both halves are tested: hiding alone would leave
 * a stored `screen` value or a deep link able to open the wrong screen.
 */
describe('preview navigation', () => {
  it('hides exactly the device-only screens', () => {
    const preferences = defaultNavigationPreferences();
    const visible = previewNavigation(preferences).visible;
    expect(visible).not.toContain('sync');
    expect(visible).not.toContain('settings');
    // Everything else the ledger offered is still offered: the preview must not quietly shrink
    // the user's own navigation.
    for (const id of preferences.visible) {
      if (!PREVIEW_HIDDEN_SCREENS.includes(id)) expect(visible).toContain(id);
    }
  });

  it('keeps the ledger order rather than inventing one', () => {
    const preferences: NavigationPreferences = {
      order: [...NAVIGATION_ITEMS.map((item) => item.id)].reverse(),
      visible: ['dashboard', 'sync', 'settings', 'transactions'],
    };
    expect(previewNavigation(preferences).order).toEqual(preferences.order);
  });

  it('still offers every ledger screen even when the user hid some', () => {
    // A user who hid 报表 must not gain it, and one who showed only 总览 must not lose the rest of
    // what they showed. The preview filters, it does not re-default.
    const preferences: NavigationPreferences = { order: ['dashboard', 'reports', 'sync'], visible: ['dashboard', 'sync'] };
    expect(previewNavigation(preferences).visible).toEqual(['dashboard']);
  });

  it('redirects a device-only screen instead of rendering it', () => {
    expect(clampPreviewScreen('sync')).toBe('dashboard');
    expect(clampPreviewScreen('settings')).toBe('dashboard');
    // A ledger screen is left exactly as it was.
    for (const id of ['dashboard', 'transactions', 'reports', 'game'] as const) {
      expect(clampPreviewScreen(id)).toBe(id);
    }
  });
});