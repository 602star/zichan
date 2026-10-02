/**
 * Balance engine (§2). Every entity that moves value generates signed postings;
 * balances are the aggregation of postings, never read directly off entities.
 * This is what makes the fee/sign conventions (§0.2, §0.3) unambiguous.
 */
import { D, sum, type Numeric } from './decimal.js';
import { conversionStepAmounts } from './conversion.js';
import type {
  ChainWithSteps,
  ConversionStep,
  GameRecord,
  Transaction,
} from './types.js';

export interface Posting {
  assetId: string;
  accountId?: string;
  /** Signed amount as a decimal string: '+' in, '−' out. */
  amount: string;
  source: { kind: string; id: string };
  date: string;
}

function push(
  out: Posting[],
  date: string,
  source: Posting['source'],
  assetId: string,
  amount: Numeric,
  accountId?: string,
): void {
  const a = D(amount);
  if (a.isZero()) return;
  out.push({ assetId, accountId, amount: a.toString(), source, date });
}

/**
 * Postings for one normalized conversion step: actual source account decrease,
 * actual target account increase, plus fees paid from an independent asset.
 */
export function postingsFromStep(
  step: ConversionStep,
  date: string,
): Posting[] {
  const out: Posting[] = [];
  const src = { kind: 'conversion_step', id: step.id };

  const amounts = conversionStepAmounts(step);
  push(out, date, src, step.fromAssetId, D(amounts.sourceDebit).negated(), step.accountFromId);
  push(out, date, src, step.toAssetId, amounts.targetCredit, step.accountToId);

  for (const fee of step.fees ?? []) {
    if (fee.treatment === 'third_asset_extra') {
      push(out, date, src, fee.assetId, D(fee.amount).negated(), fee.accountId);
    }
  }
  return out;
}

export function postingsFromChain(cws: ChainWithSteps): Posting[] {
  if (cws.chain.isDeleted || cws.chain.recordState === 'voided') return [];
  const out: Posting[] = [];
  for (const step of [...cws.steps].sort((a, b) => a.order - b.order)) {
    out.push(...postingsFromStep(step, cws.chain.date));
  }
  return out;
}

/**
 * Postings for a game record's *settlement* leg only. The game currency itself
 * is NOT posted to the balance engine (record-flow model, §3.3) — its reference
 * balance is computed separately in game.ts.
 */
const GAME_INCOME_TYPES = new Set([
  'sell_currency',
  'sell_equipment',
  'sell_material',
  'withdraw',
  'other_income',
]);
const GAME_EXPENSE_TYPES = new Set([
  'buy_currency',
  'buy_equipment',
  'buy_material',
  'topup',
  'account_cost',
  'boosting_cost',
  'fee',
  'other_expense',
]);

export function gameRecordReportingPostings(r: GameRecord): Posting[] {
  const out: Posting[] = [];
  const src = { kind: 'game_record', id: r.id };
  if (r.settlementAssetId && r.settlementAmount && !D(r.settlementAmount).isZero()) {
    const mag = D(r.settlementAmount).abs();
    const signed = GAME_INCOME_TYPES.has(r.recordType)
      ? mag
      : GAME_EXPENSE_TYPES.has(r.recordType)
        ? mag.negated()
        : D(0); // produce/consume have no settlement flow
    push(out, r.date, src, r.settlementAssetId, signed);
  }
  if (r.feeAssetId && r.feeAmount && !D(r.feeAmount).isZero()) {
    push(out, r.date, src, r.feeAssetId, D(r.feeAmount).negated());
  }
  return out;
}

/**
 * Game records never post directly to financial balances. Settlement and fee
 * legs must be represented by linked or module-created daily transactions.
 */
export function postingsFromGameRecord(_record: GameRecord): Posting[] {
  return [];
}

/**
 * Postings for a daily transaction (§2):
 *  - income: +amount (credit the asset)
 *  - expense: -amount (debit the asset)
 *  - transfer: -amount from source, +transferAmount to target
 *  - adjustment: explicit account increase/decrease, excluded from income/expense reports
 */
export function postingsFromTransaction(t: Transaction): Posting[] {
  const out: Posting[] = [];
  const src = { kind: 'transaction', id: t.id };

  if (t.isDeleted || t.recordState === 'voided' || D(t.amount).isZero()) return out;

  const mag = D(t.amount).abs();
  if (t.type === 'transfer') {
    push(out, t.date, src, t.assetId, mag.negated(), t.accountId);
    push(out, t.date, src, t.transferAssetId ?? t.assetId, D(t.transferAmount ?? t.amount).abs(), t.transferAccountId);
    return out;
  }

  if (t.type === 'adjustment') {
    const signed = t.adjustmentDirection === 'decrease' ? mag.negated() : mag;
    push(out, t.date, src, t.assetId, signed, t.accountId);
    return out;
  }

  const signed = t.type === 'expense' ? mag.negated() : mag;

  push(out, t.date, src, t.assetId, signed, t.accountId);

  return out;
}

export interface BalanceKey {
  assetId: string;
  accountId?: string;
}

export interface Balance extends BalanceKey {
  amount: string;
}

/** Aggregate postings into net balances, optionally split per account. */
export function computeBalances(
  postings: Posting[],
  opts: { perAccount?: boolean } = {},
): Balance[] {
  const map = new Map<string, { key: BalanceKey; vals: string[] }>();
  for (const p of postings) {
    const key = opts.perAccount
      ? `${p.assetId}\0${p.accountId ?? ''}`
      : p.assetId;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        key: { assetId: p.assetId, accountId: opts.perAccount ? p.accountId : undefined },
        vals: [],
      };
      map.set(key, entry);
    }
    entry.vals.push(p.amount);
  }
  return [...map.values()].map((e) => ({
    ...e.key,
    amount: sum(e.vals).toString(),
  }));
}

/** Convenience: net balance of a single asset across all postings. */
export function balanceOf(postings: Posting[], assetId: string): string {
  return sum(postings.filter((p) => p.assetId === assetId).map((p) => p.amount)).toString();
}
