/**
 * Conversion normalization and cost tracing. Stored steps keep trade principal
 * and gross output; account movements, net receipts, and actual rates are
 * derived from explicit fee rows so the ledger has one source of truth.
 */
import { D, safeDiv, sum } from './decimal.js';
import { assertCostQuoteSnapshot } from './asset-cost.js';
import { conversionCostFingerprint } from './asset-cost-events.js';
import type {
  ChainWithSteps,
  ConversionChain,
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
  if (fee.assetId === baseId) return D(fee.amount);
  if (fee.valueInBase != null && fee.valueInBase !== '') return D(fee.valueInBase);
  return D(0);
}

const CONVERSION_TYPES = new Set(['buy', 'sell', 'swap', 'exchange', 'dca', 'deposit', 'withdraw']);
const FEE_TREATMENTS = new Set(['source_included', 'source_extra', 'target_deducted', 'third_asset_extra']);
const SOURCE_AMOUNT_MODES = new Set(['trade_principal', 'account_debit']);
const TARGET_AMOUNT_MODES = new Set(['trade_gross', 'account_credit']);
const LOT_METHODS = new Set(['fifo', 'lifo', 'average', 'manual']);

/** Validate portable conversion invariants without consulting persistence. */
export function assertConversionShape(chain: ConversionChain, steps: ConversionStep[]): void {
  const costV2 = chain.costQuotes !== undefined;
  if (costV2) {
    if (!chain.occurredAtUtc || !Array.isArray(chain.costQuotes) || chain.costQuotes.length !== steps.length) throw new Error('成本转换必须包含准确时间与每一步价值状态');
    const quoteIds = new Set<string>();
    for (const quote of chain.costQuotes) {
      assertCostQuoteSnapshot(quote);
      const step = steps.find((row) => row.id === quote.stepId);
      if (!step || quoteIds.has(quote.stepId) || quote.baseCurrencyAssetId !== chain.baseCurrencyAssetId
        || quote.dependencyFingerprint !== conversionCostFingerprint(step, chain.occurredAtUtc, chain.baseCurrencyAssetId)) throw new Error('价值依据条件已变化，请重新确认或清除为未知');
      quoteIds.add(quote.stepId);
      if (quote.quoteDate && quote.quoteDate > chain.date) throw new Error('不能采用交易日期之后的行情');
      const fees = step.fees ?? [];
      if (!Array.isArray(quote.feeValues) || quote.feeValues.length !== fees.length
        || new Set(quote.feeValues.map((row) => row.feeId)).size !== fees.length) throw new Error('手续费冻结价值不完整');
      for (const value of quote.feeValues) {
        if (value.evidence) {
          assertCostQuoteSnapshot(value.evidence);
          if (value.evidence.baseCurrencyAssetId !== chain.baseCurrencyAssetId || value.evidence.valueInBase !== value.valueInBase
            || value.evidence.dependencyFingerprint !== quote.dependencyFingerprint) throw new Error('手续费价值依据条件已变化');
          if (value.evidence.quoteDate && value.evidence.quoteDate > chain.date) throw new Error('手续费不能采用交易日期之后的行情');
        }
        if (!fees.some((fee) => fee.id === value.feeId) || (value.valueInBase !== null && (!D(value.valueInBase).isFinite() || D(value.valueInBase).lt(0)))) throw new Error('手续费冻结价值无效');
      }
    }
  }
  if (!CONVERSION_TYPES.has(chain.type)) throw new Error(`资产转换类型无效：${String(chain.type)}`);
  if (chain.recordState !== undefined && chain.recordState !== 'active' && chain.recordState !== 'voided') throw new Error('资产转换记录状态无效');
  if (chain.bookValueInBase !== undefined && !D(chain.bookValueInBase).gt(0)) throw new Error('资产转换账面折算金额必须大于 0');
  if (chain.lotMethod !== undefined && !LOT_METHODS.has(chain.lotMethod)) throw new Error('资产转换批次匹配方式无效');
  if (!steps.length) throw new Error('资产转换至少需要一个步骤');
  const ordered = [...steps].sort((left, right) => left.order - right.order);
  const ids = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const step = ordered[index]!;
    if (!step.id || ids.has(step.id)) throw new Error(`步骤 ${index + 1} 的 ID 缺失或重复`);
    ids.add(step.id);
    if (step.chainId !== chain.id) throw new Error(`步骤 ${index + 1} 不属于当前转换`);
    if (!Number.isSafeInteger(step.order) || step.order !== index + 1) throw new Error('转换步骤顺序必须从 1 连续编号');
    if (step.sourceAmountMode !== undefined && !SOURCE_AMOUNT_MODES.has(step.sourceAmountMode)) throw new Error(`步骤 ${index + 1} 来源金额口径无效`);
    if (step.targetAmountMode !== undefined && !TARGET_AMOUNT_MODES.has(step.targetAmountMode)) throw new Error(`步骤 ${index + 1} 目标金额口径无效`);
    if (step.referenceRate !== undefined && !D(step.referenceRate).gt(0)) throw new Error(`步骤 ${index + 1} 参考汇率必须大于 0`);
    const sameAssetAccountMove = (chain.type === 'deposit' || chain.type === 'withdraw')
      && step.fromAssetId === step.toAssetId
      && !!step.accountFromId
      && !!step.accountToId
      && step.accountFromId !== step.accountToId;
    if (!step.fromAssetId || !step.toAssetId || (step.fromAssetId === step.toAssetId && !sameAssetAccountMove)) {
      throw new Error(`步骤 ${index + 1} 的资产无效；同币种入金或提现需要两个不同账户`);
    }
    if (!D(step.fromAmount).gt(0) || !D(step.toAmount).gt(0)) throw new Error(`步骤 ${index + 1} 的数量必须大于 0`);
    if (index > 0 && ordered[index - 1]!.toAssetId !== step.fromAssetId) {
      throw new Error(`步骤 ${index} 的目标资产必须与步骤 ${index + 1} 的来源资产一致`);
    }
    for (const fee of step.fees ?? []) {
      if (!FEE_TREATMENTS.has(fee.treatment) || !D(fee.amount).gt(0)) throw new Error(`步骤 ${index + 1} 手续费类型或数量无效`);
      const validAsset = fee.treatment === 'source_included' || fee.treatment === 'source_extra'
        ? fee.assetId === step.fromAssetId
        : fee.treatment === 'target_deducted'
          ? fee.assetId === step.toAssetId
          : fee.assetId !== step.fromAssetId && fee.assetId !== step.toAssetId;
      if (!validAsset) throw new Error(`步骤 ${index + 1} 手续费位置与资产不匹配`);
      if (!costV2 && fee.assetId !== chain.baseCurrencyAssetId && !D(fee.valueInBase ?? 0).gt(0)) {
        throw new Error(`步骤 ${index + 1} 非本位币手续费必须填写本位币金额`);
      }
    }
    if (!D(conversionStepAmounts(step).targetCredit).gt(0)) throw new Error(`步骤 ${index + 1} 的目标净入金额必须大于 0`);
    if (index > 0 && !D(conversionStepAmounts(ordered[index - 1]!).targetCredit)
      .eq(conversionStepAmounts(step).sourceDebit)) {
      throw new Error(`步骤 ${index} 的目标净入金额必须等于步骤 ${index + 1} 的来源实扣金额；剩余或补入资产请拆分记录`);
    }
  }
  const trace = traceChain({ chain, steps: ordered });
  if (!costV2 && (chain.type === 'buy' || chain.type === 'dca') && !D(trace.totalBaseCost).gt(0)) {
    throw new Error('买入或定投必须形成大于 0 的账面成本');
  }
  if (!costV2 && chain.type === 'sell' && !D(trace.totalBaseProceeds).gt(0)) {
    throw new Error('卖出必须形成大于 0 的账面收入');
  }
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
