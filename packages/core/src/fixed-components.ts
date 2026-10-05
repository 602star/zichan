import { D, safeDiv } from './decimal.js';
import { fixedAssetCost, type FixedAssetCost, type FixedAssetCostOptions } from './fixed.js';
import { localToday } from './dates.js';
import type { FixedAsset, FixedAssetEvent } from './types.js';

/** The latest installation determines the cost owner; detaching does not erase historical spending. */
export function componentHostAt(componentId: string, events: readonly FixedAssetEvent[], asOf: string): string | undefined {
  if (events.some((row) => !row.isDeleted && row.fixedAssetId === componentId
    && ['sale', 'scrap', 'retire', 'gift'].includes(row.type) && row.date <= asOf)) return undefined;
  const placement = events
    .filter((row) => !row.isDeleted && row.fixedAssetId === componentId
      && (row.type === 'install' || row.type === 'detach') && row.date <= asOf)
    .sort((left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  return placement?.type === 'install' ? placement.hostAssetId : undefined;
}

export function componentCostOwnerAt(component: FixedAsset, events: readonly FixedAssetEvent[], asOf: string): string | undefined {
  if (component.role !== 'component') return undefined;
  if (component.bundledFromAssetId) return component.bundledFromAssetId;
  return events
    .filter((row) => !row.isDeleted && row.fixedAssetId === component.id && row.type === 'install' && row.date <= asOf)
    .sort((left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1)?.hostAssetId;
}

/** Assign recorded component spending and recovery to one host without making another cash flow. */
export function fixedAssetAttributedCost(
  asset: FixedAsset,
  assets: readonly FixedAsset[],
  events: FixedAssetEvent[],
  options: FixedAssetCostOptions = {},
): FixedAssetCost {
  const own = fixedAssetCost(asset, events, options);
  if (asset.role === 'component') return own;
  const asOf = options.asOf ?? localToday();
  const components = assets.filter((row) => !row.isDeleted && row.role === 'component'
    && row.baseCurrencyAssetId === asset.baseCurrencyAssetId
    && componentCostOwnerAt(row, events, asOf) === asset.id);
  if (!components.length) return own;
  const costs = components.map((row) => fixedAssetCost(row, events, { asOf, consumables: options.consumables }));
  const invested = costs.reduce((total, cost) => total.plus(cost.investedCost), D(own.investedCost));
  const recovered = costs.reduce((total, cost) => total.plus(cost.recoveredCost), D(own.recoveredCost));
  const net = invested.minus(recovered);
  return {
    ...own,
    investedCost: invested.toString(),
    grossCost: invested.toString(),
    recoveredCost: recovered.toString(),
    netCost: net.toString(),
    perDay: safeDiv(net, own.heldDays).toString(),
    usageCosts: own.usageCosts.map((row) => ({ ...row, perUnit: safeDiv(net, row.totalUsage).toString() })),
  };
}
