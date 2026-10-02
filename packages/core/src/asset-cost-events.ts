import { D, sum } from './decimal.js';
import { canonicalJson } from './crypto.js';
import { conversionStepAmounts } from './conversion.js';
import { normalizeOccurrence } from './time.js';
import { accountChainPostings, accountOpeningPostings, accountTransactionPostings } from './account-ledger.js';
import type { Account, ChainWithSteps, ConversionStep, Transaction } from './types.js';
import type { AssetCostEvent, ConversionCostQuote, CostBasisOpening, CostQuoteSnapshot } from './asset-cost.js';

export function conversionFinancialFingerprint({ chain, steps }: ChainWithSteps): string {
  return canonicalJson({ date: chain.date, time: chain.time ?? null, timezone: chain.timezone ?? null,
    type: chain.type, baseCurrencyAssetId: chain.baseCurrencyAssetId, bookValueInBase: chain.bookValueInBase ?? null,
    lotMethod: chain.lotMethod ?? 'fifo', manualLotIds: chain.manualLotIds ?? [], costQuotes: chain.costQuotes ?? null,
    operationId: chain.operationId ?? null, operationOrder: chain.operationOrder ?? null,
    steps: [...steps].sort((a, b) => a.order - b.order).map((step) => ({ id: step.id, chainId: step.chainId, order: step.order,
      fromAssetId: step.fromAssetId, fromAmount: D(step.fromAmount).toString(), toAssetId: step.toAssetId, toAmount: D(step.toAmount).toString(),
      accountFromId: step.accountFromId ?? null, accountToId: step.accountToId ?? null, referenceRate: step.referenceRate ?? null,
      sourceAmountMode: step.sourceAmountMode ?? 'trade_principal', targetAmountMode: step.targetAmountMode ?? 'account_credit',
      fees: (step.fees ?? []).map((fee) => ({ id: fee.id, assetId: fee.assetId, amount: D(fee.amount).toString(), treatment: fee.treatment,
        valueInBase: fee.valueInBase ?? null, valueEvidence: fee.valueEvidence ?? null, accountId: fee.accountId ?? null })) })) });
}

/** Only economic dependencies: editing labels must not invalidate evidence. */
export function conversionCostFingerprint(step: ConversionStep, occurredAtUtc: string, baseCurrencyAssetId: string): string {
  return canonicalJson({ occurredAtUtc, baseCurrencyAssetId, fromAssetId: step.fromAssetId, fromAmount: step.fromAmount,
    toAssetId: step.toAssetId, toAmount: step.toAmount,
    fees: (step.fees ?? []).map(({ id, assetId, amount, treatment }) => ({ id, assetId, amount, treatment })) });
}

export function transactionCostFingerprint(transaction: Transaction, baseCurrencyAssetId: string): string {
  return canonicalJson({ baseCurrencyAssetId, occurredAtUtc: transaction.occurredAtUtc ?? null, date: transaction.date,
    type: transaction.type, amount: transaction.amount, assetId: transaction.assetId,
    transferAmount: transaction.transferAmount ?? null, transferAssetId: transaction.transferAssetId ?? null,
    adjustmentDirection: transaction.adjustmentDirection ?? null });
}

export function quoteIsCurrent(quote: CostQuoteSnapshot | undefined, fingerprint: string, baseId: string): boolean {
  return !!quote && quote.baseCurrencyAssetId === baseId && quote.dependencyFingerprint === fingerprint;
}

