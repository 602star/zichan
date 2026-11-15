import { describe, expect, it } from 'vitest';
import { continuedEntryFields, desktopDestinations } from '../src/desktop-workspace.js';
import { defaultNavigationPreferences } from '../src/navigationPreferences.js';
import { nextTabValue } from '../src/ui/useTabSet.js';

describe('desktop ledger tasks', () => {
  it('offers account and plan tasks without changing stored screen identifiers', () => {
    const entries = desktopDestinations(defaultNavigationPreferences(), 'spending');
    expect(entries.find((entry) => entry.id === 'records')?.target).toEqual({ screen: 'transactions', tab: 'records' });
    expect(entries.find((entry) => entry.id === 'accounts')?.target).toEqual({ screen: 'transactions', tab: 'accounts' });
    expect(entries.find((entry) => entry.id === 'plans')?.target).toEqual({ screen: 'transactions', tab: 'budget' });
    expect(entries.find((entry) => entry.id === 'bills')?.target).toEqual({ screen: 'transactions', tab: 'bills' });
    expect(entries.some((entry) => entry.id === 'convert')).toBe(false);
  });

  it('keeps hidden and preview-only device screens out of the workspace', () => {
    const prefs = defaultNavigationPreferences();
    const entries = desktopDestinations({ ...prefs, visible: ['transactions', 'fixed'] }, 'assets');
    expect(entries.map((entry) => entry.id)).toEqual(['records', 'accounts', 'bills', 'plans', 'fixed']);
  });

  it('continues routine fields without duplicating money, attachments or refund links', () => {
    const values = { date: '2026-11-15', time: '12:30', timezone: 'Asia/Shanghai', type: 'expense', category: 'lunch', accountId: 'wallet', assetId: 'cny', amount: '123456789.12', description: '一次性购买', note: '说明', attachmentDrafts: 'private-file', refundForId: 'original', transferAmount: '99' };
    expect(continuedEntryFields(values, true)).toEqual({ date: values.date, time: values.time, timezone: values.timezone, type: values.type, category: values.category, accountId: values.accountId, assetId: values.assetId });
    expect(continuedEntryFields(values, false)).toEqual({});
  });

  it('uses direct desktop tasks even when the mobile asset overview was enabled in saved preferences', () => {
    const prefs = defaultNavigationPreferences();
    const entries = desktopDestinations({ ...prefs, visible: [...prefs.visible, 'assets', 'convert', 'game', 'reports'] }, 'assets');
    expect(entries.filter((entry) => entry.group === '资产与分析').map((entry) => entry.id)).toEqual(['convert', 'fixed', 'game', 'reports']);
    expect(entries.find((entry) => entry.id === 'accounts')?.target).toEqual({ screen: 'transactions', tab: 'accounts' });
  });

  it('moves vertical setting tabs in both directions and wraps', () => {
    expect(nextTabValue(['ledger', 'device', 'security'], 'security', 'ArrowDown')).toBe('ledger');
    expect(nextTabValue(['ledger', 'device', 'security'], 'ledger', 'ArrowUp')).toBe('security');
  });
});
