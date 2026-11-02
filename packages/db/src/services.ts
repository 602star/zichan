/**
 * Application services (use-cases) over the LedgerStore. These wrap the core
 * calculations + persistence into reusable operations, so UIs (and the seed)
 * don't re-implement business logic. Previously this lived inline in the web
 * seed; now it's one tested place.
 */
import {
  D, endOfMonth, isValidDay,
  componentHostAt,
  defaultTransactionAccount, isDefaultAccount, accountTransactionPostings, Decimal, traceChain, conversionStepAmounts, assertConversionShape, matchSell, lotFromTrace, isTransactionActive, newId, refundAppliedAmount,
  assertDcaExecutionShape, assertDcaPlanShape, assertTransactionShape, dcaOccurrenceDate, transactionReportingEffect,
  normalizeOccurrence, canonicalJson, conversionFinancialFingerprint, assertCostBasisOpening, usesAssetCostState, assetCostSourceSummary, freezeConversionQuote, dayOfInstant,
  listScheduleOccurrences, nextUnhandledScheduleOccurrence, postingsFromTransaction,
  scheduleExecutionId, scheduleOccurrenceDate, scheduleOccurrenceIsDue, scheduledTransactionId, zonedCalendarNow,
  DEFAULT_ENABLED_CATEGORY_IDS,
  systemCategory,
  type ChainWithSteps, type ConversionChain, type ConversionStep,
  type DcaExecution, type DcaPlan,
  type Lot, type LotConsumption, type LotMethod, type SellMatchResult,
  type Account, type Asset, type Attachment, type BudgetCategory, type Category, type FixedAsset, type FixedAssetCategory,
  type Game, type GameAccount, type GameSeason, type Payee, type ReconciliationItem, type ReconciliationSession,
  type ScheduledExecution, type ScheduledTransaction, type Transaction, type TransactionCategory,
  type TransactionLocation, type TransactionSavedView, type TransactionSplit, type TransactionTag, type TransactionTemplate,
  type TransactionType,
  type FixedAssetCashflowDirection,
  type FixedAssetCashflowLink,
  type FixedAssetCashflowMode,
  type FixedAssetConsumable,
  type FixedAssetEvent,
  type FixedAssetGoal,
  type FixedAssetUsageLog,
  type FixedAssetUsageMetric,
  type FixedEventType,
  type GameCashflowDirection,
  type GameCashflowLink,
  type GameCashflowMode,
  type GameCashflowRole,
  type GameRecord,
  type GameRecordType,
  type RefundAllocation,
  type BaseEntity,
  type Collection,
  type ScheduleOccurrence,
} from '@zichan/core';
import { ConcurrencyError, isScheduledExecutionClaim, type SqlLedgerStore } from './repository.js';
import type {
  BusinessCompensationRecord,
  CompensationEntityState,
} from './business-compensation.js';
import { DomainValidationError } from './domain-errors.js';
import { readAssetCostState } from './asset-cost-service.js';
import {
  validateAssetMutationSnapshot,
  validateCategoryHierarchySnapshot,
} from './domain-validation.js';
export { DomainValidationError } from './domain-errors.js';

const SCHEDULE_SCAN_CHUNK = 1_000;
const MAX_SCHEDULE_OCCURRENCES = 100_000;
const MAX_SCHEDULE_ACTIONS_PER_RUN = 100;
const SCHEDULE_CLAIM_LEASE_MS = 2 * 60_000;
const SCHEDULE_CLAIM_WAIT_MS = 5_000;

class ScheduledExecutionUnavailableError extends Error {
  readonly code = 'SCHEDULED_EXECUTION_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'ScheduledExecutionUnavailableError';
  }
}

async function waitForScheduledClaim(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

// ─────────────────────────── record a conversion ───────────────────────────

export interface RecordConversionInput {
  chain: ConversionChain;
  steps: ConversionStep[];
}

export interface RecordConversionResult {
  chain: ConversionChain;
  lot?: Lot;
}

export interface ConversionImpactPreview {
  chains: number;
  lots: number;
  consumptions: number;
  fromDate: string;
}

export interface UpdateConversionInput extends RecordConversionInput {
  expectedVersion?: number;
}

export interface ConversionMetadataUpdate {
  chainId: string;
  expectedVersion: number;
  title?: string;
  note?: string;
  steps?: { id: string; platform?: string; note?: string; fees?: { id: string; note?: string }[] }[];
}

/** Metadata-only changes retain every frozen value and derived cost result. */
export async function updateConversionMetadata(store: SqlLedgerStore, input: ConversionMetadataUpdate): Promise<RecordConversionResult> {
  return store.transaction(async (transactionStore) => {
    const current = await transactionStore.getChainWithSteps(input.chainId);
    if (!current || current.chain.isDeleted) throw new Error('资产转换不存在');
    if (current.chain.version !== input.expectedVersion) throw new ConcurrencyError('conversion_chain', input.chainId, input.expectedVersion, current.chain.version);
    if (current.chain.operationId) throw new Error('连续转换必须整组编辑');
    if (current.chain.recordState === 'voided') throw new Error('已作废的资产转换不能编辑，请先恢复');
    const stepIds = new Set(current.steps.map((step) => step.id));
    if (input.steps?.some((step) => !stepIds.has(step.id)) || new Set(input.steps?.map((step) => step.id)).size !== (input.steps?.length ?? 0)) throw new Error('文字修改引用了无效或重复步骤');
    const chain = { ...current.chain, ...('title' in input ? { title: input.title?.trim() || undefined } : {}),
      ...('note' in input ? { note: input.note?.trim() || undefined } : {}) };
    const steps = current.steps.map((step) => {
      const patch = input.steps?.find((row) => row.id === step.id);
      if (patch?.fees?.some((fee) => !step.fees?.some((before) => before.id === fee.id))
        || new Set(patch?.fees?.map((fee) => fee.id)).size !== (patch?.fees?.length ?? 0)) throw new Error('手续费备注引用无效或重复');
      const fees = step.fees?.map((fee) => {
        const metadata = patch?.fees?.find((row) => row.id === fee.id);
        return metadata ? { ...fee, note: metadata.note?.trim() || undefined } : fee;
      });
      return { ...step, ...(step.fees ? { fees } : {}), ...(patch && 'platform' in patch ? { platform: patch.platform?.trim() || undefined } : {}),
        ...(patch && 'note' in patch ? { note: patch.note?.trim() || undefined } : {}) };
    });
    if (canonicalJson({ chain, steps }) === canonicalJson(current)) return { chain: current.chain };
    return transactionStore.runInAuditBatch('更新资产转换说明', async (batch) => {
      const saved = await batch.saveChainWithSteps(chain, steps);
      return { chain: saved.chain };
    });
  });
}

function conversionOrder(a: ConversionChain, b: ConversionChain): number {
  return a.date.localeCompare(b.date)
    || (a.time ?? '').localeCompare(b.time ?? '')
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
}

function conversionBusinessEqual(a: object, b: object, keys: string[]): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return keys.every((key) => JSON.stringify(left[key] ?? null) === JSON.stringify(right[key] ?? null));
}

function validateConversionInput(chain: ConversionChain, steps: ConversionStep[]): void {
  assertConversionShape(chain, steps);
}

async function validateConversionReferences(store: SqlLedgerStore, chain: ConversionChain, steps: ConversionStep[]): Promise<ConversionChain> {
  const occurrence = normalizeOccurrence(chain);
  const previous = await store.getChainWithSteps(chain.id);
  await requireAsset(store, chain.baseCurrencyAssetId, 'baseCurrencyAssetId', previous?.chain.baseCurrencyAssetId === chain.baseCurrencyAssetId);
  for (const [index, step] of steps.entries()) {
    const old = previous?.steps.find((row) => row.id === step.id);
    const from = await requireAsset(store, step.fromAssetId, `steps.${index}.fromAssetId`, old?.fromAssetId === step.fromAssetId);
    const to = await requireAsset(store, step.toAssetId, `steps.${index}.toAssetId`, old?.toAssetId === step.toAssetId);
    if (amountPrecision(step.fromAmount) > from.decimals) validation(`步骤 ${index + 1} 转出金额精度超过 ${from.code} 的限制`);
    if (amountPrecision(step.toAmount) > to.decimals) validation(`步骤 ${index + 1} 转入金额精度超过 ${to.code} 的限制`);
    await requireAccount(store, step.accountFromId, `steps.${index}.accountFromId`, false, old?.accountFromId === step.accountFromId);
    await requireAccount(store, step.accountToId, `steps.${index}.accountToId`, false, old?.accountToId === step.accountToId);
    for (const fee of step.fees ?? []) {
      const oldFee = old?.fees?.find((row) => row.id === fee.id);
      const feeAsset = await requireAsset(store, fee.assetId, `steps.${index}.fees`, oldFee?.assetId === fee.assetId);
      if (!D(fee.amount).gt(0) || amountPrecision(fee.amount) > feeAsset.decimals) validation(`步骤 ${index + 1} 手续费金额无效`);
      await requireAccount(store, fee.accountId, `steps.${index}.fees.accountId`, false, oldFee?.accountId === fee.accountId);
    }
  }
  const normalized = { ...chain, ...occurrence };
  const opening = (await store.costBasisOpenings.list()).sort((a, b) => Date.parse(b.occurredAtUtc) - Date.parse(a.occurredAtUtc))[0];
  if (opening && (normalized.occurredAtUtc ? Date.parse(normalized.occurredAtUtc) > Date.parse(opening.occurredAtUtc) : chain.date >= dayOfInstant(opening.occurredAtUtc, opening.timezone ?? 'UTC'))) {
    if (!normalized.occurredAtUtc) validation('成本起点之后的转换需要准确时间', 'time');
    if (chain.baseCurrencyAssetId !== opening.baseCurrencyAssetId) validation('本账本已冻结成本核算币种；变更前请确认新的成本起点', 'baseCurrencyAssetId');
    if (normalized.costQuotes === undefined) normalized.costQuotes = steps.map((step) => freezeConversionQuote(step, normalized.occurredAtUtc!, opening.baseCurrencyAssetId,
      steps.length === 1 && chain.bookValueInBase ? { source: 'manual', valueInBase: chain.bookValueInBase, priceMarkIds: [] } : undefined));
  }
  return normalized;
}

const CHAIN_CACHE_KEYS = [
  'finalAssetId', 'finalAmount', 'totalBaseCost', 'totalBaseProceeds', 'totalFeesInBase', 'realizedGainLoss',
];
const LOT_KEYS = [
  'assetId', 'sourceChainId', 'sourceDcaExecutionId', 'acquiredDate', 'originalAmount', 'baseCost',
  'baseCurrencyAssetId', 'nativeCostAssetId', 'nativeCostAmount', 'remainingAmount', 'status', 'isDeleted',
];
const CONSUMPTION_KEYS = [
  'lotId', 'sellChainId', 'consumedAmount', 'allocatedCostBase', 'proceedsBase', 'realizedPnlBase', 'isDeleted',
];

/** Rebuild every lot and sell consumption from active conversion aggregates. */
export async function rebuildConversionDerivedInTransaction(store: SqlLedgerStore): Promise<void> {
  const costState = await readAssetCostState(store);
  const chains = (await store.conversionChains.list())
    .filter((chain) => chain.recordState !== 'voided')
    .sort(conversionOrder);
  const stepsByChain = await store.listStepsByChains(chains.map((chain) => chain.id));
  const aggregates: ChainWithSteps[] = chains.map((chain) => ({ chain, steps: stepsByChain.get(chain.id) ?? [] }));

  const oldLots = await store.lots.list({ includeDeleted: true });
  const oldConsumptions = await store.lotConsumptions.list({ includeDeleted: true });
  const oldLotsById = new Map(oldLots.map((row) => [row.id, row]));
  const oldConsumptionsById = new Map(oldConsumptions.map((row) => [row.id, row]));
  const lotBySource = new Map<string, Lot>();
  for (const lot of oldLots.filter((row) => row.sourceChainId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!lotBySource.has(lot.sourceChainId!)) lotBySource.set(lot.sourceChainId!, lot);
  }
  const consumptionByPair = new Map(oldConsumptions.map((row) => [`${row.sellChainId}\u0000${row.lotId}`, row]));
  const desiredLots = new Map<string, Lot>();
  const desiredConsumptions = new Map<string, LotConsumption>();
  const workingLots = new Map<string, Lot>();
  const cacheByChain = new Map<string, Partial<ConversionChain>>();

  for (const aggregate of aggregates) {
    const { chain, steps } = aggregate;
    validateConversionInput(chain, steps);
    const trace = traceChain(aggregate);
    if (usesAssetCostState(costState, chain)) {
      const acquired = costState.events.find((event) => event.eventId === `${steps.at(-1)!.id}:2-target`);
      const pnl = assetCostSourceSummary(costState, chain.id);
      cacheByChain.set(chain.id, { finalAssetId: trace.finalAssetId, finalAmount: trace.finalAmount,
        totalBaseCost: acquired?.costInBase ?? undefined, totalBaseProceeds: chain.type === 'sell' ? trace.totalBaseProceeds : undefined,
        totalFeesInBase: trace.totalFeesInBase, realizedGainLoss: pnl.realizedGainLoss ?? undefined });
      continue;
    }
    if (chain.type === 'buy' || chain.type === 'dca') {
      if (D(trace.totalBaseCost).lte(0)) throw new Error(`转换“${chain.title ?? chain.date}”没有形成账面成本`);
      const old = lotBySource.get(chain.id);
      cacheByChain.set(chain.id, {
        finalAssetId: trace.finalAssetId,
        finalAmount: trace.finalAmount,
        totalBaseCost: trace.totalBaseCost,
        totalBaseProceeds: undefined,
        totalFeesInBase: trace.totalFeesInBase,
        realizedGainLoss: undefined,
      });
      if (D(trace.finalAmount).isZero()) {
        throw new Error(`转换"${chain.title ?? chain.date}"：买入金额被手续费全部消耗，未产生有效持仓。请检查手续费设置或调整为非买入类型。`);
      }
      const generated = lotFromTrace(trace, { sourceChainId: chain.id, acquiredDate: chain.date });
      const lot: Lot = {
        ...generated,
        id: old?.id ?? generated.id,
        createdAt: old?.createdAt ?? generated.createdAt,
        updatedAt: old?.updatedAt ?? generated.updatedAt,
        version: old?.version ?? generated.version,
        isDeleted: false,
      };
      workingLots.set(lot.id, lot);
      desiredLots.set(lot.id, lot);
      continue;
    }
    if (chain.type === 'sell') {
      const first = steps[0]!;
      if (D(trace.totalBaseProceeds).lte(0)) throw new Error(`卖出“${chain.title ?? chain.date}”没有形成账面收入`);
      const available = [...workingLots.values()].filter((lot) => lot.assetId === first.fromAssetId && D(lot.remainingAmount).gt(0));
      const match = matchSell(available, {
        sellChainId: chain.id,
        assetId: first.fromAssetId,
        baseCurrencyAssetId: chain.baseCurrencyAssetId,
        amount: conversionStepAmounts(first).sourceDebit,
        proceedsBase: trace.totalBaseProceeds,
        method: chain.lotMethod ?? 'fifo',
        selectedLotIds: chain.manualLotIds,
      });
      if (D(match.unmatchedAmount).gt(0)) throw new Error(`卖出“${chain.title ?? chain.date}”超出当时可用持仓 ${match.unmatchedAmount} ${first.fromAssetId}`);
      for (const lot of match.updatedLots) {
        // Closed lots remain in the output, but never need to be scanned by a
        // later sell. Keeping them here made long closed histories quadratic.
        if (D(lot.remainingAmount).gt(0)) workingLots.set(lot.id, lot);
        else workingLots.delete(lot.id);
        desiredLots.set(lot.id, lot);
      }
      for (const generated of match.consumptions) {
        const old = consumptionByPair.get(`${chain.id}\u0000${generated.lotId}`);
        const consumption: LotConsumption = {
          ...generated,
          id: old?.id ?? generated.id,
          createdAt: old?.createdAt ?? generated.createdAt,
          updatedAt: old?.updatedAt ?? generated.updatedAt,
          version: old?.version ?? generated.version,
          isDeleted: false,
        };
        desiredConsumptions.set(consumption.id, consumption);
      }
      cacheByChain.set(chain.id, {
        finalAssetId: trace.finalAssetId,
        finalAmount: trace.finalAmount,
        totalBaseCost: undefined,
        totalBaseProceeds: match.totalProceedsBase,
        totalFeesInBase: trace.totalFeesInBase,
        realizedGainLoss: match.realizedPnlBase,
      });
      continue;
    }

    cacheByChain.set(chain.id, {
      finalAssetId: trace.finalAssetId,
      finalAmount: trace.finalAmount,
      totalBaseCost: trace.totalBaseCost,
      totalBaseProceeds: trace.totalBaseProceeds,
      totalFeesInBase: trace.totalFeesInBase,
      realizedGainLoss: undefined,
    });
  }

  for (const aggregate of aggregates) {
    const patch = cacheByChain.get(aggregate.chain.id)!;
    const next = { ...aggregate.chain, ...patch };
    if (!conversionBusinessEqual(aggregate.chain, next, CHAIN_CACHE_KEYS)) await store.conversionChains.put(next);
  }
  for (const desired of desiredLots.values()) {
    const current = oldLotsById.get(desired.id);
    if (!current || !conversionBusinessEqual(current, desired, LOT_KEYS)) await store.lots.put(desired);
  }
  for (const old of oldLots.filter((row) => !row.isDeleted && !desiredLots.has(row.id))) await store.lots.remove(old.id, old.version);
  for (const desired of desiredConsumptions.values()) {
    const current = oldConsumptionsById.get(desired.id);
    if (!current || !conversionBusinessEqual(current, desired, CONSUMPTION_KEYS)) await store.lotConsumptions.put(desired);
  }
  for (const old of oldConsumptions.filter((row) => !row.isDeleted && !desiredConsumptions.has(row.id))) await store.lotConsumptions.remove(old.id, old.version);

  const chainsById = new Map(chains.map((chain) => [chain.id, chain]));
  for (const execution of await store.dcaExecutions.list({ includeDeleted: true })) {
    if (!execution.chainId) continue;
    const chain = chainsById.get(execution.chainId);
    if (!chain) {
      if (!execution.isDeleted) await store.dcaExecutions.remove(execution.id, execution.version);
      continue;
    }
    if (chain.type !== 'dca') {
      if (!execution.isDeleted) await store.dcaExecutions.remove(execution.id, execution.version);
      continue;
    }
    const finalChain = await store.conversionChains.get(chain.id);
    if (!finalChain) continue;
    const next = {
      ...execution,
      isDeleted: false,
      date: finalChain.date,
      actualBaseCost: finalChain.totalBaseCost ?? (usesAssetCostState(costState, finalChain) ? null : '0'),
      baseCurrencyAssetId: finalChain.baseCurrencyAssetId,
      finalAssetId: finalChain.finalAssetId ?? execution.finalAssetId,
      finalAmount: finalChain.finalAmount ?? execution.finalAmount,
      totalFeeInBase: finalChain.totalFeesInBase ?? '0',
    };
    if (!conversionBusinessEqual(execution, next, ['isDeleted', 'date', 'actualBaseCost', 'baseCurrencyAssetId', 'finalAssetId', 'finalAmount', 'totalFeeInBase'])) {
      await store.dcaExecutions.put(next);
    }
  }
}

export async function rebuildConversionDerived(store: SqlLedgerStore): Promise<void> {
  await store.transaction(rebuildConversionDerivedInTransaction);
}

export async function previewConversionImpact(store: SqlLedgerStore, chain: ConversionChain): Promise<ConversionImpactPreview> {
  const current = await store.conversionChains.get(chain.id);
  const fromDate = current && current.date < chain.date ? current.date : chain.date;
  const chains = (await store.conversionChains.list()).filter((row) => row.date >= fromDate && row.recordState !== 'voided');
  const ids = new Set(chains.map((row) => row.id));
  const lots = (await store.lots.list()).filter((row) => row.sourceChainId && ids.has(row.sourceChainId)).length;
  const consumptions = (await store.lotConsumptions.list()).filter((row) => ids.has(row.sellChainId)).length;
  return { chains: chains.length, lots, consumptions, fromDate };
}

/**
 * Persist a conversion chain, back-fill its derived caches from the trace, and
 * (for buy/dca) create the resulting cost-basis lot.
 */
export async function recordConversion(
  store: SqlLedgerStore,
  input: RecordConversionInput,
): Promise<RecordConversionResult> {
  if (input.chain.operationId) throw new Error('连续转换子记录必须通过整组保存接口提交');
  return store.runInAuditBatch('保存资产转换', async (store) => {
    const chain = await validateConversionReferences(store, { ...input.chain, recordState: input.chain.recordState ?? 'active' }, input.steps);
    validateConversionInput(chain, input.steps);
    await store.saveChainWithSteps(chain, input.steps);
    await rebuildConversionDerivedInTransaction(store);
    const saved = (await store.conversionChains.get(chain.id))!;
    const lot = (await store.lots.list({ where: { sourceChainId: chain.id } }))[0];
    return { chain: saved, lot };
  });
}

// ─────────────────────────── record a sell ───────────────────────────

export interface RecordSellInput {
  chain: ConversionChain;
  steps: ConversionStep[];
  method?: LotMethod; // defaults to the store setting, else 'fifo'
  selectedLotIds?: string[];
}

export interface RecordSellResult {
  chain: ConversionChain;
  match: Omit<SellMatchResult, 'totalCostBase' | 'realizedPnlBase' | 'totalProceedsBase'> & {
    totalCostBase: string | null;
    realizedPnlBase: string | null;
    totalProceedsBase: string | null;
  };
}

/**
 * Persist a sell chain, match it against open lots (FIFO/LIFO/average/manual),
 * write the lot consumptions, update the affected lots, and back-fill the
 * chain's proceeds + realized P&L. The sold asset/amount are taken from step 1.
 */
export async function recordSell(
  store: SqlLedgerStore,
  input: RecordSellInput,
): Promise<RecordSellResult> {
  if (input.chain.operationId) throw new Error('连续转换子记录必须通过整组保存接口提交');
  const first = input.steps[0];
  if (!first) throw new Error('recordSell: a sell needs at least one step');

  const method = input.method ?? (await defaultMethod(store));
  return store.runInAuditBatch('保存资产卖出', async (store) => {
    let chain: ConversionChain = {
      ...input.chain,
      recordState: input.chain.recordState ?? 'active',
      lotMethod: method,
      manualLotIds: method === 'manual' ? input.selectedLotIds : undefined,
    };
    chain = await validateConversionReferences(store, chain, input.steps);
    validateConversionInput(chain, input.steps);
    await store.saveChainWithSteps(chain, input.steps);
    await rebuildConversionDerivedInTransaction(store);
    const saved = (await store.conversionChains.get(chain.id))!;
    const consumptions = await store.lotConsumptions.list({ where: { sellChainId: chain.id } });
    const updatedLots = (await store.lots.list()).filter((lot) => consumptions.some((row) => row.lotId === lot.id));
    const state = await readAssetCostState(store);
    const summary = usesAssetCostState(state, saved) ? assetCostSourceSummary(state, saved.id) : undefined;
    const mainRows = state?.consumptions.filter((row) => row.eventId === `${first.id}:0-source`) ?? [];
    const match: RecordSellResult['match'] = {
      consumptions,
      updatedLots,
      totalCostBase: summary ? summary.costInBase : consumptions.reduce((total, row) => total.plus(row.allocatedCostBase), D(0)).toString(),
      totalProceedsBase: summary ? mainRows.every((row) => row.proceedsInBase !== null) ? mainRows.reduce((total, row) => total.plus(row.proceedsInBase!), D(0)).toString() : null : saved.totalBaseProceeds ?? '0',
      realizedPnlBase: summary ? summary.realizedGainLoss : saved.realizedGainLoss ?? null,
      unmatchedAmount: summary?.gapQuantity ?? '0',
    };
    return { chain: saved, match };
  });
}

export async function updateConversion(store: SqlLedgerStore, input: UpdateConversionInput): Promise<RecordConversionResult | RecordSellResult> {
  const current = await store.conversionChains.get(input.chain.id);
  if (!current || current.isDeleted) throw new Error('资产转换不存在');
  if (current.operationId) throw new Error('连续转换子记录不能独立编辑');
  if (current.recordState === 'voided') throw new Error('已作废的资产转换不能编辑，请先恢复');
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) throw new Error('资产转换已被其他操作修改，请刷新后重试');
  const oldSteps = await store.listStepsByChain(current.id);
  if (conversionFinancialFingerprint({ chain: current, steps: oldSteps }) === conversionFinancialFingerprint(input)) {
    return updateConversionMetadata(store, { chainId: current.id, expectedVersion: input.expectedVersion ?? input.chain.version,
      title: input.chain.title, note: input.chain.note, steps: input.steps.map(({ id, platform, note, fees }) => ({ id, platform, note, fees: fees?.map(({ id, note }) => ({ id, note })) })) });
  }
  const chain = {
    ...input.chain,
    id: current.id,
    createdAt: current.createdAt,
    recordState: current.recordState ?? 'active',
    voidedAt: current.voidedAt,
    voidReason: current.voidReason,
    version: input.expectedVersion ?? input.chain.version,
  };
  return chain.type === 'sell'
    ? recordSell(store, { chain, steps: input.steps, method: chain.lotMethod, selectedLotIds: chain.manualLotIds })
    : recordConversion(store, { chain, steps: input.steps });
}

async function defaultMethod(store: SqlLedgerStore): Promise<LotMethod> {
  const settings = await store.settings.list();
  return settings[0]?.defaultLotMethod ?? 'fifo';
}

// ─────────────────────────── transaction lifecycle ───────────────────────────

function activeRefunds(rows: Transaction[], originalId: string, excludingId?: string): Transaction[] {
  return rows.filter((row) => row.id !== excludingId
    && row.type === 'refund'
    && row.refundForId === originalId
    && isTransactionActive(row));
}

function transactionFinancialChanged(before: Transaction, after: Transaction): boolean {
  const financial = [
    'date', 'time', 'timezone', 'balanceTiming', 'balanceTimingAccountId', 'type', 'amount', 'assetId', 'accountId', 'transferAssetId', 'transferAccountId',
    'transferAmount', 'refundForId', 'refundAppliedAmount', 'refundAppliedAssetId', 'recordState',
    'adjustmentDirection', 'reconciliationSessionId', 'reportingTreatment',
  ];
  for (const key of financial) {
    const a = (before as unknown as Record<string, unknown>)[key];
    const b = (after as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) return true;
  }
  return false;
}

export async function isTransactionReconciled(store: SqlLedgerStore, transactionId: string): Promise<boolean> {
  const items = await store.reconciliationItems.list({ where: { transactionId } });
  for (const item of items) {
    const session = await store.reconciliationSessions.get(item.reconciliationId);
    if (session && !session.isDeleted && session.status === 'closed') return true;
  }
  return false;
}

export interface SaveTransactionAggregateInput {
  transaction: Transaction;
  splits?: TransactionSplit[];
  refundAllocations?: RefundAllocationDraft[];
  expectedVersion?: number;
}

export interface RefundAllocationDraft {
  sourceSplitId?: string;
  amount: string;
}

export interface SavedTransactionAggregate {
  transaction: Transaction;
  splits: TransactionSplit[];
  refundAllocations: RefundAllocation[];
}

function validation(message: string, field?: string): never {
  throw new DomainValidationError(message, field);
}