/** Explicitly called on adoption/confirmation, never from replay. */
export function freezeConversionQuote(step: ConversionStep, occurredAtUtc: string, baseCurrencyAssetId: string,
  evidence?: Pick<CostQuoteSnapshot, 'valueInBase' | 'source' | 'priceMarkIds' | 'quoteDate' | 'explanation'>): ConversionCostQuote {
  const transactionValue = step.fromAssetId === baseCurrencyAssetId ? step.fromAmount
    : step.toAssetId === baseCurrencyAssetId ? step.toAmount : null;
  return { stepId: step.id, baseCurrencyAssetId,
    ...(evidence ?? { valueInBase: transactionValue, source: transactionValue === null ? 'unknown' : 'transaction', priceMarkIds: [] }),
    dependencyFingerprint: conversionCostFingerprint(step, occurredAtUtc, baseCurrencyAssetId),
    feeValues: (step.fees ?? []).map((fee) => {
      const valueInBase = fee.assetId === baseCurrencyAssetId ? fee.amount : fee.valueInBase ?? null;
      const evidence: CostQuoteSnapshot = { baseCurrencyAssetId, valueInBase,
        dependencyFingerprint: conversionCostFingerprint(step, occurredAtUtc, baseCurrencyAssetId),
        ...(fee.assetId === baseCurrencyAssetId ? { source: 'transaction' as const, priceMarkIds: [] }
          : valueInBase === null ? { source: 'unknown' as const, priceMarkIds: [] }
          : fee.valueEvidence ?? { source: 'manual' as const, priceMarkIds: [], explanation: '用户确认手续费折算' }) };
      return { feeId: fee.id, valueInBase, evidence };
    }) };
}

function plusNullable(...values: (string | null)[]): string | null {
  return values.some((value) => value === null) ? null : sum(values as string[]).toString();
}

export interface CostEventIssue { sourceId: string; assetIds: string[]; code: 'stale_quote' | 'ambiguous_time'; }
export interface CostEventInput {
  asOfUtc?: string;
  accounts?: readonly Account[];
  opening: CostBasisOpening;
  chains: readonly ChainWithSteps[];
  transactions: readonly Transaction[];
  /** Ledger timezone, never the current device timezone. */
  timezone: string;
}

