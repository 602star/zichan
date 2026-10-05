/** Physical-item view model — pure selector over a Snapshot. */
import {
  D,
  componentCostOwnerAt,
  componentHostAt,
  fixedAssetAttributedCost,
  fixedConsumableRemaining,
  fixedGoalProgress,
  fixedUsageTotal,
  fixedUsageUnitLabel,
  localToday,
  type Attachment,
  type FixedAsset,
  type FixedAssetConsumable,
  type FixedAssetEvent,
  type FixedAssetGoal,
  type FixedAssetUsageLog,
  type FixedAssetUsageMetric,
  type FixedEventType,
} from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import { amount as fmtAmount, money } from '../format.js';

const EVENT_LABEL: Record<FixedEventType, string> = {
  purchase: '购入物品', activate: '启用', repair: '维修支出', upgrade: '升级／改造支出',
  install: '安装／转装配件', detach: '拆下配件',
  part_sale: '卖出配件', residual_update: '更新参考现值', warranty_expire: '保修到期', sale: '卖出整件物品',
  scrap: '报废', retire: '清退', gift: '赠出',
};

export function canPlaceFixedComponent(asset: FixedAsset): boolean {
  return !asset.isDeleted && (asset.status === 'active' || asset.status === 'stored');
}

export function canConvertFixedUpgrade(asset: FixedAsset, event: FixedAssetEvent): boolean {
  return canPlaceFixedComponent(asset) && !event.isDeleted && event.type === 'upgrade' && D(event.amountBase).gt(0);
}

const STATUS_LABEL: Record<FixedAsset['status'], string> = {
  active: '使用中', stored: '闲置/库存', sold: '已售出', scrapped: '已报废', retired: '已清退', gifted: '已赠出',
};

const CASHFLOW_LABEL = {
  record_only: '仅登记，不影响余额',
  linked_transaction: '已关联现有流水',
  create_transaction: '已创建资金流水',
} as const;

function joinDetail(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => !!part).join(' · ');
}

function dotColor(type: FixedEventType): string {
  if (type === 'purchase' || type === 'repair' || type === 'upgrade') return 'var(--negative)';
  if (type === 'sale' || type === 'part_sale') return 'var(--positive)';
  if (type === 'activate') return 'var(--accent)';
  return 'var(--fg-subtle)';
}

export type FixedTimelineMoneyKind = 'spend' | 'recover' | 'reference';

function eventMoneyKind(type: FixedEventType): FixedTimelineMoneyKind | undefined {
  if (type === 'purchase' || type === 'repair' || type === 'upgrade') return 'spend';
  if (type === 'part_sale' || type === 'sale') return 'recover';
  if (type === 'residual_update') return 'reference';
  return undefined;
}

export interface FixedTimelineVM {
  id: string;
  date: string;
  label: string;
  detail: string;
  amount?: string;
  moneyKind?: FixedTimelineMoneyKind;
  color: string;
  kind: 'event' | 'usage' | 'consumable';
  raw: FixedAssetEvent | FixedAssetUsageLog | FixedAssetConsumable;
}

export interface FixedMetricVM {
  raw: FixedAssetUsageMetric;
  total: string;
  unitLabel: string;
  perUnit: string;
}

export interface FixedGoalVM {
  raw: FixedAssetGoal;
  currentUsage: string;
  targetUsage: string;
  currentUnitCost: string;
  progress: number;
  achieved: boolean;
  unitLabel: string;
}

export interface FixedConsumableVM {
  raw: FixedAssetConsumable;
  remaining?: string;
  unitLabel?: string;
  needsAttention: boolean;
}

export interface FixedCardVM {
  id: string;
  name: string;
  isComponent: boolean;
  installedIn?: string;
  costOwner?: string;
  installedComponents: string[];
  category: string;
  categoryParent: string;
  tag: string;
  sold: boolean;
  status: string;
  days: number;
  perDay: string;
  net: string;
  invested: string;
  recovered: string;
  residual: string;
  referenceValue?: string;
  currencyCode: string;
  currencySymbol: string;
  imageAttachment?: Attachment;
  warrantyLabel: string;
  warrantyTone: 'positive' | 'warning' | 'muted';
  attachmentCount: number;
  invoiceCount: number;
  rows: { l: string; v: string }[];
  raw: FixedAsset;
  metrics: FixedMetricVM[];
  goals: FixedGoalVM[];
  consumables: FixedConsumableVM[];
  timeline: FixedTimelineVM[];
}

