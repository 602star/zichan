import { describe, expect, it } from 'vitest';
import {
  assertConversionShape,
  conversionStepAmounts,
  normalizeConversionAmounts,
  round,
  traceChain,
  type ChainWithSteps,
  type ConversionFee,
  type ConversionStep,
} from '../src/index.js';

const fee = (id: string, assetId: string, amount: string, treatment: ConversionFee['treatment'], valueInBase?: string): ConversionFee => ({ id, assetId, amount, treatment, valueInBase });

describe('conversion amount semantics', () => {
  it('turns blank form amounts into domain validation errors', () => {
    expect(() => normalizeConversionAmounts({
      fromInput: '', toInput: '', sourceAmountMode: 'trade_principal', targetAmountMode: 'account_credit', fees: [],
    })).toThrow('来源实扣必须大于');
  });

  it('normalizes a source amount that already includes the source fee', () => {
    const fees = [fee('f1', 'ETH', '1', 'source_included')];
    const normalized = normalizeConversionAmounts({ fromInput: '20', toInput: '18', sourceAmountMode: 'account_debit', targetAmountMode: 'account_credit', fees });
    const amounts = conversionStepAmounts({ id: 's', chainId: 'c', order: 1, fromAssetId: 'ETH', fromAmount: normalized.fromAmount, toAssetId: 'USD', toAmount: normalized.toAmount, fees });
    expect(amounts.sourcePrincipal).toBe('19');
    expect(amounts.sourceDebit).toBe('20');
    expect(amounts.targetCredit).toBe('18');
  });

  it('adds a source fee when the entered amount is trade principal', () => {
    const fees = [fee('f1', 'ETH', '1', 'source_extra')];
    const normalized = normalizeConversionAmounts({ fromInput: '20', toInput: '18', sourceAmountMode: 'trade_principal', targetAmountMode: 'account_credit', fees });
    const amounts = conversionStepAmounts({ id: 's', chainId: 'c', order: 1, fromAssetId: 'ETH', fromAmount: normalized.fromAmount, toAssetId: 'USD', toAmount: normalized.toAmount, fees });
    expect(amounts.sourcePrincipal).toBe('20');
    expect(amounts.sourceDebit).toBe('21');
  });

  it('derives gross target amount when the entered amount is net received', () => {
    const fees = [fee('f1', 'USD', '1', 'target_deducted')];
    const normalized = normalizeConversionAmounts({ fromInput: '20', toInput: '18', sourceAmountMode: 'trade_principal', targetAmountMode: 'account_credit', fees });
    const amounts = conversionStepAmounts({ id: 's', chainId: 'c', order: 1, fromAssetId: 'ETH', fromAmount: normalized.fromAmount, toAssetId: 'USD', toAmount: normalized.toAmount, fees });
    expect(amounts.targetGross).toBe('19');
    expect(amounts.targetCredit).toBe('18');
    expect(round(amounts.tradeRate!, 2)).toBe('0.95');
    expect(round(amounts.effectiveRate!, 2)).toBe('0.90');
  });
});

const buyChain: ChainWithSteps = {
  chain: { id: 'c1', date: '2026-03-02', type: 'dca', baseCurrencyAssetId: 'GBP', createdAt: '', updatedAt: '', version: 1, isDeleted: false },
  steps: [
    { id: 's1', chainId: 'c1', order: 1, fromAssetId: 'GBP', fromAmount: '250', toAssetId: 'USDT', toAmount: '312.10', fees: [fee('f1', 'GBP', '1.50', 'source_extra')], referenceRate: '1.2484' },
    { id: 's2', chainId: 'c1', order: 2, fromAssetId: 'USDT', fromAmount: '311.50', toAssetId: 'BTC', toAmount: '0.003317', fees: [fee('f2', 'USDT', '0.60', 'source_extra', '0.48')], referenceRate: '93850' },
  ],
};

describe('traceChain', () => {
  it('validates net-credit to actual-debit continuity including source fees', () => {
    expect(() => assertConversionShape(buyChain.chain, buyChain.steps)).not.toThrow();
    for (const fromAmount of ['311.49', '311.51']) {
      expect(() => assertConversionShape(buyChain.chain, [buyChain.steps[0]!, { ...buyChain.steps[1]!, fromAmount }]))
        .toThrow('来源实扣金额');
    }
  });

  it('uses net output after a target fee, not gross output', () => {
    const first = { ...buyChain.steps[0]!, fees: [fee('target', 'USDT', '0.1', 'target_deducted', '0.08')] };
    expect(() => assertConversionShape(buyChain.chain, [first, buyChain.steps[1]!])).toThrow('来源实扣金额');
    expect(() => assertConversionShape(buyChain.chain, [first, { ...buyChain.steps[1]!, fromAmount: '311.4' }])).not.toThrow();
  });

  it('requires book-currency values for non-base fees and ignores base-currency overrides', () => {
    const invalid = {
      ...buyChain,
      steps: [{
        ...buyChain.steps[0]!,
        fees: [fee('foreign-fee', 'ETH', '1', 'third_asset_extra')],
      }],
    };
    expect(() => assertConversionShape(invalid.chain, invalid.steps)).toThrow('非本位币手续费必须填写');

    const baseFee = {
      chain: { ...buyChain.chain, id: 'base-fee' },
      steps: [{
        ...buyChain.steps[0]!, chainId: 'base-fee', toAssetId: 'BTC', toAmount: '0.001',
        fees: [fee('base-fee-row', 'GBP', '1', 'source_extra', '999')],
      }],
    };
    expect(traceChain(baseFee).totalFeesInBase).toBe('1');
  });

  it('uses actual base account outflow and net final receipt', () => {
    const trace = traceChain(buyChain);
    expect(trace.finalAssetId).toBe('BTC');
    expect(trace.finalAmount).toBe('0.003317');
    expect(round(trace.totalBaseCost, 2)).toBe('251.50');
    expect(round(trace.totalFeesInBase, 2)).toBe('1.98');
    expect(trace.nativeCostAssetId).toBe('GBP');
    expect(trace.nativeCostAmount).toBe('251.5');
  });

  it('deducts a target-currency fee from sell proceeds', () => {
    const step: ConversionStep = {
      id: 's', chainId: 'sell', order: 1, fromAssetId: 'BTC', fromAmount: '0.005',
      toAssetId: 'GBP', toAmount: '389.20', fees: [fee('f', 'GBP', '1.30', 'target_deducted')],
    };
    const chain: ChainWithSteps = { chain: { id: 'sell', date: '2026-02-24', type: 'sell', baseCurrencyAssetId: 'GBP', createdAt: '', updatedAt: '', version: 1, isDeleted: false }, steps: [step] };
    const trace = traceChain(chain);
    expect(round(trace.totalBaseProceeds, 2)).toBe('387.90');
    expect(round(trace.totalFeesInBase, 2)).toBe('1.30');
  });

  it('uses a frozen manual book value when the book currency is outside the chain', () => {
    const chain = { ...buyChain, chain: { ...buyChain.chain, baseCurrencyAssetId: 'USD', bookValueInBase: '320' } };
    expect(traceChain(chain).totalBaseCost).toBe('320');
  });
});
