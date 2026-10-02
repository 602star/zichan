import { describe, expect, it } from 'vitest';
import { canonicalJson, freezeConversionQuote, newId, type ChainWithSteps } from '@zichan/core';
import { openLedger } from '../src/node.js';
import { confirmCostBasisOpening, exportLedger, importLedger, memoryCommitTransport, previewCostBasisOpening,
  readAssetCostState, recordConversion, syncReplica, updateConversionMetadata } from '../src/index.js';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });
async function fixture() {
  const store = await openLedger();
  for (const id of ['CNY', 'USD', 'BTC']) await store.assets.put({ ...base(), id, name: id, code: id, type: id === 'BTC' ? 'crypto' : 'fiat', decimals: 8, isActive: true });
  await store.accounts.put({ ...base(), id: 'wallet', name: '钱包', kind: 'wallet', isActive: true,
    openingAssetId: 'USD', openingBalance: '100', balanceStartAt: '2026-01-01T00:00:00.000Z', balanceStartDate: '2026-01-01' });
  const preview = await previewCostBasisOpening(store, '2026-01-02T00:00:00Z', 'CNY');
  preview.opening.items[0]!.costInBase = '700';
  await confirmCostBasisOpening(store, preview);
  return store;
}

describe('cost facts, opening and recovery', () => {
  it('confirms basis without posting an additional balance', async () => {
    const store = await fixture();
    try {
      expect(await store.transactions.list()).toEqual([]);
      expect((await store.accounts.get('wallet'))?.openingBalance).toBe('100');
      expect((await readAssetCostState(store))?.positions[0]).toMatchObject({ assetId: 'USD', quantity: '100', costInBase: '700' });
      const preview = await previewCostBasisOpening(store, '2026-01-03T00:00:00Z', 'CNY');
      preview.opening.items[0]!.quantity = '200';
      await expect(confirmCostBasisOpening(store, preview)).rejects.toThrow('实际余额');
      expect(await store.costBasisOpenings.count()).toBe(1);
    } finally { await store.close(); }
  });

  it('invalidates affected basis after a backdated economic edit, but not a label edit', async () => {
    const store = await fixture();
    try {
      const account = (await store.accounts.get('wallet'))!;
      await store.accounts.put({ ...account, name: '改名' });
      expect((await readAssetCostState(store))?.invalidAssetIds).toEqual([]);
      const aggregate: ChainWithSteps = { chain: { ...base(), date: '2026-01-01', time: '12:00:00', timezone: 'UTC', type: 'exchange', baseCurrencyAssetId: 'CNY' }, steps: [] };
      aggregate.steps = [{ id: newId(), chainId: aggregate.chain.id, order: 1, fromAssetId: 'CNY', fromAmount: '70', toAssetId: 'USD', toAmount: '10', accountToId: 'wallet' }];
      await recordConversion(store, aggregate);
      const state = await readAssetCostState(store);
      expect(state?.invalidAssetIds).toContain('USD');
      expect(state?.positions.find((row) => row.assetId === 'USD')?.costInBase).toBeNull();
    } finally { await store.close(); }
  });

  it('preserves frozen quotes and opening facts across backup import', async () => {
    const store = await fixture();
    const restored = await openLedger();
    try {
      const chain = { ...base(), date: '2026-01-03', time: '12:00:00', timezone: 'UTC', occurredAtUtc: '2026-01-03T12:00:00.000Z', type: 'exchange' as const, baseCurrencyAssetId: 'CNY' };
      const step = { id: newId(), chainId: chain.id, order: 1, fromAssetId: 'USD', fromAmount: '20', toAssetId: 'BTC', toAmount: '1', accountFromId: 'wallet' };
      await store.saveChainWithSteps({ ...chain, costQuotes: [freezeConversionQuote(step, chain.occurredAtUtc, 'CNY', { source: 'manual', valueInBase: '150', priceMarkIds: [] })] }, [step]);
      const backup = await exportLedger(store);
      expect(backup.version).toBe(8);
      await importLedger(restored, backup);
      expect(canonicalJson(await readAssetCostState(restored))).toBe(canonicalJson(await readAssetCostState(store)));
      expect((await readAssetCostState(restored))?.events.find((row) => row.sourceId === chain.id)?.realizedGainLoss).toBe('10');
    } finally { await store.close(); await restored.close(); }
  });

  it('keeps new facts pending when the remote lacks capability negotiation', async () => {
    const store = await fixture();
    try {
      const transport = memoryCommitTransport('legacy');
      const connect = transport.connect;
      transport.connect = async (ledgerId) => ({ ...await connect(ledgerId), capabilities: undefined });
      await expect(syncReplica(store, transport)).rejects.toThrow('asset-cost-v2');
      expect(transport.log).toEqual([]);
      expect(await store.costBasisOpenings.count()).toBe(1);
    } finally { await store.close(); }
  });

  it('preserves closed-period gains in their original currency after confirming a new cost currency', async () => {
    const store = await fixture();
    try {
      const first = { ...base(), date: '2026-01-03', time: '12:00', timezone: 'UTC', type: 'exchange' as const, baseCurrencyAssetId: 'CNY' };
      await recordConversion(store, { chain: first, steps: [{ id: newId(), chainId: first.id, order: 1, fromAssetId: 'USD', fromAmount: '10', toAssetId: 'CNY', toAmount: '80', accountFromId: 'wallet', accountToId: 'wallet' }] });
      const sameCurrency = await previewCostBasisOpening(store, '2026-01-04T00:00:00Z', 'CNY');
      expect(sameCurrency.opening.items.find((item) => item.assetId === 'USD')?.costInBase).toBe('630');
      const next = await previewCostBasisOpening(store, '2026-01-04T00:00:00Z', 'USD');
      next.opening.items.find((item) => item.assetId === 'CNY')!.costInBase = '10';
      await confirmCostBasisOpening(store, next);
      const second = { ...base(), date: '2026-01-05', time: '12:00', timezone: 'UTC', type: 'swap' as const, baseCurrencyAssetId: 'USD', bookValueInBase: '12' };
      await recordConversion(store, { chain: second, steps: [{ id: newId(), chainId: second.id, order: 1, fromAssetId: 'CNY', fromAmount: '80', toAssetId: 'BTC', toAmount: '1', accountFromId: 'wallet', accountToId: 'wallet' }] });
      const state = await readAssetCostState(store);
      expect(state?.baseCurrencyAssetId).toBe('USD');
      expect(state?.events.find((event) => event.sourceId === first.id && event.realize)).toMatchObject({ baseCurrencyAssetId: 'CNY', realizedGainLoss: '10' });
      expect(state?.events.find((event) => event.sourceId === second.id && event.realize)).toMatchObject({ baseCurrencyAssetId: 'USD', realizedGainLoss: '2' });
      expect(state?.positions.find((position) => position.assetId === 'BTC')).toMatchObject({ quantity: '1', costInBase: '12' });
    } finally { await store.close(); }
  });
});