export function buildAssetCostEvents(input: CostEventInput): { events: AssetCostEvent[]; issues: CostEventIssue[] } {
  const { opening } = input;
  const baseId = opening.baseCurrencyAssetId;
  const events: AssetCostEvent[] = [];
  const issues: CostEventIssue[] = [];
  const accounts = input.accounts ? [...input.accounts] : undefined;
  for (const posting of accountOpeningPostings(accounts ?? [])) {
    const account = accounts!.find((row) => row.id === posting.accountId)!;
    if (account.kind === 'other' || Date.parse(account.balanceStartAt!) <= Date.parse(opening.occurredAtUtc)
      || (input.asOfUtc && Date.parse(account.balanceStartAt!) > Date.parse(input.asOfUtc))) continue;
    events.push({ id: `account:${account.id}:opening`, sourceKind: 'adjustment', sourceId: account.id,
      occurredAtUtc: account.balanceStartAt!, orderKey: `0:${account.id}`, kind: D(posting.amount).lt(0) ? 'dispose' : 'acquire',
      assetId: posting.assetId, quantity: D(posting.amount).abs().toString(), valueInBase: null, realize: false });
  }
  for (const item of opening.items) {
    events.push({ id: `${opening.id}:${item.id}`, sourceKind: 'opening', sourceId: opening.id,
      occurredAtUtc: opening.occurredAtUtc, acquiredAtUtc: item.acquiredAtUtc, orderKey: `0:${item.id}`,
      kind: D(item.quantity).lt(0) ? 'dispose' : 'acquire', assetId: item.assetId,
      quantity: D(item.quantity).abs().toString(), valueInBase: item.costInBase, realize: false });
  }
  function instant(row: Transaction | ChainWithSteps['chain'], assetIds: string[]): string | null {
    if (input.asOfUtc && row.occurredAtUtc && Date.parse(row.occurredAtUtc) > Date.parse(input.asOfUtc)) return null;
    if (row.occurredAtUtc) return Date.parse(row.occurredAtUtc) > Date.parse(opening.occurredAtUtc) ? row.occurredAtUtc : null;
    const start = normalizeOccurrence({ date: row.date, time: '00:00:00', timezone: row.timezone ?? input.timezone }).occurredAtUtc!;
    const end = normalizeOccurrence({ date: row.date, time: '23:59:59', timezone: row.timezone ?? input.timezone }).occurredAtUtc!;
    if (input.asOfUtc && Date.parse(start) > Date.parse(input.asOfUtc)) return null;
    if (Date.parse(end) <= Date.parse(opening.occurredAtUtc)) return null;
    // A day-only record cannot be placed relative to a snapshot or another
    // intraday operation by inventing an acquisition/sale order.
    issues.push({ sourceId: row.id, assetIds, code: 'ambiguous_time' });
    return Date.parse(start) > Date.parse(opening.occurredAtUtc) ? start : null;
  }
  for (const { chain, steps } of input.chains) {
    if (chain.isDeleted || chain.recordState === 'voided') continue;
    const occurredAtUtc = instant(chain, [...new Set(steps.flatMap((step) => [step.fromAssetId, step.toAssetId, ...(step.fees ?? []).map((fee) => fee.assetId)]))]);
    if (!occurredAtUtc) continue;
    for (const step of [...steps].sort((a, b) => a.order - b.order)) {
      const postings = accounts ? accountChainPostings({ chain, steps: [step] }, accounts) : undefined;
      const fingerprint = conversionCostFingerprint(step, occurredAtUtc, baseId);
      const saved = chain.costQuotes?.find((quote) => quote.stepId === step.id);
      const quote = quoteIsCurrent(saved, fingerprint, baseId) ? saved : undefined;
      if (saved && !quote) issues.push({ sourceId: chain.id, assetIds: [step.fromAssetId, step.toAssetId], code: 'stale_quote' });
      // Real base-currency movements are facts; all other valuations require a snapshot.
      const principalValue = quote?.valueInBase ?? (step.fromAssetId === baseId ? step.fromAmount : step.toAssetId === baseId ? step.toAmount : null);
      const feeValue = (fee: NonNullable<ConversionStep['fees']>[number]): string | null => fee.assetId === baseId
        ? fee.amount : quote?.feeValues.find((row) => row.feeId === fee.id)?.valueInBase ?? null;
      const fees = step.fees ?? [];
      const sourceFees = plusNullable(...fees.filter((fee) => fee.treatment.startsWith('source_')).map(feeValue));
      const targetFees = plusNullable(...fees.filter((fee) => fee.treatment === 'target_deducted').map(feeValue));
      const thirdFees = plusNullable(...fees.filter((fee) => fee.treatment === 'third_asset_extra').map(feeValue));
      const amounts = conversionStepAmounts(step);
      const prefix = `1:${chain.operationId ?? chain.id}:${String(chain.operationOrder ?? 0).padStart(8, '0')}:${String(step.order).padStart(8, '0')}`;
      const add = (leg: string, assetId: string, kind: AssetCostEvent['kind'], quantity: string, valueInBase: string | null, realize: boolean) => {
        if (postings && !postings.some((posting) => posting.assetId === assetId && (kind === 'dispose' ? D(posting.amount).lt(0) : D(posting.amount).gt(0)))) return;
        events.push({ id: `${step.id}:${leg}`, sourceKind: 'conversion', sourceId: chain.id, occurredAtUtc,
          orderKey: `${prefix}:${leg}`, kind, assetId, quantity, valueInBase, realize,
          method: chain.lotMethod, selectedLotIds: chain.manualLotIds });
      };
      if (step.fromAssetId === step.toAssetId) {
        const movement = postings?.filter((posting) => posting.assetId === step.fromAssetId);
        if (movement?.length === 1) {
          const posting = movement[0]!;
          add('0-external', posting.assetId, D(posting.amount).lt(0) ? 'dispose' : 'acquire', D(posting.amount).abs().toString(), principalValue, D(posting.amount).lt(0));
        } else {
        const feeQuantity = D(amounts.sourceDebit).minus(amounts.targetCredit);
        if (feeQuantity.lt(0)) throw new Error('同币种转移不能增加总资产数量');
        add('0-fees', step.fromAssetId, 'dispose', feeQuantity.toString(), plusNullable(sourceFees, targetFees), true);
        }
      } else if (chain.type === 'sell') {
        const netValue = principalValue === null || targetFees === null || thirdFees === null ? null
          : D(principalValue).minus(targetFees).minus(thirdFees).toString();
        if (netValue !== null && D(netValue).lt(0)) throw new Error('卖出手续费不能超过成交价值');
        add('0-source', step.fromAssetId, 'dispose', amounts.sourceDebit, netValue, true);
        add('2-target', step.toAssetId, 'acquire', amounts.targetCredit,
          principalValue === null || targetFees === null ? null : D(principalValue).minus(targetFees).toString(), false);
      } else {
        add('0-source', step.fromAssetId, 'dispose', amounts.sourceDebit, plusNullable(principalValue, sourceFees), true);
        add('2-target', step.toAssetId, 'acquire', amounts.targetCredit, plusNullable(principalValue, sourceFees, thirdFees), false);
      }
      for (const fee of fees.filter((row) => row.treatment === 'third_asset_extra')) {
        add(`1-fee:${fee.id}`, fee.assetId, 'dispose', fee.amount, feeValue(fee), true);
      }
    }
  }
  for (const transaction of input.transactions) {
    if (transaction.isDeleted || transaction.recordState === 'voided') continue;
    const occurredAtUtc = instant(transaction, [transaction.assetId, transaction.transferAssetId ?? transaction.assetId]);
    if (!occurredAtUtc) continue;
    const postings = accounts ? accountTransactionPostings(transaction, accounts) : undefined;
    const fingerprint = transactionCostFingerprint(transaction, baseId);
    const quote = quoteIsCurrent(transaction.costQuote, fingerprint, baseId) ? transaction.costQuote : undefined;
    if (transaction.costQuote && !quote) issues.push({ sourceId: transaction.id, assetIds: [transaction.assetId], code: 'stale_quote' });
    const value = transaction.assetId === baseId ? transaction.amount : quote?.valueInBase ?? null;
    const add = (leg: string, assetId: string, kind: AssetCostEvent['kind'], quantity: string, valueInBase: string | null, realize: boolean) => {
      if (postings && !postings.some((posting) => posting.assetId === assetId && (kind === 'dispose' ? D(posting.amount).lt(0) : D(posting.amount).gt(0)))) return;
      events.push({ id: `${transaction.id}:${leg}`, sourceKind: 'transaction', sourceId: transaction.id,
        occurredAtUtc, orderKey: `1:${transaction.id}:${leg}`, kind, assetId, quantity, valueInBase, realize,
        refundSourceId: transaction.refundForId });
    };
    if (transaction.type === 'transfer') {
      const targetId = transaction.transferAssetId ?? transaction.assetId;
      const targetAmount = transaction.transferAmount ?? transaction.amount;
      if (targetId === transaction.assetId) {
        if (postings && postings.length === 1) {
          const posting = postings[0]!;
          add('0-external', posting.assetId, D(posting.amount).lt(0) ? 'dispose' : 'acquire', D(posting.amount).abs().toString(), value, D(posting.amount).lt(0));
          continue;
        }
        const difference = D(transaction.amount).minus(targetAmount);
        if (difference.gt(0)) add('0-fee', transaction.assetId, 'dispose', difference.toString(), null, true);
        else if (difference.lt(0)) add('1-extra', targetId, 'acquire', difference.negated().toString(), null, false);
      } else {
        const tradeValue = targetId === baseId ? targetAmount : value;
        add('0-source', transaction.assetId, 'dispose', transaction.amount, tradeValue, true);
        add('1-target', targetId, 'acquire', targetAmount, tradeValue, false);
      }
    } else if (transaction.type === 'refund') add('0-refund', transaction.assetId, 'refund', transaction.amount, null, false);
    else if (transaction.type === 'income' || (transaction.type === 'adjustment' && transaction.adjustmentDirection === 'increase')) {
      add('0-in', transaction.assetId, 'acquire', transaction.amount, value, false);
    } else add('0-out', transaction.assetId, 'dispose', transaction.amount, value, transaction.type === 'expense');
  }
  return { events, issues };
}
