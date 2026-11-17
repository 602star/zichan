import { ArrowLeftRight, BarChart3, BookOpen, Cloud, Gamepad2, Grid2X2, History, LayoutDashboard, List, Package, Settings2, UserRound, type LucideIcon } from 'lucide-react';
import type { ScreenId } from '../navigationPreferences.js';

const icons: Record<ScreenId, LucideIcon> = {
  dashboard: LayoutDashboard, assets: BookOpen, transactions: List, convert: ArrowLeftRight,
  game: Gamepad2, fixed: Package, reports: BarChart3, history: History, manage: Grid2X2,
  sync: Cloud, account: UserRound, settings: Settings2,
};
export function NavigationIcon({ id, size = 18 }: { id: ScreenId; size?: number }) {
  const Icon = icons[id];
  return <Icon aria-hidden="true" size={size} strokeWidth={1.8} />;
}
