/**
 * Conversion normalization and cost tracing. Stored steps keep trade principal
 * and gross output; account movements, net receipts, and actual rates are
 * derived from explicit fee rows so the ledger has one source of truth.
 */
import { D, safeDiv, sum } from './decimal.js';
import type {
  ChainWithSteps,
  ConversionFee,
  ConversionSourceAmountMode,
  ConversionStep,
  ConversionTargetAmountMode,
} from './types.js';

export interface ConversionStepAmounts {
  sourcePrincipal: string;
  sourceDebit: string;
  targetGross: string;
  targetCredit: string;
  sourceFees: string;
  targetFees: string;
  tradeRate?: string;
  effectiveRate?: string;
}

export interface NormalizeConversionAmountsInput {
  fromInput: string;
  toInput: string;
  sourceAmountMode: ConversionSourceAmountMode;
  targetAmountMode: ConversionTargetAmountMode;
  fees: ConversionFee[];
}

/** Turn the two user-facing amount inputs into canonical principal/gross values. */
export function normalizeConversionAmounts(input: NormalizeConversionAmountsInput): {
  fromAmount: string;
  toAmount: string;
} {
  const fromInput = D(input.fromInput || 0);
  const toInput = D(input.toInput || 0);
  const sourceIncluded = sum(input.fees
    .filter((fee) => fee.treatment === 'source_included')
    .map((fee) => fee.amount));
  const targetDeductions = sum(input.fees
    .filter((fee) => fee.treatment === 'target_deducted')
    .map((fee) => fee.amount));
  const principal = input.sourceAmountMode === 'account_debit'
    ? fromInput.minus(sourceIncluded)
    : fromInput;
  const gross = input.targetAmountMode === 'account_credit'
    ? toInput.plus(targetDeductions)
    : toInput;
  if (principal.lte(0)) throw new Error('来源实扣必须大于已包含的来源手续费');
  if (gross.lte(0)) throw new Error('目标成交毛额必须大于 0');
  return { fromAmount: principal.toString(), toAmount: gross.toString() };
}

/** Derive actual account movements and both rates from a normalized step. */
export function conversionStepAmounts(step: ConversionStep): ConversionStepAmounts {
  const fees = step.fees ?? [];
  const sourceFees = sum(fees
    .filter((fee) => fee.treatment === 'source_included' || fee.treatment === 'source_extra')
    .map((fee) => fee.amount));
  const targetFees = sum(fees
    .filter((fee) => fee.treatment === 'target_deducted')
    .map((fee) => fee.amount));
  const principal = D(step.fromAmount);
  const gross = D(step.toAmount);
  const sourceDebit = principal.plus(sourceFees);
  const targetCredit = gross.minus(targetFees);
  if (targetCredit.lt(0)) throw new Error('目标手续费不能超过成交毛额');
  const out: ConversionStepAmounts = {
    sourcePrincipal: principal.toString(),
    sourceDebit: sourceDebit.toString(),
    targetGross: gross.toString(),
    targetCredit: targetCredit.toString(),
    sourceFees: sourceFees.toString(),
    targetFees: targetFees.toString(),
  };
  if (principal.gt(0)) out.tradeRate = safeDiv(gross, principal).toString();
  if (sourceDebit.gt(0)) out.effectiveRate = safeDiv(targetCredit, sourceDebit).toString();
  return out;
}

export interface ChainTrace {
  baseCurrencyAssetId: string;
  finalAssetId: string;
  /** Net amount credited by the final step. */
  finalAmount: string;
  totalBaseCost: string;
  totalBaseProceeds: string;
  totalFeesInBase: string;
  nativeCostAssetId?: string;
  nativeCostAmount?: string;
  unitCost?: string;
}

function feeInBase(fee: ConversionFee, baseId: string) {
  if (fee.valueInBase != null && fee.valueInBase !== '') return D(fee.valueInBase);
  if (fee.assetId === baseId) return D(fee.amount);
  return D(0);
}

export function traceChain(cws: ChainWithSteps): ChainTrace {
  const baseId = cws.chain.baseCurrencyAssetId;
  const steps = [...cws.steps].sort((a, b) => a.order - b.order);
  let baseOut = D(0);
  let baseIn = D(0);
  let feesTotal = D(0);
  let thirdFeesOutsideBase = D(0);

  for (const step of steps) {
    const amounts = conversionStepAmounts(step);
    if (step.fromAssetId === baseId) baseOut = baseOut.plus(amounts.sourceDebit);
    if (step.toAssetId === baseId) baseIn = baseIn.plus(amounts.targetCredit);
    for (const fee of step.fees ?? []) {
      feesTotal = feesTotal.plus(feeInBase(fee, baseId));
      if (fee.treatment === 'third_asset_extra' && fee.assetId === baseId) {
        baseOut = baseOut.plus(fee.amount);
      } else if (fee.treatment === 'third_asset_extra') {
        thirdFeesOutsideBase = thirdFeesOutsideBase.plus(feeInBase(fee, baseId));
      }
    }
  }

  const netBaseOut = baseOut.minus(baseIn);
  let cost = netBaseOut.isPositive() ? netBaseOut : D(0);
  let proceeds = netBaseOut.isNegative() ? netBaseOut.negated() : D(0);
  const override = D(cws.chain.bookValueInBase || 0);
  if (override.gt(0)) {
    if (cws.chain.type === 'sell' || cws.chain.type === 'withdraw') proceeds = override;
    else cost = override;
  } else if (cost.gt(0)) {
    cost = cost.plus(thirdFeesOutsideBase);
  } else if (proceeds.gt(0)) {
    proceeds = proceeds.minus(thirdFeesOutsideBase);
  }

  const first = steps[0];
  const last = steps.at(-1);
  const finalAssetId = last?.toAssetId ?? baseId;
  const finalAmount = last ? D(conversionStepAmounts(last).targetCredit) : D(0);
  const trace: ChainTrace = {
    baseCurrencyAssetId: baseId,
    finalAssetId,
    finalAmount: finalAmount.toString(),
    totalBaseCost: cost.toString(),
    totalBaseProceeds: proceeds.toString(),
    totalFeesInBase: feesTotal.toString(),
  };
  if (first) {
    trace.nativeCostAssetId = first.fromAssetId;
    trace.nativeCostAmount = conversionStepAmounts(first).sourceDebit;
  }
  if (finalAmount.gt(0) && cost.gt(0)) trace.unitCost = cost.div(finalAmount).toString();
  return trace;
}
