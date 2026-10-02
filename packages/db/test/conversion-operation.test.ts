import { describe, expect, it } from 'vitest';
import { newId, type ChainWithSteps } from '@zichan/core';
import { openLedger } from '../src/node.js';
import { confirmCostBasisOpening, memoryCommitTransport, previewCostBasisOpening, previewConversionOperation,
  readAssetCostState, saveConversionOperation, setConversionOperationState, syncReplica, updateConversion,
  exportLedger, importLedger, preflightImport, conversionOperationDependency,
  previewStandaloneConversion, saveStandaloneConversion, updateConversionOperationMetadata, recomputeCaches, checkConsistency,
  type ConversionOperationInput } from '../src/index.js';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });
async function fixture() {
  const store = await openLedger();
  for (const id of ['CNY', 'USDT', 'BTC']) await store.assets.put({ ...base(), id, name: id, code: id, type: id === 'BTC' ? 'crypto' : id === 'USDT' ? 'stablecoin' : 'fiat', decimals: 8, isActive: true });
  await store.accounts.put({ ...base(), id: 'wallet', name: '钱包', kind: 'wallet', isActive: true,
    openingAssetId: 'CNY', openingBalance: '1000', balanceStartAt: '2026-01-01T00:00:00.000Z', balanceStartDate: '2026-01-01' });
  await confirmCostBasisOpening(store, await previewCostBasisOpening(store, '2026-01-02T00:00:00.000Z', 'CNY'));
  const segment = (fromAssetId: string, fromAmount: string, toAssetId: string, toAmount: string, bookValueInBase?: string): ChainWithSteps => {
    const chain = { ...base(), date: '2026-01-03', time: '12:00:00', timezone: 'UTC', type: 'exchange' as const, baseCurrencyAssetId: 'CNY', bookValueInBase };
    return { chain, steps: [{ id: newId(), chainId: chain.id, order: 1, fromAssetId, fromAmount, toAssetId, toAmount, accountFromId: 'wallet', accountToId: 'wallet' }] };
  };
  const input: ConversionOperationInput = { operation: { ...base(), chainIds: [] }, conversions: [segment('CNY', '100', 'USDT', '100'), segment('USDT', '80', 'BTC', '1', '80')], links: [{ retainedQuantity: '20', supplementalQuantity: '0' }] };
  return { store, input };
}

