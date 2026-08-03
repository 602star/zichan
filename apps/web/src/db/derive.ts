/** Derived read-models shared by screens — all computed via @zichan/core. */
import {
  postingsFromChain, postingsFromTransaction, computeBalances, latestPrices, D,
  type Asset, type Balance, type Posting,
} from '@zichan/core';
import type { Snapshot } from './snapshot.js';

export function assetById(snap: Snapshot): Map<string, Asset> {
  return new Map(snap.assets.map((a) => [a.id, a]));
}

export function assetByCode(snap: Snapshot, code: string): Asset | undefined {
  return snap.assets.find((a) => a.code === code);
}

export function baseAsset(snap: Snapshot): Asset | undefined {
  return (
    snap.assets.find((a) => a.id === snap.setting?.baseCurrencyAssetId) ??
    assetByCode(snap, 'GBP')
  );
}

/** Ids of equity/opening accounts (kind 'other') — excluded from cash balances. */
function externalAccountIds(snap: Snapshot): Set<string> {
  return new Set(snap.accounts.filter((a) => a.kind === 'other').map((a) => a.id));
}

/** Postings that move financial value. Game settlement is represented by its
 * linked or module-created transaction, never posted directly by a game record. */
export function financialPostings(snap: Snapshot): Posting[] {
  const external = externalAccountIds(snap);
  const out: Posting[] = [];
  for (const c of snap.chains) out.push(...postingsFromChain(c));
  for (const t of snap.transactions) out.push(...postingsFromTransaction(t));
  return out.filter((p) => !(p.accountId && external.has(p.accountId)));
}

export function balances(snap: Snapshot): Balance[] {
  return computeBalances(financialPostings(snap));
}

export function balanceOfAsset(snap: Snapshot, assetId: string): string {
  return balances(snap).find((b) => b.assetId === assetId)?.amount ?? '0';
}

/** Latest price of an asset in the base currency (1 for the base itself). */
export function priceInBase(snap: Snapshot, assetId: string): string | undefined {
  const base = baseAsset(snap);
  if (!base) return undefined;
  return latestPrices(snap.priceMarks, base.id).get(assetId);
}

export function isZeroish(v: string): boolean {
  return D(v).abs().lt('0.0000001');
}
