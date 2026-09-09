import { describe, expect, it } from 'vitest';
import { newId, type ConversionChain, type ConversionStep, type DcaPlan } from '@zichan/core';
import { openLedger } from '../src/node.js';
import { saveConversionAggregate } from '../src/index.js';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });

async function fixture() {
  const store = await openLedger();
  for (const id of ['GBP', 'USD', 'BTC']) {
    await store.assets.put({ ...base(), id, code: id, name: id, type: id === 'BTC' ? 'crypto' : 'fiat', decimals: 8, isActive: true });
  }
  const plan: DcaPlan = {
    ...base(), name: 'Test', targetAssetId: 'BTC', baseCurrencyAssetId: 'GBP',
    anchorDate: '2026-01-01', anchorMode: 'calendar_day', timezone: 'UTC', frequency: 'manual', plannedAmount: '100', status: 'active',
  };
  await store.dcaPlans.put(plan);
  const chain: ConversionChain = { ...base(), date: '2026-01-01', type: 'dca', baseCurrencyAssetId: 'GBP' };
  const steps: ConversionStep[] = [{ id: newId(), chainId: chain.id, order: 1, fromAssetId: 'GBP', fromAmount: '100', toAssetId: 'BTC', toAmount: '1', fees: [] }];
  return { store, plan, chain, steps };
}

describe('conversion aggregate service', () => {
  it('creates and edits a linked execution without stale versions', async () => {
    const { store, plan, chain, steps } = await fixture();
    try {
      const result = await saveConversionAggregate(store, { chain, steps, dcaPlanId: plan.id });
      expect((await store.lots.list())).toHaveLength(1);
      expect((await store.dcaExecutions.list())).toHaveLength(1);
      await saveConversionAggregate(store, {
        chain: result.chain, steps: [{ ...steps[0]!, toAmount: '2' }],
        editing: true, expectedVersion: result.chain.version, dcaPlanId: plan.id,
      });
      const execution = (await store.dcaExecutions.list())[0]!;
      expect(execution.finalAmount).toBe('2');
      expect(execution.occurrenceIndex).toBe(0);
      expect((await store.lots.list())[0]!.originalAmount).toBe('2');
    } finally { await store.close(); }
  });

  it('rolls back the chain and lot when plan validation fails', async () => {
    const { store, plan, chain, steps } = await fixture();
    try {
      await store.dcaPlans.put({ ...(await store.dcaPlans.get(plan.id))!, baseCurrencyAssetId: 'USD' });
      await expect(saveConversionAggregate(store, { chain, steps, dcaPlanId: plan.id })).rejects.toThrow('必须与转换一致');
      expect(await store.conversionChains.list()).toEqual([]);
      expect(await store.lots.list()).toEqual([]);
      expect(await store.dcaExecutions.list()).toEqual([]);
    } finally { await store.close(); }
  });

  it('assigns the next occurrence of a newly selected plan', async () => {
    const { store, plan, chain, steps } = await fixture();
    try {
      const secondPlan = { ...plan, ...base() };
      await store.dcaPlans.put(secondPlan);
      const otherChain = { ...chain, ...base() };
      await saveConversionAggregate(store, { chain: otherChain, steps: steps.map((step) => ({ ...step, id: newId(), chainId: otherChain.id })), dcaPlanId: secondPlan.id });
      const result = await saveConversionAggregate(store, { chain, steps, dcaPlanId: plan.id });
      await saveConversionAggregate(store, { chain: result.chain, steps, editing: true, expectedVersion: result.chain.version, dcaPlanId: secondPlan.id });
      const execution = (await store.dcaExecutions.list({ where: { chainId: chain.id } }))[0]!;
      expect(execution.planId).toBe(secondPlan.id);
      expect(execution.occurrenceIndex).toBe(1);
    } finally { await store.close(); }
  });
});