function amountPrecision(value: string): number {
  try {
    return D(value).decimalPlaces();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// 已发布账本里存着这个字面量（`categories.archive_reason`），改名需要迁移旧数据，
// 因此内部标记保留原值；它不面向用户展示，UI 文案统一叫「扩展包」。
const SYSTEM_CATEGORY_PACK_DISABLED_REASON = '系统分类包停用';

export async function enableSystemCategory(
  store: SqlLedgerStore,
  id: string,
  options: { restorePackDisabled?: boolean; makeVisible?: boolean } = {},
): Promise<Category> {
  const existing = await store.categories.get(id);
  if (existing) {
    if (existing.isDeleted || existing.mergedIntoId) {
      validation(`分类已归档，不能由系统目录自动启用：${id}`, 'category');
    }
    if (existing.isActive) {
      // 已启用的分类保留用户自己选的可见性：启用扩展包只负责补齐目录项，
      // 不应该把用户在「快捷显示与排序」里主动隐藏的分类重新拉回常用列表。
      return existing;
    }
    if (!options.restorePackDisabled || existing.archiveReason !== SYSTEM_CATEGORY_PACK_DISABLED_REASON) {
      validation(`分类已归档，不能由系统目录自动启用：${id}`, 'category');
    }
    return store.categories.put({
      ...existing,
      isActive: true,
      isHidden: options.makeVisible ? false : existing.isHidden,
      archivedAt: undefined,
      archiveReason: undefined,
    });
  }
  const catalog = systemCategory(id, false);
  if (!catalog) validation(`系统分类目录中不存在：${id}`, 'category');
  if (catalog.parentId) await enableSystemCategory(store, catalog.parentId, options);
  return store.categories.put({ ...catalog, isHidden: options.makeVisible ? false : catalog.isHidden });
}

/** 启用扩展包：补齐包内扩展分类，并恢复此前被扩展包停用的项。 */
export async function enableSystemCategories(
  store: SqlLedgerStore,
  ids: readonly string[],
): Promise<Category[]> {
  return store.runInAuditBatch(`启用扩展包 ${ids.length} 项`, async (transactionStore) => {
    const rows: Category[] = [];
    for (const id of [...new Set(ids)]) {
      rows.push(await enableSystemCategory(transactionStore, id, { restorePackDisabled: true, makeVisible: true }));
    }
    return rows;
  });
}

export interface DisabledSystemCategoriesResult {
  disabledIds: string[];
  retainedUsedIds: string[];
  /** 默认分类不受扩展包控制，被跳过的项（正常情况下不会出现）。 */
  retainedDefaultIds: string[];
  /** 仍被其他已启用扩展包引用的共享成员，保留可用。 */
  retainedSharedIds: string[];
  /** 账本里根本不存在的成员：不会为了停用而先创建它。 */
  missingIds: string[];
}

/**
 * 停用扩展包。
 *
 * 只处理包内的扩展分类，并且：
 * - 默认分类永远不停用（它们不属于任何扩展包）；
 * - 仍被其他已启用扩展包引用的共享成员不停用（`options.retainIds`）；
 * - 未落库的成员直接跳过，不为“停用”写一行幽灵数据。
 */
export async function disableSystemCategories(
  store: SqlLedgerStore,
  ids: readonly string[],
  options: { retainIds?: readonly string[] } = {},
): Promise<DisabledSystemCategoriesResult> {
  const retain = new Set(options.retainIds ?? []);
  return store.runInAuditBatch(`停用扩展包 ${ids.length} 项`, async (transactionStore) => {
    const result: DisabledSystemCategoriesResult = {
      disabledIds: [], retainedUsedIds: [], retainedDefaultIds: [], retainedSharedIds: [], missingIds: [],
    };
    const archivedAt = new Date().toISOString();
    for (const id of [...new Set(ids)]) {
      if (DEFAULT_ENABLED_CATEGORY_IDS.has(id)) {
        result.retainedDefaultIds.push(id);
        continue;
      }
      const category = await transactionStore.categories.get(id);
      if (!category || category.isDeleted || category.mergedIntoId) {
        result.missingIds.push(id);
        continue;
      }
      if (!category.isActive) {
        if (category.archiveReason === SYSTEM_CATEGORY_PACK_DISABLED_REASON) result.disabledIds.push(id);
        continue;
      }
      if (retain.has(id)) {
        result.retainedSharedIds.push(id);
        continue;
      }
      const impact = await previewMasterDataChange(transactionStore, 'category', id);
      if (impact.total > 0) result.retainedUsedIds.push(id);
      await transactionStore.categories.put({
        ...category,
        isActive: false,
        isHidden: true,
        archivedAt,
        archiveReason: SYSTEM_CATEGORY_PACK_DISABLED_REASON,
      });
      result.disabledIds.push(id);
    }
    return result;
  });
}

/**
 * 修复历史缺陷：早期版本的分类包把默认分类也当作成员，「停用」会把它们一起停用，
 * 且没有任何记录说明这件事是分类包做的。默认分类被停用后既不出现在新增记账，也不在
 * 「快捷显示与排序」里，用户只能到结构管理逐个找回。
 *
 * 只恢复「默认分类 + 停用原因正好是分类包停用」的行：用户自己归档（原因是「用户归档」）
 * 或已合并的分类不受影响，所以重复执行是安全的。
 */
export async function restoreMisdisabledDefaultCategories(store: SqlLedgerStore): Promise<string[]> {
  const rows = await store.categories.list();
  const damaged = rows.filter((category) =>
    !category.isDeleted
    && !category.mergedIntoId
    && category.isActive === false
    && category.archiveReason === SYSTEM_CATEGORY_PACK_DISABLED_REASON
    && DEFAULT_ENABLED_CATEGORY_IDS.has(category.id));
  if (!damaged.length) return [];
  return store.runInAuditBatch(`恢复被分类包误停用的默认分类 ${damaged.length} 项`, async (transactionStore) => {
    for (const category of damaged) {
      const catalog = systemCategory(category.id, false);
      await transactionStore.categories.put({
        ...category,
        isActive: true,
        isHidden: catalog ? catalog.isHidden : false,
        archivedAt: undefined,
        archiveReason: undefined,
      });
    }
    return damaged.map((category) => category.id);
  });
}

async function requireAsset(store: SqlLedgerStore, id: string, field: string, retained = false) {
  const asset = await store.assets.get(id);
  if (!asset || asset.isDeleted || (!retained && !asset.isActive)) validation(`引用的资产不存在或已停用：${id}`, field);
  return asset;
}

async function requireAccount(store: SqlLedgerStore, id: string | undefined, field: string, required: boolean, retained = false) {
  if (!id) {
    if (required) validation('请选择账户', field);
    return undefined;
  }
  const account = await store.accounts.get(id);
  if (!account || account.isDeleted || (!retained && account.isActive === false)) validation(`引用的账户不存在或已归档：${id}`, field);
  return account;
}

async function requireLeafCategory(
  store: SqlLedgerStore,
  id: string,
  expectedType: Category['type'],
  field = 'category',
): Promise<Category> {
  const category = await store.categories.get(id) ?? await enableSystemCategory(store, id);
  if (!category || category.isDeleted || !category.isActive || category.mergedIntoId) validation(`分类不存在或已归档：${id}`, field);
  if (!category.parentId) validation('请选择二级分类，不能直接选择一级分类', field);
  if (category.type !== expectedType) validation('分类与收支类型不匹配', field);
  const parent = await store.categories.get(category.parentId);
  if (!parent || parent.isDeleted || !parent.isActive || parent.type !== expectedType || parent.parentId) {
    validation('二级分类的一级分类无效或类型不一致', field);
  }
  const children = await store.categories.list({ where: { parentId: category.id } });
  if (children.some((row) => row.isActive && !row.isDeleted)) validation('流水分类必须是分类树的叶子节点', field);
  return category;
}

async function categoryPath(store: SqlLedgerStore, category: Category): Promise<string> {
  const parent = category.parentId ? await store.categories.get(category.parentId) : null;
  return parent ? `${parent.name} / ${category.name}` : category.name;
}

async function validateTransactionReferences(store: SqlLedgerStore, transaction: Transaction): Promise<void> {
  try {
    assertTransactionShape(transaction);
  } catch (error) {
    validation(error instanceof Error ? error.message : '流水枚举值无效');
  }
  const asset = await requireAsset(store, transaction.assetId, 'assetId');
  if (amountPrecision(transaction.amount) > asset.decimals) validation(`金额最多支持 ${asset.decimals} 位小数`, 'amount');
  const setting = (await store.settings.list())[0];
  const accountRequired = (setting?.ledgerMode ?? 'spending') !== 'spending';

  if (transaction.type === 'transfer') {
    await requireAccount(store, transaction.accountId, 'accountId', true);
    await requireAccount(store, transaction.transferAccountId, 'transferAccountId', true);
    if (transaction.accountId === transaction.transferAccountId) validation('转出和转入账户不能相同', 'transferAccountId');
    const targetAsset = await requireAsset(store, transaction.transferAssetId ?? '', 'transferAssetId');
    const transferAmount = D(transaction.transferAmount ?? 0);
    if (!transferAmount.gt(0)) validation('转入金额必须大于 0', 'transferAmount');
    if (amountPrecision(transferAmount.toString()) > targetAsset.decimals) validation(`转入金额最多支持 ${targetAsset.decimals} 位小数`, 'transferAmount');
  } else {
    await requireAccount(store, transaction.accountId, 'accountId', accountRequired || transaction.type === 'adjustment');
  }

  if (transaction.payeeId) {
    const payee = await store.payees.get(transaction.payeeId);
    if (!payee || payee.isDeleted || !payee.isActive || payee.mergedIntoId) validation('商户不存在或已归档', 'payeeId');
  }
  if (transaction.locationId) {
    const location = await store.transactionLocations.get(transaction.locationId);
    if (!location || location.isDeleted || !location.isActive) validation('地点不存在或已停用', 'locationId');
  }
  for (const tagId of transaction.tagIds ?? []) {
    const tag = await store.transactionTags.get(tagId);
    if (!tag || tag.isDeleted || !tag.isActive) validation(`标签不存在或已停用：${tagId}`, 'tagIds');
  }
}

async function normalizeSplits(
  store: SqlLedgerStore,
  transaction: Transaction,
  input: TransactionSplit[],
  current: TransactionSplit[],
): Promise<TransactionSplit[]> {
  if (transaction.type === 'transfer' || transaction.type === 'adjustment' || transaction.type === 'refund') return [];
  const manual = input.filter((row) => !row.isDeleted && !row.isRemainder);
  if (!manual.length) return [];
  const ids = new Set<string>();
  let total = D(0);
  for (const split of manual) {
    if (ids.has(split.id)) validation('拆分项目 ID 重复', 'splits');
    ids.add(split.id);
    const amount = D(split.amount);
    if (!amount.gt(0)) validation('拆分金额必须大于 0', 'splits');
    if (amountPrecision(amount.toString()) > (await requireAsset(store, transaction.assetId, 'assetId')).decimals) {
      validation('拆分金额精度超过交易币种精度', 'splits');
    }
    await requireLeafCategory(store, split.category, transaction.type, 'splits');
    total = total.plus(amount);
  }
  if (total.gt(transaction.amount)) validation('拆分金额合计不能超过流水金额', 'splits');
  const normalized = manual.map((row) => ({ ...row, transactionId: transaction.id, amount: D(row.amount).toString(), isRemainder: false }));
  const remainder = D(transaction.amount).minus(total);
  if (remainder.gt(0)) {
    const existing = current.find((row) => row.isRemainder);
    normalized.push({
      id: existing?.id ?? newId(),
      createdAt: existing?.createdAt ?? '',
      updatedAt: existing?.updatedAt ?? '',
      version: existing?.version ?? 1,
      isDeleted: false,
      transactionId: transaction.id,
      category: transaction.category,
      amount: remainder.toString(),
      isRemainder: true,
      note: '未拆分余额',
    });
  }
  const exact = normalized.reduce((sum, row) => sum.plus(row.amount), D(0));
  if (!exact.eq(transaction.amount)) validation('拆分金额合计必须等于流水金额', 'splits');
  return normalized;
}

interface RefundSourceRow {
  sourceSplitId?: string;
  category: Category;
  amount: Decimal;
  available: Decimal;
}

async function refundSourceRows(
  store: SqlLedgerStore,
  original: Transaction,
  excludingRefundId: string,
): Promise<RefundSourceRow[]> {
  const splits = await store.transactionSplits.list({ where: { transactionId: original.id } });
  const source: Omit<RefundSourceRow, 'available'>[] = splits.length
    ? await Promise.all(splits.map(async (split) => ({
      sourceSplitId: split.id,
      category: await requireLeafCategory(store, split.category, 'expense'),
      amount: D(split.amount),
    })))
    : [{ category: await requireLeafCategory(store, original.category, 'expense'), amount: D(original.amount) }];
  const allAllocations = await store.refundAllocations.list({ where: { sourceTransactionId: original.id } });
  const refunds = new Map((await store.transactions.list({ includeDeleted: true })).map((row) => [row.id, row]));
  return source.map((row) => {
    const used = allAllocations
      .filter((allocation) => {
        const refund = refunds.get(allocation.refundTransactionId);
        return allocation.refundTransactionId !== excludingRefundId
          && (allocation.sourceSplitId ?? '') === (row.sourceSplitId ?? '')
          && !!refund
          && isTransactionActive(refund);
      })
      .reduce((sum, allocation) => sum.plus(allocation.amount), D(0));
    const available = row.amount.minus(used);
    if (available.lt(0)) validation('原支出的退款分配已经超过对应拆分项目');
    return { ...row, available };
  });
}

function allocationUnits(total: Decimal, rows: RefundSourceRow[], decimals: number): bigint[] {
  const scale = D(10).pow(decimals);
  const totalUnitsDecimal = total.times(scale);
  if (!totalUnitsDecimal.isInteger()) validation(`退款冲减金额最多支持 ${decimals} 位小数`, 'refundAppliedAmount');
  const totalAvailable = rows.reduce((sum, row) => sum.plus(row.available), D(0));
  if (totalAvailable.lt(total)) validation('指定退款项目的可退余额不足', 'refundAllocations');
  const totalUnits = BigInt(totalUnitsDecimal.toFixed(0));
  const parts = rows.map((row, index) => {
    const raw = D(totalUnits.toString()).times(row.available).div(totalAvailable);
    const floor = raw.floor();
    return { index, units: BigInt(floor.toFixed(0)), fraction: raw.minus(floor) };
  });
  let remaining = totalUnits - parts.reduce((sum, part) => sum + part.units, 0n);
  for (const part of [...parts].sort((a, b) => b.fraction.comparedTo(a.fraction) || a.index - b.index)) {
    if (remaining <= 0n) break;
    part.units += 1n;
    remaining -= 1n;
  }
  return parts.sort((a, b) => a.index - b.index).map((part) => part.units);
}

async function buildRefundAllocations(
  store: SqlLedgerStore,
  refund: Transaction,
  original: Transaction,
  requested: RefundAllocationDraft[] | undefined,
  current: RefundAllocation[],
): Promise<RefundAllocation[]> {
  const rows = await refundSourceRows(store, original, refund.id);
  const amount = D(refund.refundAppliedAmount ?? refund.amount);
  const asset = await requireAsset(store, original.assetId, 'refundAppliedAssetId');
  const mode = refund.refundAllocationMode ?? 'proportional';
  const currentBySource = new Map(current.map((row) => [row.sourceSplitId ?? '', row]));
  const base = async (row: RefundSourceRow, value: Decimal): Promise<RefundAllocation> => {
    const existing = currentBySource.get(row.sourceSplitId ?? '');
    return {
      id: existing?.id ?? newId(), createdAt: existing?.createdAt ?? '', updatedAt: existing?.updatedAt ?? '',
      version: existing?.version ?? 1, isDeleted: false, refundTransactionId: refund.id,
      sourceTransactionId: original.id, sourceSplitId: row.sourceSplitId,
      categoryId: row.category.id, categoryPathSnapshot: await categoryPath(store, row.category),
      amount: value.toString(), assetId: original.assetId,
    };
  };

  if (mode === 'specified') {
    if (!requested?.length) validation('指定退款项目模式必须填写退款分配', 'refundAllocations');
    const requestedBySource = new Map<string, Decimal>();
    for (const allocation of requested) {
      const key = allocation.sourceSplitId ?? '';
      if (requestedBySource.has(key)) validation('同一退款项目不能重复分配', 'refundAllocations');
      requestedBySource.set(key, D(allocation.amount));
    }
    const out: RefundAllocation[] = [];
    for (const row of rows) {
      const value = requestedBySource.get(row.sourceSplitId ?? '');
      if (value == null || value.isZero()) continue;
      if (!value.gt(0) || value.gt(row.available)) validation('指定退款金额无效或超过项目可退余额', 'refundAllocations');
      out.push(await base(row, value));
    }
    if (!out.reduce((sum, row) => sum.plus(row.amount), D(0)).eq(amount)) validation('退款分配合计必须等于退款冲减金额', 'refundAllocations');
    if ([...requestedBySource.keys()].some((key) => !rows.some((row) => (row.sourceSplitId ?? '') === key))) {
      validation('指定退款项目不属于原支出', 'refundAllocations');
    }
    return out;
  }

  const availableRows = rows.filter((row) => row.available.gt(0));
  const units = allocationUnits(amount, availableRows, asset.decimals);
  const scale = D(10).pow(asset.decimals);
  const out: RefundAllocation[] = [];
  for (let index = 0; index < availableRows.length; index += 1) {
    const value = D(units[index]!.toString()).div(scale);
    if (value.gt(0)) out.push(await base(availableRows[index]!, value));
  }
  return out;
}

async function replaceTransactionChildren<T extends { id: string; version: number; isDeleted: boolean }>(
  current: T[],
  next: T[],
  put: (row: T) => Promise<T>,
  remove: (id: string, expectedVersion: number) => Promise<void>,
): Promise<T[]> {
  const currentById = new Map(current.map((row) => [row.id, row]));
  const nextIds = new Set(next.map((row) => row.id));
  const saved: T[] = [];
  for (const row of next) {
    const before = currentById.get(row.id);
    saved.push(await put(before ? { ...row, version: row.version } : row));
  }
  for (const row of current) if (!row.isDeleted && !nextIds.has(row.id)) await remove(row.id, row.version);
  return saved;
}

/** Save a transaction, its exact split set, and immutable refund allocation as one command. */
export async function saveTransactionAggregate(
  store: SqlLedgerStore,
  input: SaveTransactionAggregateInput,
): Promise<SavedTransactionAggregate> {
  const existedBeforeSave = await store.transactions.get(input.transaction.id);
  if (!input.transaction.accountId && ['expense', 'income', 'refund'].includes(input.transaction.type)) {
    const original = input.transaction.refundForId ? await store.transactions.get(input.transaction.refundForId) : undefined;
    input = { ...input, transaction: { ...input.transaction, accountId: existedBeforeSave?.accountId ?? original?.accountId ??
      defaultTransactionAccount(await store.accounts.list(), (await store.settings.list())[0], input.transaction.type) } };
  }
  return store.runInAuditBatch(existedBeforeSave ? '保存流水' : '新增流水', async (store) => {
    const existing = await store.transactions.get(input.transaction.id);
    if (existing && transactionFinancialChanged(existing, input.transaction) && await isTransactionReconciled(store, existing.id)) {
      validation('已对账流水不能直接修改，请先解除对账');
    }
    if (existing) {
      const expectedVersion = input.expectedVersion ?? input.transaction.version;
      if (expectedVersion !== input.transaction.version) validation('编辑版本与提交版本不一致，请刷新后重试');
      if (expectedVersion !== existing.version) {
        throw new ConcurrencyError('transaction', input.transaction.id, expectedVersion, existing.version);
      }
    }
    if (!D(input.transaction.amount).gt(0)) validation('金额必须大于 0', 'amount');
    const occurrence = normalizeOccurrence(input.transaction);
    const all = await store.transactions.list({ includeDeleted: true });
    const currentSplits = await store.transactionSplits.list({ where: { transactionId: input.transaction.id }, includeDeleted: true });
    const currentAllocations = await store.refundAllocations.list({ where: { refundTransactionId: input.transaction.id }, includeDeleted: true });
    let next: Transaction = {
      ...input.transaction,
      ...occurrence,
      amount: D(input.transaction.amount).abs().toString(),
      recordState: input.transaction.recordState ?? 'active',
    };

    if (next.type === 'adjustment') {
      if (!next.accountId || !next.reconciliationSessionId || !next.adjustmentDirection) {
        validation('余额调整必须关联账户、对账批次和调整方向');
      }
      next = {
        ...next, category: 'reconciliation_adjustment', transferAssetId: undefined,
        transferAccountId: undefined, transferAmount: undefined, refundForId: undefined,
        refundAppliedAmount: undefined, refundAppliedAssetId: undefined,
        refundAttributionMode: undefined, refundEffectDate: undefined, refundAllocationMode: undefined,
        originalDateSnapshot: undefined, originalAmountSnapshot: undefined,
      };
    } else if (next.type === 'refund') {
      if (!next.refundForId || next.refundForId === next.id) validation('退款必须关联一笔原支出', 'refundForId');
      const original = all.find((row) => row.id === next.refundForId);
      if (!original || !isTransactionActive(original) || original.type !== 'expense') validation('退款只能关联有效的原支出', 'refundForId');
      const applied = D(next.refundAppliedAmount ?? next.amount).abs();
      if (!applied.gt(0)) validation('退款冲减金额必须大于 0', 'refundAppliedAmount');
      // Same asset means the cash that arrived and the amount taken off the
      // original expense are the same number: with no exchange rate between them
      // the two fields can only diverge by mistake, and silently keeping them
      // apart over-offsets the original spending. Only a refund settling in a
      // different asset needs its own 冲减 figure.
      if (next.assetId === original.assetId && !applied.eq(D(next.amount).abs())) {
        validation(
          `退款金额与冲减金额必须一致：两者同为原支出币种时只能填一个数（当前 ${D(next.amount).abs().toString()} 对 ${applied.toString()}）`,
          'refundAppliedAmount',
        );
      }
      const already = activeRefunds(all, original.id, next.id).reduce((total, row) => total.plus(refundAppliedAmount(row)), D(0));
      if (already.plus(applied).gt(original.amount)) {
        validation(`退款冲减超过原支出，最多还可冲减 ${D(original.amount).minus(already).toString()}`, 'refundAppliedAmount');
      }
      const setting = (await store.settings.list())[0];
      const attribution = next.refundAttributionMode ?? existing?.refundAttributionMode ?? setting?.refundAttributionMode ?? 'original_date';
      next = {
        ...next,
        category: original.category,
        refundAppliedAmount: applied.toString(),
        refundAppliedAssetId: original.assetId,
        refundAttributionMode: attribution,
        refundEffectDate: attribution === 'original_date' ? original.date : next.date,
        refundAllocationMode: next.refundAllocationMode ?? existing?.refundAllocationMode ?? 'proportional',
        originalDateSnapshot: original.date,
        originalAmountSnapshot: original.amount,
        transferAssetId: undefined,
        transferAccountId: undefined,
        transferAmount: undefined,
      };
    } else {
      next = {
        ...next,
        adjustmentDirection: undefined,
        reconciliationSessionId: undefined,
        refundForId: undefined,
        refundAppliedAmount: undefined,
        refundAppliedAssetId: undefined,
        refundAttributionMode: undefined,
        refundEffectDate: undefined,
        refundAllocationMode: undefined,
        originalDateSnapshot: undefined,
        originalAmountSnapshot: undefined,
      };
      if (next.type === 'transfer') {
        next = {
          ...next,
          category: 'transfer',
          transferAssetId: next.transferAssetId || next.assetId,
          transferAmount: D(next.transferAmount ?? next.amount).abs().toString(),
        };
      } else {
        next.transferAssetId = undefined;
        next.transferAccountId = undefined;
        next.transferAmount = undefined;
      }
    }

    if (next.type === 'income' || next.type === 'expense') await requireLeafCategory(store, next.category, next.type);
    if (next.type === 'refund') await requireLeafCategory(store, next.category, 'expense');
    await validateTransactionReferences(store, next);

    if (next.type === 'expense') {
      const refunds = activeRefunds(all, next.id);
      if (refunds.length) {
        const refunded = refunds.reduce((total, row) => total.plus(refundAppliedAmount(row)), D(0));
        if (D(next.amount).lt(refunded)) validation(`支出金额不能低于已退款金额 ${refunded.toString()}`, 'amount');
        if (existing?.assetId !== next.assetId) validation('已有退款的支出不能修改币种，请先作废关联退款', 'assetId');
      }
    }

    const splitInput = input.splits ?? currentSplits.filter((row) => !row.isDeleted);
    const nextSplits = await normalizeSplits(store, next, splitInput, currentSplits);
    let nextAllocations: RefundAllocation[] = [];
    if (next.type === 'refund') {
      const original = all.find((row) => row.id === next.refundForId)!;
      const allocationChanged = !existing
        || existing.refundForId !== next.refundForId
        || refundAppliedAmount(existing) !== refundAppliedAmount(next)
        || existing.refundAllocationMode !== next.refundAllocationMode;
      nextAllocations = !allocationChanged && input.refundAllocations === undefined && currentAllocations.some((row) => !row.isDeleted)
        ? currentAllocations.filter((row) => !row.isDeleted)
        : await buildRefundAllocations(store, next, original, input.refundAllocations, currentAllocations);
      const allocationTotal = nextAllocations.reduce((sum, row) => sum.plus(row.amount), D(0));
      if (!allocationTotal.eq(next.refundAppliedAmount!)) validation('退款分配合计与退款冲减金额不一致');
    }

    await store.assertTransactionAggregate({
      transaction: next,
      splits: nextSplits,
      refundAllocations: nextAllocations,
    });
    return store.withPrevalidatedAggregates([`transaction:${next.id}`], async (aggregateStore) => {
      const savedTransaction = await aggregateStore.transactions.put(next);
      const savedSplits = await replaceTransactionChildren(
        currentSplits,
        nextSplits,
        (row) => aggregateStore.transactionSplits.put(row),
        (id, version) => aggregateStore.transactionSplits.remove(id, version),
      );
      const savedAllocations = await replaceTransactionChildren(
        currentAllocations,
        nextAllocations,
        (row) => aggregateStore.refundAllocations.put(row),
        (id, version) => aggregateStore.refundAllocations.remove(id, version),
      );
      return { transaction: savedTransaction, splits: savedSplits, refundAllocations: savedAllocations };
    });
  });
}

/** Convenience entry point; all writes still pass through the aggregate command. */
export async function saveTransaction(store: SqlLedgerStore, input: Transaction): Promise<Transaction> {
  return (await saveTransactionAggregate(store, { transaction: input, expectedVersion: input.version })).transaction;
}

export async function voidTransaction(store: SqlLedgerStore, transactionId: string, reason = '用户撤销'): Promise<Transaction> {
  return store.runInAuditBatch('作废流水', async (transactionStore) => {
    const current = await transactionStore.transactions.get(transactionId);
    if (!current || current.isDeleted) throw new Error('流水不存在');
    if (current.recordState === 'voided') return current;
    if (await isTransactionReconciled(transactionStore, current.id)) throw new Error('已对账流水不能直接作废，请先解除对账');
    if (current.type === 'expense') {
      const rows = await transactionStore.transactions.list();
      if (activeRefunds(rows, current.id).length) throw new Error('该支出已有退款，请先作废关联退款');
    }
    return transactionStore.transactions.put({
      ...current,
      recordState: 'voided',
      voidedAt: new Date().toISOString(),
      voidReason: reason,
    });
  });
}

export async function restoreTransaction(store: SqlLedgerStore, transactionId: string): Promise<Transaction> {
  return store.runInAuditBatch('恢复流水', async (transactionStore) => {
    const current = await transactionStore.transactions.get(transactionId);
    if (!current || current.isDeleted) throw new Error('流水不存在');
    return saveTransaction(transactionStore, {
      ...current,
      recordState: 'active',
      voidedAt: undefined,
      voidReason: undefined,
    });
  });
}

// ─────────────────────────── master-data lifecycle ───────────────────────────

export type MasterDataKind =
  | 'category'
  | 'account'
  | 'payee'
  | 'fixed_category'
  | 'tag'
  | 'location'
  | 'asset'
  | 'game'
  | 'game_account'
  | 'game_season'
  | 'fixed_asset';

export interface MasterDataImpact {
  kind: MasterDataKind;
  sourceId: string;
  targetId?: string;
  references: Record<string, number>;
  total: number;
  blockedReasons: string[];
}

export interface ArchivedMasterDataCompensation {
  kind: MasterDataKind;
  source: import('@zichan/core').BaseEntity;
  archivedVersion: number;
}

function transactionDependenciesFirst(left: Transaction, right: Transaction): number {
  return Number(left.type === 'refund') - Number(right.type === 'refund');
}

async function migrateReconciliations(
  store: SqlLedgerStore,
  dimension: 'account' | 'asset',
  sourceId: string,
  targetId: string,
): Promise<void> {
  const sessions = (await store.reconciliationSessions.list()).filter((session) =>
    dimension === 'account' ? session.accountId === sourceId : session.assetId === sourceId);
  for (const session of sessions) {
    const items = await store.reconciliationItems.list({ where: { reconciliationId: session.id } });
    const nextSession: ReconciliationSession = dimension === 'account'
      ? { ...session, accountId: targetId }
      : { ...session, assetId: targetId };
    const nextItems: ReconciliationItem[] = items.map((item) => dimension === 'account'
      ? { ...item, accountId: targetId }
      : { ...item, assetId: targetId });
    await store.assertReconciliationAggregate(nextSession, nextItems);
    await store.withPrevalidatedAggregates([`reconciliation:${session.id}`], async (aggregateStore) => {
      await aggregateStore.reconciliationSessions.put(nextSession);
      for (const item of nextItems) await aggregateStore.reconciliationItems.put(item);
    });
  }
}

function count(rows: unknown[]): number {
  return rows.length;
}

export async function previewMasterDataChange(
  store: SqlLedgerStore,
  kind: MasterDataKind,
  sourceId: string,
  targetId?: string,
): Promise<MasterDataImpact> {
  const references: Record<string, number> = {};
  const blockedReasons: string[] = [];
  if (targetId === sourceId) blockedReasons.push('合并目标不能是原记录本身');

  if (kind === 'category') {
    const source = await store.categories.get(sourceId);
    const target = targetId ? await store.categories.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原分类不存在');
    if (targetId && (!target || target.isDeleted || !target.isActive)) blockedReasons.push('目标分类不存在或已归档');
    if (source && target) {
      if (source.type !== target.type) blockedReasons.push('分类合并必须保持收入/支出类型一致');
      if (!!source.parentId !== !!target.parentId) blockedReasons.push('一级分类和二级分类不能互相合并');
    }
    references.children = await store.categories.count({ where: { parentId: sourceId } });
    references.transactions = await store.transactions.count({ where: { category: sourceId } });
    references.splits = await store.transactionSplits.count({ where: { category: sourceId } });
    references.refundAllocations = await store.refundAllocations.count({ where: { categoryId: sourceId } });
    references.budgets = await store.budgetCategories.count({ where: { category: sourceId } });
    references.schedules = await store.scheduledTransactions.count({ where: { category: sourceId } });
    references.templates = await store.transactionTemplates.count({ where: { category: sourceId } });
    references.payeeDefaults = await store.payees.count({ where: { defaultCategory: sourceId } });
    const children = await store.categories.list({ where: { parentId: sourceId } });
    if (!targetId && children.some((row) => row.isActive)) blockedReasons.push('一级分类仍有启用的二级分类，请先归档子分类');
    if (source?.parentId && target?.parentId && source.parentId !== target.parentId) {
      const duplicate = await store.categories.list({ where: { parentId: target.parentId } });
      if (duplicate.some((row) => row.id !== source.id && row.name.trim().toLowerCase() === source.name.trim().toLowerCase())) {
        blockedReasons.push('目标一级分类下已有同名二级分类');
      }
    }
  } else if (kind === 'account') {
    const source = await store.accounts.get(sourceId);
    const target = targetId ? await store.accounts.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原账户不存在');
    if (targetId && (!target || target.isDeleted || target.isActive === false)) blockedReasons.push('目标账户不存在或已归档');
    references.transactions = count((await store.transactions.list()).filter((row) => row.accountId === sourceId || row.transferAccountId === sourceId));
    references.schedules = count((await store.scheduledTransactions.list()).filter((row) => row.accountId === sourceId || row.transferAccountId === sourceId));
    references.templates = await store.transactionTemplates.count({ where: { accountId: sourceId } });
    references.payeeDefaults = await store.payees.count({ where: { defaultAccountId: sourceId } });
    references.reconciliations = await store.reconciliationSessions.count({ where: { accountId: sourceId } });
    // 需要额外加载 closed 状态判断，但 count 不支持 status 过滤，改用 list 加载带 where
    const closedSessions = (await store.reconciliationSessions.list({ where: { accountId: sourceId } })).filter((row) => row.status === 'closed');
    if (targetId && closedSessions.length) blockedReasons.push(`账户包含 ${closedSessions.length} 个已关闭对账批次，只能归档，不能普通合并`);
    let conversionRefs = 0;
    const previewChains = await store.conversionChains.list();
    const previewStepsByChain = await store.listStepsByChains(previewChains.map((c) => c.id));
    for (const chain of previewChains) {
      const steps = previewStepsByChain.get(chain.id) ?? [];
      conversionRefs += steps.filter((step) => step.accountFromId === sourceId || step.accountToId === sourceId || step.fees?.some((fee) => fee.accountId === sourceId)).length;
    }
    references.conversionSteps = conversionRefs;
    references.gameCashflows = await store.gameCashflowLinks.count({ where: { accountId: sourceId } });
  } else if (kind === 'payee') {
    const source = await store.payees.get(sourceId);
    const target = targetId ? await store.payees.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原商户不存在');
    if (targetId && (!target || target.isDeleted || !target.isActive)) blockedReasons.push('目标商户不存在或已归档');
    references.transactions = await store.transactions.count({ where: { payeeId: sourceId } });
    references.schedules = await store.scheduledTransactions.count({ where: { payeeId: sourceId } });
    references.templates = await store.transactionTemplates.count({ where: { payeeId: sourceId } });
  } else if (kind === 'fixed_category') {
    const source = await store.fixedAssetCategories.get(sourceId);
    const target = targetId ? await store.fixedAssetCategories.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原物品分类不存在');
    if (targetId && (!target || target.isDeleted || !target.isActive)) blockedReasons.push('目标物品分类不存在或已归档');
    if (source && target && !!source.parentId !== !!target.parentId) blockedReasons.push('一级分类和二级分类不能互相合并');
    references.children = await store.fixedAssetCategories.count({ where: { parentId: sourceId } });
    references.fixedAssets = await store.fixedAssets.count({ where: { categoryId: sourceId } });
    if (!targetId && references.children > 0) blockedReasons.push('一级分类仍有二级分类，请先归档子分类');
  } else if (kind === 'tag') {
    const source = await store.transactionTags.get(sourceId);
    const target = targetId ? await store.transactionTags.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原标签不存在');
    if (targetId && (!target || target.isDeleted || !target.isActive)) blockedReasons.push('目标标签不存在或已归档');
    references.transactions = count((await store.transactions.list()).filter((row) => row.tagIds?.includes(sourceId)));
    references.templates = count((await store.transactionTemplates.list()).filter((row) => row.tagIds?.includes(sourceId)));
  } else if (kind === 'location') {
    const source = await store.transactionLocations.get(sourceId);
    const target = targetId ? await store.transactionLocations.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原地点不存在');
    if (targetId && (!target || target.isDeleted || !target.isActive)) blockedReasons.push('目标地点不存在或已归档');
    references.transactions = await store.transactions.count({ where: { locationId: sourceId } });
    references.templates = await store.transactionTemplates.count({ where: { locationId: sourceId } });
  } else if (kind === 'asset') {
    const source = await store.assets.get(sourceId);
    const target = targetId ? await store.assets.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原资产不存在');
    if (targetId && (!target || target.isDeleted || !target.isActive)) blockedReasons.push('目标资产不存在或已归档');
    if (source && target && (source.type !== target.type || source.decimals !== target.decimals)) {
      blockedReasons.push('资产合并必须保持资产类型和小数精度一致');
    }
    if (targetId) {
      const activeFrozenRefunds = (await store.transactions.list()).filter((row) =>
        row.type === 'refund'
        && row.recordState !== 'voided'
        && row.refundAppliedAssetId === sourceId);
      if (activeFrozenRefunds.length) {
        blockedReasons.push(`资产包含 ${activeFrozenRefunds.length} 笔有效退款冻结关系，请先作废关联退款再合并`);
      }
    }
    const settings = await store.settings.list();
    references.settings = count(settings.filter((row) => [
      row.baseCurrencyAssetId, row.transactionDefaultAssetId, row.investmentCostAssetId,
      row.fixedAssetDefaultCurrencyAssetId, row.gameDefaultSettlementAssetId,
    ].includes(sourceId)));
    references.transactions = count((await store.transactions.list()).filter((row) =>
      row.assetId === sourceId || row.transferAssetId === sourceId || row.refundAppliedAssetId === sourceId));
    references.schedules = count((await store.scheduledTransactions.list()).filter((row) => row.assetId === sourceId || row.transferAssetId === sourceId));
    references.templates = await store.transactionTemplates.count({ where: { assetId: sourceId } });
    references.budgets = await store.budgetCategories.count({ where: { assetId: sourceId } });
    references.reconciliations = await store.reconciliationSessions.count({ where: { assetId: sourceId } });
    references.priceMarks = count((await store.priceMarks.list()).filter((row) => row.assetId === sourceId || row.quoteAssetId === sourceId));
    references.lots = count((await store.lots.list()).filter((row) =>
      row.assetId === sourceId || row.baseCurrencyAssetId === sourceId || row.nativeCostAssetId === sourceId));
    references.dca = count((await store.dcaPlans.list()).filter((row) => row.targetAssetId === sourceId || row.baseCurrencyAssetId === sourceId))
      + count((await store.dcaExecutions.list()).filter((row) => row.baseCurrencyAssetId === sourceId || row.finalAssetId === sourceId));
    references.games = count((await store.gameRecords.list()).filter((row) => row.settlementAssetId === sourceId || row.feeAssetId === sourceId));
    references.fixedAssets = await store.fixedAssets.count({ where: { baseCurrencyAssetId: sourceId } });
    let conversionRefs = 0;
    const chains = await store.conversionChains.list();
    const stepsByChain = await store.listStepsByChains(chains.map((c) => c.id));
    for (const chain of chains) {
      if (chain.baseCurrencyAssetId === sourceId || chain.finalAssetId === sourceId) conversionRefs += 1;
      const steps = stepsByChain.get(chain.id) ?? [];
      for (const step of steps) {
        const from = step.fromAssetId === sourceId ? targetId : step.fromAssetId;
        const to = step.toAssetId === sourceId ? targetId : step.toAssetId;
        if (step.fromAssetId === sourceId || step.toAssetId === sourceId || step.fees?.some((fee) => fee.assetId === sourceId)) conversionRefs += 1;
        if (targetId && from === to && !(step.accountFromId && step.accountToId && step.accountFromId !== step.accountToId)) {
          blockedReasons.push(`合并会使转换链 ${chain.id} 出现同币种成交步骤`);
        }
      }
    }
    references.conversions = conversionRefs;
  } else if (kind === 'game') {
    const source = await store.games.get(sourceId);
    const target = targetId ? await store.games.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原游戏不存在');
    if (targetId && (!target || target.isDeleted || target.isActive === false)) blockedReasons.push('目标游戏不存在或已归档');
    references.accounts = await store.gameAccounts.count({ where: { gameId: sourceId } });
    references.seasons = await store.gameSeasons.count({ where: { gameId: sourceId } });
    references.records = await store.gameRecords.count({ where: { gameId: sourceId } });
  } else if (kind === 'game_account') {
    const source = await store.gameAccounts.get(sourceId);
    const target = targetId ? await store.gameAccounts.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原游戏账号不存在');
    if (targetId && (!target || target.isDeleted || target.status !== 'active')) blockedReasons.push('目标游戏账号不存在或不可用');
    if (source && target && source.gameId !== target.gameId) blockedReasons.push('只能合并同一游戏下的账号');
    references.records = await store.gameRecords.count({ where: { gameAccountId: sourceId } });
  } else if (kind === 'game_season') {
    const source = await store.gameSeasons.get(sourceId);
    const target = targetId ? await store.gameSeasons.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原赛季不存在');
    if (targetId && (!target || target.isDeleted || target.status === 'ended')) blockedReasons.push('目标赛季不存在或已结束');
    if (source && target && source.gameId !== target.gameId) blockedReasons.push('只能合并同一游戏下的赛季');
    references.records = await store.gameRecords.count({ where: { seasonId: sourceId } });
  } else {
    const source = await store.fixedAssets.get(sourceId);
    const target = targetId ? await store.fixedAssets.get(targetId) : null;
    if (!source || source.isDeleted) blockedReasons.push('原物品资产不存在');
    if (targetId && (!target || target.isDeleted || target.archivedAt)) blockedReasons.push('目标物品资产不存在或已归档');
    if (source && target && source.baseCurrencyAssetId !== target.baseCurrencyAssetId) blockedReasons.push('只能合并记账币种相同的物品');
    if (source && target && (source.role ?? 'item') !== (target.role ?? 'item')) blockedReasons.push('整件物品与配件不能互相合并');
    references.events = await store.fixedAssetEvents.count({ where: { fixedAssetId: sourceId } });
    references.hostedComponents = await store.fixedAssetEvents.count({ where: { hostAssetId: sourceId } });
    references.bundledComponents = await store.fixedAssets.count({ where: { bundledFromAssetId: sourceId } });
    references.cashflows = await store.fixedAssetCashflowLinks.count({ where: { fixedAssetId: sourceId } });
    references.metrics = await store.fixedAssetUsageMetrics.count({ where: { fixedAssetId: sourceId } });
    references.logs = await store.fixedAssetUsageLogs.count({ where: { fixedAssetId: sourceId } });
    references.consumables = await store.fixedAssetConsumables.count({ where: { fixedAssetId: sourceId } });
    references.goals = await store.fixedAssetGoals.count({ where: { fixedAssetId: sourceId } });
    references.attachments = count((await store.attachments.list()).filter((row) => row.entityType === 'fixed_asset' && row.entityId === sourceId));
    const events = await store.fixedAssetEvents.list();
    if (targetId && events.some((row) => row.fixedAssetId === sourceId && row.type === 'purchase')
      && events.some((row) => row.fixedAssetId === targetId && row.type === 'purchase')) {
      blockedReasons.push('原物品和目标物品都包含购买事件，合并会产生两个购买基准');
    }
  }
  return {
    kind, sourceId, targetId, references,
    total: Object.values(references).reduce((sum, value) => sum + value, 0),
    blockedReasons,
  };
}

export async function archiveMasterData(
  store: SqlLedgerStore,
  kind: MasterDataKind,
  sourceId: string,
  expectedVersion: number,
  reason = '用户归档',
): Promise<ArchivedMasterDataCompensation> {
  const impact = await previewMasterDataChange(store, kind, sourceId);
  if (impact.blockedReasons.length) validation(impact.blockedReasons.join('；'));
  const result = await store.runInAuditBatch(`归档${kind}`, async (store) => {
    const archivedAt = new Date().toISOString();
    if (kind === 'category') {
      const source = await store.categories.get(sourceId);
      if (!source) validation('分类不存在');
      const archived = await store.categories.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'account') {
      const source = await store.accounts.get(sourceId);
      if (!source) validation('账户不存在');
      const archived = await store.accounts.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'payee') {
      const source = await store.payees.get(sourceId);
      if (!source) validation('商户不存在');
      const archived = await store.payees.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'fixed_category') {
      const source = await store.fixedAssetCategories.get(sourceId);
      if (!source) validation('物品分类不存在');
      const archived = await store.fixedAssetCategories.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'tag') {
      const source = await store.transactionTags.get(sourceId);
      if (!source) validation('标签不存在');
      const archived = await store.transactionTags.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'location') {
      const source = await store.transactionLocations.get(sourceId);
      if (!source) validation('地点不存在');
      const archived = await store.transactionLocations.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'asset') {
      const source = await store.assets.get(sourceId);
      if (!source) validation('资产不存在');
      const archived = await store.assets.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'game') {
      const source = await store.games.get(sourceId);
      if (!source) validation('游戏不存在');
      const archived = await store.games.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'game_account') {
      const source = await store.gameAccounts.get(sourceId);
      if (!source) validation('游戏账号不存在');
      const archived = await store.gameAccounts.put({ ...source, version: expectedVersion, status: 'inactive', archivedAt, archiveReason: reason });
      return { source, archived };
    } else if (kind === 'game_season') {
      const source = await store.gameSeasons.get(sourceId);
      if (!source) validation('赛季不存在');
      const archived = await store.gameSeasons.put({ ...source, version: expectedVersion, status: 'ended', archivedAt, archiveReason: reason });
      return { source, archived };
    } else {
      const source = await store.fixedAssets.get(sourceId);
      if (!source) validation('物品资产不存在');
      const archived = await store.fixedAssets.put({ ...source, version: expectedVersion, status: 'retired', archivedAt, archiveReason: reason });
      return { source, archived };
    }
  });
  return { kind, source: result.source, archivedVersion: result.archived.version };
}

export async function restoreArchivedMasterData(
  store: SqlLedgerStore,
  compensation: ArchivedMasterDataCompensation,
): Promise<void> {
  await store.runInAuditBatch(`撤销归档${compensation.kind}`, async (transactionStore) => {
    const assertCurrent = <T extends { version: number }>(current: T | null): T => {
      if (!current || current.version !== compensation.archivedVersion) {
        validation('该记录归档后又发生了变化，不能直接撤销');
      }
      return current;
    };
    if (compensation.kind === 'category') {
      const current = assertCurrent(await transactionStore.categories.get(compensation.source.id));
      await transactionStore.categories.put({ ...(compensation.source as Category), version: current.version });
    } else if (compensation.kind === 'account') {
      const current = assertCurrent(await transactionStore.accounts.get(compensation.source.id));
      await transactionStore.accounts.put({ ...(compensation.source as Account), version: current.version });
    } else if (compensation.kind === 'payee') {
      const current = assertCurrent(await transactionStore.payees.get(compensation.source.id));
      await transactionStore.payees.put({ ...(compensation.source as Payee), version: current.version });
    } else if (compensation.kind === 'fixed_category') {
      const current = assertCurrent(await transactionStore.fixedAssetCategories.get(compensation.source.id));
      await transactionStore.fixedAssetCategories.put({ ...(compensation.source as FixedAssetCategory), version: current.version });
    } else if (compensation.kind === 'tag') {
      const current = assertCurrent(await transactionStore.transactionTags.get(compensation.source.id));
      await transactionStore.transactionTags.put({ ...(compensation.source as TransactionTag), version: current.version });
    } else if (compensation.kind === 'location') {
      const current = assertCurrent(await transactionStore.transactionLocations.get(compensation.source.id));
      await transactionStore.transactionLocations.put({ ...(compensation.source as TransactionLocation), version: current.version });
    } else if (compensation.kind === 'asset') {
      const current = assertCurrent(await transactionStore.assets.get(compensation.source.id));
      await transactionStore.assets.put({ ...(compensation.source as Asset), version: current.version });
    } else if (compensation.kind === 'game') {
      const current = assertCurrent(await transactionStore.games.get(compensation.source.id));
      await transactionStore.games.put({ ...(compensation.source as Game), version: current.version });
    } else if (compensation.kind === 'game_account') {
      const current = assertCurrent(await transactionStore.gameAccounts.get(compensation.source.id));
      await transactionStore.gameAccounts.put({ ...(compensation.source as GameAccount), version: current.version });
    } else if (compensation.kind === 'game_season') {
      const current = assertCurrent(await transactionStore.gameSeasons.get(compensation.source.id));
      await transactionStore.gameSeasons.put({ ...(compensation.source as GameSeason), version: current.version });
    } else {
      const current = assertCurrent(await transactionStore.fixedAssets.get(compensation.source.id));
      await transactionStore.fixedAssets.put({ ...(compensation.source as FixedAsset), version: current.version });
    }
  });
}

export async function mergeMasterData(
  store: SqlLedgerStore,
  kind: MasterDataKind,
  sourceId: string,
  targetId: string,
  expectedVersion: number,
): Promise<MasterDataImpact> {
  const impact = await previewMasterDataChange(store, kind, sourceId, targetId);
  if (impact.blockedReasons.length) validation(impact.blockedReasons.join('；'));
  await store.runInAuditBatch(`合并${kind}并迁移 ${impact.total} 项引用`, async (store) => {
    const archivedAt = new Date().toISOString();
    if (kind === 'category') {
      const source = (await store.categories.get(sourceId))!;
      const target = (await store.categories.get(targetId))!;
      for (const row of await store.categories.list({ where: { parentId: sourceId } })) await store.categories.put({ ...row, parentId: targetId });
      // Publish the merge alias before migrating an expense that has refunds.
      // This gives both local validation and dependency-ordered sync replay a
      // valid transitional interpretation of the old frozen category.
      await store.categories.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
      const categoryTransactions = await store.transactions.list({ where: { category: sourceId } });
      for (const row of categoryTransactions.sort(transactionDependenciesFirst)) await store.transactions.put({ ...row, category: targetId });
      for (const row of await store.transactionSplits.list({ where: { category: sourceId } })) await store.transactionSplits.put({ ...row, category: targetId });
      for (const row of await store.refundAllocations.list({ where: { categoryId: sourceId } })) {
        await store.refundAllocations.put({ ...row, categoryId: targetId, categoryPathSnapshot: await categoryPath(store, target) });
      }
      for (const row of await store.budgetCategories.list({ where: { category: sourceId } })) await store.budgetCategories.put({ ...row, category: targetId });
      for (const row of await store.scheduledTransactions.list({ where: { category: sourceId } })) await store.scheduledTransactions.put({ ...row, category: targetId });
      for (const row of await store.transactionTemplates.list({ where: { category: sourceId } })) await store.transactionTemplates.put({ ...row, category: targetId });
      for (const row of await store.payees.list({ where: { defaultCategory: sourceId } })) await store.payees.put({ ...row, defaultCategory: targetId });
    } else if (kind === 'account') {
      const source = (await store.accounts.get(sourceId))!;
      // 账户引用涉及 OR 条件(accountId || transferAccountId),无法用单字段 where 过滤,
      // 保持 .list() + .filter() 模式,但数据量通常较小(仅关联特定账户的流水)。
      for (const row of (await store.transactions.list()).filter((item) => item.accountId === sourceId || item.transferAccountId === sourceId)) {
        const next = { ...row, accountId: row.accountId === sourceId ? targetId : row.accountId, transferAccountId: row.transferAccountId === sourceId ? targetId : row.transferAccountId };
        if (next.type === 'transfer' && next.accountId === next.transferAccountId) validation(`迁移会使转账 ${next.id} 的双方账户相同`);
        await store.transactions.put(next);
      }
      for (const row of (await store.scheduledTransactions.list()).filter((item) => item.accountId === sourceId || item.transferAccountId === sourceId)) {
        await store.scheduledTransactions.put({ ...row, accountId: row.accountId === sourceId ? targetId : row.accountId, transferAccountId: row.transferAccountId === sourceId ? targetId : row.transferAccountId });
      }
      for (const row of await store.transactionTemplates.list({ where: { accountId: sourceId } })) await store.transactionTemplates.put({ ...row, accountId: targetId });
      for (const row of await store.payees.list({ where: { defaultAccountId: sourceId } })) await store.payees.put({ ...row, defaultAccountId: targetId });
      await migrateReconciliations(store, 'account', sourceId, targetId);
      for (const row of await store.gameCashflowLinks.list({ where: { accountId: sourceId } })) await store.gameCashflowLinks.put({ ...row, accountId: targetId });
      const accountChains = await store.conversionChains.list();
      const accountStepsByChain = await store.listStepsByChains(accountChains.map((c) => c.id));
      for (const chain of accountChains) {
        const steps = accountStepsByChain.get(chain.id) ?? [];
        const affected = steps.some((step) => step.accountFromId === sourceId || step.accountToId === sourceId || step.fees?.some((fee) => fee.accountId === sourceId));
        if (!affected) continue;
        await store.saveChainWithSteps(chain, steps.map((step) => ({
          ...step,
          accountFromId: step.accountFromId === sourceId ? targetId : step.accountFromId,
          accountToId: step.accountToId === sourceId ? targetId : step.accountToId,
          fees: step.fees?.map((fee) => ({ ...fee, accountId: fee.accountId === sourceId ? targetId : fee.accountId })),
        })));
      }
      await store.accounts.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else if (kind === 'payee') {
      const source = (await store.payees.get(sourceId))!;
      const target = (await store.payees.get(targetId))!;
      for (const row of await store.transactions.list({ where: { payeeId: sourceId } })) await store.transactions.put({ ...row, payeeId: targetId });
      for (const row of await store.scheduledTransactions.list({ where: { payeeId: sourceId } })) await store.scheduledTransactions.put({ ...row, payeeId: targetId });
      for (const row of await store.transactionTemplates.list({ where: { payeeId: sourceId } })) await store.transactionTemplates.put({ ...row, payeeId: targetId });
      const aliases = [...new Set([...(target.aliases ?? []), source.name, ...(source.aliases ?? [])])].filter((value) => value !== target.name);
      await store.payees.put({ ...target, aliases });
      await store.payees.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else if (kind === 'fixed_category') {
      const source = (await store.fixedAssetCategories.get(sourceId))!;
      for (const row of await store.fixedAssetCategories.list({ where: { parentId: sourceId } })) await store.fixedAssetCategories.put({ ...row, parentId: targetId });
      for (const row of await store.fixedAssets.list({ where: { categoryId: sourceId } })) await store.fixedAssets.put({ ...row, categoryId: targetId });
      await store.fixedAssetCategories.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else if (kind === 'tag') {
      const source = (await store.transactionTags.get(sourceId))!;
      const replace = (ids: string[] | undefined) => [...new Set((ids ?? []).map((id) => id === sourceId ? targetId : id))];
      // tagIds 是 JSON 数组字段,无法用单字段 where 过滤,保持 .list() + .filter() 模式
      for (const row of (await store.transactions.list()).filter((item) => item.tagIds?.includes(sourceId))) {
        await store.transactions.put({ ...row, tagIds: replace(row.tagIds) });
      }
      for (const row of (await store.transactionTemplates.list()).filter((item) => item.tagIds?.includes(sourceId))) {
        await store.transactionTemplates.put({ ...row, tagIds: replace(row.tagIds) });
      }
      await store.transactionTags.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else if (kind === 'location') {
      const source = (await store.transactionLocations.get(sourceId))!;
      for (const row of await store.transactions.list({ where: { locationId: sourceId } })) {
        await store.transactions.put({ ...row, locationId: targetId });
      }
      for (const row of await store.transactionTemplates.list({ where: { locationId: sourceId } })) {
        await store.transactionTemplates.put({ ...row, locationId: targetId });
      }
      await store.transactionLocations.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else if (kind === 'asset') {
      const source = (await store.assets.get(sourceId))!;
      for (const row of await store.settings.list()) {
        if (![row.baseCurrencyAssetId, row.transactionDefaultAssetId, row.investmentCostAssetId, row.fixedAssetDefaultCurrencyAssetId, row.gameDefaultSettlementAssetId].includes(sourceId)) continue;
        await store.settings.put({
          ...row,
          baseCurrencyAssetId: row.baseCurrencyAssetId === sourceId ? targetId : row.baseCurrencyAssetId,
          transactionDefaultAssetId: row.transactionDefaultAssetId === sourceId ? targetId : row.transactionDefaultAssetId,
          investmentCostAssetId: row.investmentCostAssetId === sourceId ? targetId : row.investmentCostAssetId,
          fixedAssetDefaultCurrencyAssetId: row.fixedAssetDefaultCurrencyAssetId === sourceId ? targetId : row.fixedAssetDefaultCurrencyAssetId,
          gameDefaultSettlementAssetId: row.gameDefaultSettlementAssetId === sourceId ? targetId : row.gameDefaultSettlementAssetId,
        });
      }
      // 以下 OR 条件过滤器无法用单字段 where 优化,保持 .list() + .filter() 模式
      for (const row of (await store.priceMarks.list()).filter((item) => item.assetId === sourceId || item.quoteAssetId === sourceId)) {
        await store.priceMarks.put({ ...row, assetId: row.assetId === sourceId ? targetId : row.assetId, quoteAssetId: row.quoteAssetId === sourceId ? targetId : row.quoteAssetId });
      }
      for (const row of (await store.lots.list()).filter((item) => item.assetId === sourceId || item.baseCurrencyAssetId === sourceId || item.nativeCostAssetId === sourceId)) {
        await store.lots.put({
          ...row,
          assetId: row.assetId === sourceId ? targetId : row.assetId,
          baseCurrencyAssetId: row.baseCurrencyAssetId === sourceId ? targetId : row.baseCurrencyAssetId,
          nativeCostAssetId: row.nativeCostAssetId === sourceId ? targetId : row.nativeCostAssetId,
        });
      }
      for (const row of (await store.dcaPlans.list()).filter((item) => item.targetAssetId === sourceId || item.baseCurrencyAssetId === sourceId)) {
        await store.dcaPlans.put({ ...row, targetAssetId: row.targetAssetId === sourceId ? targetId : row.targetAssetId, baseCurrencyAssetId: row.baseCurrencyAssetId === sourceId ? targetId : row.baseCurrencyAssetId });
      }
      for (const row of (await store.dcaExecutions.list()).filter((item) => item.baseCurrencyAssetId === sourceId || item.finalAssetId === sourceId)) {
        await store.dcaExecutions.put({ ...row, baseCurrencyAssetId: row.baseCurrencyAssetId === sourceId ? targetId : row.baseCurrencyAssetId, finalAssetId: row.finalAssetId === sourceId ? targetId : row.finalAssetId });
      }
      const assetTransactions = (await store.transactions.list())
        .filter((item) => item.assetId === sourceId || item.transferAssetId === sourceId || item.refundAppliedAssetId === sourceId)
        .sort(transactionDependenciesFirst);
      for (const row of assetTransactions) {
        await store.transactions.put({
          ...row,
          assetId: row.assetId === sourceId ? targetId : row.assetId,
          transferAssetId: row.transferAssetId === sourceId ? targetId : row.transferAssetId,
          refundAppliedAssetId: row.refundAppliedAssetId === sourceId ? targetId : row.refundAppliedAssetId,
        });
      }
      for (const row of await store.refundAllocations.list({ where: { assetId: sourceId } })) await store.refundAllocations.put({ ...row, assetId: targetId });
      for (const row of await store.budgetCategories.list({ where: { assetId: sourceId } })) await store.budgetCategories.put({ ...row, assetId: targetId });
      for (const row of (await store.scheduledTransactions.list()).filter((item) => item.assetId === sourceId || item.transferAssetId === sourceId)) {
        await store.scheduledTransactions.put({ ...row, assetId: row.assetId === sourceId ? targetId : row.assetId, transferAssetId: row.transferAssetId === sourceId ? targetId : row.transferAssetId });
      }
      for (const row of await store.transactionTemplates.list({ where: { assetId: sourceId } })) await store.transactionTemplates.put({ ...row, assetId: targetId });
      await migrateReconciliations(store, 'asset', sourceId, targetId);
      for (const row of (await store.gameRecords.list()).filter((item) => item.settlementAssetId === sourceId || item.feeAssetId === sourceId)) {
        await store.gameRecords.put({
          ...row,
          settlementAssetId: row.settlementAssetId === sourceId ? targetId : row.settlementAssetId,
          feeAssetId: row.feeAssetId === sourceId ? targetId : row.feeAssetId,
        });
      }
      for (const row of await store.gameCashflowLinks.list({ where: { sourceAssetId: sourceId } })) await store.gameCashflowLinks.put({ ...row, sourceAssetId: targetId });
      for (const row of await store.fixedAssets.list({ where: { baseCurrencyAssetId: sourceId } })) await store.fixedAssets.put({ ...row, baseCurrencyAssetId: targetId });
      for (const row of (await store.fixedAssetCashflowLinks.list()).filter((item) => item.sourceAssetId === sourceId || item.baseAssetId === sourceId)) {
        await store.fixedAssetCashflowLinks.put({
          ...row,
          sourceAssetId: row.sourceAssetId === sourceId ? targetId : row.sourceAssetId,
          baseAssetId: row.baseAssetId === sourceId ? targetId : row.baseAssetId,
        });
      }
      const mergeChains = await store.conversionChains.list();
      const mergeStepsByChain = await store.listStepsByChains(mergeChains.map((c) => c.id));
      for (const chain of mergeChains) {
        const steps = mergeStepsByChain.get(chain.id) ?? [];
        const affected = chain.baseCurrencyAssetId === sourceId || chain.finalAssetId === sourceId
          || steps.some((step) => step.fromAssetId === sourceId || step.toAssetId === sourceId || step.fees?.some((fee) => fee.assetId === sourceId));
        if (!affected) continue;
        await store.saveChainWithSteps({
          ...chain,
          baseCurrencyAssetId: chain.baseCurrencyAssetId === sourceId ? targetId : chain.baseCurrencyAssetId,
          finalAssetId: chain.finalAssetId === sourceId ? targetId : chain.finalAssetId,
        }, steps.map((step) => ({
          ...step,
          fromAssetId: step.fromAssetId === sourceId ? targetId : step.fromAssetId,
          toAssetId: step.toAssetId === sourceId ? targetId : step.toAssetId,
          fees: step.fees?.map((fee) => ({ ...fee, assetId: fee.assetId === sourceId ? targetId : fee.assetId })),
        })));
      }
      for (const row of (await store.attachments.list()).filter((item) => item.entityType === 'asset' && item.entityId === sourceId)) {
        await store.attachments.put({ ...row, entityId: targetId });
      }
      await store.assets.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else if (kind === 'game') {
      const source = (await store.games.get(sourceId))!;
      for (const row of await store.gameAccounts.list({ where: { gameId: sourceId } })) await store.gameAccounts.put({ ...row, gameId: targetId });
      for (const row of await store.gameSeasons.list({ where: { gameId: sourceId } })) await store.gameSeasons.put({ ...row, gameId: targetId });
      for (const row of await store.gameRecords.list({ where: { gameId: sourceId } })) await store.gameRecords.put({ ...row, gameId: targetId });
      await store.games.put({ ...source, version: expectedVersion, isActive: false, archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else if (kind === 'game_account') {
      const source = (await store.gameAccounts.get(sourceId))!;
      for (const row of await store.gameRecords.list({ where: { gameAccountId: sourceId } })) await store.gameRecords.put({ ...row, gameAccountId: targetId });
      await store.gameAccounts.put({ ...source, version: expectedVersion, status: 'inactive', archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else if (kind === 'game_season') {
      const source = (await store.gameSeasons.get(sourceId))!;
      for (const row of await store.gameRecords.list({ where: { seasonId: sourceId } })) await store.gameRecords.put({ ...row, seasonId: targetId });
      await store.gameSeasons.put({ ...source, version: expectedVersion, status: 'ended', archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
    } else {
      const source = (await store.fixedAssets.get(sourceId))!;
      for (const row of await store.fixedAssetEvents.list({ where: { fixedAssetId: sourceId } })) await store.fixedAssetEvents.put({ ...row, fixedAssetId: targetId });
      for (const row of await store.fixedAssetEvents.list({ where: { hostAssetId: sourceId } })) await store.fixedAssetEvents.put({ ...row, hostAssetId: targetId });
      for (const row of await store.fixedAssets.list({ where: { bundledFromAssetId: sourceId } })) await store.fixedAssets.put({ ...row, bundledFromAssetId: targetId });
      for (const row of await store.fixedAssetCashflowLinks.list({ where: { fixedAssetId: sourceId } })) await store.fixedAssetCashflowLinks.put({ ...row, fixedAssetId: targetId });
      for (const row of await store.fixedAssetUsageMetrics.list({ where: { fixedAssetId: sourceId } })) await store.fixedAssetUsageMetrics.put({ ...row, fixedAssetId: targetId });
      for (const row of await store.fixedAssetUsageLogs.list({ where: { fixedAssetId: sourceId } })) await store.fixedAssetUsageLogs.put({ ...row, fixedAssetId: targetId });
      for (const row of await store.fixedAssetConsumables.list({ where: { fixedAssetId: sourceId } })) await store.fixedAssetConsumables.put({ ...row, fixedAssetId: targetId });
      for (const row of await store.fixedAssetGoals.list({ where: { fixedAssetId: sourceId } })) await store.fixedAssetGoals.put({ ...row, fixedAssetId: targetId });
      for (const row of (await store.attachments.list()).filter((item) => item.entityType === 'fixed_asset' && item.entityId === sourceId)) await store.attachments.put({ ...row, entityId: targetId });
      await store.fixedAssets.put({ ...source, version: expectedVersion, status: 'retired', archivedAt, archiveReason: '已合并', mergedIntoId: targetId });
      await reconcileFixedAssetStatus(store, targetId, true);
    }
  }, 'bulk_update');
  return impact;
}

// ─────────────────────────── operational record compensation ───────────────────────────

type CompensationCollection = Collection<BaseEntity>;

function collectionForCompensation(store: SqlLedgerStore, entityType: string): CompensationCollection | null {
  const collections: Record<string, unknown> = {
    conversion_operation: store.conversionOperations,
    cost_basis_opening: store.costBasisOpenings,
    asset: store.assets,
    account: store.accounts,
    setting: store.settings,
    conversion_chain: store.conversionChains,
    lot: store.lots,
    lot_consumption: store.lotConsumptions,
    price_mark: store.priceMarks,
    dca_plan: store.dcaPlans,
    dca_execution: store.dcaExecutions,
    game: store.games,
    game_account: store.gameAccounts,
    game_season: store.gameSeasons,
    game_record: store.gameRecords,
    game_cashflow_link: store.gameCashflowLinks,
    fixed_asset: store.fixedAssets,
    fixed_asset_category: store.fixedAssetCategories,
    fixed_asset_event: store.fixedAssetEvents,
    fixed_asset_cashflow_link: store.fixedAssetCashflowLinks,
    fixed_asset_usage_metric: store.fixedAssetUsageMetrics,
    fixed_asset_usage_log: store.fixedAssetUsageLogs,
    fixed_asset_consumable: store.fixedAssetConsumables,
    fixed_asset_goal: store.fixedAssetGoals,
    attachment: store.attachments,
    category: store.categories,
    transaction_tag: store.transactionTags,
    transaction_location: store.transactionLocations,
    payee: store.payees,
    transaction: store.transactions,
    transaction_split: store.transactionSplits,
    refund_allocation: store.refundAllocations,
    budget_category: store.budgetCategories,
    scheduled_transaction: store.scheduledTransactions,
    scheduled_execution: store.scheduledExecutions,
    transaction_template: store.transactionTemplates,
    transaction_saved_view: store.transactionSavedViews,
    reconciliation_session: store.reconciliationSessions,
    reconciliation_item: store.reconciliationItems,
  };
  return (collections[entityType] as CompensationCollection | undefined) ?? null;
}

// canonicalJson is imported from @zichan/core (crypto.ts) — both implementations
// filter undefined values and sort keys, so they are functionally identical.

function aggregateKeysForCompensation(states: CompensationEntityState[]): Set<string> {
  const keys = new Set<string>();
  for (const state of states) {
    if (state.entityType === 'transaction') keys.add(`transaction:${state.entityId}`);
    if (state.entityType === 'transaction_split') {
      const id = state.before?.['transactionId'] ?? state.after?.['transactionId'];
      if (typeof id === 'string') keys.add(`transaction:${id}`);
    }
    if (state.entityType === 'refund_allocation') {
      const id = state.before?.['refundTransactionId'] ?? state.after?.['refundTransactionId'];
      if (typeof id === 'string') keys.add(`transaction:${id}`);
    }
    if (state.entityType === 'reconciliation_session') keys.add(`reconciliation:${state.entityId}`);
    if (state.entityType === 'reconciliation_item') {
      const id = state.before?.['reconciliationId'] ?? state.after?.['reconciliationId'];
      if (typeof id === 'string') keys.add(`reconciliation:${id}`);
    }
  }
  return keys;
}

async function assertCompensationCurrent(
  store: SqlLedgerStore,
  state: CompensationEntityState,
): Promise<void> {
  if (state.entityType === 'conversion_chain_steps') {
    const expected = Array.isArray(state.after?.['steps']) ? state.after['steps'] : [];
    const current = await store.listStepsByChain(state.entityId);
    if (canonicalJson(current) !== canonicalJson(expected)) {
      validation(`资产转换 ${state.entityId} 的步骤后来发生了变化，不能整批撤销`);
    }
    return;
  }
  const collection = collectionForCompensation(store, state.entityType);
  if (!collection) validation(`撤销记录包含不支持的实体类型：${state.entityType}`);
  const current = await collection.get(state.entityId);
  const expectedVersion = Number(state.after?.['version']);
  if (!current || !Number.isSafeInteger(expectedVersion) || current.version !== expectedVersion) {
    validation(`${state.entityType} ${state.entityId} 后来发生了变化，不能整批撤销`);
  }
}

async function applyCompensationState(
  store: SqlLedgerStore,
  state: CompensationEntityState,
): Promise<void> {
  if (state.entityType === 'conversion_chain_steps') {
    if (!state.before) return;
    const chain = await store.conversionChains.get(state.entityId);
    if (!chain || chain.isDeleted) return;
    const steps = Array.isArray(state.before['steps'])
      ? state.before['steps'].map((row) => ({ ...(row as ConversionStep), chainId: state.entityId }))
      : [];
    await store.saveChainWithSteps({ ...chain, version: chain.version }, steps);
    return;
  }
  const collection = collectionForCompensation(store, state.entityType);
  if (!collection) validation(`撤销记录包含不支持的实体类型：${state.entityType}`);
  const current = await collection.get(state.entityId);
  if (!current) validation(`${state.entityType} ${state.entityId} 不存在，不能撤销`);
  if (!state.before) {
    if (!current.isDeleted) await collection.remove(current.id, current.version);
    return;
  }
  await collection.put({
    ...(state.before as unknown as BaseEntity),
    id: state.entityId,
    version: current.version,
  });
}

async function assertCompensationAggregates(
  store: SqlLedgerStore,
  keys: Set<string>,
): Promise<void> {
  for (const key of keys) {
    const separator = key.indexOf(':');
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (type === 'transaction') {
      const transaction = await store.transactions.get(id);
      const splits = await store.transactionSplits.list({ where: { transactionId: id } });
      const refundAllocations = await store.refundAllocations.list({ where: { refundTransactionId: id } });
      if (transaction && !transaction.isDeleted) {
        await store.assertTransactionAggregate({ transaction, splits, refundAllocations });
      } else if (splits.length || refundAllocations.length) {
        validation(`流水 ${id} 已删除但仍保留活动拆分或退款分配`);
      }
    } else if (type === 'reconciliation') {
      const session = await store.reconciliationSessions.get(id);
      const items = await store.reconciliationItems.list({ where: { reconciliationId: id } });
      if (session && !session.isDeleted) await store.assertReconciliationAggregate(session, items);
      else if (items.length) validation(`对账批次 ${id} 已删除但仍保留活动项目`);
    }
  }
}

async function applyBusinessCompensationStates(
  store: SqlLedgerStore,
  compensation: BusinessCompensationRecord,
): Promise<void> {
  for (const state of compensation.payload.states) await assertCompensationCurrent(store, state);
  const writeKeys = compensation.payload.states
    .filter((state) => state.entityType !== 'conversion_chain_steps')
    .map((state) => `${state.entityType}:${state.entityId}`);
  const deleteKeys = compensation.payload.states
    .filter((state) => !state.before || state.before['isDeleted'] === true)
    .map((state) => `${state.entityType}:${state.entityId}`);
  const aggregateKeys = aggregateKeysForCompensation(compensation.payload.states);
  await store.withValidatedRestore(writeKeys, deleteKeys, (restoreStore) =>
    restoreStore.withPrevalidatedAggregates(aggregateKeys, async (aggregateStore) => {
      const ordered = [...compensation.payload.states].sort((left, right) => right.sequence - left.sequence);
      for (const state of ordered) await applyCompensationState(aggregateStore, state);
      await assertCompensationAggregates(aggregateStore, aggregateKeys);
    }));
}

export interface BusinessCompensationInspection {
  reversible: boolean;
  affectedEntities: { entityType: string; entityId: string }[];
  blocker?: string;
}

class CompensationInspectionRollback extends Error {}

/** Run the complete compensation in a rollback-only transaction without changing its status. */
export async function inspectBusinessCompensation(
  store: SqlLedgerStore,
  compensationId: string,
): Promise<BusinessCompensationInspection> {
  const compensation = await store.getBusinessCompensation(compensationId);
  if (!compensation) return { reversible: false, affectedEntities: [], blocker: '撤销记录不存在' };
  if (compensation.status !== 'pending') {
    return {
      reversible: false,
      affectedEntities: compensation.affectedEntities,
      blocker: compensation.status === 'applied' ? '该操作已经撤销' : compensation.error ?? '该操作已不可撤销',
    };
  }
  try {
    await store.transaction(async (transactionStore) => {
      await applyBusinessCompensationStates(transactionStore, compensation);
      throw new CompensationInspectionRollback();
    });
  } catch (error) {
    if (error instanceof CompensationInspectionRollback) {
      return { reversible: true, affectedEntities: compensation.affectedEntities };
    }
    return {
      reversible: false,
      affectedEntities: compensation.affectedEntities,
      blocker: error instanceof Error ? error.message : String(error),
    };
  }
  return { reversible: false, affectedEntities: compensation.affectedEntities, blocker: '撤销预检没有完成' };
}

export async function undoBusinessCompensation(
  store: SqlLedgerStore,
  compensationId: string,
): Promise<BusinessCompensationRecord> {
  const compensation = await store.getBusinessCompensation(compensationId);
  if (!compensation) validation('撤销记录不存在');
  if (compensation.status !== 'pending') validation(compensation.status === 'applied' ? '该操作已经撤销' : '该操作已不可撤销');
  const batchId = newId();
  await store.createAuditBatch({
    id: batchId,
    type: 'user',
    label: `撤销：${compensation.label}`,
    entityCount: compensation.payload.states.length,
    summary: `补偿 ${compensation.affectedEntities.length} 个对象`,
  });
  let transactionCommitted = false;
  try {
    await store.withAuditContext(
      { batchId, source: 'local' },
      (scoped) => scoped.transaction(async (transactionStore) => {
        await applyBusinessCompensationStates(transactionStore, compensation);
        await transactionStore.markBusinessCompensation(compensation.id, 'applied', {
          appliedAt: new Date().toISOString(),
          appliedBatchId: batchId,
        });
      }),
    );
    transactionCommitted = true;
    const entityCount = (await store.operationLog({ batchId })).length;
    await store.finishAuditBatch(batchId, { entityCount, appliedCount: entityCount, outcome: 'applied' });
  } catch (error) {
    // The status changes to `applied` in the same transaction as the inverse
    // writes. `withAuditContext` can still fail while sealing the sync commit
    // after SQLite has committed, so confirm the durable status before ever
    // writing `pending` again. Otherwise a retry could apply the inverse twice.
    if (!transactionCommitted) {
      try {
        transactionCommitted = (await store.getBusinessCompensation(compensation.id))?.status === 'applied';
      } catch {
        // If durable state cannot be read, leave it untouched. Retrying the
        // status write under uncertainty is less safe than surfacing the error.
        throw error;
      }
    }
    if (transactionCommitted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const deterministic = error instanceof DomainValidationError || error instanceof ConcurrencyError;
    await store.markBusinessCompensation(compensation.id, deterministic ? 'blocked' : 'pending', { error: message });
    await store.finishAuditBatch(batchId, {
      entityCount: 0,
      appliedCount: 0,
      outcome: 'invalid',
      summary: message,
    });
    throw error;
  }
  return (await store.getBusinessCompensation(compensation.id))!;
}

export interface DeletedBudgetCategoryCompensation {
  entity: BudgetCategory;
  deletedVersion: number;
}

export interface DeletedSavedViewCompensation {
  entity: TransactionSavedView;
  deletedVersion: number;
}

export interface DeletedFixedUsageLogCompensation {
  entity: FixedAssetUsageLog;
  deletedVersion: number;
}

export interface EntityStateCompensation<T> {
  before: T;
  changedVersion: number;
}

export async function deleteBudgetCategory(
  store: SqlLedgerStore,
  id: string,
  expectedVersion: number,
): Promise<DeletedBudgetCategoryCompensation> {
  const entity = await store.budgetCategories.get(id);
  if (!entity || entity.isDeleted) validation('预算不存在');
  if (entity.version !== expectedVersion) validation('预算已在其他窗口被修改，请刷新后重试');
  await store.runInAuditBatch('删除预算并生成撤销点', (transactionStore) =>
    transactionStore.budgetCategories.remove(id, expectedVersion));
  const deleted = await store.budgetCategories.get(id);
  return { entity, deletedVersion: deleted?.version ?? expectedVersion + 1 };
}

export async function restoreDeletedBudgetCategory(
  store: SqlLedgerStore,
  compensation: DeletedBudgetCategoryCompensation,
): Promise<BudgetCategory> {
  return store.runInAuditBatch('撤销删除预算', async (transactionStore) => {
    const current = await transactionStore.budgetCategories.get(compensation.entity.id);
    if (!current?.isDeleted || current.version !== compensation.deletedVersion) {
      validation('预算删除后又发生了变化，不能直接撤销');
    }
    return transactionStore.budgetCategories.put({
      ...compensation.entity,
      version: current.version,
      isDeleted: false,
    });
  });
}

export async function deleteTransactionSavedView(
  store: SqlLedgerStore,
  id: string,
  expectedVersion: number,
): Promise<DeletedSavedViewCompensation> {
  const entity = await store.transactionSavedViews.get(id);
  if (!entity || entity.isDeleted) validation('保存筛选不存在');
  if (entity.version !== expectedVersion) validation('保存筛选已在其他窗口被修改，请刷新后重试');
  await store.runInAuditBatch('删除保存筛选并生成撤销点', (transactionStore) =>
    transactionStore.transactionSavedViews.remove(id, expectedVersion));
  const deleted = await store.transactionSavedViews.get(id);
  return { entity, deletedVersion: deleted?.version ?? expectedVersion + 1 };
}

export async function restoreDeletedTransactionSavedView(
  store: SqlLedgerStore,
  compensation: DeletedSavedViewCompensation,
): Promise<TransactionSavedView> {
  return store.runInAuditBatch('撤销删除保存筛选', async (transactionStore) => {
    const current = await transactionStore.transactionSavedViews.get(compensation.entity.id);
    if (!current?.isDeleted || current.version !== compensation.deletedVersion) {
      validation('保存筛选删除后又发生了变化，不能直接撤销');
    }
    return transactionStore.transactionSavedViews.put({
      ...compensation.entity,
      version: current.version,
      isDeleted: false,
    });
  });
}

export async function archiveScheduledTransaction(
  store: SqlLedgerStore,
  id: string,
  expectedVersion: number,
): Promise<EntityStateCompensation<ScheduledTransaction>> {
  const before = await store.scheduledTransactions.get(id);
  if (!before || before.isDeleted) validation('定期交易不存在');
  if (before.version !== expectedVersion) validation('定期交易已在其他窗口被修改，请刷新后重试');
  const changed = await store.runInAuditBatch('停用定期交易', (transactionStore) =>
    transactionStore.scheduledTransactions.put({
      ...before,
      status: 'paused',
      autoCreate: false,
    }));
  return { before, changedVersion: changed.version };
}

export async function restoreScheduledTransactionState(
  store: SqlLedgerStore,
  compensation: EntityStateCompensation<ScheduledTransaction>,
): Promise<ScheduledTransaction> {
  return store.runInAuditBatch('撤销停用定期交易', async (transactionStore) => {
    const current = await transactionStore.scheduledTransactions.get(compensation.before.id);
    if (!current || current.isDeleted || current.version !== compensation.changedVersion) {
      validation('定期交易停用后又发生了变化，不能直接撤销');
    }
    return transactionStore.scheduledTransactions.put({
      ...compensation.before,
      version: current.version,
    });
  });
}

export async function archiveFixedUsageMetric(
  store: SqlLedgerStore,
  id: string,
  expectedVersion: number,
): Promise<EntityStateCompensation<FixedAssetUsageMetric>> {
  const before = await store.fixedAssetUsageMetrics.get(id);
  if (!before || before.isDeleted) validation('使用指标不存在');
  if (before.version !== expectedVersion) validation('使用指标已在其他窗口被修改，请刷新后重试');
  const changed = await store.runInAuditBatch('停用物品使用指标', (transactionStore) =>
    transactionStore.fixedAssetUsageMetrics.put({ ...before, isActive: false, isPrimary: false }));
  return { before, changedVersion: changed.version };
}

export async function restoreFixedUsageMetricState(
  store: SqlLedgerStore,
  compensation: EntityStateCompensation<FixedAssetUsageMetric>,
): Promise<FixedAssetUsageMetric> {
  return store.runInAuditBatch('撤销停用物品使用指标', async (transactionStore) => {
    const current = await transactionStore.fixedAssetUsageMetrics.get(compensation.before.id);
    if (!current || current.isDeleted || current.version !== compensation.changedVersion) {
      validation('使用指标停用后又发生了变化，不能直接撤销');
    }
    return transactionStore.fixedAssetUsageMetrics.put({
      ...compensation.before,
      version: current.version,
    });
  });
}

export async function deleteFixedUsageLog(
  store: SqlLedgerStore,
  id: string,
  expectedVersion: number,
): Promise<DeletedFixedUsageLogCompensation> {
  const entity = await store.fixedAssetUsageLogs.get(id);
  if (!entity || entity.isDeleted) validation('使用记录不存在');
  if (entity.version !== expectedVersion) validation('使用记录已在其他窗口被修改，请刷新后重试');
  await store.runInAuditBatch('删除物品使用记录并生成撤销点', (transactionStore) =>
    transactionStore.fixedAssetUsageLogs.remove(id, expectedVersion));
  const deleted = await store.fixedAssetUsageLogs.get(id);
  return { entity, deletedVersion: deleted?.version ?? expectedVersion + 1 };
}

export async function restoreDeletedFixedUsageLog(
  store: SqlLedgerStore,
  compensation: DeletedFixedUsageLogCompensation,
): Promise<FixedAssetUsageLog> {
  return store.runInAuditBatch('撤销删除物品使用记录', async (transactionStore) => {
    const current = await transactionStore.fixedAssetUsageLogs.get(compensation.entity.id);
    if (!current?.isDeleted || current.version !== compensation.deletedVersion) {
      validation('使用记录删除后又发生了变化，不能直接撤销');
    }
    return transactionStore.fixedAssetUsageLogs.put({
      ...compensation.entity,
      version: current.version,
      isDeleted: false,
    });
  });
}

export async function cancelFixedAssetGoal(
  store: SqlLedgerStore,
  id: string,
  expectedVersion: number,
): Promise<EntityStateCompensation<FixedAssetGoal>> {
  const before = await store.fixedAssetGoals.get(id);
  if (!before || before.isDeleted) validation('成本目标不存在');
  if (before.version !== expectedVersion) validation('成本目标已在其他窗口被修改，请刷新后重试');
  const changed = await store.runInAuditBatch('取消物品成本目标', (transactionStore) =>
    transactionStore.fixedAssetGoals.put({ ...before, status: 'cancelled' }));
  return { before, changedVersion: changed.version };
}

export async function restoreFixedAssetGoalState(
  store: SqlLedgerStore,
  compensation: EntityStateCompensation<FixedAssetGoal>,
): Promise<FixedAssetGoal> {
  return store.runInAuditBatch('撤销取消物品成本目标', async (transactionStore) => {
    const current = await transactionStore.fixedAssetGoals.get(compensation.before.id);
    if (!current || current.isDeleted || current.version !== compensation.changedVersion) {
      validation('成本目标取消后又发生了变化，不能直接撤销');
    }
    return transactionStore.fixedAssetGoals.put({
      ...compensation.before,
      version: current.version,
    });
  });
}

// ─────────────────────────── real bank reconciliation ───────────────────────────

export interface ReconciliationCandidate {
  transaction: Transaction;
  postingAmount: string;
  reconciled: boolean;
}

export interface ReconciliationPreview {
  previousSession?: ReconciliationSession;
  openingBalance: string;
  selectedTotal: string;
  clearedBalance: string;
  difference: string;
  candidates: ReconciliationCandidate[];
  conversionTotal: string;
  conversionEntries: { id: string; date: string; postingAmount: string }[];
  excluded?: { beforeOpening: number; afterStatement: number; alreadyReconciled: number };
}

export interface ReconciliationInput {
  id?: string;
  accountId: string;
  assetId: string;
  statementDate: string;
  statementBalance: string;
  selectedTransactionIds: string[];
  createAdjustment?: boolean;
  note?: string;
}

function postingAmount(transaction: Transaction, accountId: string, assetId: string, accounts?: import('@zichan/core').Account[]): string {
  return (accounts ? accountTransactionPostings(transaction, accounts) : postingsFromTransaction(transaction))
    .filter((posting) => posting.accountId === accountId && posting.assetId === assetId)
    .reduce((total, posting) => total.plus(posting.amount), D(0))
    .toString();
}

export async function previewReconciliation(store: SqlLedgerStore, input: ReconciliationInput): Promise<ReconciliationPreview> {
  if (!input.accountId || !input.assetId) throw new Error('请选择对账账户和币种');
  const account = await store.accounts.get(input.accountId);
  if (!account || isDefaultAccount(account)) throw new Error('请选择银行卡或钱包进行对账');
  if (account.balanceStartDate && input.statementDate < account.balanceStartDate) throw new Error('账单日不能早于余额起点');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.statementDate)) throw new Error('账单截止日无效');
  const sessions = (await store.reconciliationSessions.list())
    .filter((row) => row.status === 'closed' && row.accountId === input.accountId && row.assetId === input.assetId)
    .sort((a, b) => b.statementDate.localeCompare(a.statementDate) || (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  const previousSession = sessions.find((row) => row.statementDate < input.statementDate);
  if (sessions.some((row) => row.statementDate >= input.statementDate && row.id !== input.id)) {
    throw new Error('账单截止日必须晚于该账户最近一次对账');
  }
  const activeItems = await store.reconciliationItems.list();
  const closedIds = new Set(sessions.map((row) => row.id));
  const reconciledKeys = new Set(activeItems
    .filter((row) => closedIds.has(row.reconciliationId))
    .map((row) => `${row.transactionId}\0${row.accountId}\0${row.assetId}`));
  const transactions = (await store.transactions.list()).filter(isTransactionActive);
  const excluded = { beforeOpening: 0, afterStatement: 0, alreadyReconciled: 0 };
  for (const transaction of transactions) {
    if (D(postingAmount(transaction, input.accountId, input.assetId)).isZero()) continue;
    if (transaction.date > input.statementDate) excluded.afterStatement++;
    else if (D(postingAmount(transaction, input.accountId, input.assetId, [account])).isZero()) excluded.beforeOpening++;
    else if (reconciledKeys.has(`${transaction.id}\0${input.accountId}\0${input.assetId}`)) excluded.alreadyReconciled++;
  }
  const candidates = transactions
    .filter((row) => row.date <= input.statementDate)
    .map((transaction) => ({
      transaction,
      postingAmount: postingAmount(transaction, input.accountId, input.assetId, [account]),
      reconciled: reconciledKeys.has(`${transaction.id}\0${input.accountId}\0${input.assetId}`),
    }))
    .filter((row) => !D(row.postingAmount).isZero() && !row.reconciled)
    .sort((a, b) => a.transaction.date.localeCompare(b.transaction.date) || a.transaction.id.localeCompare(b.transaction.id));
  const conversionEntries = (await store.accountConversionPostings())
    .filter((posting) => posting.accountId === input.accountId && posting.assetId === input.assetId
      && posting.date <= input.statementDate
      && (!previousSession || posting.date > previousSession.statementDate))
    .map((posting, index) => ({
      id: `${posting.source.id}:${index}`,
      date: posting.date,
      postingAmount: posting.amount,
    }))
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  const conversionTotal = conversionEntries.reduce((total, row) => total.plus(row.postingAmount), D(0));
  const selected = new Set(input.selectedTransactionIds);
  const selectedTotal = candidates
    .filter((row) => selected.has(row.transaction.id))
    .reduce((total, row) => total.plus(row.postingAmount), conversionTotal);
  const openingBalance = D(previousSession?.statementBalance ?? (account.openingAssetId === input.assetId ? account.openingBalance : undefined) ?? 0);
  const clearedBalance = openingBalance.plus(selectedTotal);
  const difference = D(input.statementBalance || 0).minus(clearedBalance);
  return {
    previousSession,
    excluded,
    openingBalance: openingBalance.toString(),
    selectedTotal: selectedTotal.toString(),
    clearedBalance: clearedBalance.toString(),
    difference: difference.toString(),
    candidates,
    conversionTotal: conversionTotal.toString(),
    conversionEntries,
  };
}

export async function closeReconciliation(store: SqlLedgerStore, input: ReconciliationInput): Promise<ReconciliationSession> {
  const preview = await previewReconciliation(store, input);
  const selected = new Set(input.selectedTransactionIds);
  const rows = preview.candidates.filter((row) => selected.has(row.transaction.id));
  if (rows.length !== selected.size) throw new Error('部分流水已经被对账或不属于当前账单');
  const originalDifference = D(preview.difference);
  if (!originalDifference.isZero() && !input.createAdjustment) throw new Error(`对账差额为 ${originalDifference.toString()}，请继续核对或创建调整流水`);

  const sessionId = input.id ?? newId();
  const closedAt = new Date().toISOString();
  const adjustmentId = !originalDifference.isZero() ? `reconciliation-adjustment-${sessionId}` : undefined;
  const batchId = newId();
  await store.createAuditBatch({
    id: batchId,
    type: 'system',
    label: `完成账户对账 ${input.statementDate}`,
    entityCount: rows.length + (adjustmentId ? 2 : 1),
    summary: `${input.accountId} · ${input.assetId} · ${rows.length} 条流水`,
  });
  const session = await store.withAuditContext({ batchId, source: 'local' }, (scoped) => scoped.transaction(async (transactionStore) =>
    transactionStore.withPrevalidatedAggregates([`reconciliation:${sessionId}`], async (aggregateStore) => {
    const nextSession = await aggregateStore.reconciliationSessions.put({
      id: sessionId, createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      accountId: input.accountId,
      assetId: input.assetId,
      statementDate: input.statementDate,
      statementBalance: D(input.statementBalance || 0).toString(),
      openingBalance: preview.openingBalance,
      selectedTotal: D(preview.selectedTotal).plus(originalDifference).toString(),
      conversionTotal: preview.conversionTotal,
      clearedBalance: D(preview.clearedBalance).plus(originalDifference).toString(),
      difference: '0',
      status: 'closed',
      adjustmentTransactionId: adjustmentId,
      closedAt,
      note: input.note,
    });

    let adjustment: Transaction | undefined;
    if (adjustmentId) {
      adjustment = await saveTransaction(aggregateStore, {
        id: adjustmentId,
        createdAt: closedAt,
        updatedAt: closedAt,
        version: 1,
        isDeleted: false,
        date: input.statementDate,
        type: 'adjustment',
        category: 'reconciliation_adjustment',
        amount: originalDifference.abs().toString(),
        assetId: input.assetId,
        accountId: input.accountId,
        adjustmentDirection: originalDifference.isPositive() ? 'increase' : 'decrease',
        reconciliationSessionId: sessionId,
        status: 'cleared',
        description: '对账余额调整',
        balanceTiming: 'after', balanceTimingAccountId: input.accountId,
      });
    }

    const itemRows = adjustment
      ? [...rows, { transaction: adjustment, postingAmount: originalDifference.toString(), reconciled: false }]
      : rows;
    for (const row of itemRows) {
      const item: ReconciliationItem = {
        id: `reconciliation-item-${sessionId}-${row.transaction.id}`,
        createdAt: closedAt,
        updatedAt: '',
        version: 1,
        isDeleted: false,
        reconciliationId: sessionId,
        transactionId: row.transaction.id,
        accountId: input.accountId,
        assetId: input.assetId,
        postingAmount: row.postingAmount,
        previousStatus: row.transaction.status ?? 'cleared',
        selectedAt: closedAt,
      };
      await aggregateStore.reconciliationItems.put(item);
      if (row.transaction.status === 'pending') await aggregateStore.transactions.put({ ...row.transaction, status: 'cleared' });
    }
    const savedItems = await aggregateStore.reconciliationItems.list({ where: { reconciliationId: sessionId } });
    await aggregateStore.assertReconciliationAggregate(nextSession, savedItems);
    return nextSession;
  })));
  await store.finishAuditBatch(batchId);
  return session;
}

export async function undoLatestReconciliation(store: SqlLedgerStore, reconciliationId: string): Promise<void> {
  const session = await store.reconciliationSessions.get(reconciliationId);
  if (!session || session.isDeleted || session.status !== 'closed') throw new Error('对账记录不存在');
  const later = (await store.reconciliationSessions.list()).find((row) =>
    row.accountId === session.accountId
    && row.assetId === session.assetId
    && row.status === 'closed'
    && (row.statementDate > session.statementDate || (row.statementDate === session.statementDate && row.id !== session.id)),
  );
  if (later) throw new Error('只能从最新一期开始撤销对账');
  const items = await store.reconciliationItems.list({ where: { reconciliationId } });
  const batchId = newId();
  await store.createAuditBatch({ id: batchId, type: 'system', label: `撤销账户对账 ${session.statementDate}`, entityCount: items.length + 1 });
  await store.withAuditContext({ batchId, source: 'local' }, (scoped) => scoped.transaction(async (transactionStore) =>
    transactionStore.withPrevalidatedAggregates([`reconciliation:${session.id}`], async (aggregateStore) => {
    for (const item of items) await aggregateStore.reconciliationItems.remove(item.id, item.version);
    for (const item of items) {
      const transaction = await aggregateStore.transactions.get(item.transactionId);
      if (!transaction || transaction.isDeleted) continue;
      if (transaction.id === session.adjustmentTransactionId) {
        await aggregateStore.transactions.put({
          ...transaction,
          recordState: 'voided',
          voidedAt: new Date().toISOString(),
          voidReason: '撤销对账调整',
        });
      } else if (transaction.status !== item.previousStatus) {
        await aggregateStore.transactions.put({ ...transaction, status: item.previousStatus });
      }
    }
    await aggregateStore.reconciliationSessions.remove(session.id, session.version);
  })));
  await store.finishAuditBatch(batchId);
}

// ─────────────────────────── scheduled transaction execution ───────────────────────────

function deterministicCreatedAt(schedule: ScheduledTransaction, date: string): string {
  return `${date}T${(schedule.time ?? '00:00').slice(0, 5)}:00.000Z`;
}

async function saveScheduleExecution(
  store: SqlLedgerStore,
  schedule: ScheduledTransaction,
  index: number,
  status: ScheduledExecution['status'],
  error?: unknown,
): Promise<ScheduledExecution> {
  const date = scheduleOccurrenceDate(schedule, index);
  const createdAt = deterministicCreatedAt(schedule, date);
  const id = scheduleExecutionId(schedule.id, index);
  const current = await store.scheduledExecutions.get(id);
  const attemptedAt = new Date().toISOString();
  const retryCount = status === 'failed'
    ? (current?.retryCount ?? 0) + 1
    : current?.retryCount ?? 0;
  const retryDelayMs = Math.min(24 * 60 * 60_000, 5 * 60_000 * (2 ** Math.max(0, retryCount - 1)));
  return store.scheduledExecutions.put({
    id,
    createdAt: current?.createdAt ?? createdAt,
    updatedAt: current?.updatedAt ?? '',
    version: current?.version ?? 1,
    isDeleted: false,
    scheduleId: schedule.id, occurrenceIndex: index, occurrenceDate: date, status,
    transactionId: status === 'created' ? scheduledTransactionId(schedule.id, index) : undefined,
    attemptedAt,
    completedAt: status === 'failed' ? undefined : attemptedAt,
    retryCount,
    lastError: status === 'failed' ? (error instanceof Error ? error.message : String(error ?? '未知错误')) : undefined,
    nextRetryAt: status === 'failed' ? new Date(Date.parse(attemptedAt) + retryDelayMs).toISOString() : undefined,
  });
}

async function completedScheduledTransaction(
  store: SqlLedgerStore,
  execution: ScheduledExecution | null | undefined,
): Promise<Transaction | null> {
  if (!execution || execution.isDeleted || execution.status !== 'created' || !execution.transactionId) return null;
  const transaction = await store.transactions.get(execution.transactionId);
  return transaction && !transaction.isDeleted ? transaction : null;
}

async function waitForCompletedScheduledTransaction(
  store: SqlLedgerStore,
  executionId: string,
): Promise<Transaction | null> {
  const deadline = Date.now() + SCHEDULE_CLAIM_WAIT_MS;
  while (Date.now() < deadline) {
    const execution = await store.scheduledExecutions.get(executionId);
    const completed = await completedScheduledTransaction(store, execution);
    if (completed) return completed;
    if (execution?.status === 'skipped') throw new Error('该期已按补记策略跳过');
    if (execution && !isScheduledExecutionClaim(execution)) return null;
    await waitForScheduledClaim();
  }
  return null;
}

export async function materializeScheduledTransaction(
  store: SqlLedgerStore,
  scheduleId: string,
  occurrenceIndex?: number,
  options: { forceRetry?: boolean } = {},
): Promise<Transaction> {
  const schedule = await store.scheduledTransactions.get(scheduleId);
  if (!schedule || schedule.isDeleted) throw new Error('定期交易不存在');
  if (schedule.status !== 'active') throw new Error('定期交易已暂停');
  const executions = await store.scheduledExecutions.list({ where: { scheduleId } });
  const occurrence = occurrenceIndex === undefined
    ? nextUnhandledScheduleOccurrence(schedule, executions)
    : { index: occurrenceIndex, date: scheduleOccurrenceDate(schedule, occurrenceIndex) };
  if (!occurrence || (schedule.endDate && occurrence.date > schedule.endDate)) throw new Error('定期交易已结束');
  const executionId = scheduleExecutionId(schedule.id, occurrence.index);
  const existingExecution = await store.scheduledExecutions.get(executionId);
  if (existingExecution && !existingExecution.isDeleted) {
    if (existingExecution.status === 'skipped') throw new Error('该期已按补记策略跳过');
    if (existingExecution.status === 'created' && !existingExecution.transactionId) throw new Error('定期执行记录缺少流水引用');
    const completed = await completedScheduledTransaction(store, existingExecution);
    if (completed) return completed;
  }
  const createdAt = deterministicCreatedAt(schedule, occurrence.date);
  const attemptedAt = new Date().toISOString();
  const claim = await store.claimScheduledExecution({
    id: executionId,
    scheduleId: schedule.id,
    occurrenceIndex: occurrence.index,
    occurrenceDate: occurrence.date,
    transactionId: scheduledTransactionId(schedule.id, occurrence.index),
    createdAt,
    attemptedAt,
    leaseUntil: new Date(Date.parse(attemptedAt) + SCHEDULE_CLAIM_LEASE_MS).toISOString(),
    forceRetry: options.forceRetry,
  });
  if (claim.state === 'created') {
    const completed = await completedScheduledTransaction(store, claim.execution);
    if (completed) return completed;
    throw new Error('定期执行记录引用的流水不存在');
  }
  if (claim.state === 'skipped') throw new Error('该期已按补记策略跳过');
  if (claim.state === 'busy') {
    const completed = await waitForCompletedScheduledTransaction(store, executionId);
    if (completed) return completed;
    throw new ScheduledExecutionUnavailableError('该期正在其他窗口生成，请稍后重试');
  }
  if (claim.state === 'retry_wait') {
    throw new ScheduledExecutionUnavailableError(
      claim.execution.nextRetryAt
        ? `该期失败后正在退避，下次重试时间：${claim.execution.nextRetryAt}`
        : '该期失败后正在等待重试',
    );
  }
  if (claim.state !== 'claimed') throw new ScheduledExecutionUnavailableError('未能取得定期交易生成租约');
  const claimToken = claim.token;

  const transaction: Transaction = {
    id: scheduledTransactionId(schedule.id, occurrence.index),
    createdAt,
    updatedAt: '',
    version: 1,
    isDeleted: false,
    date: occurrence.date,
    time: schedule.time,
    timezone: schedule.timezone,
    type: schedule.type,
    category: schedule.category,
    amount: schedule.amount,
    assetId: schedule.assetId,
    accountId: schedule.accountId,
    transferAssetId: schedule.transferAssetId,
    transferAccountId: schedule.transferAccountId,
    transferAmount: schedule.transferAmount,
    status: 'pending',
    payeeId: schedule.payeeId,
    merchant: schedule.merchant,
    description: schedule.description ?? schedule.name,
    scheduledExecutionId: executionId,
    note: schedule.note,
  };
  const batchId = newId();
  try {
    const saved = await store.withAuditContext({ batchId, source: 'system' }, (scoped) => scoped.transaction(async (transactionStore) => {
      const owned = await transactionStore.getScheduledExecutionClaim(executionId, claimToken);
      if (!owned) throw new ScheduledExecutionUnavailableError('定期交易生成租约已被其他窗口接管');
      await transactionStore.createAuditBatch({
        id: batchId,
        type: 'system',
        label: `生成定期交易 ${schedule.name}`,
        entityCount: 2,
      });
      const existing = await transactionStore.transactions.get(transaction.id);
      if (existing?.isDeleted) throw new Error('定期交易对应的流水已删除，无法自动重建');
      if (existing && existing.scheduledExecutionId !== executionId) {
        throw new Error('定期交易确定性流水编号已被其他记录占用');
      }
      const row = existing ?? await saveTransaction(transactionStore, transaction);
      await saveScheduleExecution(transactionStore, schedule, occurrence.index, 'created');
      return row;
    }));
    const entityCount = (await store.operationLog({ batchId })).length;
    await store.finishAuditBatch(batchId, { entityCount, appliedCount: entityCount, outcome: 'applied' });
    return saved;
  } catch (error) {
    const completed = await completedScheduledTransaction(
      store,
      await store.scheduledExecutions.get(executionId),
    );
    if (completed) return completed;

    const failureBatchId = newId();
    const recorded = await store.withAuditContext(
      { batchId: failureBatchId, source: 'system' },
      (scoped) => scoped.transaction(async (transactionStore) => {
        const owned = await transactionStore.getScheduledExecutionClaim(executionId, claimToken);
        if (!owned) return false;
        await transactionStore.createAuditBatch({
          id: failureBatchId,
          type: 'system',
          label: `记录定期交易失败 ${schedule.name}`,
          entityCount: 1,
          summary: error instanceof Error ? error.message : String(error),
        });
        await saveScheduleExecution(transactionStore, schedule, occurrence.index, 'failed', error);
        return true;
      }),
    );
    if (recorded) {
      await store.finishAuditBatch(failureBatchId, {
        entityCount: 1,
        appliedCount: 1,
        outcome: 'invalid',
        summary: error instanceof Error ? error.message : String(error),
      });
    } else {
      const resolved = await completedScheduledTransaction(
        store,
        await store.scheduledExecutions.get(executionId),
      );
      if (resolved) return resolved;
    }
    throw error;
  }
}

export interface ScheduledRunResult {
  created: number;
  skipped: number;
  failed: number;
  backlog: number;
  errors: { scheduleId: string; message: string }[];
}

async function markScheduledOccurrencesSkipped(
  store: SqlLedgerStore,
  schedule: ScheduledTransaction,
  occurrences: ScheduleOccurrence[],
): Promise<number> {
  const owned: { occurrence: ScheduleOccurrence; executionId: string; token: string }[] = [];
  for (const occurrence of occurrences) {
    const attemptedAt = new Date().toISOString();
    const executionId = scheduleExecutionId(schedule.id, occurrence.index);
    const claim = await store.claimScheduledExecution({
      id: executionId,
      scheduleId: schedule.id,
      occurrenceIndex: occurrence.index,
      occurrenceDate: occurrence.date,
      transactionId: scheduledTransactionId(schedule.id, occurrence.index),
      createdAt: deterministicCreatedAt(schedule, occurrence.date),
      attemptedAt,
      leaseUntil: new Date(Date.parse(attemptedAt) + SCHEDULE_CLAIM_LEASE_MS).toISOString(),
    });
    if (claim.state === 'claimed') owned.push({ occurrence, executionId, token: claim.token });
  }
  if (!owned.length) return 0;

  const batchId = newId();
  const saved = await store.withAuditContext(
    { batchId, source: 'system' },
    (scoped) => scoped.transaction(async (transactionStore) => {
      const stillOwned: typeof owned = [];
      for (const row of owned) {
        if (await transactionStore.getScheduledExecutionClaim(row.executionId, row.token)) stillOwned.push(row);
      }
      if (!stillOwned.length) return 0;
      await transactionStore.createAuditBatch({
        id: batchId,
        type: 'system',
        label: `跳过定期交易 ${schedule.name}`,
        entityCount: stillOwned.length,
        summary: `按“只生成最近一期”策略跳过 ${stillOwned.length} 期`,
      });
      for (const row of stillOwned) {
        await saveScheduleExecution(transactionStore, schedule, row.occurrence.index, 'skipped');
      }
      return stillOwned.length;
    }),
  );
  if (saved > 0) {
    await store.finishAuditBatch(batchId, {
      entityCount: saved,
      appliedCount: saved,
      outcome: 'applied',
    });
  }
  return saved;
}

export async function runDueScheduledTransactions(store: SqlLedgerStore, now = new Date()): Promise<ScheduledRunResult> {
  const result: ScheduledRunResult = { created: 0, skipped: 0, failed: 0, backlog: 0, errors: [] };
  const schedules = (await store.scheduledTransactions.list()).filter((row) => row.status === 'active' && row.autoCreate);
  for (const schedule of schedules) {
    try {
      const local = zonedCalendarNow(now, schedule.timezone);
      const executions = await store.scheduledExecutions.list({ where: { scheduleId: schedule.id } });
      const handled = new Set(executions
        .filter((row) => !row.isDeleted && (row.status === 'created' || row.status === 'skipped'))
        .map((row) => row.occurrenceIndex));
      const failedByIndex = new Map(executions
        .filter((row) => !row.isDeleted && row.status === 'failed')
        .map((row) => [row.occurrenceIndex, row]));
      // 分块扫描:listScheduleOccurrences 单次最多 1000 期,超过(日频约 2.7 年)会被静默截断。
      // 从 0 起分块扫到 throughDate,跳过已处理期次,保证空洞(如失败待重试期次)不会被跳过。
      const due: ScheduleOccurrence[] = [];
      let fromIndex = 0;
      for (let chunk = 0; chunk <= MAX_SCHEDULE_OCCURRENCES / SCHEDULE_SCAN_CHUNK; chunk += 1) {
        const probingLimit = chunk === MAX_SCHEDULE_OCCURRENCES / SCHEDULE_SCAN_CHUNK ? 1 : SCHEDULE_SCAN_CHUNK;
        const rows = listScheduleOccurrences(schedule, { fromIndex, throughDate: local.date, max: probingLimit });
        if (!rows.length) break;
        if (chunk === MAX_SCHEDULE_OCCURRENCES / SCHEDULE_SCAN_CHUNK) {
          throw new Error(`定期交易 ${schedule.name} 的期次超过 10 万，请缩短有效期`);
        }
        due.push(...rows.filter((occurrence) => !handled.has(occurrence.index) && scheduleOccurrenceIsDue(schedule, occurrence, now)));
        fromIndex = rows[rows.length - 1]!.index + 1;
        if (rows.length < SCHEDULE_SCAN_CHUNK) break; // 已到 throughDate / endDate
      }
      if (!due.length) continue;
      result.backlog += due.length;
      const retryReady = (occurrence: ScheduleOccurrence) => {
        const failed = failedByIndex.get(occurrence.index);
        return !failed?.nextRetryAt || failed.nextRetryAt <= now.toISOString();
      };
      let createRows: ScheduleOccurrence[];
      let skippedRows: ScheduleOccurrence[] = [];
      if (schedule.catchUpPolicy === 'latest') {
        const pending = due.filter((occurrence) => !failedByIndex.has(occurrence.index));
        const failed = due.filter((occurrence) => failedByIndex.has(occurrence.index) && retryReady(occurrence));
        const maxHandled = handled.size ? Math.max(...handled) : -1;
        const newest = pending.at(-1);
        const newestToCreate = newest && newest.index > maxHandled ? newest : undefined;
        createRows = [...(newestToCreate ? [newestToCreate] : []), ...failed]
          .slice(0, MAX_SCHEDULE_ACTIONS_PER_RUN);
        const createIds = new Set(createRows.map((row) => row.index));
        skippedRows = pending
          .filter((occurrence) => !createIds.has(occurrence.index))
          .slice(0, MAX_SCHEDULE_ACTIONS_PER_RUN - createRows.length);
      } else {
        createRows = due.filter(retryReady).slice(0, MAX_SCHEDULE_ACTIONS_PER_RUN);
      }
      if (skippedRows.length) {
        result.skipped += await markScheduledOccurrencesSkipped(store, schedule, skippedRows);
      }
      for (const occurrence of createRows) {
        try {
          await materializeScheduledTransaction(store, schedule.id, occurrence.index);
          result.created += 1;
        } catch (error) {
          if (error instanceof ScheduledExecutionUnavailableError) continue;
          result.failed += 1;
          result.errors.push({ scheduleId: schedule.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      result.failed += 1;
      result.errors.push({ scheduleId: schedule.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export interface ScheduledBacklogItem {
  scheduleId: string;
  scheduleName: string;
  occurrenceIndex: number;
  occurrenceDate: string;
  status: 'pending' | 'failed';
  retryCount: number;
  lastError?: string;
  nextRetryAt?: string;
}

export async function previewScheduledBacklog(
  store: SqlLedgerStore,
  now = new Date(),
): Promise<ScheduledBacklogItem[]> {
  const rows: ScheduledBacklogItem[] = [];
  const schedules = (await store.scheduledTransactions.list()).filter((row) => row.status === 'active' && row.autoCreate);
  for (const schedule of schedules) {
    const local = zonedCalendarNow(now, schedule.timezone);
    const executions = await store.scheduledExecutions.list({ where: { scheduleId: schedule.id } });
    const handled = new Set(executions
      .filter((row) => !row.isDeleted && (row.status === 'created' || row.status === 'skipped'))
      .map((row) => row.occurrenceIndex));
    const failed = new Map(executions
      .filter((row) => !row.isDeleted && row.status === 'failed')
      .map((row) => [row.occurrenceIndex, row]));
    // 分块扫描,避免 1000 期上限截断(与 runDueScheduledTransactions 一致)。
    const due: ScheduleOccurrence[] = [];
    let fromIndex = 0;
    for (let chunk = 0; chunk <= MAX_SCHEDULE_OCCURRENCES / SCHEDULE_SCAN_CHUNK; chunk += 1) {
      const probingLimit = chunk === MAX_SCHEDULE_OCCURRENCES / SCHEDULE_SCAN_CHUNK ? 1 : SCHEDULE_SCAN_CHUNK;
      const chunkRows = listScheduleOccurrences(schedule, { fromIndex, throughDate: local.date, max: probingLimit });
      if (!chunkRows.length) break;
      if (chunk === MAX_SCHEDULE_OCCURRENCES / SCHEDULE_SCAN_CHUNK) {
        throw new Error(`定期交易 ${schedule.name} 的期次超过 10 万，请缩短有效期`);
      }
      due.push(...chunkRows.filter((occurrence) => !handled.has(occurrence.index) && scheduleOccurrenceIsDue(schedule, occurrence, now)));
      fromIndex = chunkRows[chunkRows.length - 1]!.index + 1;
      if (chunkRows.length < SCHEDULE_SCAN_CHUNK) break; // 已到 throughDate / endDate
    }
    for (const occurrence of due) {
      const execution = failed.get(occurrence.index);
      const claimedElsewhere = isScheduledExecutionClaim(execution);
      rows.push({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        occurrenceIndex: occurrence.index,
        occurrenceDate: occurrence.date,
        status: execution && !claimedElsewhere ? 'failed' : 'pending',
        retryCount: execution?.retryCount ?? 0,
        lastError: claimedElsewhere ? undefined : execution?.lastError,
        nextRetryAt: claimedElsewhere ? undefined : execution?.nextRetryAt,
      });
    }
  }
  return rows.sort((left, right) =>
    left.occurrenceDate.localeCompare(right.occurrenceDate)
    || left.scheduleName.localeCompare(right.scheduleName)
    || left.occurrenceIndex - right.occurrenceIndex);
}

export async function retryScheduledExecution(
  store: SqlLedgerStore,
  executionId: string,
): Promise<Transaction> {
  const execution = await store.scheduledExecutions.get(executionId);
  if (!execution || execution.isDeleted || execution.status !== 'failed') {
    throw new Error('失败的定期执行记录不存在');
  }
  return materializeScheduledTransaction(
    store,
    execution.scheduleId,
    execution.occurrenceIndex,
    { forceRetry: true },
  );
}

// ─────────────────────────── game cash-flow normalization ───────────────────────────

const GAME_INCOME_RECORD_TYPES = new Set<GameRecordType>([
  'sell_currency', 'sell_equipment', 'sell_material', 'withdraw', 'other_income',
]);
const GAME_EXPENSE_RECORD_TYPES = new Set<GameRecordType>([
  'buy_currency', 'buy_equipment', 'buy_material', 'topup', 'fee', 'account_cost', 'boosting_cost', 'other_expense',
]);

export interface GameCashflowTransactionDraft {
  categoryId: string;
  accountId?: string;
  payeeId?: string;
  merchant?: string;
  description?: string;
  note?: string;
}

export interface GameCashflowDraft {
  mode: GameCashflowMode;
  linkedTransactionId?: string;
  createTransaction?: GameCashflowTransactionDraft;
}

export interface SaveGameRecordInput {
  record: GameRecord;
  settlement: GameCashflowDraft;
  fee: GameCashflowDraft;
  expectedVersion?: number;
}

export interface SavedGameRecord {
  record: GameRecord;
  settlementLink?: GameCashflowLink;
  feeLink?: GameCashflowLink;
  settlementTransaction?: Transaction;
  feeTransaction?: Transaction;
}

export interface DeletedGameRecordCompensation {
  record: GameRecord;
  deletedVersion: number;
  links: {
    link: GameCashflowLink;
    deletedVersion: number;
    createdTransactionVersion?: number;
  }[];
}

function gameCashflowDirection(record: GameRecord, role: GameCashflowRole): GameCashflowDirection | undefined {
  if (role === 'fee') return 'outflow';
  if (GAME_INCOME_RECORD_TYPES.has(record.recordType)) return 'inflow';
  if (GAME_EXPENSE_RECORD_TYPES.has(record.recordType)) return 'outflow';
  return undefined;
}

function gameCashflowSource(record: GameRecord, role: GameCashflowRole): { assetId?: string; amount?: string } {
  return role === 'settlement'
    ? { assetId: record.settlementAssetId, amount: record.settlementAmount }
    : { assetId: record.feeAssetId, amount: record.feeAmount };
}

async function currentGameCashflowLink(
  store: SqlLedgerStore,
  gameRecordId: string,
  role: GameCashflowRole,
): Promise<GameCashflowLink | undefined> {
  return (await store.gameCashflowLinks.list({
    where: { gameRecordId, role },
    includeDeleted: true,
  })).sort((left, right) => right.version - left.version)[0];
}

async function clearGameCashflow(
  store: SqlLedgerStore,
  current: GameCashflowLink | undefined,
  reason: string,
): Promise<void> {
  if (!current || current.isDeleted) return;
  if (current.ownership === 'created') {
    const transaction = await store.transactions.get(current.transactionId);
    if (transaction && !transaction.isDeleted && isTransactionActive(transaction)) {
      await voidTransaction(store, transaction.id, reason);
    }
  }
  await store.gameCashflowLinks.remove(current.id, current.version);
}

async function validateGameRecordReferences(store: SqlLedgerStore, record: GameRecord): Promise<void> {
  const game = await store.games.get(record.gameId);
  if (!game || game.isDeleted || game.isActive === false || game.mergedIntoId) validation('游戏不存在或已归档', 'gameId');
  if (record.seasonId) {
    const season = await store.gameSeasons.get(record.seasonId);
    if (!season || season.isDeleted || season.gameId !== record.gameId || season.mergedIntoId) {
      validation('赛季不存在、已归档或不属于所选游戏', 'seasonId');
    }
  }
  if (record.gameAccountId) {
    const account = await store.gameAccounts.get(record.gameAccountId);
    if (!account || account.isDeleted || account.gameId !== record.gameId || account.mergedIntoId) {
      validation('游戏账号不存在、已归档或不属于所选游戏', 'gameAccountId');
    }
  }
  // 独立手续费记录的费用必须写在结算字段；再填手续费字段会同时创建两条支出
  // 流水并让报表重复计费（core/game.ts seasonSummary 同样依赖这一不变量）。
  if (record.recordType === 'fee' && record.feeAssetId) {
    validation('独立手续费记录的费用应填写在结算金额字段，不能同时填写手续费字段', 'feeAmount');
  }
  for (const role of ['settlement', 'fee'] as const) {
    const source = gameCashflowSource(record, role);
    // Point at whichever half is missing so the form can jump to it: an error the
    // user cannot locate reads as an unexplainable refusal.
    if (!!source.assetId !== !!source.amount) {
      validation(
        `${role === 'settlement' ? '结算' : '手续费'}币种和金额必须同时填写`,
        source.assetId ? `${role}Amount` : `${role}AssetId`,
      );
    }
    if (!source.assetId || !source.amount) continue;
    const asset = await requireAsset(store, source.assetId, role === 'settlement' ? 'settlementAssetId' : 'feeAssetId');
    if (!D(source.amount).gt(0)) validation(`${role === 'settlement' ? '结算' : '手续费'}金额必须大于 0`, `${role}Amount`);
    if (amountPrecision(source.amount) > asset.decimals) validation(`${asset.code} 最多支持 ${asset.decimals} 位小数`, `${role}Amount`);
  }
}

async function saveGameCashflow(
  store: SqlLedgerStore,
  record: GameRecord,
  role: GameCashflowRole,
  draft: GameCashflowDraft,
): Promise<{ link?: GameCashflowLink; transaction?: Transaction }> {
  const current = await currentGameCashflowLink(store, record.id, role);
  const source = gameCashflowSource(record, role);
  const direction = gameCashflowDirection(record, role);
  if (!source.assetId || !source.amount || !direction) {
    await clearGameCashflow(store, current, '游戏记录不再产生该资金流水');
    return {};
  }
  if (draft.mode === 'record_only') {
    await clearGameCashflow(store, current, '游戏资金模式改为仅登记');
    return {};
  }

  const expectedType: TransactionType = direction === 'inflow' ? 'income' : 'expense';
  let transaction: Transaction;
  let ownership: GameCashflowLink['ownership'];
  if (draft.mode === 'linked_transaction') {
    if (!draft.linkedTransactionId) validation('请选择已有流水', `${role}TransactionId`);
    const linked = await store.transactions.get(draft.linkedTransactionId);
    if (!linked || linked.isDeleted || !isTransactionActive(linked)) validation('关联流水不存在或已作废');
    if (linked.type !== expectedType) validation(`该资金项必须关联${expectedType === 'income' ? '收入' : '支出'}流水`);
    if (linked.assetId !== source.assetId || !D(linked.amount).eq(source.amount)) {
      validation('关联流水的币种和金额必须与游戏资金项完全一致');
    }
    const duplicate = (await store.gameCashflowLinks.list({ where: { transactionId: linked.id } }))
      .find((row) => row.id !== current?.id);
    if (duplicate) validation('该流水已关联其他游戏资金项，不能重复计入');
    if (current?.ownership === 'created' || (current && current.transactionId !== linked.id)) {
      await clearGameCashflow(store, current, '游戏资金来源已更换');
    }
    transaction = linked;
    ownership = 'linked';
  } else {
    const create = draft.createTransaction;
    if (!create) validation('请填写要创建的流水信息');
    await requireLeafCategory(store, create.categoryId, expectedType, `${role}CategoryId`);
    const setting = (await store.settings.list({ limit: 1 }))[0];
    const accountRequired = (setting?.ledgerMode ?? 'spending') !== 'spending';
    const account = accountRequired
      ? await requireAccount(store, create.accountId, `${role}AccountId`, true)
      : undefined;
    if (create.payeeId) {
      const payee = await store.payees.get(create.payeeId);
      if (!payee || payee.isDeleted || !payee.isActive || payee.mergedIntoId) validation('商户不存在或已归档');
    }
    if (current && current.ownership !== 'created') await clearGameCashflow(store, current, '游戏资金来源改为新建流水');
    const transactionId = current?.ownership === 'created'
      ? current.transactionId
      : `game-${role}-transaction-${record.id}`;
    const existing = await store.transactions.get(transactionId);
    transaction = await saveTransaction(store, {
      id: transactionId,
      createdAt: existing?.createdAt ?? '',
      updatedAt: existing?.updatedAt ?? '',
      version: existing?.version ?? 1,
      isDeleted: false,
      date: record.date,
      type: expectedType,
      category: create.categoryId,
      amount: D(source.amount).abs().toString(),
      assetId: source.assetId,
      accountId: account?.id,
      status: 'cleared',
      payeeId: create.payeeId,
      merchant: create.merchant,
      description: create.description ?? `${role === 'fee' ? '游戏手续费' : direction === 'inflow' ? '游戏结算收入' : '游戏结算支出'}`,
      recordState: 'active',
      voidedAt: undefined,
      voidReason: undefined,
      note: create.note,
    });
    ownership = 'created';
  }

  const baseLink = await currentGameCashflowLink(store, record.id, role);
  const link = await store.gameCashflowLinks.put({
    id: baseLink?.id ?? newId(),
    createdAt: baseLink?.createdAt ?? '',
    updatedAt: baseLink?.updatedAt ?? '',
    version: baseLink?.version ?? 1,
    isDeleted: false,
    gameRecordId: record.id,
    role,
    transactionId: transaction.id,
    direction,
    ownership,
    sourceAmount: D(source.amount).abs().toString(),
    sourceAssetId: source.assetId,
    accountId: transaction.accountId,
    note: ownership === 'created' ? '由游戏模块创建' : '关联已有流水',
  });
  return { link, transaction };
}

export async function saveGameRecordAggregate(
  store: SqlLedgerStore,
  input: SaveGameRecordInput,
): Promise<SavedGameRecord> {
  return store.runInAuditBatch('保存游戏记录及资金流水', async (transactionStore) => {
    const current = await transactionStore.gameRecords.get(input.record.id);
    if (current && input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      validation('游戏记录已在其他窗口被修改，请刷新后重试');
    }
    await validateGameRecordReferences(transactionStore, input.record);
    const record = await transactionStore.gameRecords.put({
      ...input.record,
      version: current ? (input.expectedVersion ?? input.record.version) : input.record.version,
    });
    const settlement = await saveGameCashflow(transactionStore, record, 'settlement', input.settlement);
    const fee = await saveGameCashflow(transactionStore, record, 'fee', input.fee);
    if (settlement.transaction?.id && settlement.transaction.id === fee.transaction?.id) {
      validation('结算和手续费不能共用同一条流水');
    }
    return {
      record,
      settlementLink: settlement.link,
      feeLink: fee.link,
      settlementTransaction: settlement.transaction,
      feeTransaction: fee.transaction,
    };
  });
}

export async function deleteGameRecord(
  store: SqlLedgerStore,
  recordId: string,
  expectedVersion: number,
): Promise<DeletedGameRecordCompensation> {
  const record = await store.gameRecords.get(recordId);
  if (!record || record.isDeleted) validation('游戏记录不存在');
  if (record.version !== expectedVersion) validation('游戏记录已在其他窗口被修改，请刷新后重试');
  const links = await store.gameCashflowLinks.list({ where: { gameRecordId: recordId } });
  await store.runInAuditBatch('删除游戏记录并补偿资金流水', async (transactionStore) => {
    for (const link of links) await clearGameCashflow(transactionStore, link, '游戏记录已删除');
    await transactionStore.gameRecords.remove(record.id, record.version);
  });
  const deleted = await store.gameRecords.get(record.id);
  const compensationLinks: DeletedGameRecordCompensation['links'] = [];
  for (const link of links) {
    const deletedLink = await store.gameCashflowLinks.get(link.id);
    const transaction = link.ownership === 'created' ? await store.transactions.get(link.transactionId) : undefined;
    compensationLinks.push({
      link,
      deletedVersion: deletedLink?.version ?? link.version + 1,
      createdTransactionVersion: transaction?.version,
    });
  }
  return {
    record,
    deletedVersion: deleted?.version ?? record.version + 1,
    links: compensationLinks,
  };
}

export async function restoreDeletedGameRecord(
  store: SqlLedgerStore,
  compensation: DeletedGameRecordCompensation,
): Promise<GameRecord> {
  return store.runInAuditBatch('撤销删除游戏记录', async (transactionStore) => {
    const deleted = await transactionStore.gameRecords.get(compensation.record.id);
    if (!deleted?.isDeleted || deleted.version !== compensation.deletedVersion) {
      validation('游戏记录删除后又发生了变化，不能直接撤销');
    }
    const restored = await transactionStore.gameRecords.put({
      ...compensation.record,
      version: deleted.version,
      isDeleted: false,
    });
    for (const item of compensation.links) {
      const deletedLink = await transactionStore.gameCashflowLinks.get(item.link.id);
      if (!deletedLink?.isDeleted || deletedLink.version !== item.deletedVersion) {
        validation('游戏资金关联删除后又发生了变化，不能直接撤销');
      }
      if (item.link.ownership === 'created') {
        const transaction = await transactionStore.transactions.get(item.link.transactionId);
        if (!transaction || transaction.version !== item.createdTransactionVersion || transaction.recordState !== 'voided') {
          validation('游戏模块创建的流水后来发生了变化，不能直接撤销');
        }
        await restoreTransaction(transactionStore, transaction.id);
      }
      await transactionStore.gameCashflowLinks.put({
        ...item.link,
        version: deletedLink.version,
        isDeleted: false,
      });
    }
    return restored;
  });
}

// ─────────────────────────── export / import ───────────────────────────

export interface LedgerBackup {
  version: 7 | 8;
  conversionOperations?: import('@zichan/core').ConversionOperation[];
  costBasisOpenings?: import('@zichan/core').CostBasisOpening[];
  exportedAt: string;
  chains: { chain: ConversionChain; steps: ConversionStep[] }[];
  assets: unknown[];
  accounts: unknown[];
  settings: unknown[];
  lots: Lot[];
  lotConsumptions: LotConsumption[];
  priceMarks: unknown[];
  dcaPlans: unknown[];
  dcaExecutions: unknown[];
  games: unknown[];
  gameAccounts: unknown[];
  gameSeasons: unknown[];
  gameRecords: unknown[];
  gameCashflowLinks: GameCashflowLink[];
  fixedAssets: unknown[];
  fixedAssetCategories: unknown[];
  fixedAssetEvents: unknown[];
  fixedAssetCashflowLinks: FixedAssetCashflowLink[];
  fixedAssetUsageMetrics: unknown[];
  fixedAssetUsageLogs: unknown[];
  fixedAssetConsumables: unknown[];
  fixedAssetGoals: unknown[];
  attachments: unknown[];
  categories: Category[];
  transactionTags: TransactionTag[];
  transactionLocations: TransactionLocation[];
  transactionTemplates: TransactionTemplate[];
  transactionSavedViews: TransactionSavedView[];
  payees: Payee[];
  transactions: Transaction[];
  transactionSplits: TransactionSplit[];
  refundAllocations: RefundAllocation[];
  budgetCategories: BudgetCategory[];
  scheduledTransactions: ScheduledTransaction[];
  scheduledExecutions: ScheduledExecution[];
  reconciliationSessions: ReconciliationSession[];
  reconciliationItems: ReconciliationItem[];
}

export interface BackupSummary {
  exportedAt?: string;
  entities: number;
  chains: number;
  steps: number;
  byType: Record<string, number>;
}

export interface BackupCheckIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

export interface BackupPreflight {
  ok: boolean;
  summary: BackupSummary;
  issues: BackupCheckIssue[];
}

const ENTITY_ARRAYS: { key: keyof LedgerBackup; type: string }[] = [
  { key: 'conversionOperations', type: 'conversion_operation' },
  { key: 'costBasisOpenings', type: 'cost_basis_opening' },
  { key: 'assets', type: 'asset' },
  { key: 'accounts', type: 'account' },
  { key: 'settings', type: 'setting' },
  { key: 'lots', type: 'lot' },
  { key: 'lotConsumptions', type: 'lot_consumption' },
  { key: 'priceMarks', type: 'price_mark' },
  { key: 'dcaPlans', type: 'dca_plan' },
  { key: 'dcaExecutions', type: 'dca_execution' },
  { key: 'games', type: 'game' },
  { key: 'gameAccounts', type: 'game_account' },
  { key: 'gameSeasons', type: 'game_season' },
  { key: 'gameRecords', type: 'game_record' },
  { key: 'gameCashflowLinks', type: 'game_cashflow_link' },
  { key: 'fixedAssets', type: 'fixed_asset' },
  { key: 'fixedAssetCategories', type: 'fixed_asset_category' },
  { key: 'fixedAssetEvents', type: 'fixed_asset_event' },
  { key: 'fixedAssetCashflowLinks', type: 'fixed_asset_cashflow_link' },
  { key: 'fixedAssetUsageMetrics', type: 'fixed_asset_usage_metric' },
  { key: 'fixedAssetUsageLogs', type: 'fixed_asset_usage_log' },
  { key: 'fixedAssetConsumables', type: 'fixed_asset_consumable' },
  { key: 'fixedAssetGoals', type: 'fixed_asset_goal' },
  { key: 'attachments', type: 'attachment' },
  { key: 'categories', type: 'category' },
  { key: 'transactionTags', type: 'transaction_tag' },
  { key: 'transactionLocations', type: 'transaction_location' },
  { key: 'transactionTemplates', type: 'transaction_template' },
  { key: 'transactionSavedViews', type: 'transaction_saved_view' },
  { key: 'payees', type: 'payee' },
  { key: 'transactions', type: 'transaction' },
  { key: 'transactionSplits', type: 'transaction_split' },
  { key: 'refundAllocations', type: 'refund_allocation' },
  { key: 'budgetCategories', type: 'budget_category' },
  { key: 'scheduledTransactions', type: 'scheduled_transaction' },
  { key: 'scheduledExecutions', type: 'scheduled_execution' },
  { key: 'reconciliationSessions', type: 'reconciliation_session' },
  { key: 'reconciliationItems', type: 'reconciliation_item' },
];

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function rowId(row: unknown): string | undefined {
  const obj = asObj(row);
  return typeof obj?.['id'] === 'string' ? obj['id'] : undefined;
}

function rows(data: Partial<LedgerBackup>, key: keyof LedgerBackup): unknown[] {
  const value = data[key];
  return Array.isArray(value) ? value : [];
}

function pushIssue(
  issues: BackupCheckIssue[],
  level: BackupCheckIssue['level'],
  code: string,
  message: string,
  entityType?: string,
  entityId?: string,
): void {
  issues.push({ level, code, message, entityType, entityId });
}

function requireRef(
  issues: BackupCheckIssue[],
  refs: Set<string>,
  id: unknown,
  code: string,
  message: string,
  entityType: string,
  entityId?: string,
): void {
  if (typeof id === 'string' && id && !refs.has(id)) {
    pushIssue(issues, 'error', code, `${message}: ${id}`, entityType, entityId);
  }
}

function requireRefs(
  issues: BackupCheckIssue[],
  refs: Set<string>,
  value: unknown,
  code: string,
  message: string,
  entityType: string,
  entityId?: string,
): void {
  if (!Array.isArray(value)) return;
  for (const id of value) requireRef(issues, refs, id, code, message, entityType, entityId);
}

function checkOccurrenceSnapshot(
  issues: BackupCheckIssue[],
  row: Record<string, unknown> | null,
  entityType: string,
  entityId?: string,
): void {
  if (!row) return;
  const precision = row['timePrecision'];
  const timezone = row['timezone'];
  if (!['day', 'minute', 'second'].includes(String(precision)) || typeof timezone !== 'string' || !timezone.trim()) {
    pushIssue(issues, 'error', 'invalid_occurrence', '记录缺少有效的时间精度或 IANA 时区', entityType, entityId);
    return;
  }
  try {
    const normalized = normalizeOccurrence({
      date: String(row['date'] ?? ''),
      time: typeof row['time'] === 'string' ? row['time'] : undefined,
      timezone,
      timePrecision: precision as 'day' | 'minute' | 'second',
      timeDisambiguation: row['timeDisambiguation'] === 'earlier' || row['timeDisambiguation'] === 'later'
        ? row['timeDisambiguation']
        : undefined,
    });
    const mismatch = row['timezone'] !== normalized.timezone
      || row['timePrecision'] !== normalized.timePrecision
      || (row['occurredAtUtc'] ?? undefined) !== normalized.occurredAtUtc
      || (row['utcOffsetMinutes'] ?? undefined) !== normalized.utcOffsetMinutes
      || (row['timeDisambiguation'] ?? undefined) !== normalized.timeDisambiguation;
    if (mismatch) pushIssue(issues, 'error', 'occurrence_snapshot_mismatch', '本地时间、时区与 UTC 快照不一致', entityType, entityId);
  } catch (error) {
    pushIssue(issues, 'error', 'invalid_occurrence', error instanceof Error ? error.message : String(error), entityType, entityId);
  }
}

/** Validate a backup's structure and references without mutating a store. */
export function preflightImport(data: unknown): BackupPreflight {
  const issues: BackupCheckIssue[] = [];
  const obj = asObj(data);
  const summary: BackupSummary = { entities: 0, chains: 0, steps: 0, byType: {} };
  if (!obj) {
    pushIssue(issues, 'error', 'invalid_json', '备份不是 JSON 对象');
    return { ok: false, summary, issues };
  }
  if (obj['version'] !== 7 && obj['version'] !== 8) pushIssue(issues, 'error', 'unsupported_version', '仅支持 version=7 或 version=8 备份');
  if (typeof obj['exportedAt'] === 'string') summary.exportedAt = obj['exportedAt'];

  const dataObj = obj as Partial<LedgerBackup>;
  for (const { key, type } of ENTITY_ARRAYS) {
    if ((key === 'costBasisOpenings' || key === 'conversionOperations') && dataObj.version === 7 && dataObj[key] === undefined) continue;
    if (!Array.isArray(dataObj[key])) pushIssue(issues, 'error', 'missing_array', `${String(key)} 必须是数组`, type);
  }
  if (!Array.isArray(dataObj.chains)) pushIssue(issues, 'error', 'missing_array', 'chains 必须是数组', 'conversion_chain');
  const activeSettings = rows(dataObj, 'settings')
    .map(asObj)
    .filter((setting): setting is Record<string, unknown> => !!setting && setting['isDeleted'] !== true);
  if (activeSettings.length > 1) {
    pushIssue(issues, 'error', 'multiple_active_settings', '备份包含多个活动账本设置', 'setting');
  }

  const ids: Record<string, Set<string>> = {};
  const referenceIds: Record<string, Set<string>> = {};
  const noteId = (type: string, id: string) => {
    ids[type] ??= new Set<string>();
    if (ids[type].has(id)) pushIssue(issues, 'error', 'duplicate_id', `${type} 重复 ID: ${id}`, type, id);
    ids[type].add(id);
  };
  for (const { key, type } of ENTITY_ARRAYS) {
    const list = rows(dataObj, key);
    summary.byType[type] = list.length;
    summary.entities += list.length;
    for (const row of list) {
      const id = rowId(row);
      if (!id) pushIssue(issues, 'error', 'missing_id', `${type} 缺少 id`, type);
      else {
        noteId(type, id);
        if (asObj(row)?.['isDeleted'] !== true) {
          referenceIds[type] ??= new Set<string>();
          referenceIds[type].add(id);
        }
      }
    }
  }

  const chainIds = new Set<string>();
  const referenceChainIds = new Set<string>();
  for (const item of Array.isArray(dataObj.chains) ? dataObj.chains : []) {
    const c = asObj(item)?.['chain'];
    const chain = asObj(c);
    const id = typeof chain?.['id'] === 'string' ? chain['id'] : undefined;
    if (!id) {
      pushIssue(issues, 'error', 'missing_id', 'conversion_chain 缺少 id', 'conversion_chain');
      continue;
    }
    if (chainIds.has(id)) pushIssue(issues, 'error', 'duplicate_id', `conversion_chain 重复 ID: ${id}`, 'conversion_chain', id);
    chainIds.add(id);
    if (chain?.['isDeleted'] !== true) referenceChainIds.add(id);
    const stepList = asObj(item)?.['steps'];
    if (!Array.isArray(stepList)) {
      pushIssue(issues, 'error', 'missing_steps', `链路 ${id} 缺少 steps 数组`, 'conversion_chain', id);
      continue;
    }
    summary.steps += stepList.length;
    for (const step of stepList) {
      const s = asObj(step);
      if (!s) {
        pushIssue(issues, 'error', 'invalid_step', `链路 ${id} 包含非法 step`, 'conversion_chain', id);
        continue;
      }
      if (s['chainId'] !== id) {
        pushIssue(issues, 'error', 'step_chain_mismatch', `步骤 ${String(s['id'] ?? '?')} 的 chainId 与链路不一致`, 'conversion_chain', id);
      }
    }
  }
  summary.chains = chainIds.size;

  // Groups are facts: never accept a backup that would silently split ownership.
  const conversionRows = (Array.isArray(dataObj.chains) ? dataObj.chains : []).map((item) => asObj(asObj(item)?.['chain'])).filter((row): row is Record<string, unknown> => !!row);
  const conversionById = new Map(conversionRows.map((row) => [String(row['id']), row]));
  const operationById = new Map(rows(dataObj, 'conversionOperations').map(asObj).filter((row): row is Record<string, unknown> => !!row).map((row) => [String(row['id']), row]));
  for (const [id, operation] of operationById) {
    const children = operation['chainIds'];
    if (!Array.isArray(children) || !children.length || children.some((child) => typeof child !== 'string') || new Set(children).size !== children.length) {
      pushIssue(issues, 'error', 'invalid_conversion_operation', '连续转换子记录列表为空或重复', 'conversion_operation', id);
      continue;
    }
    for (const [index, childId] of children.entries()) {
      const child = conversionById.get(String(childId));
      if (!child || child['operationId'] !== id || child['operationOrder'] !== index
        || (operation['isDeleted'] !== true && child['isDeleted'] === true)
        || (operation['isDeleted'] !== true && (child['recordState'] ?? 'active') !== (operation['recordState'] ?? 'active'))) {
        pushIssue(issues, 'error', 'conversion_operation_mismatch', '连续转换子记录缺失、归属、顺序或作废状态不一致', 'conversion_operation', id);
      }
    }
  }
  for (const child of conversionRows) {
    if (!child['operationId'] || child['isDeleted'] === true) continue;
    const owner = operationById.get(String(child['operationId']));
    if (!owner || owner['isDeleted'] === true || !Array.isArray(owner['chainIds']) || !owner['chainIds'].includes(child['id'])) {
      pushIssue(issues, 'error', 'missing_conversion_operation', '转换子记录缺少所属连续操作', 'conversion_chain', String(child['id']));
    }
  }

  const assetIds = referenceIds['asset'] ?? new Set<string>();
  for (const row of rows(dataObj, 'costBasisOpenings')) {
    const opening = row as import('@zichan/core').CostBasisOpening;
    try {
      assertCostBasisOpening(opening);
      requireRef(issues, assetIds, opening.baseCurrencyAssetId, 'missing_asset', '成本起点核算币种不存在', 'cost_basis_opening', opening.id);
      for (const item of opening.items) requireRef(issues, assetIds, item.assetId, 'missing_asset', '成本起点资产不存在', 'cost_basis_opening', opening.id);
    } catch (error) { pushIssue(issues, 'error', 'invalid_cost_opening', error instanceof Error ? error.message : String(error), 'cost_basis_opening', opening?.id); }
  }
  const accountIds = referenceIds['account'] ?? new Set<string>();
  const categoryIds = referenceIds['category'] ?? new Set<string>();
  const tagIds = referenceIds['transaction_tag'] ?? new Set<string>();
  const locationIds = referenceIds['transaction_location'] ?? new Set<string>();
  const payeeIds = referenceIds['payee'] ?? new Set<string>();
  const transactionIds = referenceIds['transaction'] ?? new Set<string>();
  const scheduleIds = referenceIds['scheduled_transaction'] ?? new Set<string>();
  const reconciliationIds = referenceIds['reconciliation_session'] ?? new Set<string>();
  const lotIds = referenceIds['lot'] ?? new Set<string>();
  const gameIds = referenceIds['game'] ?? new Set<string>();
  const gameAccountIds = referenceIds['game_account'] ?? new Set<string>();
  const seasonIds = referenceIds['game_season'] ?? new Set<string>();
  const fixedAssetIds = referenceIds['fixed_asset'] ?? new Set<string>();
  const fixedCategoryIds = referenceIds['fixed_asset_category'] ?? new Set<string>();
  const fixedMetricIds = referenceIds['fixed_asset_usage_metric'] ?? new Set<string>();
  const categoryRows = rows(dataObj, 'categories').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const categoryById = new Map(categoryRows.map((row) => [String(row['id']), row]));
  const categoryParentIds = new Set(categoryRows.filter((row) => row['isDeleted'] !== true).map((row) => row['parentId']).filter((id): id is string => typeof id === 'string' && !!id));
  const transactionRows = rows(dataObj, 'transactions').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const transactionById = new Map(transactionRows.map((row) => [String(row['id']), row]));
  const reconciliationRows = rows(dataObj, 'reconciliationSessions').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const reconciliationById = new Map(reconciliationRows.map((row) => [String(row['id']), row]));
  const reconciliationItemRows = rows(dataObj, 'reconciliationItems').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const splitRows = rows(dataObj, 'transactionSplits').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const splitById = new Map(splitRows.map((row) => [String(row['id']), row]));
  const fixedAssetRows = rows(dataObj, 'fixedAssets').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const fixedAssetById = new Map(fixedAssetRows.map((row) => [String(row['id']), row]));
  const fixedEventRows = rows(dataObj, 'fixedAssetEvents').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const fixedEventById = new Map(fixedEventRows.map((row) => [String(row['id']), row]));
  const fixedConsumableRows = rows(dataObj, 'fixedAssetConsumables').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const fixedConsumableById = new Map(fixedConsumableRows.map((row) => [String(row['id']), row]));
  const typedCategories = categoryRows.filter((row) =>
    row['isDeleted'] !== true
    &&
    typeof row['id'] === 'string'
    && typeof row['name'] === 'string'
    && (row['type'] === 'income' || row['type'] === 'expense')) as unknown as Category[];
  for (const category of typedCategories) {
    for (const issue of validateCategoryHierarchySnapshot(typedCategories, category, undefined, 0, true)) {
      pushIssue(issues, 'error', 'category_hierarchy_invalid', issue.message, 'category', category.id);
    }
  }
  const typedAssets = rows(dataObj, 'assets').map(asObj)
    .filter((row): row is Record<string, unknown> => !!row
      && typeof row['id'] === 'string'
      && typeof row['code'] === 'string'
      && typeof row['name'] === 'string') as unknown as Asset[];
  const seenAssetCodes = new Map<string, string>();
  for (const asset of typedAssets) {
    for (const issue of validateAssetMutationSnapshot(asset, undefined, 0)) {
      pushIssue(issues, 'error', 'asset_invalid', issue.message, 'asset', asset.id);
    }
    if (asset.isDeleted || asset.isActive === false) continue;
    const normalizedCode = asset.code.trim().normalize('NFKC').toLowerCase();
    const previous = seenAssetCodes.get(normalizedCode);
    if (previous) {
      pushIssue(issues, 'error', 'duplicate_asset_code', `资产代码与 ${previous} 重复`, 'asset', asset.id);
    } else {
      seenAssetCodes.set(normalizedCode, asset.id);
    }
  }
  const refundTotals = new Map<string, ReturnType<typeof D>>();
  for (const row of transactionRows) {
    if (row['isDeleted'] === true || row['recordState'] === 'voided' || row['type'] !== 'refund' || typeof row['refundForId'] !== 'string') continue;
    try {
      const amount = D(String(row['refundAppliedAmount'] ?? row['amount'] ?? '0')).abs();
      refundTotals.set(row['refundForId'], (refundTotals.get(row['refundForId']) ?? D(0)).plus(amount));
    } catch {
      pushIssue(issues, 'error', 'invalid_refund_amount', '退款包含非法冲减金额', 'transaction', rowId(row));
    }
  }
  const gameAccountGame = new Map(rows(dataObj, 'gameAccounts').map(asObj).filter((row): row is Record<string, unknown> => !!row).map((row) => [String(row['id']), String(row['gameId'])]));
  const seasonGame = new Map(rows(dataObj, 'gameSeasons').map(asObj).filter((row): row is Record<string, unknown> => !!row).map((row) => [String(row['id']), String(row['gameId'])]));
  for (const row of rows(dataObj, 'settings')) {
    const setting = asObj(row); const id = rowId(row);
    for (const field of ['baseCurrencyAssetId', 'transactionDefaultAssetId', 'investmentCostAssetId', 'fixedAssetDefaultCurrencyAssetId', 'gameDefaultSettlementAssetId']) {
      requireRef(issues, assetIds, setting?.[field], 'missing_asset_ref', `设置 ${field} 引用了不存在的资产`, 'setting', id);
    }
  }
  const dcaPlanRows = rows(dataObj, 'dcaPlans').map(asObj).filter((row): row is Record<string, unknown> => !!row);
  const dcaPlanById = new Map(dcaPlanRows.map((row) => [String(row['id']), row]));
  for (const row of dcaPlanRows) {
    const id = rowId(row);
    try {
      assertDcaPlanShape(row as unknown as DcaPlan);
    } catch (error) {
      pushIssue(issues, 'error', 'invalid_dca_plan', error instanceof Error ? error.message : String(error), 'dca_plan', id);
    }
    requireRef(issues, assetIds, row['targetAssetId'], 'missing_asset_ref', '定投计划引用了不存在的目标资产', 'dca_plan', id);
    requireRef(issues, assetIds, row['baseCurrencyAssetId'], 'missing_asset_ref', '定投计划引用了不存在的投入资产', 'dca_plan', id);
  }
  const dcaOccurrences = new Set<string>();
  for (const row of rows(dataObj, 'dcaExecutions').map(asObj).filter((item): item is Record<string, unknown> => !!item)) {
    const id = rowId(row);
    const planId = typeof row['planId'] === 'string' ? row['planId'] : '';
    const plan = dcaPlanById.get(planId);
    try {
      assertDcaExecutionShape(row as unknown as DcaExecution);
      if (plan && plan['frequency'] !== 'manual'
        && dcaOccurrenceDate(plan as unknown as DcaPlan, Number(row['occurrenceIndex'])) !== row['scheduledDate']) {
        throw new Error('定投执行日期与计划期次不一致');
      }
      const occurrenceKey = `${planId}\0${String(row['occurrenceIndex'])}`;
      if (dcaOccurrences.has(occurrenceKey)) throw new Error('同一定投期次存在重复执行');
      dcaOccurrences.add(occurrenceKey);
    } catch (error) {
      pushIssue(issues, 'error', 'invalid_dca_execution', error instanceof Error ? error.message : String(error), 'dca_execution', id);
    }
    requireRef(issues, referenceIds['dca_plan'] ?? new Set<string>(), row['planId'], 'missing_dca_plan_ref', '定投执行引用了不存在的计划', 'dca_execution', id);
    requireRef(issues, assetIds, row['baseCurrencyAssetId'], 'missing_asset_ref', '定投执行引用了不存在的投入资产', 'dca_execution', id);
    requireRef(issues, assetIds, row['finalAssetId'], 'missing_asset_ref', '定投执行引用了不存在的目标资产', 'dca_execution', id);
    requireRef(issues, referenceChainIds, row['chainId'], 'missing_chain_ref', '定投执行引用了不存在的转换链路', 'dca_execution', id);
  }
  for (const item of Array.isArray(dataObj.chains) ? dataObj.chains : []) {
    const wrapper = asObj(item);
    const chain = asObj(wrapper?.['chain']);
    const id = typeof chain?.['id'] === 'string' ? chain['id'] : undefined;
    checkOccurrenceSnapshot(issues, chain, 'conversion_chain', id);
    requireRef(issues, assetIds, chain?.['baseCurrencyAssetId'], 'missing_asset_ref', '转换链路引用了不存在的结算资产', 'conversion_chain', id);
    const stepList = wrapper?.['steps'];
    if (!Array.isArray(stepList)) continue;
    try {
      assertConversionShape(
        chain as unknown as ConversionChain,
        stepList as unknown as ConversionStep[],
      );
    } catch (error) {
      pushIssue(issues, 'error', 'invalid_conversion', error instanceof Error ? error.message : String(error), 'conversion_chain', id);
    }
    for (const step of stepList) {
      const s = asObj(step);
      requireRef(issues, assetIds, s?.['fromAssetId'], 'missing_asset_ref', '转换步骤引用了不存在的转出资产', 'conversion_chain', id);
      requireRef(issues, assetIds, s?.['toAssetId'], 'missing_asset_ref', '转换步骤引用了不存在的转入资产', 'conversion_chain', id);
      const fees = s?.['fees'];
      if (Array.isArray(fees)) {
        for (const fee of fees) {
          const f = asObj(fee);
          requireRef(issues, assetIds, f?.['assetId'], 'missing_asset_ref', '转换步骤引用了不存在的手续费资产', 'conversion_chain', id);
          requireRef(issues, accountIds, f?.['accountId'], 'missing_account_ref', '转换手续费引用了不存在的账户', 'conversion_chain', id);
        }
      }
      requireRef(issues, accountIds, s?.['accountFromId'], 'missing_account_ref', '转换步骤引用了不存在的转出账户', 'conversion_chain', id);
      requireRef(issues, accountIds, s?.['accountToId'], 'missing_account_ref', '转换步骤引用了不存在的转入账户', 'conversion_chain', id);
    }
  }
  for (const row of rows(dataObj, 'lots')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, assetIds, r?.['assetId'], 'missing_asset_ref', '批次引用了不存在的资产', 'lot', id);
    requireRef(issues, referenceChainIds, r?.['sourceChainId'], 'missing_chain_ref', '批次引用了不存在的来源链路', 'lot', id);
  }
  for (const row of rows(dataObj, 'lotConsumptions')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, lotIds, r?.['lotId'], 'missing_lot_ref', '批次消耗引用了不存在的 lot', 'lot_consumption', id);
    requireRef(issues, referenceChainIds, r?.['sellChainId'], 'missing_chain_ref', '批次消耗引用了不存在的卖出链路', 'lot_consumption', id);
  }
  for (const row of rows(dataObj, 'priceMarks')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, assetIds, r?.['assetId'], 'missing_asset_ref', '价格引用了不存在的资产', 'price_mark', id);
    requireRef(issues, assetIds, r?.['quoteAssetId'], 'missing_asset_ref', '价格引用了不存在的计价资产', 'price_mark', id);
  }
  for (const row of rows(dataObj, 'dcaPlans')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, assetIds, r?.['targetAssetId'], 'missing_asset_ref', '定投计划引用了不存在的目标资产', 'dca_plan', id);
    requireRef(issues, assetIds, r?.['baseCurrencyAssetId'], 'missing_asset_ref', '定投计划引用了不存在的投入资产', 'dca_plan', id);
  }
  const dcaPlanIds = referenceIds['dca_plan'] ?? new Set<string>();
  for (const row of rows(dataObj, 'dcaExecutions')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, dcaPlanIds, r?.['planId'], 'missing_dca_plan_ref', '定投执行引用了不存在的计划', 'dca_execution', id);
    requireRef(issues, referenceChainIds, r?.['chainId'], 'missing_chain_ref', '定投执行引用了不存在的链路', 'dca_execution', id);
  }
  for (const row of rows(dataObj, 'transactions')) {
    const r = asObj(row); const id = rowId(row);
    if (r) {
      try {
        assertTransactionShape(r as unknown as Transaction);
      } catch (error) {
        pushIssue(issues, 'error', 'invalid_transaction_enum', error instanceof Error ? error.message : '流水枚举值无效', 'transaction', id);
      }
    }
    checkOccurrenceSnapshot(issues, r, 'transaction', id);
    requireRef(issues, assetIds, r?.['assetId'], 'missing_asset_ref', '日常收支引用了不存在的资产', 'transaction', id);
    requireRef(issues, assetIds, r?.['refundAppliedAssetId'], 'missing_asset_ref', '退款冲减币种不存在', 'transaction', id);
    requireRef(issues, assetIds, r?.['transferAssetId'], 'missing_asset_ref', '转账引用了不存在的目标资产', 'transaction', id);
    requireRef(issues, accountIds, r?.['accountId'], 'missing_account_ref', '日常收支引用了不存在的账户', 'transaction', id);
    requireRef(issues, accountIds, r?.['transferAccountId'], 'missing_account_ref', '转账引用了不存在的目标账户', 'transaction', id);
    if (r?.['type'] !== 'transfer' && r?.['type'] !== 'adjustment') {
      requireRef(issues, categoryIds, r?.['category'], 'missing_category_ref', '日常收支引用了不存在的分类', 'transaction', id);
    }
    requireRefs(issues, tagIds, r?.['tagIds'], 'missing_tag_ref', '日常收支引用了不存在的标签', 'transaction', id);
    requireRef(issues, locationIds, r?.['locationId'], 'missing_location_ref', '日常收支引用了不存在的地点', 'transaction', id);
    requireRef(issues, payeeIds, r?.['payeeId'], 'missing_payee_ref', '日常收支引用了不存在的商户', 'transaction', id);
    requireRef(issues, transactionIds, r?.['refundForId'], 'missing_transaction_ref', '退款引用了不存在的原流水', 'transaction', id);
    const categoryId = typeof r?.['category'] === 'string' ? r['category'] : undefined;
    const txType = r?.['type'];
    if (r?.['recordState'] !== undefined && r['recordState'] !== 'active' && r['recordState'] !== 'voided') {
      pushIssue(issues, 'error', 'invalid_record_state', '流水记录状态无效', 'transaction', id);
    }
    if (txType === 'refund') {
      const original = typeof r?.['refundForId'] === 'string' ? transactionById.get(r['refundForId']) : undefined;
      if (!original || original['type'] !== 'expense') pushIssue(issues, 'error', 'invalid_refund_origin', '退款必须关联一笔支出', 'transaction', id);
      try {
        if (D(String(r?.['refundAppliedAmount'] ?? r?.['amount'] ?? '0')).lte(0)) pushIssue(issues, 'error', 'invalid_refund_amount', '退款冲减金额必须大于 0', 'transaction', id);
      } catch {
        pushIssue(issues, 'error', 'invalid_refund_amount', '退款冲减金额格式无效', 'transaction', id);
      }
      const attribution = r?.['refundAttributionMode'];
      const expectedEffectDate = attribution === 'original_date' ? r?.['originalDateSnapshot'] : attribution === 'refund_date' ? r?.['date'] : undefined;
      if (!expectedEffectDate || r?.['refundEffectDate'] !== expectedEffectDate
        || typeof r?.['originalDateSnapshot'] !== 'string'
        || typeof r?.['originalAmountSnapshot'] !== 'string'
        || !['proportional', 'specified'].includes(String(r?.['refundAllocationMode']))) {
        pushIssue(issues, 'error', 'refund_snapshot_invalid', '退款缺少完整且一致的日期、原金额或分配模式快照', 'transaction', id);
      }
      if (original && r?.['refundAppliedAssetId'] !== original['assetId']) {
        pushIssue(issues, 'error', 'refund_asset_mismatch', '退款冻结币种必须与原支出币种一致', 'transaction', id);
      }
    }
    if (categoryId && txType !== 'transfer' && txType !== 'adjustment') {
      const category = categoryById.get(categoryId);
      if (categoryParentIds.has(categoryId)) pushIssue(issues, 'error', 'parent_category_selected', '日常收支不能直接使用一级分类', 'transaction', id);
      const expectedCategoryType = txType === 'refund' ? 'expense' : txType;
      if (category && category['type'] !== expectedCategoryType) pushIssue(issues, 'error', 'category_type_mismatch', '日常收支的分类与收入/支出类型不一致', 'transaction', id);
    }
  }
  for (const [originalId, total] of refundTotals) {
    const original = transactionById.get(originalId);
    if (!original || original['isDeleted'] === true || original['recordState'] === 'voided') continue;
    try {
      if (total.gt(String(original['amount'] ?? '0'))) pushIssue(issues, 'error', 'refund_amount_exceeded', '退款冲减合计超过原支出', 'transaction', originalId);
    } catch {
      pushIssue(issues, 'error', 'invalid_transaction_amount', '退款关联的原支出金额无效', 'transaction', originalId);
    }
  }
  for (const row of rows(dataObj, 'transactionTemplates')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, categoryIds, r?.['category'], 'missing_category_ref', '交易模板引用了不存在的分类', 'transaction_template', id);
    requireRef(issues, assetIds, r?.['assetId'], 'missing_asset_ref', '交易模板引用了不存在的资产', 'transaction_template', id);
    requireRef(issues, accountIds, r?.['accountId'], 'missing_account_ref', '交易模板引用了不存在的账户', 'transaction_template', id);
    requireRef(issues, payeeIds, r?.['payeeId'], 'missing_payee_ref', '交易模板引用了不存在的商户', 'transaction_template', id);
    requireRefs(issues, tagIds, r?.['tagIds'], 'missing_tag_ref', '交易模板引用了不存在的标签', 'transaction_template', id);
    requireRef(issues, locationIds, r?.['locationId'], 'missing_location_ref', '交易模板引用了不存在的地点', 'transaction_template', id);
  }
  for (const row of splitRows) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, transactionIds, r?.['transactionId'], 'missing_transaction_ref', '拆分明细引用了不存在的流水', 'transaction_split', id);
    requireRef(issues, categoryIds, r?.['category'], 'missing_category_ref', '拆分明细引用了不存在的分类', 'transaction_split', id);
  }
  for (const row of rows(dataObj, 'budgetCategories')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, categoryIds, r?.['category'], 'missing_category_ref', '预算引用了不存在的分类', 'budget_category', id);
    if (typeof r?.['assetId'] !== 'string' || !r['assetId']) pushIssue(issues, 'error', 'required_field_missing', '预算缺少币种', 'budget_category', id);
    requireRef(issues, assetIds, r?.['assetId'], 'missing_asset_ref', '预算引用了不存在的币种', 'budget_category', id);
  }
  for (const row of rows(dataObj, 'scheduledTransactions')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, assetIds, r?.['assetId'], 'missing_asset_ref', '定期交易引用了不存在的资产', 'scheduled_transaction', id);
    requireRef(issues, assetIds, r?.['transferAssetId'], 'missing_asset_ref', '定期转账引用了不存在的目标资产', 'scheduled_transaction', id);
    requireRef(issues, accountIds, r?.['accountId'], 'missing_account_ref', '定期交易引用了不存在的账户', 'scheduled_transaction', id);
    requireRef(issues, accountIds, r?.['transferAccountId'], 'missing_account_ref', '定期转账引用了不存在的目标账户', 'scheduled_transaction', id);
    requireRef(issues, categoryIds, r?.['category'], 'missing_category_ref', '定期交易引用了不存在的分类', 'scheduled_transaction', id);
    requireRef(issues, payeeIds, r?.['payeeId'], 'missing_payee_ref', '定期交易引用了不存在的商户', 'scheduled_transaction', id);
  }
  for (const row of rows(dataObj, 'scheduledExecutions')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, scheduleIds, r?.['scheduleId'], 'missing_schedule_ref', '定期执行引用了不存在的计划', 'scheduled_execution', id);
    requireRef(issues, transactionIds, r?.['transactionId'], 'missing_transaction_ref', '定期执行引用了不存在的流水', 'scheduled_execution', id);
  }
  for (const r of reconciliationRows) {
    const id = rowId(r);
    requireRef(issues, accountIds, r?.['accountId'], 'missing_account_ref', '对账会话引用了不存在的账户', 'reconciliation_session', id);
    requireRef(issues, assetIds, r?.['assetId'], 'missing_asset_ref', '对账会话引用了不存在的资产', 'reconciliation_session', id);
    if (!['open', 'closed'].includes(String(r['status'] ?? ''))) {
      pushIssue(issues, 'error', 'invalid_reconciliation_status', '对账状态无效', 'reconciliation_session', id);
    }
    if (r['status'] === 'closed' && (typeof r['closedAt'] !== 'string' || !r['closedAt'])) {
      pushIssue(issues, 'error', 'missing_reconciliation_closed_at', '已关闭对账缺少关闭时间', 'reconciliation_session', id);
    }
  }
  const reconciliationItemKeys = new Set<string>();
  for (const r of reconciliationItemRows) {
    const id = rowId(r);
    requireRef(issues, reconciliationIds, r?.['reconciliationId'], 'missing_reconciliation_ref', '对账项目引用了不存在的批次', 'reconciliation_item', id);
    requireRef(issues, transactionIds, r?.['transactionId'], 'missing_transaction_ref', '对账项目引用了不存在的流水', 'reconciliation_item', id);
    requireRef(issues, accountIds, r?.['accountId'], 'missing_account_ref', '对账项目引用了不存在的账户', 'reconciliation_item', id);
    requireRef(issues, assetIds, r?.['assetId'], 'missing_asset_ref', '对账项目引用了不存在的币种', 'reconciliation_item', id);
    if (r['isDeleted'] === true) continue;
    if (r['previousStatus'] !== 'pending' && r['previousStatus'] !== 'cleared') {
      pushIssue(issues, 'error', 'invalid_reconciliation_previous_status', '对账项目的原流水状态无效', 'reconciliation_item', id);
    }
    const session = reconciliationById.get(String(r['reconciliationId'] ?? ''));
    if (session && (session['accountId'] !== r['accountId'] || session['assetId'] !== r['assetId'])) {
      pushIssue(issues, 'error', 'reconciliation_item_scope_mismatch', '对账项目与批次的账户或币种不一致', 'reconciliation_item', id);
    }
    const uniqueKey = `${String(r['transactionId'] ?? '')}\0${String(r['accountId'] ?? '')}\0${String(r['assetId'] ?? '')}`;
    if (reconciliationItemKeys.has(uniqueKey)) {
      pushIssue(issues, 'error', 'duplicate_reconciliation_item', '同一流水、账户和币种不能重复对账', 'reconciliation_item', id);
    }
    reconciliationItemKeys.add(uniqueKey);
    const transaction = transactionById.get(String(r['transactionId'] ?? ''));
    if (transaction && session) {
      if (transaction['isDeleted'] === true || transaction['recordState'] === 'voided') {
        pushIssue(issues, 'error', 'inactive_reconciliation_transaction', '对账项目引用的流水已删除或作废', 'reconciliation_item', id);
      }
      if (String(transaction['date'] ?? '') > String(session['statementDate'] ?? '')) {
        pushIssue(issues, 'error', 'reconciliation_item_after_statement', '对账项目日期晚于账单截止日', 'reconciliation_item', id);
      }
      if (session['adjustmentTransactionId'] === transaction['id']
        && (transaction['type'] !== 'adjustment' || transaction['reconciliationSessionId'] !== session['id'])) {
        pushIssue(issues, 'error', 'reconciliation_adjustment_mismatch', '对账调整流水与对账批次不一致', 'reconciliation_item', id);
      }
      try {
        const expected = accountTransactionPostings(transaction as unknown as Transaction, rows(dataObj, 'accounts') as unknown as import('@zichan/core').Account[])
          .filter((posting) => posting.accountId === session['accountId'] && posting.assetId === session['assetId'])
          .reduce((total, posting) => total.plus(posting.amount), D(0));
        if (!expected.eq(String(r['postingAmount'] ?? ''))) {
          pushIssue(issues, 'error', 'reconciliation_posting_mismatch', '对账项目金额与流水实际过账金额不一致', 'reconciliation_item', id);
        }
      } catch {
        pushIssue(issues, 'error', 'invalid_reconciliation_posting', '无法计算对账项目的流水过账金额', 'reconciliation_item', id);
      }
    }
  }
  for (const session of reconciliationRows.filter((row) => row['isDeleted'] !== true)) {
    const id = rowId(session);
    const activeItems = reconciliationItemRows.filter((row) =>
      row['isDeleted'] !== true && row['reconciliationId'] === session['id']);
    try {
      const selected = activeItems.reduce((total, item) => total.plus(String(item['postingAmount'] ?? '')), D(0));
      const cleared = D(String(session['openingBalance'] ?? '')).plus(selected);
      const difference = D(String(session['statementBalance'] ?? '')).minus(cleared);
      if (!selected.eq(String(session['selectedTotal'] ?? ''))) {
        pushIssue(issues, 'error', 'reconciliation_selected_total_mismatch', '已选流水合计与对账项目不一致', 'reconciliation_session', id);
      }
      if (!cleared.eq(String(session['clearedBalance'] ?? ''))) {
        pushIssue(issues, 'error', 'reconciliation_cleared_balance_mismatch', '清算余额不等于期初余额加已选流水合计', 'reconciliation_session', id);
      }
      if (!difference.eq(String(session['difference'] ?? ''))) {
        pushIssue(issues, 'error', 'reconciliation_difference_mismatch', '对账差额不等于账单余额减清算余额', 'reconciliation_session', id);
      }
      if (session['status'] === 'closed' && !difference.isZero()) {
        pushIssue(issues, 'error', 'reconciliation_closed_with_difference', '差额不为零的对账不能关闭', 'reconciliation_session', id);
      }
      if (session['adjustmentTransactionId']
        && !activeItems.some((item) => item['transactionId'] === session['adjustmentTransactionId'])) {
        pushIssue(issues, 'error', 'missing_reconciliation_adjustment_item', '对账批次缺少对应的调整项目', 'reconciliation_session', id);
      }
    } catch {
      pushIssue(issues, 'error', 'invalid_reconciliation_amount', '对账金额格式无效', 'reconciliation_session', id);
    }
  }
  for (const row of rows(dataObj, 'gameAccounts')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, gameIds, r?.['gameId'], 'missing_game_ref', '游戏账号引用了不存在的游戏', 'game_account', id);
  }
  for (const row of rows(dataObj, 'gameSeasons')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, gameIds, r?.['gameId'], 'missing_game_ref', '赛季引用了不存在的游戏', 'game_season', id);
  }
  for (const row of rows(dataObj, 'gameRecords')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, gameIds, r?.['gameId'], 'missing_game_ref', '游戏记录引用了不存在的游戏', 'game_record', id);
    requireRef(issues, seasonIds, r?.['seasonId'], 'missing_season_ref', '游戏记录引用了不存在的赛季', 'game_record', id);
    requireRef(issues, gameAccountIds, r?.['gameAccountId'], 'missing_game_account_ref', '游戏记录引用了不存在的账号', 'game_record', id);
    const gameId = typeof r?.['gameId'] === 'string' ? r['gameId'] : undefined;
    const seasonId = typeof r?.['seasonId'] === 'string' ? r['seasonId'] : undefined;
    const accountId = typeof r?.['gameAccountId'] === 'string' ? r['gameAccountId'] : undefined;
    if (gameId && seasonId && seasonGame.get(seasonId) !== gameId) pushIssue(issues, 'error', 'season_game_mismatch', '游戏记录的赛季不属于所选游戏', 'game_record', id);
    if (gameId && accountId && gameAccountGame.get(accountId) !== gameId) pushIssue(issues, 'error', 'account_game_mismatch', '游戏记录的账号不属于所选游戏', 'game_record', id);
    requireRef(issues, assetIds, r?.['settlementAssetId'], 'missing_asset_ref', '游戏记录引用了不存在的结算资产', 'game_record', id);
    requireRef(issues, assetIds, r?.['feeAssetId'], 'missing_asset_ref', '游戏记录引用了不存在的手续费资产', 'game_record', id);
  }
  const gameRecordIds = referenceIds['game_record'] ?? new Set<string>();
  const gameCashflowKeys = new Set<string>();
  for (const row of rows(dataObj, 'gameCashflowLinks')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, gameRecordIds, r?.['gameRecordId'], 'missing_game_record_ref', '游戏资金关联引用了不存在的游戏记录', 'game_cashflow_link', id);
    requireRef(issues, transactionIds, r?.['transactionId'], 'missing_transaction_ref', '游戏资金关联引用了不存在的流水', 'game_cashflow_link', id);
    requireRef(issues, assetIds, r?.['sourceAssetId'], 'missing_asset_ref', '游戏资金关联引用了不存在的币种', 'game_cashflow_link', id);
    requireRef(issues, accountIds, r?.['accountId'], 'missing_account_ref', '游戏资金关联引用了不存在的账户', 'game_cashflow_link', id);
    const role = String(r?.['role'] ?? '');
    if (!['settlement', 'fee'].includes(role)) pushIssue(issues, 'error', 'invalid_game_cashflow_role', '游戏资金关联角色无效', 'game_cashflow_link', id);
    const key = `${String(r?.['gameRecordId'] ?? '')}:${role}`;
    if (gameCashflowKeys.has(key)) pushIssue(issues, 'error', 'duplicate_game_cashflow_role', '同一游戏记录的资金角色只能关联一次', 'game_cashflow_link', id);
    gameCashflowKeys.add(key);
  }
  for (const row of rows(dataObj, 'fixedAssets')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, assetIds, r?.['baseCurrencyAssetId'], 'missing_asset_ref', '固定资产引用了不存在的结算资产', 'fixed_asset', id);
    requireRef(issues, fixedCategoryIds, r?.['categoryId'], 'missing_fixed_category_ref', '物品资产引用了不存在的分类', 'fixed_asset', id);
    if (r?.['bundledFromAssetId']) requireRef(issues, fixedAssetIds, r['bundledFromAssetId'], 'missing_fixed_asset_ref', '原配件所属物品不存在', 'fixed_asset', id);
    const category = rows(dataObj, 'fixedAssetCategories').map(asObj)
      .find((candidate) => candidate?.['id'] === r?.['categoryId']);
    const parent = rows(dataObj, 'fixedAssetCategories').map(asObj)
      .find((candidate) => candidate?.['id'] === category?.['parentId']);
    const hasChildren = rows(dataObj, 'fixedAssetCategories').map(asObj)
      .some((candidate) => candidate?.['parentId'] === category?.['id'] && candidate?.['isDeleted'] !== true);
    if (category && (typeof category['parentId'] !== 'string' || !parent || parent['parentId'] || hasChildren)) {
      pushIssue(issues, 'error', 'fixed_category_not_leaf', '物品资产必须使用有效的二级叶子分类', 'fixed_asset', id);
    }
  }
  for (const row of rows(dataObj, 'fixedAssetEvents')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, fixedAssetIds, r?.['fixedAssetId'], 'missing_fixed_asset_ref', '固定资产事件引用了不存在的资产', 'fixed_asset_event', id);
    if (r?.['hostAssetId']) requireRef(issues, fixedAssetIds, r['hostAssetId'], 'missing_fixed_asset_ref', '配件安装目标不存在', 'fixed_asset_event', id);
    if (r?.['parentSaleEventId']) requireRef(issues, new Set(fixedEventById.keys()), r['parentSaleEventId'], 'missing_fixed_event_ref', '配件随售关联的整机出售事件不存在', 'fixed_asset_event', id);
  }
  const purchaseEventsByAsset = new Map<string, Record<string, unknown>[]>();
  for (const event of fixedEventRows.filter((row) => row['isDeleted'] !== true)) {
    const type = String(event['type'] ?? '') as FixedEventType;
    const direction = FIXED_EVENT_CASHFLOW_DIRECTION[type];
    const mode = event['cashflowMode'];
    if (direction && !['record_only', 'linked_transaction', 'create_transaction'].includes(String(mode))) {
      pushIssue(issues, 'error', 'cashflow_mode_invalid', '有资金影响的物品事件缺少有效资金模式', 'fixed_asset_event', rowId(event));
    }
    if (!direction && mode !== undefined && mode !== null && mode !== '') {
      pushIssue(issues, 'error', 'cashflow_mode_invalid', '无资金影响的物品事件不应设置资金模式', 'fixed_asset_event', rowId(event));
    }
    if (type !== 'purchase') continue;
    const assetId = String(event['fixedAssetId'] ?? '');
    const list = purchaseEventsByAsset.get(assetId) ?? [];
    list.push(event);
    purchaseEventsByAsset.set(assetId, list);
  }
  for (const [assetId, events] of purchaseEventsByAsset) {
    if (events.length > 1) pushIssue(issues, 'error', 'duplicate_purchase_event', '同一物品只能有一条购买事件', 'fixed_asset', assetId);
  }
  for (const row of rows(dataObj, 'fixedAssetUsageMetrics')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, fixedAssetIds, r?.['fixedAssetId'], 'missing_fixed_asset_ref', '用量指标引用了不存在的物品资产', 'fixed_asset_usage_metric', id);
  }
  for (const row of rows(dataObj, 'fixedAssetUsageLogs')) {
    const r = asObj(row); const id = rowId(row);
    requireRef(issues, fixedAssetIds, r?.['fixedAssetId'], 'missing_fixed_asset_ref', '用量记录引用了不存在的物品资产', 'fixed_asset_usage_log', id);
    requireRef(issues, fixedMetricIds, r?.['metricId'], 'missing_usage_metric_ref', '用量记录引用了不存在的指标', 'fixed_asset_usage_log', id);
  }
  for (const key of ['fixedAssetConsumables', 'fixedAssetGoals'] as const) {
    for (const row of rows(dataObj, key)) {
      const r = asObj(row); const id = rowId(row);
      requireRef(issues, fixedAssetIds, r?.['fixedAssetId'], 'missing_fixed_asset_ref', '物品附属记录引用了不存在的物品资产', key === 'fixedAssetConsumables' ? 'fixed_asset_consumable' : 'fixed_asset_goal', id);
      requireRef(issues, fixedMetricIds, r?.['usageMetricId'] ?? r?.['metricId'], 'missing_usage_metric_ref', '物品附属记录引用了不存在的用量指标', key === 'fixedAssetConsumables' ? 'fixed_asset_consumable' : 'fixed_asset_goal', id);
      if (key === 'fixedAssetConsumables' && !['record_only', 'linked_transaction', 'create_transaction'].includes(String(r?.['cashflowMode']))) {
        pushIssue(issues, 'error', 'cashflow_mode_invalid', '耗材缺少有效资金模式', 'fixed_asset_consumable', id);
      }
    }
  }

  const splitTotals = new Map<string, ReturnType<typeof D>>();
  const splitRemainders = new Map<string, number>();
  for (const row of splitRows) {
    const r = asObj(row);
    if (!r || r['isDeleted'] === true || typeof r['transactionId'] !== 'string') continue;
    const parent = transactionById.get(r['transactionId']);
    const category = typeof r['category'] === 'string' ? categoryById.get(r['category']) : undefined;
    if (!parent || !['income', 'expense'].includes(String(parent['type']))) {
      pushIssue(issues, 'error', 'invalid_split_parent', '只有收入或支出流水可以包含拆分项目', 'transaction_split', rowId(row));
    }
    if (!category || !category['parentId'] || categoryParentIds.has(String(category['id'])) || category['type'] !== parent?.['type']) {
      pushIssue(issues, 'error', 'invalid_split_category', '拆分项目必须使用与流水类型一致的叶子二级分类', 'transaction_split', rowId(row));
    }
    if (r['isRemainder'] === true) {
      splitRemainders.set(r['transactionId'], (splitRemainders.get(r['transactionId']) ?? 0) + 1);
      if (r['category'] !== parent?.['category']) pushIssue(issues, 'error', 'invalid_split_remainder', '未拆分余项必须归入流水主分类', 'transaction_split', rowId(row));
    }
    try {
      const amount = D(String(r['amount'] ?? '0'));
      if (!amount.gt(0)) throw new Error('non-positive');
      splitTotals.set(r['transactionId'], (splitTotals.get(r['transactionId']) ?? D(0)).plus(amount));
    } catch {
      pushIssue(issues, 'error', 'invalid_split_amount', '拆分明细金额必须为正数', 'transaction_split', rowId(row));
    }
  }
  for (const [transactionId, total] of splitTotals) {
    const parent = transactionById.get(transactionId);
    if (!parent || parent['isDeleted'] === true) continue;
    try {
      const limit = parent['amount'];
      if (!total.eq(String(limit ?? '0'))) pushIssue(issues, 'error', 'split_total_mismatch', '拆分金额合计必须精确等于流水金额', 'transaction', transactionId);
    } catch {
      pushIssue(issues, 'error', 'invalid_transaction_amount', '原流水包含非法金额', 'transaction', transactionId);
    }
    if ((splitRemainders.get(transactionId) ?? 0) > 1) pushIssue(issues, 'error', 'multiple_split_remainders', '同一流水最多只能有一个未拆分余项', 'transaction', transactionId);
  }

  const allocationTotals = new Map<string, ReturnType<typeof D>>();
  for (const row of rows(dataObj, 'refundAllocations')) {
    const r = asObj(row); const id = rowId(row);
    if (!r || r['isDeleted'] === true) continue;
    requireRef(issues, transactionIds, r['refundTransactionId'], 'missing_transaction_ref', '退款分配引用了不存在的退款流水', 'refund_allocation', id);
    requireRef(issues, transactionIds, r['sourceTransactionId'], 'missing_transaction_ref', '退款分配引用了不存在的原支出', 'refund_allocation', id);
    requireRef(issues, categoryIds, r['categoryId'], 'missing_category_ref', '退款分配引用了不存在的冻结分类', 'refund_allocation', id);
    requireRef(issues, assetIds, r['assetId'], 'missing_asset_ref', '退款分配引用了不存在的冻结币种', 'refund_allocation', id);
    const refund = typeof r['refundTransactionId'] === 'string' ? transactionById.get(r['refundTransactionId']) : undefined;
    const source = typeof r['sourceTransactionId'] === 'string' ? transactionById.get(r['sourceTransactionId']) : undefined;
    const sourceSplit = typeof r['sourceSplitId'] === 'string' ? splitById.get(r['sourceSplitId']) : undefined;
    if (!refund || refund['type'] !== 'refund' || !source || source['type'] !== 'expense' || refund['refundForId'] !== source['id']) {
      pushIssue(issues, 'error', 'refund_allocation_mismatch', '退款分配与退款流水或原支出不一致', 'refund_allocation', id);
    }
    if (r['sourceSplitId'] && (!sourceSplit || sourceSplit['transactionId'] !== source?.['id'])) {
      pushIssue(issues, 'error', 'refund_split_mismatch', '退款分配引用的原拆分项目不属于原支出', 'refund_allocation', id);
    }
    if (r['assetId'] !== source?.['assetId'] || typeof r['categoryPathSnapshot'] !== 'string' || !r['categoryPathSnapshot'].trim()) {
      pushIssue(issues, 'error', 'refund_snapshot_invalid', '退款分配缺少有效的冻结分类路径或币种', 'refund_allocation', id);
    }
    try {
      const amount = D(String(r['amount'] ?? '0'));
      if (!amount.gt(0)) throw new Error('non-positive');
      if (refund) allocationTotals.set(String(refund['id']), (allocationTotals.get(String(refund['id'])) ?? D(0)).plus(amount));
    } catch {
      pushIssue(issues, 'error', 'invalid_refund_amount', '退款分配金额必须为正数', 'refund_allocation', id);
    }
  }
  for (const transaction of transactionRows.filter((row) => row['isDeleted'] !== true && row['type'] === 'refund')) {
    let expected: ReturnType<typeof D>;
    try { expected = D(String(transaction['refundAppliedAmount'] ?? '0')); } catch { continue; }
    if (!(allocationTotals.get(String(transaction['id'])) ?? D(0)).eq(expected)) {
      pushIssue(issues, 'error', 'refund_allocation_total_mismatch', '退款分配合计必须等于冻结的退款冲减金额', 'transaction', rowId(transaction));
    }
  }

  const cashflowByTransaction = new Map<string, ReturnType<typeof D>>();
  const cashflowBySource = new Map<string, { count: number; total: ReturnType<typeof D> }>();
  for (const row of rows(dataObj, 'fixedAssetCashflowLinks')) {
    const r = asObj(row); const id = rowId(row);
    if (!r || r['isDeleted'] === true) continue;
    requireRef(issues, fixedAssetIds, r['fixedAssetId'], 'missing_fixed_asset_ref', '资金关联引用了不存在的物品资产', 'fixed_asset_cashflow_link', id);
    requireRef(issues, transactionIds, r['transactionId'], 'missing_transaction_ref', '资金关联引用了不存在的流水', 'fixed_asset_cashflow_link', id);
    requireRef(issues, assetIds, r['sourceAssetId'], 'missing_asset_ref', '资金关联引用了不存在的来源币种', 'fixed_asset_cashflow_link', id);
    requireRef(issues, assetIds, r['baseAssetId'], 'missing_asset_ref', '资金关联引用了不存在的记账币种', 'fixed_asset_cashflow_link', id);
    const sourceType = r['sourceType'];
    const sourceId = typeof r['sourceId'] === 'string' ? r['sourceId'] : '';
    const source = sourceType === 'event'
      ? fixedEventById.get(sourceId)
      : sourceType === 'consumable' ? fixedConsumableById.get(sourceId) : undefined;
    if (!source) {
      pushIssue(issues, 'error', 'missing_cashflow_source', '资金关联引用了不存在的物品事件或耗材', 'fixed_asset_cashflow_link', id);
    }
    const fixed = typeof r['fixedAssetId'] === 'string' ? fixedAssetById.get(r['fixedAssetId']) : undefined;
    const transaction = typeof r['transactionId'] === 'string' ? transactionById.get(r['transactionId']) : undefined;
    const expectedDirection = sourceType === 'event'
      ? FIXED_EVENT_CASHFLOW_DIRECTION[String(source?.['type'] ?? '') as FixedEventType]
      : sourceType === 'consumable' ? 'outflow' : undefined;
    const expectedType = expectedDirection === 'inflow' ? 'income' : 'expense';
    const expectedOwnership = source?.['cashflowMode'] === 'create_transaction' ? 'created' : 'linked';
    if (!source || source['isDeleted'] === true || source['fixedAssetId'] !== fixed?.['id']
      || !expectedDirection || r['direction'] !== expectedDirection
      || !transaction || transaction['type'] !== expectedType || transaction['recordState'] === 'voided' || transaction['isDeleted'] === true
      || r['ownership'] !== expectedOwnership
      || r['sourceAssetId'] !== transaction['assetId'] || r['baseAssetId'] !== fixed?.['baseCurrencyAssetId']) {
      pushIssue(issues, 'error', 'cashflow_link_mismatch', '物品资金关联与来源记录、流水方向、所有权或币种不一致', 'fixed_asset_cashflow_link', id);
    }
    try {
      const sourceAmount = D(String(r['sourceAmount'] ?? '0'));
      const amountBase = D(String(r['amountBase'] ?? '0'));
      const rate = D(String(r['fxRateSnapshot'] ?? '0'));
      if (!sourceAmount.gt(0) || !amountBase.gt(0) || !rate.gt(0) || !sourceAmount.times(rate).eq(amountBase)
        || !amountBase.eq(String(source?.['amountBase'] ?? '0'))) throw new Error('invalid');
      if (transaction) cashflowByTransaction.set(String(transaction['id']), (cashflowByTransaction.get(String(transaction['id'])) ?? D(0)).plus(sourceAmount));
      const key = `${String(sourceType)}:${sourceId}`;
      const aggregate = cashflowBySource.get(key) ?? { count: 0, total: D(0) };
      aggregate.count += 1;
      aggregate.total = aggregate.total.plus(amountBase);
      cashflowBySource.set(key, aggregate);
    } catch {
      pushIssue(issues, 'error', 'invalid_cashflow_amount', '资金关联金额、来源金额或冻结汇率无效', 'fixed_asset_cashflow_link', id);
    }
  }
  for (const [transactionId, allocated] of cashflowByTransaction) {
    const transaction = transactionById.get(transactionId);
    try { if (transaction && allocated.gt(String(transaction['amount'] ?? '0'))) pushIssue(issues, 'error', 'cashflow_amount_exceeded', '物品资金关联合计超过来源流水金额', 'transaction', transactionId); }
    catch { pushIssue(issues, 'error', 'invalid_transaction_amount', '资金来源流水金额无效', 'transaction', transactionId); }
  }
  const cashflowSources = [
    ...fixedEventRows.filter((row) => row['isDeleted'] !== true && !!FIXED_EVENT_CASHFLOW_DIRECTION[String(row['type'] ?? '') as FixedEventType])
      .map((row) => ({ type: 'event', row, entityType: 'fixed_asset_event' })),
    ...fixedConsumableRows.filter((row) => row['isDeleted'] !== true)
      .map((row) => ({ type: 'consumable', row, entityType: 'fixed_asset_consumable' })),
  ];
  for (const source of cashflowSources) {
    const mode = source.row['cashflowMode'];
    const aggregate = cashflowBySource.get(`${source.type}:${String(source.row['id'])}`) ?? { count: 0, total: D(0) };
    try {
      const amount = D(String(source.row['amountBase'] ?? '0'));
      if ((mode === 'record_only' && aggregate.count > 0)
        || (mode !== 'record_only' && (aggregate.count !== 1 || !aggregate.total.eq(amount)))) {
        pushIssue(issues, 'error', 'cashflow_total_mismatch', '物品资金关联必须与来源金额和资金模式一一对应', source.entityType, rowId(source.row));
      }
    } catch {
      pushIssue(issues, 'error', 'invalid_cashflow_amount', '物品资金来源金额无效', source.entityType, rowId(source.row));
    }
  }

  const attachmentTargets: Record<string, Set<string>> = {
    transaction: transactionIds,
    conversion_chain: referenceChainIds,
    game: gameIds,
    game_account: gameAccountIds,
    game_record: referenceIds['game_record'] ?? new Set<string>(),
    fixed_asset: fixedAssetIds,
    fixed_asset_event: referenceIds['fixed_asset_event'] ?? new Set<string>(),
    fixed_asset_consumable: referenceIds['fixed_asset_consumable'] ?? new Set<string>(),
    fixed_asset_usage_log: referenceIds['fixed_asset_usage_log'] ?? new Set<string>(),
    price_mark: referenceIds['price_mark'] ?? new Set<string>(),
    asset: assetIds,
    account: accountIds,
  };
  for (const row of rows(dataObj, 'attachments')) {
    const r = asObj(row); const id = rowId(row);
    const entityType = typeof r?.['entityType'] === 'string' ? r['entityType'] : '';
    const target = attachmentTargets[entityType];
    if (!target) pushIssue(issues, 'error', 'unknown_attachment_entity', `附件使用了未知关联类型 ${entityType || '空'}`, 'attachment', id);
    else requireRef(issues, target, r?.['entityId'], 'missing_attachment_ref', '附件引用了不存在的记录', 'attachment', id);
  }

  return { ok: !issues.some((i) => i.level === 'error'), summary, issues };
}

export const validateLedgerBackup = preflightImport;

/** Full snapshot of every entity (including soft-deleted) — a portable backup. */
export async function exportLedger(store: SqlLedgerStore): Promise<LedgerBackup> {
  const all = { includeDeleted: true } as const;
  const costBasisOpenings = await store.costBasisOpenings.list(all);
  const conversionOperations = await store.conversionOperations.list(all);
  const chainRows = await store.conversionChains.list(all);
  const chains = await Promise.all(
    chainRows.map(async (chain) => ({ chain, steps: await store.listStepsByChain(chain.id) })),
  );
  const [
    assets, accounts, settings, lots, lotConsumptions, priceMarks, dcaPlans, dcaExecutions,
    games, gameAccounts, gameSeasons, gameRecords, gameCashflowLinks, fixedAssets, fixedAssetCategories, fixedAssetEvents, fixedAssetCashflowLinks,
    fixedAssetUsageMetrics, fixedAssetUsageLogs, fixedAssetConsumables, fixedAssetGoals,
    attachments, categories, transactionTags, transactionLocations, transactionTemplates, transactionSavedViews,
    payees, transactions, transactionSplits, refundAllocations, budgetCategories, scheduledTransactions, scheduledExecutions,
    reconciliationSessions, reconciliationItems,
  ] = await Promise.all([
    store.assets.list(all), store.accounts.list(all), store.settings.list(all),
    store.lots.list(all), store.lotConsumptions.list(all), store.priceMarks.list(all),
    store.dcaPlans.list(all), store.dcaExecutions.list(all), store.games.list(all),
    store.gameAccounts.list(all), store.gameSeasons.list(all), store.gameRecords.list(all),
    store.gameCashflowLinks.list(all),
    store.fixedAssets.list(all), store.fixedAssetCategories.list(all), store.fixedAssetEvents.list(all),
    store.fixedAssetCashflowLinks.list(all),
    store.fixedAssetUsageMetrics.list(all), store.fixedAssetUsageLogs.list(all),
    store.fixedAssetConsumables.list(all), store.fixedAssetGoals.list(all),
    store.attachments.list(all), store.categories.list(all), store.transactionTags.list(all),
    store.transactionLocations.list(all), store.transactionTemplates.list(all), store.transactionSavedViews.list(all), store.payees.list(all),
    store.transactions.list(all), store.transactionSplits.list(all), store.refundAllocations.list(all), store.budgetCategories.list(all),
    store.scheduledTransactions.list(all), store.scheduledExecutions.list(all),
    store.reconciliationSessions.list(all), store.reconciliationItems.list(all),
  ]);
  const costV2 = conversionOperations.length > 0 || costBasisOpenings.length > 0 || chains.some(({ chain }) => chain.costQuotes?.length || chain.type === 'swap') || transactions.some((row) => row.costQuote);
  return {
    version: costV2 ? 8 : 7,
    ...(costV2 ? { costBasisOpenings, conversionOperations } : {}), exportedAt: new Date().toISOString(), chains,
    assets, accounts, settings, lots, lotConsumptions, priceMarks, dcaPlans, dcaExecutions,
    games, gameAccounts, gameSeasons, gameRecords, gameCashflowLinks, fixedAssets, fixedAssetCategories, fixedAssetEvents, fixedAssetCashflowLinks,
    fixedAssetUsageMetrics, fixedAssetUsageLogs, fixedAssetConsumables, fixedAssetGoals, attachments,
    categories, transactionTags, transactionLocations, transactionTemplates, transactionSavedViews, payees, transactions, transactionSplits, refundAllocations, budgetCategories,
    scheduledTransactions, scheduledExecutions, reconciliationSessions, reconciliationItems,
  };
}

export interface ImportResult {
  entities: number;
  chains: number;
}

export interface RestoreResult extends ImportResult {
  removed: number;
}

export interface ImportLedgerOptions {
  /** Runs inside the same SQLite transaction after all imported entities exist. */
  afterImport?: (store: SqlLedgerStore) => Promise<void>;
  /** Runs immediately after the outer import/restore SQLite transaction commits. */
  onCommitted?: (result: ImportResult | RestoreResult) => void | Promise<void>;
}

export interface FixedAssetCashflowDraft {
  mode: FixedAssetCashflowMode;
  linkedTransactionId?: string;
  sourceAmount: string;
  createTransaction?: FixedAssetCashflowTransactionDraft;
}

export interface FixedAssetCashflowTransactionDraft {
  categoryId: string;
  accountId?: string;
  payeeId?: string;
  merchant?: string;
  description?: string;
  note?: string;
  reportingTreatment?: Transaction['reportingTreatment'];
}

export interface SaveFixedAssetAcquisitionInput {
  asset: FixedAsset;
  purchaseAmount: string;
  cashflow: FixedAssetCashflowDraft;
  expectedVersion?: number;
}

export interface SavedFixedAssetAcquisition {
  asset: FixedAsset;
  purchaseEvent: FixedAssetEvent;
  cashflowLink?: FixedAssetCashflowLink;
  transaction?: Transaction;
}

async function requireFixedAssetLeafCategory(store: SqlLedgerStore, id: string): Promise<FixedAssetCategory> {
  const category = await store.fixedAssetCategories.get(id);
  if (!category || category.isDeleted || !category.isActive || category.mergedIntoId) {
    validation('物品分类不存在或已归档', 'categoryId');
  }
  if (!category.parentId) validation('请选择物品的二级分类', 'categoryId');
  const parent = await store.fixedAssetCategories.get(category.parentId);
  if (!parent || parent.isDeleted || !parent.isActive || parent.parentId) {
    validation('物品二级分类的一级分类无效', 'categoryId');
  }
  const children = await store.fixedAssetCategories.list({ where: { parentId: category.id } });
  if (children.some((row) => row.isActive && !row.isDeleted)) validation('物品必须选择叶子分类', 'categoryId');
  return category;
}

const FIXED_EVENT_CASHFLOW_DIRECTION: Partial<Record<FixedEventType, FixedAssetCashflowDirection>> = {
  purchase: 'outflow',
  repair: 'outflow',
  upgrade: 'outflow',
  part_sale: 'inflow',
  sale: 'inflow',
};

interface FixedAssetCashflowSource {
  fixedAsset: FixedAsset;
  sourceType: FixedAssetCashflowLink['sourceType'];
  sourceId: string;
  date: string;
  amountBase: string;
  direction: FixedAssetCashflowDirection;
  description: string;
}

async function currentFixedAssetCashflowLink(
  store: SqlLedgerStore,
  sourceType: FixedAssetCashflowLink['sourceType'],
  sourceId: string,
): Promise<FixedAssetCashflowLink | undefined> {
  return (await store.fixedAssetCashflowLinks.list({
    where: { sourceType, sourceId },
    includeDeleted: true,
  })).sort((left, right) => right.version - left.version)[0];
}

async function clearFixedAssetCashflow(
  store: SqlLedgerStore,
  current: FixedAssetCashflowLink | undefined,
  reason: string,
): Promise<void> {
  if (!current || current.isDeleted) return;
  if (current.ownership === 'created') {
    const transaction = await store.transactions.get(current.transactionId);
    if (transaction && !transaction.isDeleted && isTransactionActive(transaction)) {
      await voidTransaction(store, transaction.id, reason);
    }
  }
  await store.fixedAssetCashflowLinks.remove(current.id, current.version);
}

async function saveFixedAssetCashflow(
  store: SqlLedgerStore,
  source: FixedAssetCashflowSource,
  draft: FixedAssetCashflowDraft,
): Promise<{ link?: FixedAssetCashflowLink; transaction?: Transaction }> {
  const current = await currentFixedAssetCashflowLink(store, source.sourceType, source.sourceId);
  if (draft.mode === 'record_only') {
    await clearFixedAssetCashflow(store, current, '物品资金模式改为仅登记');
    return {};
  }

  const baseAsset = await requireAsset(store, source.fixedAsset.baseCurrencyAssetId, 'baseCurrencyAssetId');
  const amountBase = D(source.amountBase);
  if (!amountBase.gt(0) || amountPrecision(amountBase.toString()) > baseAsset.decimals) {
    validation('关联资金时金额必须大于 0，且精度不能超过记账币种', 'amountBase');
  }

  let transaction: Transaction | null = null;
  let ownership: FixedAssetCashflowLink['ownership'] = 'linked';
  if (draft.mode === 'create_transaction') {
    const transactionDraft = draft.createTransaction;
    if (!transactionDraft?.categoryId) validation('请选择同时创建流水的二级分类', 'cashflowCategory');
    const existingOwned = current?.ownership === 'created'
      ? await store.transactions.get(current.transactionId)
      : null;
    if (existingOwned && (existingOwned.isDeleted || !isTransactionActive(existingOwned))) {
      validation('自动创建的流水已被作废或删除，请改用关联已有流水', 'cashflowMode');
    }
    const type: TransactionType = source.direction === 'outflow' ? 'expense' : 'income';
    transaction = (await saveTransactionAggregate(store, {
      transaction: {
        id: existingOwned?.id ?? newId(),
        createdAt: existingOwned?.createdAt ?? '',
        updatedAt: existingOwned?.updatedAt ?? '',
        version: existingOwned?.version ?? 1,
        isDeleted: false,
        date: source.date,
        timePrecision: 'day',
        type,
        category: transactionDraft.categoryId,
        amount: amountBase.toString(),
        assetId: source.fixedAsset.baseCurrencyAssetId,
        accountId: transactionDraft.accountId,
        payeeId: transactionDraft.payeeId,
        merchant: transactionDraft.merchant,
        description: transactionDraft.description?.trim() || source.description,
        note: transactionDraft.note,
        status: existingOwned?.status ?? 'cleared',
        reportingTreatment: source.direction === 'inflow'
          ? transactionDraft.reportingTreatment ?? 'ordinary'
          : 'ordinary',
        recordState: 'active',
      },
      expectedVersion: existingOwned?.version,
    })).transaction;
    ownership = 'created';
  } else {
    if (!draft.linkedTransactionId) validation('请选择已有资金流水', 'cashflowTransactionId');
    transaction = await store.transactions.get(draft.linkedTransactionId);
    const expectedType = source.direction === 'outflow' ? 'expense' : 'income';
    if (!transaction || transaction.isDeleted || !isTransactionActive(transaction) || transaction.type !== expectedType) {
      validation(source.direction === 'outflow' ? '资金来源必须是有效支出流水' : '资金来源必须是有效收入流水', 'cashflowTransactionId');
    }
    if (current?.ownership === 'created' && current.transactionId !== transaction.id) {
      await clearFixedAssetCashflow(store, current, '物品资金模式改为关联已有流水');
    }
  }

  const sourceAsset = await requireAsset(store, transaction.assetId, 'cashflowTransactionId');
  const sourceAmount = draft.mode === 'create_transaction'
    ? D(transaction.amount)
    : D(draft.sourceAmount);
  if (!sourceAmount.gt(0) || amountPrecision(sourceAmount.toString()) > sourceAsset.decimals) {
    validation('关联流水金额无效或精度超限', 'cashflowSourceAmount');
  }
  const allocatedElsewhere = (await store.fixedAssetCashflowLinks.list({ where: { transactionId: transaction.id } }))
    .filter((row) => !row.isDeleted && row.id !== current?.id)
    .reduce((total, row) => total.plus(row.sourceAmount), D(0));
  if (allocatedElsewhere.plus(sourceAmount).gt(transaction.amount)) {
    validation('关联金额超过该流水尚未分配的金额', 'cashflowSourceAmount');
  }

  const link = await store.fixedAssetCashflowLinks.put({
    id: current?.id ?? newId(),
    createdAt: current?.createdAt ?? '',
    updatedAt: current?.updatedAt ?? '',
    version: current?.version ?? 1,
    isDeleted: false,
    fixedAssetId: source.fixedAsset.id,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    transactionId: transaction.id,
    direction: source.direction,
    ownership,
    sourceAmount: sourceAmount.toString(),
    sourceAssetId: transaction.assetId,
    amountBase: amountBase.toString(),
    baseAssetId: source.fixedAsset.baseCurrencyAssetId,
    fxRateSnapshot: amountBase.div(sourceAmount).toString(),
    note: ownership === 'created' ? '由物品资产模块创建' : undefined,
  });
  return { link, transaction };
}

/**
 * Save a fixed asset, its purchase event and its funding allocation atomically.
 * The UI may expose one funding row, while the service supports multiple source
 * expenses so future imports and split purchases do not need another schema.
 */
export async function saveFixedAssetAcquisition(
  store: SqlLedgerStore,
  input: SaveFixedAssetAcquisitionInput,
): Promise<SavedFixedAssetAcquisition> {
  return store.runInAuditBatch('保存物品及资金来源', async (store) => {
    const existing = await store.fixedAssets.get(input.asset.id);
    if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      validation('物品已在其他窗口被修改，请刷新后重试');
    }
    await requireFixedAssetLeafCategory(store, input.asset.categoryId);
    const baseAsset = await requireAsset(store, input.asset.baseCurrencyAssetId, 'baseCurrencyAssetId');
    const purchaseAmount = D(input.purchaseAmount);
    if (purchaseAmount.lt(0)) validation('购买金额不能为负数', 'purchaseAmount');
    if (input.asset.bundledFromAssetId) {
      if (input.asset.role !== 'component' || !purchaseAmount.isZero() || input.cashflow.mode !== 'record_only') {
        validation('原配件不应重复记录整机已包含的购买支出', 'purchaseAmount');
      }
      const origin = await store.fixedAssets.get(input.asset.bundledFromAssetId);
      if (!origin || origin.isDeleted || origin.role === 'component') validation('原配件所属整机无效', 'bundledFromAssetId');
      if (origin.baseCurrencyAssetId !== input.asset.baseCurrencyAssetId) validation('原配件记账币种需与整机一致', 'baseCurrencyAssetId');
    }
    if (existing && existing.baseCurrencyAssetId !== input.asset.baseCurrencyAssetId) {
      const components = (await store.fixedAssets.list()).filter((row) => !row.isDeleted && row.role === 'component');
      const events = await store.fixedAssetEvents.list();
      if (input.asset.role === 'component' && events.some((row) => row.fixedAssetId === input.asset.id && row.type === 'install' && !row.isDeleted)
        || input.asset.role !== 'component' && components.some((row) => row.bundledFromAssetId === input.asset.id
          || events.some((event) => event.fixedAssetId === row.id && event.hostAssetId === input.asset.id && !event.isDeleted))) {
        validation('已有配件归属记录，不能直接更改记账币种', 'baseCurrencyAssetId');
      }
    }
    if (amountPrecision(purchaseAmount.toString()) > baseAsset.decimals) {
      validation(`购买金额最多支持 ${baseAsset.decimals} 位小数`, 'purchaseAmount');
    }
    const savedAsset = await store.fixedAssets.put({
      ...input.asset,
      version: existing ? (input.expectedVersion ?? input.asset.version) : input.asset.version,
    });
    const purchaseEvents = (await store.fixedAssetEvents.list({ where: { fixedAssetId: savedAsset.id } }))
      .filter((row) => row.type === 'purchase')
      .sort((left, right) => left.date.localeCompare(right.date));
    const currentPurchase = purchaseEvents[0];
    const purchaseEvent = await store.fixedAssetEvents.put({
      id: currentPurchase?.id ?? newId(),
      createdAt: currentPurchase?.createdAt ?? '',
      updatedAt: currentPurchase?.updatedAt ?? '',
      version: currentPurchase?.version ?? 1,
      isDeleted: false,
      fixedAssetId: savedAsset.id,
      date: savedAsset.purchaseDate,
      type: 'purchase',
      amountBase: purchaseAmount.toString(),
      cashflowMode: input.cashflow.mode,
      note: currentPurchase?.note ?? '购买记录',
    });
    const cashflow = await saveFixedAssetCashflow(store, {
      fixedAsset: savedAsset,
      sourceType: 'event',
      sourceId: purchaseEvent.id,
      date: purchaseEvent.date,
      amountBase: purchaseEvent.amountBase,
      direction: 'outflow',
      description: `购买 ${savedAsset.name}`,
    }, input.cashflow);
    await reconcileFixedAssetStatus(store, savedAsset.id);
    return {
      asset: savedAsset,
      purchaseEvent,
      cashflowLink: cashflow.link,
      transaction: cashflow.transaction,
    };
  });
}

/** Reclassify an existing upgrade as a tracked part without duplicating its expense or transaction. */
export async function convertFixedUpgradeToComponent(
  store: SqlLedgerStore,
  input: { upgradeEventId: string; expectedVersion: number; component: FixedAsset },
): Promise<FixedAsset> {
  return store.runInAuditBatch('将升级支出转为可追踪配件', async (store) => {
    const upgrade = await store.fixedAssetEvents.get(input.upgradeEventId);
    if (!upgrade || upgrade.isDeleted || upgrade.type !== 'upgrade' || upgrade.version !== input.expectedVersion) {
      validation('升级记录已变更，请刷新后重试');
    }
    if (!D(upgrade.amountBase).gt(0)) validation('只有正金额升级支出可转为配件');
    const host = await store.fixedAssets.get(upgrade.fixedAssetId);
    if (!host || host.isDeleted || host.role === 'component' || ['sold', 'scrapped', 'retired', 'gifted'].includes(host.status)) {
      validation('原物品已不可用于安装配件');
    }
    if (input.component.role !== 'component' || input.component.bundledFromAssetId
      || input.component.baseCurrencyAssetId !== host.baseCurrencyAssetId
      || input.component.purchaseDate !== upgrade.date) {
      validation('配件购买日期和记账币种需与原升级记录一致');
    }
    await requireFixedAssetLeafCategory(store, input.component.categoryId);
    if (await store.fixedAssets.get(input.component.id)) validation('配件记录已存在');
    const saved = await store.fixedAssets.put(input.component);
    await store.fixedAssetEvents.put({ ...upgrade, fixedAssetId: saved.id, type: 'purchase' });
    const link = await currentFixedAssetCashflowLink(store, 'event', upgrade.id);
    if (link && !link.isDeleted) await store.fixedAssetCashflowLinks.put({ ...link, fixedAssetId: saved.id });
    await saveFixedAssetEvent(store, { event: {
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      fixedAssetId: saved.id, hostAssetId: host.id, type: 'install', date: upgrade.date, amountBase: '0',
    } });
    return saved;
  });
}

export async function reconcileFixedAssetStatus(store: SqlLedgerStore, assetId: string, resetIfNoTerminal = false): Promise<void> {
  const asset = await store.fixedAssets.get(assetId);
  if (!asset) throw new Error(`fixed asset not found: ${assetId}`);
  const terminal = (await store.fixedAssetEvents.list({ where: { fixedAssetId: assetId } }))
    .filter((event) => ['sale', 'scrap', 'retire', 'gift'].includes(event.type))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const status = terminal?.type === 'sale' ? 'sold'
    : terminal?.type === 'scrap' ? 'scrapped'
      : terminal?.type === 'retire' ? 'retired'
        : terminal?.type === 'gift' ? 'gifted'
          : resetIfNoTerminal ? 'active' : asset.status;
  if (status !== asset.status) await store.fixedAssets.put({ ...asset, status });
}

export interface SaveFixedAssetEventInput {
  event: FixedAssetEvent;
  cashflow?: FixedAssetCashflowDraft;
  expectedVersion?: number;
  includeComponents?: boolean;
}

export interface SavedFixedAssetEvent {
  event: FixedAssetEvent;
  cashflowLink?: FixedAssetCashflowLink;
  transaction?: Transaction;
}

interface DeletedFixedCashflowCompensation {
  link: FixedAssetCashflowLink;
  deletedVersion: number;
  createdTransactionVersion?: number;
  createdTransactionWasActive: boolean;
}

interface DeletedAttachmentCompensation {
  attachment: Attachment;
  deletedVersion: number;
}

export interface DeletedFixedAssetEventCompensation {
  event: FixedAssetEvent;
  deletedVersion: number;
  includedEvents: { event: FixedAssetEvent; deletedVersion: number }[];
  cashflow?: DeletedFixedCashflowCompensation;
  attachments: DeletedAttachmentCompensation[];
}

export interface DeletedFixedAssetConsumableCompensation {
  consumable: FixedAssetConsumable;
  deletedVersion: number;
  cashflow?: DeletedFixedCashflowCompensation;
  attachments: DeletedAttachmentCompensation[];
}

async function fixedCashflowDeleteSnapshot(
  store: SqlLedgerStore,
  link: FixedAssetCashflowLink | undefined,
): Promise<{ link?: FixedAssetCashflowLink; createdTransactionWasActive: boolean }> {
  if (!link || link.isDeleted) return { createdTransactionWasActive: false };
  const transaction = link.ownership === 'created'
    ? await store.transactions.get(link.transactionId)
    : undefined;
  return {
    link,
    createdTransactionWasActive: !!transaction && !transaction.isDeleted && isTransactionActive(transaction),
  };
}

async function fixedCashflowDeleteCompensation(
  store: SqlLedgerStore,
  snapshot: Awaited<ReturnType<typeof fixedCashflowDeleteSnapshot>>,
): Promise<DeletedFixedCashflowCompensation | undefined> {
  if (!snapshot.link) return undefined;
  const deletedLink = await store.fixedAssetCashflowLinks.get(snapshot.link.id);
  const transaction = snapshot.link.ownership === 'created'
    ? await store.transactions.get(snapshot.link.transactionId)
    : undefined;
  return {
    link: snapshot.link,
    deletedVersion: deletedLink?.version ?? snapshot.link.version + 1,
    createdTransactionVersion: transaction?.version,
    createdTransactionWasActive: snapshot.createdTransactionWasActive,
  };
}

async function restoreFixedCashflowCompensation(
  store: SqlLedgerStore,
  compensation: DeletedFixedCashflowCompensation | undefined,
): Promise<void> {
  if (!compensation) return;
  const deletedLink = await store.fixedAssetCashflowLinks.get(compensation.link.id);
  if (!deletedLink?.isDeleted || deletedLink.version !== compensation.deletedVersion) {
    validation('物品资金关联删除后又发生了变化，不能直接撤销');
  }
  if (compensation.link.ownership === 'created' && compensation.createdTransactionWasActive) {
    const transaction = await store.transactions.get(compensation.link.transactionId);
    if (!transaction
      || transaction.version !== compensation.createdTransactionVersion
      || transaction.recordState !== 'voided') {
      validation('物品模块创建的流水后来发生了变化，不能直接撤销');
    }
    await restoreTransaction(store, transaction.id);
  }
  await store.fixedAssetCashflowLinks.put({
    ...compensation.link,
    version: deletedLink.version,
    isDeleted: false,
  });
}

async function deletedAttachmentCompensations(
  store: SqlLedgerStore,
  attachments: Attachment[],
): Promise<DeletedAttachmentCompensation[]> {
  const result: DeletedAttachmentCompensation[] = [];
  for (const attachment of attachments) {
    const deleted = await store.attachments.get(attachment.id);
    result.push({ attachment, deletedVersion: deleted?.version ?? attachment.version + 1 });
  }
  return result;
}

async function restoreDeletedAttachments(
  store: SqlLedgerStore,
  compensations: DeletedAttachmentCompensation[],
): Promise<void> {
  for (const compensation of compensations) {
    const current = await store.attachments.get(compensation.attachment.id);
    if (!current?.isDeleted || current.version !== compensation.deletedVersion) {
      validation(`附件 ${compensation.attachment.fileName} 删除后又发生了变化，不能直接撤销`);
    }
    await store.attachments.put({
      ...compensation.attachment,
      version: current.version,
      isDeleted: false,
    });
  }
}

export async function saveFixedAssetEvent(
  store: SqlLedgerStore,
  input: SaveFixedAssetEventInput,
): Promise<SavedFixedAssetEvent> {
  return store.runInAuditBatch('保存物品生命周期事件', async (store) => {
    const current = await store.fixedAssetEvents.get(input.event.id);
    if (current?.parentSaleEventId || input.event.parentSaleEventId) validation('随整机出售的配件记录需通过整机出售事件维护');
    if (current?.type === 'purchase' || input.event.type === 'purchase') {
      validation('购买事件只能在物品编辑页维护');
    }
    if (current && input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      validation('物品事件已在其他窗口被修改，请刷新后重试');
    }
    const fixedAsset = await store.fixedAssets.get(input.event.fixedAssetId);
    if (!fixedAsset || fixedAsset.isDeleted) validation('物品资产不存在');
    const amount = D(input.event.amountBase);
    if (amount.lt(0)) validation('金额不能小于 0', 'amountBase');
    if (input.event.type === 'part_sale' && !input.event.note?.trim()) validation('请填写卖出的配件名称', 'note');
    if (input.event.type === 'install' || input.event.type === 'detach') {
      if (fixedAsset.role !== 'component') validation('只有可追踪配件才能安装或拆下', 'type');
      if (!amount.isZero()) validation('安装或拆下不能产生新的支出', 'amountBase');
      if (input.cashflow?.mode && input.cashflow.mode !== 'record_only') validation('安装或拆下不产生资金流水', 'cashflowMode');
      if (input.event.date < fixedAsset.purchaseDate) validation('操作日期不能早于配件购入日期', 'date');
      const otherEvents = (await store.fixedAssetEvents.list({ where: { fixedAssetId: fixedAsset.id } }))
        .filter((row) => row.id !== input.event.id);
      if (otherEvents.some((row) => !row.isDeleted && (row.type === 'install' || row.type === 'detach') && row.date === input.event.date)) {
        validation('同一配件同一天只能记录一次安装、拆下或转装', 'date');
      }
      const currentHost = componentHostAt(fixedAsset.id, otherEvents, input.event.date);
      if (input.event.type === 'install') {
        const host = input.event.hostAssetId ? await store.fixedAssets.get(input.event.hostAssetId) : null;
        if (!host || host.isDeleted || host.role === 'component' || ['sold', 'scrapped', 'retired', 'gifted'].includes(host.status)) {
          validation('请选择仍在持有的整件物品', 'hostAssetId');
        }
        if (host.id === fixedAsset.id || host.baseCurrencyAssetId !== fixedAsset.baseCurrencyAssetId) {
          validation('配件与目标物品需使用相同记账币种', 'hostAssetId');
        }
        if (currentHost === host.id) validation('配件已安装在目标物品上', 'hostAssetId');
      } else {
        if (input.event.hostAssetId) validation('拆下配件不能指定目标物品', 'hostAssetId');
        if (!currentHost) validation('该配件当前没有安装在物品上', 'type');
      }
      const terminal = (await store.fixedAssetEvents.list({ where: { fixedAssetId: fixedAsset.id } }))
        .filter((row) => !row.isDeleted && row.id !== input.event.id && ['sale', 'scrap', 'retire', 'gift'].includes(row.type))
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      if (terminal && input.event.date >= terminal.date) validation('已出售或清退的配件不能再安装或拆下', 'date');
    } else if (input.event.hostAssetId) validation('只有安装事件可指定目标物品', 'hostAssetId');
    if (input.event.type === 'sale' && fixedAsset.role === 'component') {
      const futurePlacement = (await store.fixedAssetEvents.list({ where: { fixedAssetId: fixedAsset.id } }))
        .some((row) => !row.isDeleted && row.id !== input.event.id
          && (row.type === 'install' || row.type === 'detach') && row.date > input.event.date);
      if (futurePlacement) validation('卖出日期之后还有配件安装记录，请先调整安装历史', 'date');
    }
    if (['sale', 'scrap', 'retire', 'gift'].includes(input.event.type)
      && fixedAsset.role !== 'component' && !(input.event.type === 'sale' && input.includeComponents)) {
      const components = (await store.fixedAssets.list()).filter((row) => !row.isDeleted && row.role === 'component');
      const allEvents = (await store.fixedAssetEvents.list()).filter((row) => row.parentSaleEventId !== input.event.id);
      if (components.some((row) => componentHostAt(row.id, allEvents, input.event.date) === fixedAsset.id)) {
        validation('仍有配件安装在这件物品上，出售时请选择随整机出售，其他清退操作请先拆下配件', 'type');
      }
    }
    const direction = FIXED_EVENT_CASHFLOW_DIRECTION[input.event.type];
    const event = await store.fixedAssetEvents.put({
      ...input.event,
      version: current ? (input.expectedVersion ?? input.event.version) : input.event.version,
      cashflowMode: direction ? input.cashflow?.mode ?? 'record_only' : undefined,
    });
    const previousIncluded = (await store.fixedAssetEvents.list({ where: { parentSaleEventId: event.id } }))
      .filter((row) => !row.isDeleted);
    if (event.type === 'sale' && fixedAsset.role !== 'component' && input.includeComponents) {
      const components = (await store.fixedAssets.list()).filter((row) => !row.isDeleted && row.role === 'component');
      const allEvents = (await store.fixedAssetEvents.list()).filter((row) => row.parentSaleEventId !== event.id);
      const includedIds = new Set<string>();
      for (const component of components.filter((row) => componentHostAt(row.id, allEvents, event.date) === fixedAsset.id)) {
        includedIds.add(component.id);
        const previous = previousIncluded.find((row) => row.fixedAssetId === component.id);
        await store.fixedAssetEvents.put({
          id: previous?.id ?? newId(), createdAt: previous?.createdAt ?? '', updatedAt: previous?.updatedAt ?? '',
          version: previous?.version ?? 1, isDeleted: false, fixedAssetId: component.id,
          parentSaleEventId: event.id, date: event.date, type: 'sale', amountBase: '0',
          cashflowMode: 'record_only', note: `随 ${fixedAsset.name} 出售`,
        });
        await reconcileFixedAssetStatus(store, component.id);
      }
      for (const previous of previousIncluded.filter((row) => !includedIds.has(row.fixedAssetId))) {
        await store.fixedAssetEvents.remove(previous.id, previous.version);
        await reconcileFixedAssetStatus(store, previous.fixedAssetId, true);
      }
    } else for (const previous of previousIncluded) {
      await store.fixedAssetEvents.remove(previous.id, previous.version);
      await reconcileFixedAssetStatus(store, previous.fixedAssetId, true);
    }
    let cashflow: { link?: FixedAssetCashflowLink; transaction?: Transaction } = {};
    if (direction) {
      cashflow = await saveFixedAssetCashflow(store, {
        fixedAsset,
        sourceType: 'event',
        sourceId: event.id,
        date: event.date,
        amountBase: event.amountBase,
        direction,
        description: `${event.type === 'sale' ? '出售整件物品' : event.type === 'part_sale' ? '卖出配件' : event.type === 'repair' ? '维修' : '升级'} ${fixedAsset.name}`,
      }, input.cashflow ?? { mode: 'record_only', sourceAmount: '0' });
    } else {
      await clearFixedAssetCashflow(
        store,
        await currentFixedAssetCashflowLink(store, 'event', event.id),
        '物品事件不再产生资金流水',
      );
    }
    await reconcileFixedAssetStatus(
      store,
      event.fixedAssetId,
      !!current && ['sale', 'scrap', 'retire', 'gift'].includes(current.type),
    );
    return { event, cashflowLink: cashflow.link, transaction: cashflow.transaction };
  });
}

export async function deleteFixedAssetEvent(
  store: SqlLedgerStore,
  event: FixedAssetEvent,
): Promise<DeletedFixedAssetEventCompensation> {
  const current = await store.fixedAssetEvents.get(event.id);
  if (!current || current.isDeleted) validation('物品生命周期事件不存在');
  if (current.parentSaleEventId) validation('随整机出售的配件记录需通过整机出售事件维护');
  if (current.version !== event.version) validation('物品事件已在其他窗口被修改，请刷新后重试');
  const link = await currentFixedAssetCashflowLink(store, 'event', event.id);
  const cashflowSnapshot = await fixedCashflowDeleteSnapshot(store, link);
  const attachments = await store.attachments.list({ where: { entityType: 'fixed_asset_event', entityId: event.id } });
  const included = (await store.fixedAssetEvents.list({ where: { parentSaleEventId: event.id } })).filter((row) => !row.isDeleted);
  await store.runInAuditBatch('删除物品生命周期事件', async (store) => {
    if (event.type === 'purchase') validation('购买事件随物品维护，不能单独删除');
    await clearFixedAssetCashflow(
      store,
      await currentFixedAssetCashflowLink(store, 'event', event.id),
      '物品生命周期事件已删除',
    );
    for (const attachment of attachments) await store.attachments.remove(attachment.id, attachment.version);
    for (const child of included) {
      await store.fixedAssetEvents.remove(child.id, child.version);
      await reconcileFixedAssetStatus(store, child.fixedAssetId, true);
    }
    await store.fixedAssetEvents.remove(event.id, event.version);
    await reconcileFixedAssetStatus(store, event.fixedAssetId, ['sale', 'scrap', 'retire', 'gift'].includes(event.type));
  });
  const deleted = await store.fixedAssetEvents.get(event.id);
  return {
    event: current,
    deletedVersion: deleted?.version ?? event.version + 1,
    includedEvents: await Promise.all(included.map(async (child) => ({
      event: child, deletedVersion: (await store.fixedAssetEvents.get(child.id))?.version ?? child.version + 1,
    }))),
    cashflow: await fixedCashflowDeleteCompensation(store, cashflowSnapshot),
    attachments: await deletedAttachmentCompensations(store, attachments),
  };
}

export async function restoreDeletedFixedAssetEvent(
  store: SqlLedgerStore,
  compensation: DeletedFixedAssetEventCompensation,
): Promise<FixedAssetEvent> {
  return store.runInAuditBatch('撤销删除物品生命周期事件', async (transactionStore) => {
    const current = await transactionStore.fixedAssetEvents.get(compensation.event.id);
    if (!current?.isDeleted || current.version !== compensation.deletedVersion) {
      validation('物品事件删除后又发生了变化，不能直接撤销');
    }
    const restored = await transactionStore.fixedAssetEvents.put({
      ...compensation.event,
      version: current.version,
      isDeleted: false,
    });
    for (const child of compensation.includedEvents ?? []) {
      const deletedChild = await transactionStore.fixedAssetEvents.get(child.event.id);
      if (!deletedChild?.isDeleted || deletedChild.version !== child.deletedVersion) validation('配件出售记录已改变，无法撤销整机出售');
      await transactionStore.fixedAssetEvents.put({ ...child.event, version: deletedChild.version, isDeleted: false });
      await reconcileFixedAssetStatus(transactionStore, child.event.fixedAssetId, true);
    }
    await restoreFixedCashflowCompensation(transactionStore, compensation.cashflow);
    await restoreDeletedAttachments(transactionStore, compensation.attachments);
    await reconcileFixedAssetStatus(transactionStore, restored.fixedAssetId, true);
    return restored;
  });
}

export interface SaveFixedAssetConsumableInput {
  consumable: FixedAssetConsumable;
  cashflow: FixedAssetCashflowDraft;
  expectedVersion?: number;
}

export interface SavedFixedAssetConsumable {
  consumable: FixedAssetConsumable;
  cashflowLink?: FixedAssetCashflowLink;
  transaction?: Transaction;
}

export async function saveFixedAssetConsumable(
  store: SqlLedgerStore,
  input: SaveFixedAssetConsumableInput,
): Promise<SavedFixedAssetConsumable> {
  return store.runInAuditBatch('保存物品耗材及资金来源', async (store) => {
    const current = await store.fixedAssetConsumables.get(input.consumable.id);
    if (current && input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      validation('耗材已在其他窗口被修改，请刷新后重试');
    }
    const fixedAsset = await store.fixedAssets.get(input.consumable.fixedAssetId);
    if (!fixedAsset || fixedAsset.isDeleted) validation('物品资产不存在');
    if (input.consumable.usageMetricId) {
      const metric = await store.fixedAssetUsageMetrics.get(input.consumable.usageMetricId);
      if (!metric || metric.isDeleted || metric.fixedAssetId !== fixedAsset.id) {
        validation('耗材寿命指标不属于当前物品', 'usageMetricId');
      }
    }
    const amount = D(input.consumable.amountBase);
    if (amount.lt(0)) validation('耗材成本不能小于 0', 'amountBase');
    const consumable = await store.fixedAssetConsumables.put({
      ...input.consumable,
      version: current ? (input.expectedVersion ?? input.consumable.version) : input.consumable.version,
      cashflowMode: input.cashflow.mode,
    });
    const cashflow = await saveFixedAssetCashflow(store, {
      fixedAsset,
      sourceType: 'consumable',
      sourceId: consumable.id,
      date: consumable.purchaseDate,
      amountBase: consumable.amountBase,
      direction: 'outflow',
      description: `购买耗材 ${consumable.name}`,
    }, input.cashflow);
    return { consumable, cashflowLink: cashflow.link, transaction: cashflow.transaction };
  });
}

export async function deleteFixedAssetConsumable(
  store: SqlLedgerStore,
  consumable: FixedAssetConsumable,
): Promise<DeletedFixedAssetConsumableCompensation> {
  const current = await store.fixedAssetConsumables.get(consumable.id);
  if (!current || current.isDeleted) validation('物品耗材不存在');
  if (current.version !== consumable.version) validation('耗材已在其他窗口被修改，请刷新后重试');
  const link = await currentFixedAssetCashflowLink(store, 'consumable', consumable.id);
  const cashflowSnapshot = await fixedCashflowDeleteSnapshot(store, link);
  const attachments = await store.attachments.list({ where: { entityType: 'fixed_asset_consumable', entityId: consumable.id } });
  await store.runInAuditBatch('删除物品耗材', async (store) => {
    await clearFixedAssetCashflow(
      store,
      await currentFixedAssetCashflowLink(store, 'consumable', consumable.id),
      '物品耗材已删除',
    );
    const attachments = await store.attachments.list({ where: { entityType: 'fixed_asset_consumable', entityId: consumable.id } });
    for (const attachment of attachments) await store.attachments.remove(attachment.id, attachment.version);
    await store.fixedAssetConsumables.remove(consumable.id, consumable.version);
  });
  const deleted = await store.fixedAssetConsumables.get(consumable.id);
  return {
    consumable: current,
    deletedVersion: deleted?.version ?? consumable.version + 1,
    cashflow: await fixedCashflowDeleteCompensation(store, cashflowSnapshot),
    attachments: await deletedAttachmentCompensations(store, attachments),
  };
}

export async function restoreDeletedFixedAssetConsumable(
  store: SqlLedgerStore,
  compensation: DeletedFixedAssetConsumableCompensation,
): Promise<FixedAssetConsumable> {
  return store.runInAuditBatch('撤销删除物品耗材', async (transactionStore) => {
    const current = await transactionStore.fixedAssetConsumables.get(compensation.consumable.id);
    if (!current?.isDeleted || current.version !== compensation.deletedVersion) {
      validation('物品耗材删除后又发生了变化，不能直接撤销');
    }
    const restored = await transactionStore.fixedAssetConsumables.put({
      ...compensation.consumable,
      version: current.version,
      isDeleted: false,
    });
    await restoreFixedCashflowCompensation(transactionStore, compensation.cashflow);
    await restoreDeletedAttachments(transactionStore, compensation.attachments);
    return restored;
  });
}

export async function deleteFixedAsset(store: SqlLedgerStore, asset: FixedAsset): Promise<void> {
  await archiveMasterData(store, 'fixed_asset', asset.id, asset.version, '用户归档');
}

/**
 * Restore a backup by upserting every entity (merge semantics — does not delete
 * rows that aren't in the backup). Import into a fresh/empty store for a clean
 * restore.
 */
export async function importLedger(
  store: SqlLedgerStore,
  data: LedgerBackup,
  options: ImportLedgerOptions = {},
): Promise<ImportResult> {
  const sourcePreflight = preflightImport(data);
  if (!sourcePreflight.ok) throw new Error(`importLedger: preflight failed (${sourcePreflight.issues.filter((i) => i.level === 'error').map((i) => `${i.code}: ${i.message}`).join('; ')})`);
  const existingDefaults = (await store.accounts.list()).filter(isDefaultAccount);
  const mapping = new Map<string, string>();
  for (const account of data.accounts as import('@zichan/core').Account[]) {
    const existing = existingDefaults.find((a) => a.purpose === account.purpose);
    if (existing && existing.id !== account.id) mapping.set(account.id, existing.id);
  }
  if (mapping.size) {
    const accountFields = new Set(['accountId', 'accountFromId', 'accountToId', 'transferAccountId', 'defaultAccountId', 'expenseDefaultAccountId', 'incomeDefaultAccountId', 'balanceTimingAccountId']);
    const remap = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(remap);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        accountFields.has(key) && typeof item === 'string' ? mapping.get(item) ?? item : remap(item)]));
    };
    const rewritten = remap(data) as LedgerBackup;
    rewritten.accounts = (data.accounts as import('@zichan/core').Account[]).map((a) => mapping.has(a.id) ? existingDefaults.find((x) => x.id === mapping.get(a.id))! : a);
    rewritten.attachments = (rewritten.attachments as import('@zichan/core').Attachment[]).map((a) => a.entityType === 'account' && mapping.has(a.entityId) ? { ...a, entityId: mapping.get(a.entityId)! } : a);
    data = rewritten;
  }
  const preflight = preflightImport(data);
  if (!preflight.ok) {
    throw new Error(`importLedger: preflight failed (${preflight.issues.filter((i) => i.level === 'error').map((i) => `${i.code}: ${i.message}`).join('; ')})`);
  }

  return store.runInAuditBatch('导入账本', (batchStore) => batchStore.withBackupImportContext(async (store) => {
    let entities = 0;
    const putAll = async (coll: { put: (e: never) => Promise<unknown> }, rows: unknown[]) => {
      for (const row of rows) {
        await coll.put(row as never);
        entities += 1;
      }
    };
    const hierarchyFirst = (rows: unknown[]): unknown[] =>
      [...rows].sort((left, right) => {
        const leftParent = asObj(left)?.['parentId'];
        const rightParent = asObj(right)?.['parentId'];
        return Number(typeof leftParent === 'string' && Boolean(leftParent))
          - Number(typeof rightParent === 'string' && Boolean(rightParent));
      });
    const dependencyFirst = <T extends { id: string }>(rows: T[], parentId: (row: T) => string | undefined): T[] => {
      const byId = new Map(rows.map((row) => [row.id, row]));
      const visited = new Set<string>();
      const visiting = new Set<string>();
      const ordered: T[] = [];
      const visit = (row: T): void => {
        if (visited.has(row.id)) return;
        if (visiting.has(row.id)) throw new Error(`importLedger: cyclic fixed-asset reference (${row.id})`);
        visiting.add(row.id);
        const parent = byId.get(parentId(row) ?? '');
        if (parent) visit(parent);
        visiting.delete(row.id);
        visited.add(row.id);
        ordered.push(row);
      };
      rows.forEach(visit);
      return ordered;
    };
    const transactions = [...data.transactions].sort((left, right) =>
      Number(left.type === 'refund') - Number(right.type === 'refund'));

    // Restore in dependency order. The scoped import context accepts historical
    // references to archived rows, but still rejects missing or deleted targets.
    await putAll(store.assets, data.assets);
    await putAll(store.accounts, data.accounts);
    await putAll(store.categories, hierarchyFirst(data.categories));
    await putAll(store.fixedAssetCategories, hierarchyFirst(data.fixedAssetCategories));
    await putAll(store.transactionTags, data.transactionTags);
    await putAll(store.transactionLocations, data.transactionLocations);
    await putAll(store.games, data.games);
    for (const { chain, steps } of data.chains) {
      await store.saveChainWithSteps(chain, steps);
    }
    await putAll(store.conversionOperations, data.conversionOperations ?? []);
    await putAll(store.settings, data.settings);
    await putAll(store.costBasisOpenings, data.costBasisOpenings ?? []);
    await putAll(store.priceMarks, data.priceMarks);
    await putAll(store.lots, data.lots);
    await putAll(store.lotConsumptions, data.lotConsumptions);
    await putAll(store.dcaPlans, data.dcaPlans);
    await putAll(store.dcaExecutions, data.dcaExecutions);
    await putAll(store.gameAccounts, data.gameAccounts);
    await putAll(store.gameSeasons, data.gameSeasons);
    await putAll(store.gameRecords, data.gameRecords);
    await putAll(store.gameCashflowLinks, data.gameCashflowLinks);
    await putAll(store.fixedAssets, dependencyFirst(data.fixedAssets as FixedAsset[], (row) => row.bundledFromAssetId));
    await putAll(store.fixedAssetEvents, dependencyFirst(data.fixedAssetEvents as FixedAssetEvent[], (row) => row.parentSaleEventId));
    await putAll(store.fixedAssetCashflowLinks, data.fixedAssetCashflowLinks);
    await putAll(store.fixedAssetUsageMetrics, data.fixedAssetUsageMetrics);
    await putAll(store.fixedAssetUsageLogs, data.fixedAssetUsageLogs);
    await putAll(store.fixedAssetConsumables, data.fixedAssetConsumables);
    await putAll(store.fixedAssetGoals, data.fixedAssetGoals);
    await putAll(store.payees, data.payees);
    await putAll(store.transactionTemplates, data.transactionTemplates);
    await putAll(store.transactionSavedViews, data.transactionSavedViews);
    const transactionKeys = data.transactions.map((row) => `transaction:${row.id}`);
    await store.withPrevalidatedAggregates(transactionKeys, async (aggregateStore) => {
      await putAll(aggregateStore.transactions, transactions);
      await putAll(aggregateStore.transactionSplits, data.transactionSplits);
      await putAll(aggregateStore.refundAllocations, data.refundAllocations);
      for (const transaction of data.transactions.filter((row) => !row.isDeleted)) {
        await aggregateStore.assertTransactionAggregate({
          transaction,
          splits: data.transactionSplits.filter((row) => row.transactionId === transaction.id),
          refundAllocations: data.refundAllocations.filter((row) => row.refundTransactionId === transaction.id),
        });
      }
    });
    await putAll(store.budgetCategories, data.budgetCategories);
    await putAll(store.scheduledTransactions, data.scheduledTransactions);
    await putAll(store.scheduledExecutions, data.scheduledExecutions);
    const reconciliationKeys = data.reconciliationSessions.map((row) => `reconciliation:${row.id}`);
    await store.withPrevalidatedAggregates(reconciliationKeys, async (aggregateStore) => {
      await putAll(aggregateStore.reconciliationSessions, data.reconciliationSessions);
      await putAll(aggregateStore.reconciliationItems, data.reconciliationItems);
      for (const session of data.reconciliationSessions.filter((row) => !row.isDeleted)) {
        await aggregateStore.assertReconciliationAggregate(
          session,
          data.reconciliationItems.filter((row) => row.reconciliationId === session.id),
        );
      }
    });
    await putAll(store.attachments, data.attachments);
    await options.afterImport?.(batchStore);
    return { entities, chains: data.chains.length };
  }), 'import', { undoable: false, onCommitted: options.onCommitted });
}

/**
 * Replace the active ledger with a backup while preserving sync semantics.
 * Rows absent from the backup become tombstones, so the deletion can propagate
 * to other devices instead of silently resurrecting on the next sync.
 */
export async function restoreLedger(
  store: SqlLedgerStore,
  data: LedgerBackup,
  options: ImportLedgerOptions = {},
): Promise<RestoreResult> {
  const preflight = preflightImport(data);
  if (!preflight.ok) {
    throw new Error(`restoreLedger: preflight failed (${preflight.issues.filter((i) => i.level === 'error').map((i) => `${i.code}: ${i.message}`).join('; ')})`);
  }

  const rowsFor = (key: keyof LedgerBackup): unknown[] => {
    const value = data[key];
    return Array.isArray(value) ? value : [];
  };
  return store.runInAuditBatch('恢复账本', async (store) => {
    type RestoreCollection = {
      key: keyof LedgerBackup;
      type: string;
      storeKey: keyof SqlLedgerStore;
      coll: {
        list: () => Promise<import('@zichan/core').BaseEntity[]>;
        remove: (id: string, expectedVersion: number) => Promise<void>;
      };
    };
    // Dependants come first. Reference deletion is scoped to the exact rows
    // proven absent by preflight; aggregate validation still runs on the final snapshot.
    const collections: RestoreCollection[] = [
      { key: 'conversionOperations', type: 'conversion_operation', storeKey: 'conversionOperations', coll: store.conversionOperations },
      { key: 'costBasisOpenings', type: 'cost_basis_opening', storeKey: 'costBasisOpenings', coll: store.costBasisOpenings },
      { key: 'attachments', type: 'attachment', storeKey: 'attachments', coll: store.attachments },
      { key: 'reconciliationItems', type: 'reconciliation_item', storeKey: 'reconciliationItems', coll: store.reconciliationItems },
      { key: 'gameCashflowLinks', type: 'game_cashflow_link', storeKey: 'gameCashflowLinks', coll: store.gameCashflowLinks },
      { key: 'fixedAssetCashflowLinks', type: 'fixed_asset_cashflow_link', storeKey: 'fixedAssetCashflowLinks', coll: store.fixedAssetCashflowLinks },
      { key: 'transactionSplits', type: 'transaction_split', storeKey: 'transactionSplits', coll: store.transactionSplits },
      { key: 'refundAllocations', type: 'refund_allocation', storeKey: 'refundAllocations', coll: store.refundAllocations },
      { key: 'scheduledExecutions', type: 'scheduled_execution', storeKey: 'scheduledExecutions', coll: store.scheduledExecutions },
      { key: 'transactions', type: 'transaction', storeKey: 'transactions', coll: store.transactions },
      { key: 'reconciliationSessions', type: 'reconciliation_session', storeKey: 'reconciliationSessions', coll: store.reconciliationSessions },
      { key: 'fixedAssetUsageLogs', type: 'fixed_asset_usage_log', storeKey: 'fixedAssetUsageLogs', coll: store.fixedAssetUsageLogs },
      { key: 'fixedAssetGoals', type: 'fixed_asset_goal', storeKey: 'fixedAssetGoals', coll: store.fixedAssetGoals },
      { key: 'fixedAssetConsumables', type: 'fixed_asset_consumable', storeKey: 'fixedAssetConsumables', coll: store.fixedAssetConsumables },
      { key: 'fixedAssetUsageMetrics', type: 'fixed_asset_usage_metric', storeKey: 'fixedAssetUsageMetrics', coll: store.fixedAssetUsageMetrics },
      { key: 'fixedAssetEvents', type: 'fixed_asset_event', storeKey: 'fixedAssetEvents', coll: store.fixedAssetEvents },
      { key: 'fixedAssets', type: 'fixed_asset', storeKey: 'fixedAssets', coll: store.fixedAssets },
      { key: 'fixedAssetCategories', type: 'fixed_asset_category', storeKey: 'fixedAssetCategories', coll: store.fixedAssetCategories },
      { key: 'gameRecords', type: 'game_record', storeKey: 'gameRecords', coll: store.gameRecords },
      { key: 'gameAccounts', type: 'game_account', storeKey: 'gameAccounts', coll: store.gameAccounts },
      { key: 'gameSeasons', type: 'game_season', storeKey: 'gameSeasons', coll: store.gameSeasons },
      { key: 'games', type: 'game', storeKey: 'games', coll: store.games },
      { key: 'lotConsumptions', type: 'lot_consumption', storeKey: 'lotConsumptions', coll: store.lotConsumptions },
      { key: 'lots', type: 'lot', storeKey: 'lots', coll: store.lots },
      { key: 'dcaExecutions', type: 'dca_execution', storeKey: 'dcaExecutions', coll: store.dcaExecutions },
      { key: 'dcaPlans', type: 'dca_plan', storeKey: 'dcaPlans', coll: store.dcaPlans },
      { key: 'priceMarks', type: 'price_mark', storeKey: 'priceMarks', coll: store.priceMarks },
      { key: 'budgetCategories', type: 'budget_category', storeKey: 'budgetCategories', coll: store.budgetCategories },
      { key: 'scheduledTransactions', type: 'scheduled_transaction', storeKey: 'scheduledTransactions', coll: store.scheduledTransactions },
      { key: 'transactionTemplates', type: 'transaction_template', storeKey: 'transactionTemplates', coll: store.transactionTemplates },
      { key: 'transactionSavedViews', type: 'transaction_saved_view', storeKey: 'transactionSavedViews', coll: store.transactionSavedViews },
      { key: 'payees', type: 'payee', storeKey: 'payees', coll: store.payees },
      { key: 'transactionLocations', type: 'transaction_location', storeKey: 'transactionLocations', coll: store.transactionLocations },
      { key: 'transactionTags', type: 'transaction_tag', storeKey: 'transactionTags', coll: store.transactionTags },
      { key: 'categories', type: 'category', storeKey: 'categories', coll: store.categories },
      { key: 'settings', type: 'setting', storeKey: 'settings', coll: store.settings },
      { key: 'accounts', type: 'account', storeKey: 'accounts', coll: store.accounts },
      { key: 'assets', type: 'asset', storeKey: 'assets', coll: store.assets },
    ];
    const pendingDeletes: {
      type: string;
      row: import('@zichan/core').BaseEntity;
      storeKey: keyof SqlLedgerStore;
    }[] = [];
    for (const { key, type, storeKey, coll } of collections) {
      const targetIds = new Set(rowsFor(key).map(rowId).filter((id): id is string => !!id));
      for (const current of await coll.list()) {
        if (!targetIds.has(current.id)) pendingDeletes.push({ type, row: current, storeKey });
      }
    }

    const targetChainIds = new Set(data.chains.map(({ chain }) => chain.id));
    for (const chain of await store.conversionChains.list()) {
      if (!targetChainIds.has(chain.id)) {
        pendingDeletes.push({
          type: 'conversion_chain',
          row: chain as ConversionChain & Record<string, unknown>,
          storeKey: 'conversionChains',
        });
      }
    }

    const writeKeys = new Set<string>();
    for (const { key, type } of ENTITY_ARRAYS) {
      for (const row of rowsFor(key)) {
        const id = rowId(row);
        if (id) writeKeys.add(`${type}:${id}`);
      }
    }
    for (const { chain } of data.chains) writeKeys.add(`conversion_chain:${chain.id}`);
    const deleteKeys = pendingDeletes.map(({ type, row }) => `${type}:${row.id}`);
    const aggregateKeys = new Set<string>();
    for (const { type, row } of pendingDeletes) {
      const values = row as import('@zichan/core').BaseEntity & Record<string, unknown>;
      if (type === 'transaction') aggregateKeys.add(`transaction:${row.id}`);
      if (type === 'transaction_split' && typeof values['transactionId'] === 'string') {
        aggregateKeys.add(`transaction:${values['transactionId']}`);
      }
      if (type === 'refund_allocation' && typeof values['refundTransactionId'] === 'string') {
        aggregateKeys.add(`transaction:${values['refundTransactionId']}`);
      }
      if (type === 'reconciliation_session') aggregateKeys.add(`reconciliation:${row.id}`);
      if (type === 'reconciliation_item' && typeof values['reconciliationId'] === 'string') {
        aggregateKeys.add(`reconciliation:${values['reconciliationId']}`);
      }
    }
    return store.withValidatedRestore(writeKeys, deleteKeys, (restoreStore) =>
      restoreStore.withPrevalidatedAggregates(aggregateKeys, async (aggregateStore) => {
        for (const { row, storeKey } of pendingDeletes) {
          const collection = aggregateStore[storeKey] as unknown as RestoreCollection['coll'];
          await collection.remove(row.id, row.version);
        }
        const imported = await importLedger(aggregateStore, data, options);
        return { ...imported, removed: pendingDeletes.length };
      }));
  }, 'import', { undoable: false, onCommitted: options.onCommitted });
}

// ─────────────────────────── daily transaction services ───────────────────────────

export interface ImportTransactionsInput {
  transactions: Transaction[];
  /** Default true: skip same date/time/type/category/amount/asset/account/description/merchant rows. */
  skipDuplicates?: boolean;
}

export interface ImportTransactionsResult {
  imported: number;
  skipped: number;
  duplicateIds: string[];
}

export interface MonthlyTransactionCategorySummary {
  category: TransactionCategory;
  type: TransactionType;
  totalAmount: string;
  count: number;
}

export interface MonthlyTransactionSummary {
  month: string;
  income: string;
  expense: string;
  net: string;
  transactionCount: number;
  byCategory: MonthlyTransactionCategorySummary[];
}

function transactionFingerprint(t: Transaction): string {
  return [
    t.date, t.time ?? '', t.type, t.category, D(t.amount).abs().toString(), t.assetId, t.accountId ?? '',
    t.refundForId ?? '', t.refundAppliedAmount ?? '', t.refundAppliedAssetId ?? '',
    t.description?.trim() ?? '', t.merchant?.trim() ?? '',
  ].join('\u0001');
}

function normalizeTransaction(t: Transaction): Transaction {
  const amount = D(t.amount).abs();
  if (amount.isZero()) throw new Error('transaction amount must be positive');
  return {
    ...t,
    amount: amount.toString(),
  };
}

export async function importTransactions(
  store: SqlLedgerStore,
  input: ImportTransactionsInput,
): Promise<ImportTransactionsResult> {
  const skipDuplicates = input.skipDuplicates ?? true;
  const existing = skipDuplicates ? await store.transactions.list({ includeDeleted: true }) : [];
  const seen = new Set(existing.map(transactionFingerprint));
  const fingerprintOwner = new Map(existing.map((transaction) => [transactionFingerprint(transaction), transaction.id]));
  const idRemap = new Map<string, string>();
  const duplicateIds: string[] = [];
  let imported = 0;
  let skipped = 0;

  await store.transaction(async (store) => {
    const ordered = [...input.transactions].sort((a, b) => Number(a.type === 'refund') - Number(b.type === 'refund'));
    for (const raw of ordered) {
      const tx = normalizeTransaction({
        ...raw,
        refundForId: raw.refundForId ? idRemap.get(raw.refundForId) ?? raw.refundForId : undefined,
      });
      const fp = transactionFingerprint(tx);
      if (skipDuplicates && seen.has(fp)) {
        duplicateIds.push(raw.id);
        const ownerId = fingerprintOwner.get(fp);
        if (ownerId) idRemap.set(raw.id, ownerId);
        skipped += 1;
        continue;
      }
      const saved = await saveTransaction(store, tx);
      seen.add(fp);
      fingerprintOwner.set(fp, saved.id);
      idRemap.set(raw.id, saved.id);
      imported += 1;
    }
  });

  return { imported, skipped, duplicateIds };
}

export async function monthlyTransactionSummary(
  store: SqlLedgerStore,
  month: string,
  assetId?: string,
): Promise<MonthlyTransactionSummary> {
  const firstDay = `${month}-01`;
  if (!/^\d{4}-\d{2}$/.test(month) || !isValidDay(firstDay)) throw new DomainValidationError('月份无效');
  let income = D(0);
  let expense = D(0);
  let transactionCount = 0;
  const assetIds = new Set<string>();
  const byKey = new Map<string, MonthlyTransactionCategorySummary>();

  for await (const page of store.iterateTransactionReport({ from: firstDay, to: endOfMonth(firstDay), pageSize: 500 })) {
    const splitsByTransaction = new Map<string, TransactionSplit[]>();
    const allocationsByRefund = new Map<string, RefundAllocation[]>();
    for (const split of page.transactionSplits) {
      const rows = splitsByTransaction.get(split.transactionId) ?? [];
      rows.push(split);
      splitsByTransaction.set(split.transactionId, rows);
    }
    for (const allocation of page.refundAllocations) {
      const rows = allocationsByRefund.get(allocation.refundTransactionId) ?? [];
      rows.push(allocation);
      allocationsByRefund.set(allocation.refundTransactionId, rows);
    }
    for (const transaction of page.transactions) {
      const effect = transactionReportingEffect(transaction, {
        splits: splitsByTransaction.get(transaction.id),
        refundAllocations: allocationsByRefund.get(transaction.id),
      });
      if (assetId && effect.reportAssetId !== assetId) continue;
      if (D(effect.incomeDelta).isZero() && D(effect.expenseDelta).isZero()) continue;
      assetIds.add(effect.reportAssetId);
      transactionCount += 1;
      income = income.plus(effect.incomeDelta);
      expense = expense.plus(effect.expenseDelta);
      const summaryType: TransactionType = D(effect.incomeDelta).isZero() ? 'expense' : 'income';
      const direction = D(effect.expenseDelta).isNegative() ? -1 : 1;
      for (const categoryRow of effect.categoryRows) {
        const key = `${summaryType}:${categoryRow.categoryId}`;
        const row = byKey.get(key) ?? {
          category: categoryRow.categoryId,
          type: summaryType,
          totalAmount: '0',
          count: 0,
        };
        row.totalAmount = D(row.totalAmount).plus(D(categoryRow.amount).mul(direction)).toString();
        row.count += 1;
        byKey.set(key, row);
      }
    }
  }
  if (!assetId && assetIds.size > 1) {
    throw new DomainValidationError(`月度汇总必须指定币种，当前包含：${[...assetIds].sort().join('、')}`);
  }

  return {
    month,
    income: income.toString(),
    expense: expense.toString(),
    net: income.minus(expense).toString(),
    transactionCount,
    byCategory: [...byKey.values()].sort((a, b) => D(b.totalAmount).comparedTo(D(a.totalAmount))),
  };
}

// ─────────────────────────── conversion lifecycle ───────────────────────────

export async function voidConversion(store: SqlLedgerStore, chainId: string, reason = '用户撤销'): Promise<ConversionChain> {
  return store.runInAuditBatch('作废资产转换', async (transactionStore) => {
    const chain = await transactionStore.conversionChains.get(chainId);
    if (!chain || chain.isDeleted) throw new Error('资产转换不存在');
    if (chain.operationId) throw new Error('连续转换必须整组作废');
    if (chain.recordState === 'voided') return chain;
    const saved = await transactionStore.conversionChains.put({
      ...chain,
      recordState: 'voided',
      voidedAt: new Date().toISOString(),
      voidReason: reason,
    });
    await rebuildConversionDerivedInTransaction(transactionStore);
    return saved;
  });
}

export async function restoreConversion(store: SqlLedgerStore, chainId: string): Promise<ConversionChain> {
  return store.runInAuditBatch('恢复资产转换', async (transactionStore) => {
    const chain = await transactionStore.conversionChains.get(chainId);
    if (!chain || chain.isDeleted) throw new Error('资产转换不存在');
    if (chain.operationId) throw new Error('连续转换必须整组恢复');
    const saved = await transactionStore.conversionChains.put({
      ...chain,
      recordState: 'active',
      voidedAt: undefined,
      voidReason: undefined,
    });
    await rebuildConversionDerivedInTransaction(transactionStore);
    return (await transactionStore.conversionChains.get(saved.id))!;
  });
}