describe('atomic continuous conversions', () => {
  it('previews without writes, retains intermediate funds, and synchronizes one aggregate', async () => {
    const { store, input } = await fixture();
    const remote = await openLedger();
    try {
      const audit = await store.operationLog();
      const preview = await previewConversionOperation(store, input);
      expect(preview.errors).toEqual([]);
      expect(await store.operationLog()).toEqual(audit);
      expect(preview.retained).toEqual([{ assetId: 'USDT', accountId: 'wallet', quantity: '20' }]);
      expect(preview.assetChanges).toContainEqual({ assetId: 'CNY', delta: '-100' });
      const operation = await saveConversionOperation(store, preview);
      const state = await readAssetCostState(store);
      expect(state?.positions.find((row) => row.assetId === 'BTC')).toMatchObject({ quantity: '1', costInBase: '80' });
      expect(state?.positions.find((row) => row.assetId === 'USDT')).toMatchObject({ quantity: '20', costInBase: '20' });
      const transport = memoryCommitTransport();
      await remote.adoptLedgerId(await store.getLedgerId());
      await syncReplica(store, transport);
      expect(transport.log.flatMap((row) => row.commit.revisions).filter((row) => row.aggregateType === 'conversion')).toEqual([]);
      expect(transport.log.flatMap((row) => row.commit.revisions).filter((row) => row.aggregateType === 'conversion_operation')).toHaveLength(1);
      const result = await syncReplica(remote, transport);
      expect(result.invalid).toBe(0);
      expect(await readAssetCostState(remote)).toEqual(state);
      const voided = await setConversionOperationState(store, operation.id, operation.version, 'voided');
      expect((await readAssetCostState(store))?.positions.filter((row) => row.assetId !== 'CNY')).toEqual([]);
      await setConversionOperationState(store, voided.id, voided.version, 'active');
      expect(await readAssetCostState(store)).toEqual(state);
    } finally { await store.close(); await remote.close(); }
  });

  it('rejects expired previews and independent child edits without partial records', async () => {
    const { store, input } = await fixture();
    try {
      const preview = await previewConversionOperation(store, input);
      await store.accounts.put({ ...(await store.accounts.get('wallet'))!, name: '另一个窗口修改' });
      await expect(saveConversionOperation(store, preview)).rejects.toThrow('刷新预览');
      expect(await store.conversionChains.count()).toBe(0);
      expect(await store.conversionOperations.count()).toBe(0);
      await saveConversionOperation(store, await previewConversionOperation(store, input));
      const child = (await store.getChainWithSteps(input.conversions[0]!.chain.id))!;
      await expect(updateConversion(store, { ...child, expectedVersion: child.chain.version })).rejects.toThrow('不能独立编辑');
    } finally { await store.close(); }
  });

  it('requires explicit top-up source and calculates retention using debit including fees', async () => {
    const { store, input } = await fixture();
    try {
      input.conversions[1]!.steps[0]!.fees = [{ id: newId(), assetId: 'USDT', amount: '2', treatment: 'source_extra', valueInBase: '2' }];
      expect((await previewConversionOperation(store, input)).errors[0]?.message).toContain('实际扣款');
      input.links[0]!.retainedQuantity = '18';
      expect((await previewConversionOperation(store, input)).errors).toEqual([]);
      input.conversions[1]!.steps[0]!.fromAmount = '110';
      input.links[0] = { retainedQuantity: '0', supplementalQuantity: '12' };
      expect((await previewConversionOperation(store, input)).errors[0]?.message).toContain('补入资金');
      input.links[0]!.accountId = 'wallet';
      const preview = await previewConversionOperation(store, input);
      expect(preview.errors).toEqual([]);
      expect(preview.warnings.some((warning) => warning.message.includes('余额不足'))).toBe(true);
      await expect(saveConversionOperation(store, preview)).resolves.toBeDefined();
    } finally { await store.close(); }
  });

  it('round-trips group ownership in backups and rejects missing children or owners', async () => {
    const { store, input } = await fixture();
    const restored = await openLedger();
    try {
      await saveConversionOperation(store, await previewConversionOperation(store, input));
      const backup = await exportLedger(store);
      expect(preflightImport(backup).ok).toBe(true);
      await importLedger(restored, backup);
      expect(await readAssetCostState(restored)).toEqual(await readAssetCostState(store));
      expect(preflightImport({ ...backup, conversionOperations: [] }).ok).toBe(false);
      expect(preflightImport({ ...backup, chains: backup.chains.slice(1) }).ok).toBe(false);
      expect((await restored.conversionOperations.list())[0]?.links).toEqual(input.links);
    } finally { await store.close(); await restored.close(); }
  });

  it('rejects undo after a cost dependency changes and does not audit a state no-op', async () => {
    const { store, input } = await fixture();
    try {
      const operation = await saveConversionOperation(store, await previewConversionOperation(store, input));
      const token = await conversionOperationDependency(store, operation.id);
      const before = await store.operationLog();
      await setConversionOperationState(store, operation.id, operation.version, 'active', token);
      expect(await store.operationLog()).toEqual(before);
      const opening = (await store.costBasisOpenings.list())[0]!;
      await store.costBasisOpenings.put({ ...opening, confirmedAt: '2026-01-04T00:00:00.000Z' });
      await expect(setConversionOperationState(store, operation.id, operation.version, 'voided', token)).rejects.toThrow('后续修改');
      expect((await store.conversionOperations.get(operation.id))?.recordState).not.toBe('voided');
    } finally { await store.close(); }
  });

  it('uses the same pure calculator for independent conversion saves and preserves unknown costs on cache repair', async () => {
    const { store, input } = await fixture();
    try {
      const aggregate = input.conversions[1]!;
      aggregate.chain.bookValueInBase = undefined;
      const before = await store.operationLog();
      const preview = await previewStandaloneConversion(store, aggregate);
      expect(preview.errors).toEqual([]);
      expect(await store.operationLog()).toEqual(before);
      const result = await saveStandaloneConversion(store, preview);
      expect(result.chain.realizedGainLoss).toBeUndefined();
      expect(result.chain.totalBaseCost).toBeUndefined();
      expect(await store.conversionOperations.count()).toBe(0);
      await recomputeCaches(store);
      expect((await store.conversionChains.get(result.chain.id))?.realizedGainLoss).toBeUndefined();
      expect((await checkConsistency(store)).filter((issue) => issue.kind === 'chain_cache_stale')).toEqual([]);
      expect(await recomputeCaches(store)).toEqual({ lots: 0, chains: 0 });
      await expect(saveStandaloneConversion(store, preview)).rejects.toThrow('刷新预览');
    } finally { await store.close(); }
  });

  it('updates only group metadata without changing cost results and keeps no-op edits out of audit', async () => {
    const { store, input } = await fixture();
    try {
      const operation = await saveConversionOperation(store, await previewConversionOperation(store, input));
      const conversions = await Promise.all(operation.chainIds.map(async (id) => (await store.getChainWithSteps(id))!));
      const cost = await readAssetCostState(store);
      conversions[0]!.steps[0]!.note = '只有文字变化';
      const saved = await updateConversionOperationMetadata(store, { ...input, operation: { ...operation, title: '整组标题' }, conversions });
      expect(await readAssetCostState(store)).toEqual(cost);
      const updated = await Promise.all(saved.chainIds.map(async (id) => (await store.getChainWithSteps(id))!));
      const audit = await store.operationLog();
      await updateConversionOperationMetadata(store, { ...input, operation: saved, conversions: updated });
      expect(await store.operationLog()).toEqual(audit);
      updated[0]!.steps[0]!.fromAmount = '200';
      await expect(updateConversionOperationMetadata(store, { ...input, operation: saved, conversions: updated })).rejects.toThrow('资金字段');
    } finally { await store.close(); }
  });

  it('links a DCA execution atomically and restores it with the entire group', async () => {
    const { store, input } = await fixture();
    try {
      const plan = await store.dcaPlans.put({ ...base(), name: '连续定投', baseCurrencyAssetId: 'CNY', targetAssetId: 'BTC',
        anchorDate: '2026-01-01', anchorMode: 'calendar_day', timezone: 'UTC', frequency: 'manual', plannedAmount: '100', status: 'active' });
      input.dcaPlanId = plan.id;
      input.conversions[1]!.chain.type = 'dca';
      const saved = await saveConversionOperation(store, await previewConversionOperation(store, input));
      expect((await store.dcaExecutions.list())[0]).toMatchObject({ actualBaseCost: '80', finalAmount: '1', planId: plan.id });
      const voided = await setConversionOperationState(store, saved.id, saved.version, 'voided');
      expect(await store.dcaExecutions.list()).toEqual([]);
      await setConversionOperationState(store, saved.id, voided.version, 'active');
      expect((await store.dcaExecutions.list())[0]).toMatchObject({ actualBaseCost: '80', finalAmount: '1' });
    } finally { await store.close(); }
  });
});
