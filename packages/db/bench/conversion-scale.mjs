import { performance } from 'node:perf_hooks';
import { createLedgerStore, rebuildConversionDerived } from '../dist/index.js';
import { NodeSqliteDriver } from '../dist/node.js';

const pairs = Number(process.argv[2] || 2000);
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 10000) throw new Error('Expected 1–10000 buy/sell pairs');
const store = await createLedgerStore(new NodeSqliteDriver());
const base = (id, date) => ({ id, createdAt: `${date}T00:00:00.000Z`, updatedAt: `${date}T00:00:00.000Z`, version: 1, isDeleted: false });
try {
  await store.transaction(async (tx) => {
    for (const [id, type, decimals] of [['CNY', 'fiat', 2], ['BTC', 'crypto', 8]]) {
      await tx.assets.put({ ...base(id, '2020-01-01'), code: id, name: id, type, decimals, isActive: true });
    }
    for (let index = 0; index < pairs * 2; index++) {
      const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
      const buy = index % 2 === 0;
      const id = `bench-chain-${String(index).padStart(6, '0')}`;
      await tx.saveChainWithSteps({ ...base(id, date), date, type: buy ? 'buy' : 'sell', baseCurrencyAssetId: 'CNY', recordState: 'active', lotMethod: 'fifo' }, [
        { id: `step-${id}`, chainId: id, order: 1, fromAssetId: buy ? 'CNY' : 'BTC', fromAmount: buy ? '100' : '1', toAssetId: buy ? 'BTC' : 'CNY', toAmount: buy ? '1' : '110', fees: [] },
      ]);
    }
  });
  await rebuildConversionDerived(store);
  const samples = [];
  for (let index = 0; index < 5; index++) {
    const start = performance.now();
    await rebuildConversionDerived(store);
    samples.push(Number((performance.now() - start).toFixed(2)));
  }
  const lots = await store.lots.list();
  const consumptions = await store.lotConsumptions.list();
  if (lots.length !== pairs || consumptions.length !== pairs || lots.some((lot) => lot.remainingAmount !== '0')) throw new Error('Rebuild changed expected inventory');
  const chains = await store.conversionChains.list();
  if (chains.filter((chain) => chain.type === 'sell').some((chain) => chain.realizedGainLoss !== '10')) throw new Error('Rebuild changed exact P&L');
  console.log(JSON.stringify({ scenario: 'alternating fully closed FIFO lots', conversions: pairs * 2, samplesMs: samples, exactInventoryAndPnl: true }));
} finally { await store.close(); }