describe('conversion metadata updates', () => {
  it('does not rebuild lots, accepts unchanged archived references, and skips no-op audits', async () => {
    const store = await openLedger();
    try {
      for (const id of ['CNY', 'BTC']) await store.assets.put({ ...base(), id, name: id, code: id, type: id === 'BTC' ? 'crypto' : 'fiat', decimals: 8, isActive: true });
      const chain = { ...base(), date: '2026-01-01', type: 'buy' as const, baseCurrencyAssetId: 'CNY' };
      const step = { id: newId(), chainId: chain.id, order: 1, fromAssetId: 'CNY', fromAmount: '100', toAssetId: 'BTC', toAmount: '1' };
      const result = await recordConversion(store, { chain, steps: [step] });
      const lots = await store.lots.list();
      await store.assets.put({ ...(await store.assets.get('BTC'))!, isActive: false });
      const changed = await updateConversionMetadata(store, { chainId: chain.id, expectedVersion: result.chain.version, title: '标题', steps: [{ id: step.id, platform: '交易所' }] });
      expect(await store.lots.list()).toEqual(lots);
      const audit = await store.operationLog();
      const same = await updateConversionMetadata(store, { chainId: chain.id, expectedVersion: changed.chain.version, title: '标题' });
      expect(same.chain.version).toBe(changed.chain.version);
      expect(await store.operationLog()).toEqual(audit);
      await expect(updateConversionMetadata(store, { chainId: chain.id, expectedVersion: result.chain.version, title: '冲突' })).rejects.toThrow('其他窗口修改');
    } finally { await store.close(); }
  });
});