export function buildFixed(snap: Snapshot, asOf = localToday()): FixedCardVM[] {
  const categoryById = new Map(snap.fixedAssetCategories.map((category) => [category.id, category]));
  const assetById = new Map(snap.assets.map((asset) => [asset.id, asset]));
  const fixedById = new Map(snap.fixedAssets.map((asset) => [asset.id, asset]));
  return snap.fixedAssets.map((asset): FixedCardVM => {
    const events = snap.fixedEvents.filter((event) => event.fixedAssetId === asset.id).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    const metrics = snap.fixedUsageMetrics.filter((metric) => metric.fixedAssetId === asset.id && metric.isActive);
    const logs = snap.fixedUsageLogs.filter((log) => log.fixedAssetId === asset.id);
    const consumables = snap.fixedConsumables.filter((item) => item.fixedAssetId === asset.id);
    const goals = snap.fixedGoals.filter((goal) => goal.fixedAssetId === asset.id);
    const cashflowBySource = new Map(snap.fixedCashflowLinks
      .filter((link) => !link.isDeleted && link.fixedAssetId === asset.id)
      .map((link) => [`${link.sourceType}:${link.sourceId}`, link]));
    const cost = fixedAssetAttributedCost(asset, snap.fixedAssets, snap.fixedEvents, { asOf, usageMetrics: metrics, usageLogs: logs, consumables });
    const currency = assetById.get(asset.baseCurrencyAssetId);
    const cash = (value: string) => money(value, currency?.symbol ?? currency?.code ?? '', currency?.decimals ?? 2);
    const category = categoryById.get(asset.categoryId);
    const parent = category?.parentId ? categoryById.get(category.parentId) : undefined;
    const itemAttachments = snap.attachments.filter((attachment) => attachment.entityType === 'fixed_asset' && attachment.entityId === asset.id);
    const imageAttachment = itemAttachments.find((attachment) => attachment.role === 'image');
    const warrantyDays = asset.warrantyEndDate ? Math.ceil((Date.parse(`${asset.warrantyEndDate}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000) : undefined;
    const warrantyLabel = warrantyDays == null ? '未记录保修' : warrantyDays < 0 ? `已过保 ${Math.abs(warrantyDays)} 天` : warrantyDays === 0 ? '今日保修到期' : `在保 · 剩 ${warrantyDays} 天`;
    const warrantyTone = warrantyDays == null ? 'muted' as const : warrantyDays < 0 ? 'warning' as const : 'positive' as const;
    const metricVMs = metrics.map((metric): FixedMetricVM => {
      const total = fixedUsageTotal(metric, logs);
      const usageCost = cost.usageCosts.find((row) => row.metricId === metric.id);
      return { raw: metric, total, unitLabel: fixedUsageUnitLabel(metric), perUnit: usageCost?.perUnit ?? '0' };
    });
    const goalVMs = goals.map((goal): FixedGoalVM => {
      const progress = fixedGoalProgress(goal, asset, events, metrics, logs, asOf);
      const metric = metrics.find((row) => row.id === goal.metricId);
      return { raw: goal, currentUsage: progress.currentUsage, targetUsage: progress.targetUsage, currentUnitCost: progress.currentUnitCost, progress: Number(progress.progress), achieved: progress.achieved, unitLabel: goal.unit === 'day' ? '天' : metric ? fixedUsageUnitLabel(metric) : goal.customUnit || '单位' };
    });
    const consumableVMs = consumables.map((item): FixedConsumableVM => {
      const remaining = fixedConsumableRemaining(item, metrics, logs);
      const metric = metrics.find((row) => row.id === item.usageMetricId);
      const needsAttention = item.status === 'active' && remaining !== undefined && Number(remaining) <= Number(item.reminderAtRemaining ?? 0);
      return { raw: item, remaining, unitLabel: metric ? fixedUsageUnitLabel(metric) : undefined, needsAttention };
    });
    const timeline: FixedTimelineVM[] = [
      ...events.map((event): FixedTimelineVM => {
        const link = cashflowBySource.get(`event:${event.id}`);
        const moneyKind = eventMoneyKind(event.type);
        return {
          id: event.id,
          date: event.date,
          label: EVENT_LABEL[event.type],
          detail: joinDetail(
            event.cashflowMode ? CASHFLOW_LABEL[event.cashflowMode] : undefined,
            link || event.cashflowMode === 'record_only' ? undefined : event.cashflowMode ? '资金关联缺失' : undefined,
            event.type === 'install' ? `目标：${fixedById.get(event.hostAssetId ?? '')?.name ?? '未知物品'}` : undefined,
            event.note,
          ),
          amount: moneyKind && (D(event.amountBase).gt(0) || moneyKind === 'reference') ? cash(event.amountBase) : undefined,
          moneyKind,
          color: dotColor(event.type),
          kind: 'event',
          raw: event,
        };
      }),
      ...logs.map((log): FixedTimelineVM => {
        const metric = metrics.find((row) => row.id === log.metricId);
        return { id: log.id, date: log.date, label: metric?.name ?? '使用量', detail: `${log.entryMode === 'meter' ? '累计读数' : '增加'} ${fmtAmount(log.value, 4)} ${metric ? fixedUsageUnitLabel(metric) : ''}${log.note ? ` · ${log.note}` : ''}`, color: 'var(--accent)', kind: 'usage', raw: log };
      }),
      ...consumables.flatMap((item): FixedTimelineVM[] => {
        const link = cashflowBySource.get(`consumable:${item.id}`);
        const rows: FixedTimelineVM[] = [{
          id: item.id,
          date: item.purchaseDate,
          label: item.installedDate === item.purchaseDate ? '购入并安装耗材' : '购入耗材',
          detail: joinDetail(item.name, CASHFLOW_LABEL[item.cashflowMode], link ? undefined : item.cashflowMode === 'record_only' ? undefined : '资金关联缺失'),
          amount: D(item.amountBase).gt(0) ? cash(item.amountBase) : undefined,
          moneyKind: 'spend',
          color: 'var(--negative)',
          kind: 'consumable',
          raw: item,
        }];
        if (item.installedDate && item.installedDate !== item.purchaseDate) rows.push({
          id: `${item.id}:install`, date: item.installedDate, label: '安装耗材', detail: item.name,
          color: 'var(--fg-subtle)', kind: 'consumable', raw: item,
        });
        if (item.replacedDate) rows.push({ id: `${item.id}:terminal`, date: item.replacedDate, label: item.status === 'replaced' ? '更换耗材' : '丢弃耗材', detail: item.name, color: item.status === 'replaced' ? 'var(--accent)' : 'var(--negative)', kind: 'consumable', raw: item });
        return rows;
      }),
    ].sort((a, b) => b.date.localeCompare(a.date));
    return {
      id: asset.id,
      name: asset.name,
      isComponent: asset.role === 'component',
      installedIn: asset.role === 'component' ? fixedById.get(componentHostAt(asset.id, snap.fixedEvents, asOf) ?? '')?.name : undefined,
      costOwner: asset.role === 'component' ? fixedById.get(componentCostOwnerAt(asset, snap.fixedEvents, asOf) ?? '')?.name : undefined,
      installedComponents: snap.fixedAssets.filter((row) => row.role === 'component' && componentHostAt(row.id, snap.fixedEvents, asOf) === asset.id).map((row) => row.name),
      category: category?.name ?? '待分类',
      categoryParent: parent?.name ?? category?.name ?? '其他物品',
      tag: asset.tag ?? '',
      sold: cost.basis === 'final',
      status: STATUS_LABEL[asset.status],
      days: cost.heldDays,
      perDay: cost.perDay,
      net: cost.netCost,
      invested: cost.investedCost,
      recovered: cost.recoveredCost,
      residual: cost.salePrice ?? cost.currentResidual ?? '0',
      referenceValue: cost.currentResidual,
      currencyCode: currency?.code ?? '',
      currencySymbol: currency?.symbol ?? currency?.code ?? '',
      imageAttachment,
      warrantyLabel,
      warrantyTone,
      attachmentCount: itemAttachments.length,
      invoiceCount: itemAttachments.filter((attachment) => attachment.role === 'invoice').length,
      rows: [
        { l: '累计支出', v: cash(cost.investedCost) },
        { l: '累计回款', v: cash(cost.recoveredCost) },
        { l: '维修／升级支出', v: cash(D(cost.repair).plus(cost.upgrade).toString()) },
        { l: '耗材支出', v: cash(cost.consumable) },
      ],
      raw: asset,
      metrics: metricVMs,
      goals: goalVMs,
      consumables: consumableVMs,
      timeline,
    };
  });
}
