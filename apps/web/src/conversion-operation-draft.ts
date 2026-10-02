import { freezeConversionQuote, normalizeOccurrence, type ChainWithSteps, type ConversionOperation } from '@zichan/core';
import type { ConversionOperationInput } from '@zichan/db';

/** A step becomes a segment so the next step may explicitly retain or supplement its proceeds. */
export function buildConversionOperationDraft(input: {
  prepared: ChainWithSteps;
  operation: ConversionOperation;
  existing?: ConversionOperationInput;
  links: ConversionOperationInput['links'];
  dcaPlanId?: string;
}): ConversionOperationInput {
  const { prepared, operation, existing } = input;
  const conversions = prepared.steps.map((step, index): ChainWithSteps => {
    const original = existing?.conversions.find((row) => row.steps.some((item) => item.id === step.id));
    const reusesChain = original?.steps[0]?.id === step.id;
    const chainId = reusesChain ? original.chain.id : `segment-${step.id}`;
    const { operationId: _operationId, operationOrder: _operationOrder, ...template } = prepared.chain;
    const chain = { ...template, ...(reusesChain ? { id: chainId, version: original.chain.version, createdAt: original.chain.createdAt } : { id: chainId, version: 1 }),
      type: prepared.chain.type === 'dca' && index < prepared.steps.length - 1 ? 'exchange' as const : prepared.chain.type,
      bookValueInBase: index === prepared.steps.length - 1 ? prepared.chain.bookValueInBase : undefined,
      relatedDcaExecutionId: reusesChain ? original.chain.relatedDcaExecutionId : undefined,
      operationId: operation.id, operationOrder: index };
    // A shared editor must not overwrite segment-specific facts when only text changes.
    if (reusesChain && existing) {
      const first = existing.conversions[0]!.chain;
      const last = existing.conversions.at(-1)!.chain;
      if (prepared.chain.date === first.date && prepared.chain.time === first.time && prepared.chain.timezone === first.timezone) {
        Object.assign(chain, { date: original.chain.date, time: original.chain.time, timezone: original.chain.timezone,
          timePrecision: original.chain.timePrecision, timeDisambiguation: original.chain.timeDisambiguation });
      }
      if (prepared.chain.type === last.type) chain.type = original.chain.type;
      if (prepared.chain.bookValueInBase === last.bookValueInBase) chain.bookValueInBase = original.chain.bookValueInBase;
      if (prepared.chain.lotMethod === first.lotMethod) chain.lotMethod = original.chain.lotMethod;
      if (JSON.stringify(prepared.chain.manualLotIds) === JSON.stringify(first.manualLotIds)) chain.manualLotIds = original.chain.manualLotIds;
    }
    Object.assign(chain, normalizeOccurrence(chain));
    const child = { ...step, chainId, order: 1 };
    const supplied = prepared.chain.costQuotes?.find((quote) => quote.stepId === step.id);
    const fresh = freezeConversionQuote(child, chain.occurredAtUtc!, chain.baseCurrencyAssetId,
      supplied ? { valueInBase: supplied.valueInBase, source: supplied.source, priceMarkIds: supplied.priceMarkIds, quoteDate: supplied.quoteDate, explanation: supplied.explanation }
        : chain.bookValueInBase ? { valueInBase: chain.bookValueInBase, source: 'manual', priceMarkIds: [] } : undefined);
    const previous = original?.chain.costQuotes?.find((quote) => quote.stepId === step.id);
    chain.costQuotes = [previous && previous.dependencyFingerprint === fresh.dependencyFingerprint
      && previous.valueInBase === fresh.valueInBase && previous.source === fresh.source
      && JSON.stringify(previous.priceMarkIds) === JSON.stringify(fresh.priceMarkIds)
      && JSON.stringify(previous.feeValues) === JSON.stringify(fresh.feeValues) ? previous : fresh];
    return { chain, steps: [child] };
  });
  return { operation: { ...operation, title: prepared.chain.title, chainIds: conversions.map(({ chain }) => chain.id) }, conversions, links: input.links, dcaPlanId: input.dcaPlanId };
}
