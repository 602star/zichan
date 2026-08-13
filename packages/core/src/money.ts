import { D } from './decimal.js';

export interface Money {
  amount: string;
  assetId: string;
}

export function money(amount: string | number, assetId: string): Money {
  if (!assetId) throw new Error('金额必须指定币种');
  return { amount: D(amount).toString(), assetId };
}

/** Sum only homogeneous money. Mixed currencies must be grouped or converted first. */
export function sumMoney(values: Money[], assetId?: string): Money {
  const target = assetId ?? values[0]?.assetId;
  if (!target) throw new Error('金额求和必须指定币种');
  let total = D(0);
  for (const value of values) {
    if (value.assetId !== target) throw new Error(`禁止跨币种直接相加：${target} 与 ${value.assetId}`);
    total = total.plus(value.amount);
  }
  return { amount: total.toString(), assetId: target };
}

export function groupMoney(values: Money[]): Map<string, Money> {
  const groups = new Map<string, Money[]>();
  for (const value of values) {
    const prev = groups.get(value.assetId);
    if (prev) prev.push(value);
    else groups.set(value.assetId, [value]);
  }
  return new Map([...groups].map(([assetId, rows]) => [assetId, sumMoney(rows, assetId)]));
}

