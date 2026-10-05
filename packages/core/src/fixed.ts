/** Physical-item lifecycle cost, usage, goals, and consumable reminders. */
import { D, safeDiv, sum } from './decimal.js';
import { heldDays, localToday } from './dates.js';
import type {
  FixedAsset,
  FixedAssetConsumable,
  FixedAssetEvent,
  FixedAssetGoal,
  FixedAssetUsageLog,
  FixedAssetUsageMetric,
  FixedEventType,
  FixedUsageUnit,
} from './types.js';

const COST_TYPES = new Set<FixedEventType>(['purchase', 'repair', 'upgrade']);
const TERMINAL_TYPES = new Set<FixedEventType>(['sale', 'scrap', 'retire', 'gift']);

export interface FixedUsageCost {
  metricId?: string;
  name: string;
  unit: FixedUsageUnit;
  unitLabel: string;
  totalUsage: string;
  perUnit: string;
}

export interface FixedAssetCostOptions {
  asOf?: string;
  usageMetrics?: FixedAssetUsageMetric[];
  usageLogs?: FixedAssetUsageLog[];
  consumables?: FixedAssetConsumable[];
}

export interface FixedAssetCost {
  purchase: string;
  repair: string;
  consumable: string;
  upgrade: string;
  otherCost: string;
  investedCost: string;
  recoveredCost: string;
  grossCost: string;
  currentResidual?: string;
  currentValuation?: string;
  salePrice?: string;
  netCost: string;
  heldDays: number;
  perDay: string;
  usageCosts: FixedUsageCost[];
  basis: 'current' | 'final';
}

export function fixedUsageUnitLabel(metric: Pick<FixedAssetUsageMetric, 'unit' | 'customUnit'>): string {
  if (metric.unit === 'day') return '天';
  if (metric.unit === 'count') return '次';
  if (metric.unit === 'km') return '公里';
  if (metric.unit === 'hour') return '小时';
  return metric.customUnit?.trim() || '单位';
}

export function fixedUsageTotal(metric: FixedAssetUsageMetric, logs: FixedAssetUsageLog[]): string {
  const rows = logs
    .filter((log) => !log.isDeleted && log.metricId === metric.id)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  let total = D(0);
  let meter = D(metric.startValue || 0);
  for (const row of rows) {
    const value = D(row.value || 0);
    if (row.entryMode === 'meter') {
      const delta = value.minus(meter);
      if (delta.gt(0)) total = total.plus(delta);
      meter = value;
    } else if (value.gt(0)) {
      total = total.plus(value);
    }
  }
  return total.toString();
}

