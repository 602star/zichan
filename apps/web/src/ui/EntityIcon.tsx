import { useState } from 'react';
import { isEntityIconImage, SYSTEM_CATEGORY_CATALOG, type Category } from '@zichan/core';
import { Utensils, Car, ShoppingBag, House, HeartPulse, BookOpen, Ticket, Users, Landmark, CircleEllipsis, BriefcaseBusiness, TrendingUp, Wallet, Coffee, Fuel, Plane, TrainFront, Bike, Smartphone, Shirt, Gift, PawPrint, Store, Building2, UserRound, Package, Music, Gamepad2, type LucideIcon } from 'lucide-react';
import { siTaobao, siMeituan, siBilibili, siNeteasecloudmusic, siSteam, siAppstore, type SimpleIcon } from 'simple-icons';
import { findPlatform } from '../payee-catalog.js';

export const ENTITY_ICONS: Record<string, { label: string; component: LucideIcon }> = {
  utensils: { label: '餐饮', component: Utensils }, car: { label: '汽车', component: Car },
  shopping: { label: '购物', component: ShoppingBag }, house: { label: '居家', component: House },
  health: { label: '健康', component: HeartPulse }, book: { label: '学习', component: BookOpen },
  ticket: { label: '演出票务', component: Ticket }, users: { label: '家庭', component: Users },
  bank: { label: '金融', component: Landmark }, other: { label: '其他', component: CircleEllipsis },
  work: { label: '工作', component: BriefcaseBusiness }, investment: { label: '投资', component: TrendingUp },
  wallet: { label: '钱包', component: Wallet }, coffee: { label: '咖啡', component: Coffee },
  fuel: { label: '加油', component: Fuel }, plane: { label: '飞机', component: Plane },
  train: { label: '火车', component: TrainFront }, bike: { label: '骑行', component: Bike },
  phone: { label: '通信', component: Smartphone }, shirt: { label: '服饰', component: Shirt },
  gift: { label: '礼物', component: Gift }, pet: { label: '宠物', component: PawPrint },
  store: { label: '商家', component: Store }, company: { label: '公司', component: Building2 },
  person: { label: '个人', component: UserRound }, package: { label: '快递', component: Package },
  music: { label: '音乐', component: Music }, game: { label: '游戏', component: Gamepad2 },
};
const defaults: Record<string, string> = {
  expense_food: 'utensils', expense_transport: 'car', expense_shopping: 'shopping', expense_home: 'house',
  expense_health: 'health', expense_learning: 'book', expense_entertainment: 'ticket', expense_family: 'users',
  expense_finance: 'bank', expense_misc: 'other', income_work: 'work', income_investment: 'investment', income_other: 'wallet',
  coffee_drinks: 'coffee', fuel: 'fuel', flight: 'plane', train_flight: 'train', transport: 'train',
  taxi_ride: 'car', taxi: 'car', bike_ebike: 'bike', shared_ebike: 'bike', communication: 'phone',
  concert: 'ticket', movies: 'ticket', music_festival: 'music', games: 'game', express_postage: 'package',
};
const brands: Record<string, SimpleIcon> = {
  taobao: siTaobao, meituan: siMeituan, bilibili: siBilibili, 'netease-music': siNeteasecloudmusic,
  steam: siSteam, 'app-store': siAppstore,
};

export function categoryIconValue(id: string, categories: Category[] = []): string {
  const category = categories.find((row) => row.id === id) ?? SYSTEM_CATEGORY_CATALOG.find((row) => row.id === id);
  if (category && 'icon' in category && category.icon) return category.icon;
  if (defaults[id]) return `lucide:${defaults[id]}`;
  const parent = categories.find((row) => row.id === category?.parentId);
  return parent?.icon || `lucide:${defaults[category?.parentId ?? ''] ?? 'other'}`;
}

export function categoryOptionIcon(option: { value: string; icon?: string; parentIcon?: string; parentId?: string }): string {
  return option.icon || (defaults[option.value] ? `lucide:${defaults[option.value]}` : option.parentIcon)
    || (option.parentId ? categoryIconValue(option.parentId) : categoryIconValue(option.value));
}

/** Never fetch remote URLs or render uploaded SVG markup. */
export function EntityIcon({ icon, fallback = 'other', platformName, platformId, size = 18, color }: {
  icon?: string; fallback?: string; platformName?: string; platformId?: string; size?: number; color?: string;
}) {
  const [failed, setFailed] = useState('');
  const style = { width: size, height: size, flex: '0 0 auto' as const, color, verticalAlign: 'middle' as const };
  if (isEntityIconImage(icon) && failed !== icon) return <img aria-hidden="true" alt="" src={icon} width={size} height={size}
    style={{ ...style, objectFit: 'contain' }} onError={() => setFailed(icon)} />;
  const brand = !icon ? brands[platformId?.replace(/^platform-payee:/, '') ?? ''] ?? brands[findPlatform(platformName ?? '')?.id ?? ''] : undefined;
  if (brand) return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" style={style} fill="currentColor"><path d={brand.path} /></svg>;
  const Icon = ENTITY_ICONS[icon?.replace(/^lucide:/, '') ?? '']?.component ?? ENTITY_ICONS[fallback]?.component ?? CircleEllipsis;
  return <Icon aria-hidden="true" size={size} strokeWidth={1.8} style={style} />;
}

export function CategoryMark({ id, categories }: { id: string; categories: Category[] }) {
  return <EntityIcon icon={categoryIconValue(id, categories)} color={categories.find((row) => row.id === id)?.color} />;
}
