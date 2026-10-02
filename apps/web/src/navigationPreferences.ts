import type { LedgerMode } from '@zichan/core';

export type ScreenId = 'dashboard' | 'convert' | 'transactions' | 'game' | 'fixed' | 'reports' | 'history' | 'manage' | 'sync' | 'settings';

export interface NavigationItem {
  id: ScreenId;
  label: string;
  icon: string;
  description: string;
}

export interface NavigationPreferences {
  order: ScreenId[];
  visible: ScreenId[];
}

export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { id: 'dashboard', label: '总览', icon: '◈', description: '净资产和近期动态' },
  { id: 'convert', label: '资产转换', icon: '⇄', description: '换汇、买卖和转换链路' },
  { id: 'transactions', label: '日常收支', icon: '≋', description: '日常支出与收支流水' },
  { id: 'game', label: '游戏赛季', icon: '◆', description: '游戏投入、产出与回收' },
  { id: 'fixed', label: '物品资产', icon: '▤', description: '物品成本与生命周期' },
  { id: 'reports', label: '报表', icon: '▦', description: '支出、成本与盈亏报表' },
  { id: 'history', label: '历史', icon: '◷', description: '操作记录与冲突处理' },
  { id: 'manage', label: '管理', icon: '⊞', description: '资产、分类和基础资料' },
  { id: 'sync', label: '同步', icon: '⇅', description: '设备和同步服务器' },
  { id: 'settings', label: '设置', icon: '⚙', description: '记账、导航和数据设置' },
] as const;

export const REQUIRED_NAVIGATION_IDS = new Set<ScreenId>(['transactions', 'settings']);

const ALL_SCREEN_IDS = NAVIGATION_ITEMS.map((item) => item.id);
const SCREEN_ID_SET = new Set<ScreenId>(ALL_SCREEN_IDS);

/*
 * What a brand-new ledger shows. The pinned entries from REQUIRED_NAVIGATION_IDS
 * are added on top, so a fresh sidebar reads 总览 → 日常收支 → 物品资产 → 设置
 * and the phone bar keeps its three primary slots for the modules a person
 * actually opens every day.
 *
 * The set is the same for every ledger mode on purpose: switching from 轻量记账
 * to 账户/资产记账 later must not silently add seven entries, and a module that
 * starts hidden is still one tap away under 更多 → 未启用模块.
 */
const DEFAULT_VISIBLE_SCREEN_IDS: readonly ScreenId[] = ['dashboard', 'transactions', 'fixed'];

function normalizedIds(value: unknown): ScreenId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ScreenId>();
  const result: ScreenId[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !SCREEN_ID_SET.has(candidate as ScreenId)) continue;
    const id = candidate as ScreenId;
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function defaultNavigationPreferences(): NavigationPreferences {
  return {
    order: [...ALL_SCREEN_IDS],
    visible: ALL_SCREEN_IDS.filter(
      (id) => DEFAULT_VISIBLE_SCREEN_IDS.includes(id) || REQUIRED_NAVIGATION_IDS.has(id),
    ),
  };
}

export function parseNavigationPreferences(value: string | undefined): NavigationPreferences {
  if (!value) return defaultNavigationPreferences();
  try {
    const parsed = JSON.parse(value) as { version?: unknown; order?: unknown; visible?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.order) || !Array.isArray(parsed.visible)) {
      return defaultNavigationPreferences();
    }
    const requestedOrder = normalizedIds(parsed.order);
    const requestedVisible = normalizedIds(parsed.visible);
    const order = [...requestedOrder, ...ALL_SCREEN_IDS.filter((id) => !requestedOrder.includes(id))];
    const visible = order.filter((id) => requestedVisible.includes(id) || REQUIRED_NAVIGATION_IDS.has(id));
    return { order, visible };
  } catch {
    return defaultNavigationPreferences();
  }
}

export function serializeNavigationPreferences(preferences: NavigationPreferences): string {
  return JSON.stringify({ version: 1, order: preferences.order, visible: preferences.visible });
}

export function orderedNavigationItems(preferences: NavigationPreferences, includeHidden = false): NavigationItem[] {
  const byId = new Map(NAVIGATION_ITEMS.map((item) => [item.id, item]));
  const visible = new Set(preferences.visible);
  return preferences.order
    .filter((id) => includeHidden || visible.has(id))
    .map((id) => byId.get(id))
    .filter((item): item is NavigationItem => Boolean(item));
}

export function setNavigationItemVisible(
  preferences: NavigationPreferences,
  id: ScreenId,
  isVisible: boolean,
): NavigationPreferences {
  if (!isVisible && REQUIRED_NAVIGATION_IDS.has(id)) return preferences;
  const visible = new Set(preferences.visible);
  if (isVisible) visible.add(id);
  else visible.delete(id);
  return { ...preferences, visible: preferences.order.filter((candidate) => visible.has(candidate)) };
}

export function moveNavigationItem(
  preferences: NavigationPreferences,
  id: ScreenId,
  direction: -1 | 1,
): NavigationPreferences {
  const index = preferences.order.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= preferences.order.length) return preferences;
  const order = [...preferences.order];
  [order[index], order[target]] = [order[target]!, order[index]!];
  return { order, visible: order.filter((candidate) => preferences.visible.includes(candidate)) };
}

export function navigationLabel(id: ScreenId, mode: LedgerMode): string {
  void mode;
  return NAVIGATION_ITEMS.find((item) => item.id === id)?.label ?? id;
}
