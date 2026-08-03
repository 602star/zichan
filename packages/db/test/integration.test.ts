import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openLedger } from '../src/node.js';
import {
  newId, traceChain, postingsFromChain, balanceOf, round,
  type ConversionChain, type ConversionStep,
} from '@zichan/core';

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

describe('chain + steps persistence, and core integration', () => {
  it('saveChainWithSteps persists steps and feeds the core calculations', async () => {
    const store = await openLedger();
    await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
    await store.assets.put({ ...base(), id: 'USDT', code: 'USDT', name: 'Tether', type: 'stablecoin', decimals: 6, isActive: true } as never);
    await store.assets.put({ ...base(), id: 'BTC', code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8, isActive: true } as never);
    const chain = { ...base(), date: '2026-03-02', type: 'dca', baseCurrencyAssetId: 'GBP' } as ConversionChain;
    const steps: ConversionStep[] = [
      { id: newId(), chainId: chain.id, order: 1, fromAssetId: 'GBP', fromAmount: '250',
        toAssetId: 'USDT', toAmount: '312.10', fees: [{ id: newId(), assetId: 'GBP', amount: '1.50', treatment: 'source_extra' }] },
      { id: newId(), chainId: chain.id, order: 2, fromAssetId: 'USDT', fromAmount: '311.50',
        toAssetId: 'BTC', toAmount: '0.003317', fees: [{ id: newId(), assetId: 'USDT', amount: '0.60', treatment: 'source_extra', valueInBase: '0.48' }] },
    ];
    await store.saveChainWithSteps(chain, steps);

    const loaded = await store.getChainWithSteps(chain.id);
    expect(loaded?.steps.length).toBe(2);
    expect(loaded?.steps[0]!.fromAmount).toBe('250');
    expect(loaded?.steps[1]!.fees?.[0]?.valueInBase).toBe('0.48');

    // The persisted chain flows straight into the core calc engine.
    const trace = traceChain(loaded!);
    expect(round(trace.totalBaseCost, 2)).toBe('251.50');
    expect(round(balanceOf(postingsFromChain(loaded!), 'BTC'), 6)).toBe('0.003317');

    // Step changes are captured in the audit trail.
    const log = await store.operationLog({ entityType: 'conversion_chain_steps' });
    expect(log.length).toBe(1);
    expect(JSON.parse(log[0]!.payload!).steps.length).toBe(2);

    await store.close();
  });

  it('replacing steps removes the old ones', async () => {
    const store = await openLedger();
    await store.assets.put({ ...base(), id: 'GBP', code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true } as never);
    await store.assets.put({ ...base(), id: 'USDT', code: 'USDT', name: 'Tether', type: 'stablecoin', decimals: 6, isActive: true } as never);
    await store.assets.put({ ...base(), id: 'BTC', code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8, isActive: true } as never);
    const chain = { ...base(), date: '2026-01-01', type: 'exchange', baseCurrencyAssetId: 'GBP' } as ConversionChain;
    await store.saveChainWithSteps(chain, [
      { id: newId(), chainId: chain.id, order: 1, fromAssetId: 'GBP', fromAmount: '100', toAssetId: 'USDT', toAmount: '123' },
      { id: newId(), chainId: chain.id, order: 2, fromAssetId: 'USDT', fromAmount: '123', toAssetId: 'BTC', toAmount: '0.001' },
    ]);
    await store.saveChainWithSteps(chain, [
      { id: newId(), chainId: chain.id, order: 1, fromAssetId: 'GBP', fromAmount: '100', toAssetId: 'USDT', toAmount: '124' },
    ]);
    const loaded = await store.getChainWithSteps(chain.id);
    expect(loaded?.steps.length).toBe(1);
    expect(loaded?.steps[0]!.toAmount).toBe('124');
    await store.close();
  });

  it('persists data across a reopen (file-backed db)', async () => {
    const file = join(tmpdir(), `zichan-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      const s1 = await openLedger({ filename: file });
      await s1.assets.put({ ...base(), code: 'BTC', name: 'Bitcoin', type: 'crypto', decimals: 8, isActive: true } as never);
      await s1.close();

      const s2 = await openLedger({ filename: file });
      const list = await s2.assets.list();
      expect(list.length).toBe(1);
      expect(list[0]!.code).toBe('BTC');
      await s2.close();
    } finally {
      rmSync(file, { force: true });
    }
  });
});
