import { describe, expect, it } from 'vitest';
import { buildAssetCostEvents, assertConversionShape, conversionFinancialFingerprint, conversionCostFingerprint, freezeConversionQuote, replayAssetCosts,
  type ChainWithSteps, type CostBasisOpening, type ConversionFee, type Transaction } from '../src/index.js';

const stamp = { createdAt: '', updatedAt: '', version: 1, isDeleted: false };
const opening: CostBasisOpening = { ...stamp, id: 'opening', occurredAtUtc: '2026-01-01T00:00:00Z',
  confirmedAt: '2026-01-01T00:00:00Z', baseCurrencyAssetId: 'CNY', sourceFingerprint: '', items: [
    { id: 'btc', assetId: 'BTC', quantity: '10', costInBase: '100', acquiredAtUtc: '2025-12-01T00:00:00Z' },
    { id: 'bnb', assetId: 'BNB', quantity: '10', costInBase: '20', acquiredAtUtc: '2025-12-01T00:00:00Z' },
  ] };
function swap(fees: ConversionFee[] = []): ChainWithSteps {
  const chain: ChainWithSteps['chain'] = { ...stamp, id: 'swap', type: 'swap', date: '2026-01-02', time: '10:00',
    timezone: 'UTC', occurredAtUtc: '2026-01-02T10:00:00Z', baseCurrencyAssetId: 'CNY' };
  const steps = [{ id: 's', chainId: chain.id, order: 1, fromAssetId: 'BTC', fromAmount: '2', toAssetId: 'ETH', toAmount: '20', fees }];
  chain.costQuotes = [freezeConversionQuote(steps[0]!, chain.occurredAtUtc!, 'CNY', { valueInBase: '40', source: 'manual', priceMarkIds: [] })];
  return { chain, steps };
}
function replay(chains: ChainWithSteps[], transactions: Transaction[] = []) {
  return replayAssetCosts(buildAssetCostEvents({ opening, chains, transactions, timezone: 'UTC' }).events, 'CNY');
}

describe('ledger cost event semantics', () => {
  it('realizes swap source and establishes a new target basis', () => {
    const result = replay([swap()]);
    expect(result.events.find((row) => row.eventId === 's:0-source')).toMatchObject({ costInBase: '20', realizedGainLoss: '20' });
    expect(result.positions.find((row) => row.assetId === 'ETH')).toMatchObject({ quantity: '20', costInBase: '40' });
  });
  it('capitalizes source and third fees once, and gives net target quantity the full basis', () => {
    const result = replay([swap([
      { id: 'f1', assetId: 'BTC', amount: '1', treatment: 'source_extra', valueInBase: '20' },
      { id: 'f2', assetId: 'ETH', amount: '2', treatment: 'target_deducted', valueInBase: '4' },
      { id: 'f3', assetId: 'BNB', amount: '1', treatment: 'third_asset_extra', valueInBase: '3' },
    ])]);
    expect(result.positions.find((row) => row.assetId === 'ETH')).toMatchObject({ quantity: '18', costInBase: '63' });
    expect(result.positions.find((row) => row.assetId === 'BTC')?.quantity).toBe('7');
    expect(result.events.find((row) => row.eventId === 's:1-fee:f3')?.realizedGainLoss).toBe('1');
  });
  it('subtracts sell fees from proceeds without subtracting target quantity twice', () => {
    const trade = swap([
      { id: 'f1', assetId: 'BTC', amount: '1', treatment: 'source_included', valueInBase: '20' },
      { id: 'f2', assetId: 'ETH', amount: '2', treatment: 'target_deducted', valueInBase: '4' },
      { id: 'f3', assetId: 'BNB', amount: '1', treatment: 'third_asset_extra', valueInBase: '3' },
    ]);
    trade.chain.type = 'sell';
    const result = replay([trade]);
    expect(result.events.find((row) => row.eventId === 's:0-source')).toMatchObject({ costInBase: '30', realizedGainLoss: '3' });
    expect(result.positions.find((row) => row.assetId === 'ETH')).toMatchObject({ quantity: '18', costInBase: '36' });
    expect(result.events.find((row) => row.eventId === 's:1-fee:f3')?.realizedGainLoss).toBe('1');
  });
  it('same-currency transfers leave the cost pool unchanged', () => {
    const trade = swap();
    trade.chain.type = 'deposit';
    trade.steps[0]!.toAssetId = 'BTC';
    trade.steps[0]!.toAmount = '2';
    trade.chain.costQuotes = [];
    expect(replay([trade]).positions.find((row) => row.assetId === 'BTC')).toMatchObject({ quantity: '10', costInBase: '100' });
  });
  it('marks changed evidence stale and never reuses its old amount', () => {
    const trade = swap();
    trade.steps[0]!.fromAmount = '3';
    const built = buildAssetCostEvents({ opening, chains: [trade], transactions: [], timezone: 'UTC' });
    expect(built.issues[0]?.code).toBe('stale_quote');
    expect(replayAssetCosts(built.events, 'CNY').positions.find((row) => row.assetId === 'ETH')?.costInBase).toBeNull();
  });
  it('metadata changes do not invalidate value evidence', () => {
    const trade = swap();
    const step = trade.steps[0]!;
    const fingerprint = conversionCostFingerprint(step, trade.chain.occurredAtUtc!, 'CNY');
    expect(conversionCostFingerprint({ ...step, platform: 'new platform', note: 'memo' }, trade.chain.occurredAtUtc!, 'CNY')).toBe(fingerprint);
  });
  it('reports ambiguous day-only records instead of silently confirming costs', () => {
    const trade = swap();
    delete trade.chain.occurredAtUtc;
    delete trade.chain.time;
    expect(buildAssetCostEvents({ opening, chains: [trade], transactions: [], timezone: 'UTC' }).issues[0]?.code).toBe('ambiguous_time');
  });
  it('freezes fee evidence and rejects future or mismatched price evidence', () => {
    const trade = swap([{ id: 'f', assetId: 'BNB', amount: '1', treatment: 'third_asset_extra', valueInBase: '3',
      valueEvidence: { source: 'price_mark', priceMarkIds: ['historical-price'], quoteDate: '2026-01-01', explanation: 'confirmed historical quote' } }]);
    const evidence = trade.chain.costQuotes![0]!.feeValues[0]!.evidence!;
    expect(evidence).toMatchObject({ source: 'price_mark', quoteDate: '2026-01-01', priceMarkIds: ['historical-price'], valueInBase: '3' });
    expect(() => assertConversionShape(trade.chain, trade.steps)).not.toThrow();
    const before = conversionFinancialFingerprint(trade);
    trade.steps[0]!.fees![0]!.note = 'Text only';
    expect(conversionFinancialFingerprint(trade)).toBe(before);
    evidence.quoteDate = '2026-01-03';
    expect(() => assertConversionShape(trade.chain, trade.steps)).toThrow('交易日期之后');
  });

});
