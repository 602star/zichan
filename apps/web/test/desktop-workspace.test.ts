import { describe, expect, it } from 'vitest';
import { continuedEntryFields, desktopDestinations } from '../src/desktop-workspace.js';
import { defaultNavigationPreferences, moveSidebarItem, navigationLabel, parseNavigationPreferences, serializeNavigationPreferences, sidebarNavigationItems } from '../src/navigationPreferences.js';
import { nextTabValue } from '../src/ui/useTabSet.js';

describe('desktop ledger tasks', () => {
  it('uses matching sidebar and settings names, while keeping the shorter phone labels', () => {
    const prefs = defaultNavigationPreferences();
    const settings = sidebarNavigationItems(prefs, true);
    expect(settings.map((item) => item.label)).toEqual(['工作台', '流水', '资产转换', '物品资产', '游戏赛季', '报表', '资料管理', '操作历史', '我的账号', '设置']);
    expect(settings.some((item) => item.id === 'assets')).toBe(false);
    expect(navigationLabel('dashboard', 'spending', 'mobile')).toBe('总览');
    expect(navigationLabel('transactions', 'spending', 'mobile')).toBe('收支');
    expect(navigationLabel('history', 'spending')).toBe('操作历史');
    for (const destination of desktopDestinations({ ...prefs, visible: prefs.order }, 'spending').filter((row) => row.target.screen !== 'transactions')) {
      expect(destination.label).toBe(settings.find((row) => row.id === destination.target.screen)?.label);
    }
  });

  it('applies persisted ordering to the actual sidebar and stops at group boundaries', () => {
    const original = defaultNavigationPreferences();
    let prefs = { ...original, visible: original.order };
    for (let i = 0; i < 3; i++) prefs = moveSidebarItem(prefs, 'reports', -1);
    prefs = parseNavigationPreferences(serializeNavigationPreferences(prefs));
    expect(desktopDestinations(prefs, 'spending').filter((row) => row.group === '资产与分析').map((row) => row.id)).toEqual(['reports', 'convert', 'fixed', 'game']);
    expect(moveSidebarItem(prefs, 'reports', -1)).toEqual(prefs);
    expect(moveSidebarItem(prefs, 'assets', 1)).toEqual(prefs);
    const records = desktopDestinations(prefs, 'spending').filter((row) => row.group === '日常');
    expect(records.map((row) => row.id)).toEqual(['dashboard', 'records', 'accounts', 'bills', 'plans']);
  });
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
