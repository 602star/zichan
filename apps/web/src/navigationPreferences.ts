import type { LedgerMode } from '@zichan/core';

export type ScreenId = 'dashboard' | 'assets' | 'convert' | 'transactions' | 'game' | 'fixed' | 'reports' | 'history' | 'manage' | 'sync' | 'account' | 'settings';
export const NAVIGATION_GROUPS = ['日常', '资产与分析', '账本工具'] as const;
export type NavigationGroup = typeof NAVIGATION_GROUPS[number];

export interface NavigationItem {
  id: ScreenId;
  label: string;
  mobileLabel?: string;
  group: NavigationGroup;
  description: string;
}

export interface NavigationPreferences {
  order: ScreenId[];
  visible: ScreenId[];
}

export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { id: 'dashboard', label: '工作台', mobileLabel: '总览', group: '日常', description: '净资产、最近流水、账单与待办' },
  { id: 'transactions', label: '流水', mobileLabel: '收支', group: '日常', description: '固定提供流水、账户、账单与还款、计划四个入口' },
  { id: 'assets', label: '资产', group: '资产与分析', description: '手机端的账户、持仓与物品入口' },
  { id: 'convert', label: '资产转换', group: '资产与分析', description: '连续换汇、买卖与手续费' },
  { id: 'fixed', label: '物品资产', group: '资产与分析', description: '物品卡片、配件耗材与使用成本' },
  { id: 'game', label: '游戏赛季', group: '资产与分析', description: '游戏投入、产出与回收' },
  { id: 'reports', label: '报表', group: '资产与分析', description: '收支、资产、物品与游戏报表' },
  { id: 'manage', label: '资料管理', group: '账本工具', description: '分类、交易对象、币种、价格与模板' },
  { id: 'history', label: '操作历史', group: '账本工具', description: '记录变更、撤销与冲突处理' },
  { id: 'account', label: '我的账号', group: '账本工具', description: '个人资料、邮箱、配额与账号安全' },
  { id: 'settings', label: '设置', group: '账本工具', description: '记账、备份、同步、恢复与外观' },
] as const;

export const REQUIRED_NAVIGATION_IDS = new Set<ScreenId>(['transactions', 'settings']);

const ALL_SCREEN_IDS = NAVIGATION_ITEMS.map((item) => item.id);
const SCREEN_ID_SET = new Set<ScreenId>(ALL_SCREEN_IDS);

/*
 * What a brand-new ledger shows. The pinned entries from REQUIRED_NAVIGATION_IDS
 * are added on top, so a fresh sidebar reads 工作台 → 流水（含账户、账单与还款、计划）→ 物品资产 → 我的账号 → 设置
 * while the phone uses a fixed 总览／收支／记一笔／资产／更多 bar.
 *
 * The set is the same for every ledger mode on purpose: switching from 轻量记账
 * to 账户/资产记账 later must not silently add seven entries, and a module that
 * starts hidden is still available in the phone task directory. Sidebar
 * visibility is configured separately under 添加到桌面侧栏.
 */
const DEFAULT_VISIBLE_SCREEN_IDS: readonly ScreenId[] = ['dashboard', 'transactions', 'fixed', 'account'];

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
    const newAccountPage = !requestedOrder.includes('account');
    const visible = order.filter((id) => requestedVisible.includes(id) || REQUIRED_NAVIGATION_IDS.has(id) || (newAccountPage && id === 'account'));
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

export function sidebarNavigationItems(preferences: NavigationPreferences, includeHidden = false): NavigationItem[] {
  const ordered = orderedNavigationItems(preferences, includeHidden).filter((item) => item.id !== 'assets');
  return NAVIGATION_GROUPS.flatMap((group) => ordered.filter((item) => item.group === group));
}

/** Sidebar groups stay fixed; ordering applies to the real neighbours within each group. */
export function moveSidebarItem(preferences: NavigationPreferences, id: ScreenId, direction: -1 | 1): NavigationPreferences {
  if (id === 'assets') return preferences;
  const current = NAVIGATION_ITEMS.find((item) => item.id === id);
  const peers = sidebarNavigationItems(preferences, true).filter((item) => item.group === current?.group);
  const neighbour = peers[peers.findIndex((item) => item.id === id) + direction];
  if (!neighbour || !current) return preferences;
  const order = [...preferences.order];
  const from = order.indexOf(id), to = order.indexOf(neighbour.id);
  if (from < 0 || to < 0) return preferences;
  [order[from], order[to]] = [order[to]!, order[from]!];
  return { order, visible: order.filter((candidate) => preferences.visible.includes(candidate)) };
}

export function navigationLabel(id: ScreenId, mode: LedgerMode, surface: 'desktop' | 'mobile' = 'desktop'): string {
  void mode;
  const item = NAVIGATION_ITEMS.find((item) => item.id === id);
  return (surface === 'mobile' ? item?.mobileLabel ?? item?.label : item?.label) ?? id;
}