export function fixedAssetCost(
  asset: FixedAsset,
  events: FixedAssetEvent[],
  options: string | FixedAssetCostOptions = {},
): FixedAssetCost {
  const opts = typeof options === 'string' ? { asOf: options } : options;
  const asOf = opts.asOf ?? localToday();
  const evs = events
    .filter((event) => event.fixedAssetId === asset.id && !event.isDeleted && event.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const consumables = (opts.consumables ?? [])
    .filter((item) => item.fixedAssetId === asset.id && !item.isDeleted && item.purchaseDate <= asOf);
  const bucket = (type: FixedEventType) => sum(evs.filter((event) => event.type === type).map((event) => event.amountBase));
  const purchase = bucket('purchase');
  const repair = bucket('repair');
  const upgrade = bucket('upgrade');
  const consumable = sum(consumables.map((item) => item.amountBase));
  const eventCosts = sum(evs.filter((event) => COST_TYPES.has(event.type)).map((event) => event.amountBase));
  const investedCost = eventCosts.plus(consumable);
  const recoveredCost = bucket('part_sale').plus(bucket('sale'));

  const residualEvents = evs.filter((event) => event.type === 'residual_update');
  const currentResidual = residualEvents.length ? D(residualEvents.at(-1)!.amountBase) : undefined;
  const terminalEvent = evs.filter((event) => TERMINAL_TYPES.has(event.type)).at(-1);
  const salePrice = terminalEvent?.type === 'sale' ? D(terminalEvent.amountBase) : undefined;
  // Current status has no effective date, so it cannot determine an explicit
  // historical snapshot. In that mode only terminal events on/before asOf are
  // authoritative.
  const final = !!terminalEvent
    || (opts.asOf === undefined && ['sold', 'scrapped', 'retired', 'gifted'].includes(asset.status));
  // Reference value is informational; only recorded proceeds reduce net investment.
  const netCost = investedCost.minus(recoveredCost);
  const endDate = terminalEvent?.date ?? asOf;
  const days = heldDays(asset.activatedDate ?? asset.purchaseDate, endDate);

  const usageCosts: FixedUsageCost[] = [{
    name: '持有时间',
    unit: 'day',
    unitLabel: '天',
    totalUsage: String(days),
    perUnit: safeDiv(netCost, days).toString(),
  }];
  for (const metric of (opts.usageMetrics ?? []).filter((row) => row.fixedAssetId === asset.id && row.isActive && !row.isDeleted)) {
    const totalUsage = fixedUsageTotal(metric, (opts.usageLogs ?? []).filter((row) => row.date <= asOf));
    usageCosts.push({
      metricId: metric.id,
      name: metric.name,
      unit: metric.unit,
      unitLabel: fixedUsageUnitLabel(metric),
      totalUsage,
      perUnit: safeDiv(netCost, totalUsage).toString(),
    });
  }

  const result: FixedAssetCost = {
    purchase: purchase.toString(),
    repair: repair.toString(),
    consumable: consumable.toString(),
    upgrade: upgrade.toString(),
    otherCost: '0',
    investedCost: investedCost.toString(),
    recoveredCost: recoveredCost.toString(),
    grossCost: investedCost.toString(),
    netCost: netCost.toString(),
    heldDays: days,
    perDay: safeDiv(netCost, days).toString(),
    usageCosts,
    basis: final ? 'final' : 'current',
  };
  if (currentResidual !== undefined) {
    result.currentResidual = currentResidual.toString();
    // The fixed-asset model has no independent market marks, so valuation uses
    // the latest residual book value available at the requested cutoff.
    result.currentValuation = currentResidual.toString();
  }
  if (salePrice !== undefined) result.salePrice = salePrice.toString();
  return result;
}

export interface FixedGoalProgress {
  currentUsage: string;
  targetUsage: string;
  currentUnitCost: string;
  progress: string;
  achieved: boolean;
}

export function fixedGoalProgress(
  goal: FixedAssetGoal,
  asset: FixedAsset,
  events: FixedAssetEvent[],
  metrics: FixedAssetUsageMetric[],
  logs: FixedAssetUsageLog[],
  asOf: string = localToday(),
): FixedGoalProgress {
  const terminal = events
    .filter((event) => event.fixedAssetId === asset.id && TERMINAL_TYPES.has(event.type) && !event.isDeleted && event.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  let current = D(0);
  if (goal.unit === 'day') {
    current = D(heldDays(goal.startDate || asset.activatedDate || asset.purchaseDate, terminal?.date ?? asOf));
  } else {
    const metric = metrics.find((row) => row.id === goal.metricId);
    if (metric) current = D(fixedUsageTotal(metric, logs.filter((row) => row.date <= asOf)));
  }
  const target = D(goal.targetUsage || 0);
  return {
    currentUsage: current.toString(),
    targetUsage: target.toString(),
    currentUnitCost: safeDiv(goal.costBasisAmount, current).toString(),
    progress: target.gt(0) ? (current.div(target).gt(1) ? '1' : current.div(target).toString()) : '0',
    achieved: target.gt(0) && current.gte(target),
  };
}

export function fixedConsumableRemaining(
  consumable: FixedAssetConsumable,
  metrics: FixedAssetUsageMetric[],
  logs: FixedAssetUsageLog[],
): string | undefined {
  if (!consumable.installedDate || !consumable.usageMetricId || !consumable.targetLife) return undefined;
  const metric = metrics.find((row) => row.id === consumable.usageMetricId);
  if (!metric) return undefined;
  const current = D(fixedUsageTotal(metric, logs));
  const installed = D(consumable.installedAtUsage || 0);
  return D(consumable.targetLife).minus(current.minus(installed)).toString();
}
