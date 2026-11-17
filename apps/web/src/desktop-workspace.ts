import type { LedgerMode } from '@zichan/core';
import { NAVIGATION_GROUPS, navigationLabel, type NavigationGroup, type NavigationPreferences, type ScreenId } from './navigationPreferences.js';
import type { ScreenTarget } from './screen-target.js';

export interface DesktopDestination { id: string; label: string; target: ScreenTarget; group: NavigationGroup; }

export function desktopDestinations(preferences: NavigationPreferences, mode: LedgerMode): DesktopDestination[] {
  const visible = new Set(preferences.visible);
  const entries: Array<DesktopDestination & { source: ScreenId }> = [
    { id: 'dashboard', label: '工作台', source: 'dashboard', target: { screen: 'dashboard' }, group: '日常' },
    { id: 'records', label: '流水', source: 'transactions', target: { screen: 'transactions', tab: 'records' }, group: '日常' },
    ...[
      { id: 'accounts', label: '账户', source: 'transactions' as const, target: { screen: 'transactions' as const, tab: 'accounts' }, group: '日常' as const },
      { id: 'bills', label: '账单与还款', source: 'transactions' as const, target: { screen: 'transactions' as const, tab: 'bills' }, group: '日常' as const },
      { id: 'plans', label: '计划', source: 'transactions' as const, target: { screen: 'transactions' as const, tab: 'budget' }, group: '日常' as const },
    ],
    { id: 'convert', label: '资产转换', source: 'convert', target: { screen: 'convert' }, group: '资产与分析' },
    { id: 'fixed', label: '物品资产', source: 'fixed', target: { screen: 'fixed' }, group: '资产与分析' },
    { id: 'game', label: '游戏赛季', source: 'game', target: { screen: 'game' }, group: '资产与分析' },
    { id: 'reports', label: '报表', source: 'reports', target: { screen: 'reports' }, group: '资产与分析' },
    { id: 'manage', label: '资料管理', source: 'manage', target: { screen: 'manage' }, group: '账本工具' },
    { id: 'history', label: '操作历史', source: 'history', target: { screen: 'history' }, group: '账本工具' },
    { id: 'account', label: '我的账号', source: 'account', target: { screen: 'account' }, group: '账本工具' },
    { id: 'settings', label: '设置', source: 'settings', target: { screen: 'settings' }, group: '账本工具' },
  ];
  return entries.filter((entry) => visible.has(entry.source))
    .map((entry) => ({ ...entry, label: entry.source === 'transactions' ? entry.label : navigationLabel(entry.source, mode) }))
    .sort((a, b) => NAVIGATION_GROUPS.indexOf(a.group) - NAVIGATION_GROUPS.indexOf(b.group)
      || preferences.order.indexOf(a.source) - preferences.order.indexOf(b.source));
}

/** Only routine entry fields survive. Amounts, attachments and refund links never carry over. */
export function continuedEntryFields(values: Record<string, string>, retain: boolean): Record<string, string> {
  return retain ? Object.fromEntries(['date', 'time', 'timezone', 'type', 'category', 'assetId', 'accountId']
    .filter((key) => values[key] !== undefined).map((key) => [key, values[key]!])) : {};
}
