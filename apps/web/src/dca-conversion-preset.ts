import type { Asset, DcaPlan } from '@zichan/core';

export interface DcaConversionPreset {
  planId: string;
  title: string;
  bookCurrencyAssetId: string;
  plannedAmount: string;
  assetPathIds: string[];
  pathWarning?: string;
}

function activeAssets(assets: Asset[]): Asset[] {
  return assets.filter((asset) => !asset.isDeleted && asset.isActive);
}

/** Resolve a human-authored code path only when every code is unique and endpoints match the plan. */
export function buildDcaConversionPreset(plan: DcaPlan, assets: Asset[]): DcaConversionPreset {
  const available = activeAssets(assets);
  const byId = new Map(available.map((asset) => [asset.id, asset]));
  const base = byId.get(plan.baseCurrencyAssetId);
  const target = byId.get(plan.targetAssetId);
  if (!base || !target) throw new Error('定投计划引用的来源或目标资产不可用');
  if (base.id === target.id) throw new Error('定投计划的来源和目标资产不能相同');

  const fallback = [base.id, target.id];
  const rawPath = plan.defaultPath?.trim();
  if (!rawPath) {
    return {
      planId: plan.id,
      title: plan.name,
      bookCurrencyAssetId: base.id,
      plannedAmount: plan.plannedAmount,
      assetPathIds: fallback,
    };
  }

  const tokens = rawPath.split(/\s*(?:->|→|⇒|>)\s*/).filter(Boolean);
  const ids: string[] = [];
  let valid = tokens.length >= 2;
  for (const token of tokens) {
    const matches = available.filter((asset) => asset.code.toLocaleLowerCase() === token.toLocaleLowerCase());
    if (matches.length !== 1) {
      valid = false;
      break;
    }
    ids.push(matches[0]!.id);
  }
  valid = valid
    && ids[0] === base.id
    && ids.at(-1) === target.id
    && ids.every((id, index) => index === 0 || id !== ids[index - 1]);

  return {
    planId: plan.id,
    title: plan.name,
    bookCurrencyAssetId: base.id,
    plannedAmount: plan.plannedAmount,
    assetPathIds: valid ? ids : fallback,
    pathWarning: valid
      ? undefined
      : `默认路径“${rawPath}”无法唯一匹配可用资产，已安全回退为 ${base.code} → ${target.code}`,
  };
}
