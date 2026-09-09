import { newId, nextUnhandledDcaOccurrence } from '@zichan/core';
import type { SqlLedgerStore } from './repository.js';
import { recordConversion, recordSell, updateConversion, type UpdateConversionInput } from './services.js';

/** One transaction for the conversion, derived lots and optional plan execution. */
export async function saveConversionAggregate(
  store: SqlLedgerStore,
  input: UpdateConversionInput & { dcaPlanId?: string; editing?: boolean },
) {
  return store.runInAuditBatch(input.editing ? '更新资产转换及定投记录' : '保存资产转换及定投记录', async (transactionStore) => {
    const executions = await transactionStore.dcaExecutions.list({ where: { chainId: input.chain.id } });
    if (executions.length > 1) throw new Error('该转换关联了多条定投执行记录，请先运行数据自检');
    const currentExecution = executions[0];
    const result = input.editing
      ? await updateConversion(transactionStore, input)
      : input.chain.type === 'sell'
        ? await recordSell(transactionStore, { ...input, method: input.chain.lotMethod, selectedLotIds: input.chain.manualLotIds })
        : await recordConversion(transactionStore, input);
    const savedChain = result.chain;
    if (savedChain.type === 'dca' && input.dcaPlanId) {
      const plan = await transactionStore.dcaPlans.get(input.dcaPlanId);
      if (!plan || plan.isDeleted || (plan.status !== 'active' && plan.id !== currentExecution?.planId)) {
        throw new Error('关联的定投计划不存在或已经停用');
      }
      if (plan.baseCurrencyAssetId !== savedChain.baseCurrencyAssetId || plan.targetAssetId !== savedChain.finalAssetId) {
        throw new Error('定投计划的本位币和目标资产必须与转换一致');
      }
      const planExecutions = (await transactionStore.dcaExecutions.list({ where: { planId: plan.id } }))
        .filter((row) => row.id !== currentExecution?.id);
      const occurrence = currentExecution?.planId === plan.id
        ? { index: currentExecution.occurrenceIndex, date: currentExecution.scheduledDate }
        : plan.frequency === 'manual'
          ? { index: planExecutions.reduce((max, row) => Math.max(max, row.occurrenceIndex), -1) + 1, date: savedChain.date }
          : nextUnhandledDcaOccurrence(plan, planExecutions);
      if (!occurrence) throw new Error('该定投计划没有可执行的下一期');
      // Rebuild may have refreshed this execution; retain the current version.
      const refreshed = currentExecution ? await transactionStore.dcaExecutions.get(currentExecution.id) : undefined;
      await transactionStore.dcaExecutions.put({
        id: currentExecution?.id ?? newId(),
        createdAt: currentExecution?.createdAt ?? '',
        updatedAt: refreshed?.updatedAt ?? '',
        version: refreshed?.version ?? 1,
        isDeleted: false,
        planId: plan.id,
        occurrenceIndex: occurrence.index,
        scheduledDate: occurrence.date,
        date: savedChain.date,
        plannedAmount: plan.plannedAmount,
        actualBaseCost: savedChain.totalBaseCost ?? '0',
        baseCurrencyAssetId: savedChain.baseCurrencyAssetId,
        finalAssetId: savedChain.finalAssetId!,
        finalAmount: savedChain.finalAmount!,
        totalFeeInBase: savedChain.totalFeesInBase ?? '0',
        chainId: savedChain.id,
        note: currentExecution?.note,
      });
    } else if (currentExecution) {
      const refreshed = await transactionStore.dcaExecutions.get(currentExecution.id);
      if (refreshed && !refreshed.isDeleted) await transactionStore.dcaExecutions.remove(refreshed.id, refreshed.version);
    }
    return result;
  });
}
