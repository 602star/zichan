/**
 * Doctor — consistency self-check and derived-cache recompute. The derived
 * caches (lot.remainingAmount/status, chain.totalBaseCost/proceeds/realized/…)
 * are denormalized (§0.5); this verifies them against a recompute from the
 * source-of-truth (steps + consumptions) and can rewrite them.
 */
import {
  assertConversionShape,
  D,
  assertDcaExecutionShape,
  assertDcaPlanShape,
  assertScheduledExecutionShape,
  assertTransactionShape,
  dcaOccurrenceDate,
  isTransactionActive,
  normalizeOccurrence,
  sum,
  traceChain,
  usesAssetCostState, assetCostSourceSummary, type AssetCostState,
} from '@zichan/core';
import type { SqlLedgerStore } from './repository.js';
import { readAssetCostState } from './asset-cost-service.js';

export type IssueKind =
  | 'lot_remaining_mismatch'
  | 'oversold_lot'
  | 'orphan_consumption'
  | 'chain_cache_stale'
  | 'conversion_step_invalid'
  | 'missing_reference'
  | 'category_mismatch'
  | 'category_cycle'
  | 'split_amount_exceeded'
  | 'split_total_mismatch'
  | 'refund_invalid'
  | 'refund_allocation_invalid'
  | 'refund_amount_exceeded'
  | 'reconciliation_invalid'
  | 'game_reference_mismatch'
  | 'game_cashflow_invalid'
  | 'game_fee_record_conflict'
  | 'fixed_status_mismatch'
  | 'fixed_cashflow_invalid'
  | 'invalid_enum'
  | 'occurrence_invalid'
  | 'required_field_missing'
  | 'attachment_file_invalid';

export interface ConsistencyIssue {
  kind: IssueKind;
  entityType: string;
  entityId: string;
  detail: string;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    (m.get(k) ?? m.set(k, []).get(k)!).push(it);
  }
  return m;
}

/** Amount a chain's cache should hold, recomputed from its steps + consumptions. */
async function chainExpected(store: SqlLedgerStore, chainId: string, type: string, costState?: AssetCostState) {
  const steps = await store.listStepsByChain(chainId);
  if (!steps.length) return null;
  const chain = (await store.conversionChains.get(chainId))!;
  if (chain.recordState === 'voided') return null;
  const t = traceChain({ chain, steps });
  if (usesAssetCostState(costState, chain)) {
    const acquired = costState.events.find((event) => event.eventId === `${steps.at(-1)!.id}:2-target`);
    return { finalAssetId: t.finalAssetId, finalAmount: t.finalAmount, totalBaseCost: acquired?.costInBase ?? undefined,
      totalBaseProceeds: type === 'sell' ? t.totalBaseProceeds : undefined, totalFeesInBase: t.totalFeesInBase,
      realizedGainLoss: assetCostSourceSummary(costState, chainId).realizedGainLoss ?? undefined };
  }
  if (type === 'sell') {
    const cons = await store.lotConsumptions.list({ where: { sellChainId: chainId } });
    const realized = sum(cons.map((c) => c.realizedPnlBase));
    return {
      finalAssetId: t.finalAssetId, finalAmount: t.finalAmount,
      totalBaseProceeds: t.totalBaseProceeds, totalFeesInBase: t.totalFeesInBase,
      realizedGainLoss: realized.toString(),
    };
  }
  return {
    finalAssetId: t.finalAssetId, finalAmount: t.finalAmount,
    totalBaseCost: t.totalBaseCost, totalFeesInBase: t.totalFeesInBase,
  };
}

function numericEqualWithinTolerance(current: unknown, expected: string): boolean {
  const diff = D(String(current)).minus(expected).abs();
  if (diff.isZero()) return true;
  if (diff.lte('0.000000000000000001')) return true;
  const scale = D(String(current)).abs().gt(D(expected).abs()) ? D(String(current)).abs() : D(expected).abs();
  return !scale.isZero() && diff.div(scale).lte('0.000000000000000001');
}

function occurrenceIsValid(row: {
  date: string;
  time?: string;
  timezone?: string;
  timePrecision?: 'day' | 'minute' | 'second';
  occurredAtUtc?: string;
  utcOffsetMinutes?: number;
  timeDisambiguation?: 'earlier' | 'later';
}): boolean {
  if (!row.timezone || !row.timePrecision) return false;
  try {
    const normalized = normalizeOccurrence(row);
    return row.timezone === normalized.timezone
      && row.timePrecision === normalized.timePrecision
      && row.occurredAtUtc === normalized.occurredAtUtc
      && row.utcOffsetMinutes === normalized.utcOffsetMinutes
      && row.timeDisambiguation === normalized.timeDisambiguation;
  } catch {
    return false;
  }
}

export async function checkConsistency(store: SqlLedgerStore): Promise<ConsistencyIssue[]> {
  const issues: ConsistencyIssue[] = [];
  const costState = await readAssetCostState(store);
  if (costState?.invalidAssetIds.length) issues.push({ kind: 'required_field_missing', entityType: 'cost_basis_opening', entityId: costState.openingId,
    detail: '起点之前的账务或发生时间已变化，需要重新核对成本起点；相关盈亏未完整核算' });
  const lots = await store.lots.list();
  const cons = await store.lotConsumptions.list();
  const consByLot = groupBy(cons, (c) => c.lotId);
  const lotIds = new Set(lots.map((l) => l.id));

  for (const lot of lots) {
    const consumed = sum((consByLot.get(lot.id) ?? []).map((c) => c.consumedAmount));
    const expected = D(lot.originalAmount).minus(consumed);
    if (!expected.eq(D(lot.remainingAmount))) {
      issues.push({ kind: 'lot_remaining_mismatch', entityType: 'lot', entityId: lot.id,
        detail: `remaining ${lot.remainingAmount} ≠ original−consumed ${expected.toString()}` });
    }
    if (D(lot.remainingAmount).isNegative()) {
      issues.push({ kind: 'oversold_lot', entityType: 'lot', entityId: lot.id,
        detail: `remaining is negative (${lot.remainingAmount})` });
    }
  }
  for (const c of cons) {
    if (!lotIds.has(c.lotId)) {
      issues.push({ kind: 'orphan_consumption', entityType: 'lot_consumption', entityId: c.id,
        detail: `references missing lot ${c.lotId}` });
    }
  }

  const chains = await store.conversionChains.list();
  const operations = await store.conversionOperations.list();
  for (const operation of operations) for (const [index, id] of operation.chainIds.entries()) {
    const child = chains.find((chain) => chain.id === id);
    if (!child || child.operationId !== operation.id || child.operationOrder !== index || (child.recordState ?? 'active') !== (operation.recordState ?? 'active')) {
      issues.push({ kind: 'missing_reference', entityType: 'conversion_operation', entityId: operation.id, detail: '连续转换子记录缺失、顺序、归属或作废状态不一致' });
    }
  }
  for (const ch of chains) {
    if (ch.operationId && !operations.some((operation) => operation.id === ch.operationId && operation.chainIds.includes(ch.id))) issues.push({ kind: 'missing_reference', entityType: 'conversion_chain', entityId: ch.id, detail: '缺少所属连续转换' });
    if (!occurrenceIsValid(ch)) {
      issues.push({ kind: 'occurrence_invalid', entityType: 'conversion_chain', entityId: ch.id, detail: '本地时间、时区与 UTC 快照不一致' });
    }
    const exp = await chainExpected(store, ch.id, ch.type, costState);
    if (!exp) continue;
    for (const [k, v] of Object.entries(exp)) {
      const cur = (ch as unknown as Record<string, unknown>)[k];
      if (cur == null || cur === '') continue; // never-populated cache: recompute will fill it
      // Only treat *fully numeric* strings as amounts — ids are ULIDs that start
      // with a digit, so a loose /^\d/ test would feed them to Decimal and throw.
      const isNumeric = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
      const equal = isNumeric ? numericEqualWithinTolerance(cur, v) : cur === v;
      if (!equal) {
        issues.push({ kind: 'chain_cache_stale', entityType: 'conversion_chain', entityId: ch.id,
          detail: `${k}: cached ${String(cur)} ≠ recomputed ${String(v)}` });
        break;
      }
    }
  }

  const [
    assets, accounts, settings, categories, tags, locations, payees, transactions, allSplits, refundAllocations,
    games, gameAccounts, seasons, gameRecords, gameCashflowLinks, fixedAssets, fixedCategories, fixedEvents,
    fixedCashflowLinks, fixedMetrics, fixedLogs, fixedConsumables, fixedGoals, attachments,
    budgets, schedules, scheduleExecutions, reconciliations, reconciliationItems, priceMarks, dcaPlans, dcaExecutions, templates,
  ] = await Promise.all([
    store.assets.list(), store.accounts.list(), store.settings.list(), store.categories.list(), store.transactionTags.list(),
    store.transactionLocations.list(), store.payees.list(), store.transactions.list(), store.transactionSplits.list({ includeDeleted: true }), store.refundAllocations.list(),
    store.games.list(), store.gameAccounts.list(), store.gameSeasons.list(), store.gameRecords.list(), store.gameCashflowLinks.list(),
    store.fixedAssets.list(), store.fixedAssetCategories.list(), store.fixedAssetEvents.list(), store.fixedAssetCashflowLinks.list(),
    store.fixedAssetUsageMetrics.list(), store.fixedAssetUsageLogs.list(),
    store.fixedAssetConsumables.list(), store.fixedAssetGoals.list(), store.attachments.list(),
    store.budgetCategories.list(), store.scheduledTransactions.list(), store.scheduledExecutions.list(),
    store.reconciliationSessions.list(), store.reconciliationItems.list(),
    store.priceMarks.list(), store.dcaPlans.list(), store.dcaExecutions.list(), store.transactionTemplates.list(),
  ]);
  const splits = allSplits.filter((row) => !row.isDeleted);
  const ids = <T extends { id: string }>(rows: T[]) => new Set(rows.map((row) => row.id));
  const assetIds = ids(assets);
  const accountIds = ids(accounts);
  const categoryIds = ids(categories);
  const tagIds = ids(tags);
  const locationIds = ids(locations);
  const payeeIds = ids(payees);
  const transactionIds = ids(transactions);
  const scheduleIds = ids(schedules);
  const reconciliationIds = ids(reconciliations);
  const gameIds = ids(games);
  const gameAccountIds = ids(gameAccounts);
  const seasonIds = ids(seasons);
  const fixedAssetIds = ids(fixedAssets);
  const fixedCategoryIds = ids(fixedCategories);
  const fixedMetricIds = ids(fixedMetrics);
  const chainIds = ids(chains);
  const dcaPlanIds = ids(dcaPlans);
  const dcaPlanById = new Map(dcaPlans.map((row) => [row.id, row]));
  const categoryById = new Map(categories.map((row) => [row.id, row]));
  const transactionById = new Map(transactions.map((row) => [row.id, row]));
  const gameRecordById = new Map(gameRecords.map((row) => [row.id, row]));
  const splitById = new Map(allSplits.map((row) => [row.id, row]));
  const fixedAssetById = new Map(fixedAssets.map((row) => [row.id, row]));
  const fixedEventById = new Map(fixedEvents.map((row) => [row.id, row]));
  const fixedConsumableById = new Map(fixedConsumables.map((row) => [row.id, row]));
  const gameCashflowRequiresAccount = (settings[0]?.ledgerMode ?? 'spending') !== 'spending';
  const parentCategoryIds = new Set(categories.map((row) => row.parentId).filter((id): id is string => !!id));
  const accountGame = new Map(gameAccounts.map((row) => [row.id, row.gameId]));
  const seasonGame = new Map(seasons.map((row) => [row.id, row.gameId]));
  const missing = (exists: boolean, entityType: string, entityId: string, detail: string) => {
    if (!exists) issues.push({ kind: 'missing_reference', entityType, entityId, detail });
  };

  for (const asset of assets) {
    if (!asset.name.trim() || !asset.code.trim()) issues.push({ kind: 'required_field_missing', entityType: 'asset', entityId: asset.id, detail: '资产名称或代码为空' });
  }
  for (const account of accounts) {
    if (!account.name.trim()) issues.push({ kind: 'required_field_missing', entityType: 'account', entityId: account.id, detail: '账户名称为空' });
  }
  for (const setting of settings) {
    for (const [field, assetId] of [
      ['baseCurrencyAssetId', setting.baseCurrencyAssetId],
      ['transactionDefaultAssetId', setting.transactionDefaultAssetId],
      ['investmentCostAssetId', setting.investmentCostAssetId],
      ['fixedAssetDefaultCurrencyAssetId', setting.fixedAssetDefaultCurrencyAssetId],
      ['gameDefaultSettlementAssetId', setting.gameDefaultSettlementAssetId],
    ] as const) {
      if (assetId) missing(assetIds.has(assetId), 'setting', setting.id, `${field} 引用了不存在的资产 ${assetId}`);
    }
  }
  for (const category of categories) {
    if (!category.name.trim()) issues.push({ kind: 'required_field_missing', entityType: 'category', entityId: category.id, detail: '分类名称为空' });
    if (category.parentId) missing(categoryIds.has(category.parentId), 'category', category.id, `引用了不存在的父级分类 ${category.parentId}`);
  }
  // 分类父链循环检测(A→B→A):沿 parentId 链上溯,遇到已访问分类即循环。
  for (const category of categories) {
    const seen = new Set<string>();
    let current = category.parentId ? categoryById.get(category.parentId) : undefined;
    while (current) {
      if (seen.has(current.id)) {
        issues.push({ kind: 'category_cycle', entityType: 'category', entityId: category.id, detail: `分类父链存在循环引用(${current.name})` });
        break;
      }
      seen.add(current.id);
      current = current.parentId ? categoryById.get(current.parentId) : undefined;
    }
  }
  for (const game of games) {
    if (!game.name.trim()) issues.push({ kind: 'required_field_missing', entityType: 'game', entityId: game.id, detail: '游戏名称为空' });
  }
  for (const fixed of fixedAssets) {
    if (!fixed.name.trim() || !fixed.purchaseDate || !fixed.categoryId) issues.push({ kind: 'required_field_missing', entityType: 'fixed_asset', entityId: fixed.id, detail: '物品资产名称、分类或购买日期为空' });
  }

  const activeRefundTotals = new Map<string, ReturnType<typeof D>>();
  for (const tx of transactions) {
    try {
      assertTransactionShape(tx);
    } catch (error) {
      issues.push({
        kind: 'invalid_enum',
        entityType: 'transaction',
        entityId: tx.id,
        detail: error instanceof Error ? error.message : '流水枚举值无效',
      });
    }
    if (!occurrenceIsValid(tx)) {
      issues.push({ kind: 'occurrence_invalid', entityType: 'transaction', entityId: tx.id, detail: '本地时间、时区与 UTC 快照不一致' });
    }
    missing(assetIds.has(tx.assetId), 'transaction', tx.id, `引用了不存在的资产 ${tx.assetId}`);
    if (tx.accountId) missing(accountIds.has(tx.accountId), 'transaction', tx.id, `引用了不存在的账户 ${tx.accountId}`);
    if (tx.transferAssetId) missing(assetIds.has(tx.transferAssetId), 'transaction', tx.id, `引用了不存在的目标资产 ${tx.transferAssetId}`);
    if (tx.transferAccountId) missing(accountIds.has(tx.transferAccountId), 'transaction', tx.id, `引用了不存在的目标账户 ${tx.transferAccountId}`);
    if (tx.payeeId) missing(payeeIds.has(tx.payeeId), 'transaction', tx.id, `引用了不存在的商户 ${tx.payeeId}`);
    if (tx.locationId) missing(locationIds.has(tx.locationId), 'transaction', tx.id, `引用了不存在的地点 ${tx.locationId}`);
    if (tx.type === 'refund') {
      const original = tx.refundForId ? transactionById.get(tx.refundForId) : undefined;
      let applied = D(0);
      let appliedValid = false;
      try {
        applied = D(tx.refundAppliedAmount ?? 0);
        appliedValid = applied.gt(0);
      } catch {
        appliedValid = false;
      }
      const structurallyValid = !!original
        && original.type === 'expense'
        && tx.refundForId !== tx.id
        && appliedValid
        && tx.refundAppliedAssetId === original.assetId;
      const activePairValid = !isTransactionActive(tx) || (structurallyValid && isTransactionActive(original!));
      if (!structurallyValid || !activePairValid) {
        issues.push({ kind: 'refund_invalid', entityType: 'transaction', entityId: tx.id, detail: '退款必须关联有效原支出，并保存正数冲减金额及原支出币种' });
      } else if (isTransactionActive(tx)) {
        activeRefundTotals.set(original!.id, (activeRefundTotals.get(original!.id) ?? D(0)).plus(applied));
      }
      const expectedEffectDate = tx.refundAttributionMode === 'original_date'
        ? tx.originalDateSnapshot
        : tx.refundAttributionMode === 'refund_date' ? tx.date : undefined;
      if (!expectedEffectDate || tx.refundEffectDate !== expectedEffectDate || !tx.originalAmountSnapshot
        || !tx.originalDateSnapshot || !tx.refundAllocationMode) {
        issues.push({ kind: 'refund_invalid', entityType: 'transaction', entityId: tx.id, detail: '退款缺少完整且一致的冻结日期、原金额或分配模式' });
      }
    } else if (tx.refundForId || tx.refundAppliedAmount || tx.refundAppliedAssetId) {
      issues.push({ kind: 'refund_invalid', entityType: 'transaction', entityId: tx.id, detail: '非退款流水不应包含退款关联字段' });
    }
    for (const tagId of tx.tagIds ?? []) missing(tagIds.has(tagId), 'transaction', tx.id, `引用了不存在的标签 ${tagId}`);
    if (tx.type === 'adjustment') {
      if (!tx.accountId || !tx.reconciliationSessionId || !tx.adjustmentDirection) {
        issues.push({ kind: 'required_field_missing', entityType: 'transaction', entityId: tx.id, detail: '余额调整缺少账户、对账批次或方向' });
      }
    } else if (tx.type !== 'transfer') {
      const category = categoryById.get(tx.category);
      const expectedCategoryType = tx.type === 'refund' ? 'expense' : tx.type;
      if (!category || parentCategoryIds.has(tx.category) || category.type !== expectedCategoryType) {
        issues.push({ kind: 'category_mismatch', entityType: 'transaction', entityId: tx.id, detail: '分类不存在、不是二级分类，或与收支类型不一致' });
      }
    }
  }
  for (const [originalId, total] of activeRefundTotals) {
    const original = transactionById.get(originalId)!;
    if (total.gt(original.amount)) issues.push({ kind: 'refund_amount_exceeded', entityType: 'transaction', entityId: originalId, detail: `有效退款合计 ${total.toString()} 超过原支出 ${original.amount}` });
  }

  for (const lot of lots) {
    missing(assetIds.has(lot.assetId), 'lot', lot.id, `引用了不存在的资产 ${lot.assetId}`);
    if (lot.sourceChainId) missing(chainIds.has(lot.sourceChainId), 'lot', lot.id, `引用了不存在的来源链路 ${lot.sourceChainId}`);
  }
  for (const chain of chains) {
    const steps = await store.listStepsByChain(chain.id);
    try {
      assertConversionShape(chain, steps);
    } catch (error) {
      issues.push({ kind: 'conversion_step_invalid', entityType: 'conversion_chain', entityId: chain.id, detail: error instanceof Error ? error.message : String(error) });
    }
    for (const step of steps) {
      missing(assetIds.has(step.fromAssetId), 'conversion_chain', chain.id, `转换步骤引用了不存在的来源资产 ${step.fromAssetId}`);
      missing(assetIds.has(step.toAssetId), 'conversion_chain', chain.id, `转换步骤引用了不存在的目标资产 ${step.toAssetId}`);
      if (step.accountFromId) missing(accountIds.has(step.accountFromId), 'conversion_chain', chain.id, `转换步骤引用了不存在的来源账户 ${step.accountFromId}`);
      if (step.accountToId) missing(accountIds.has(step.accountToId), 'conversion_chain', chain.id, `转换步骤引用了不存在的目标账户 ${step.accountToId}`);
      for (const fee of step.fees ?? []) {
        missing(assetIds.has(fee.assetId), 'conversion_chain', chain.id, `手续费引用了不存在的资产 ${fee.assetId}`);
        if (fee.accountId) missing(accountIds.has(fee.accountId), 'conversion_chain', chain.id, `手续费引用了不存在的账户 ${fee.accountId}`);
      }
    }
  }
  for (const consumption of cons) missing(lotIds.has(consumption.lotId) && chainIds.has(consumption.sellChainId), 'lot_consumption', consumption.id, '批次消耗引用的批次或卖出链路不存在');
  for (const mark of priceMarks) {
    missing(assetIds.has(mark.assetId), 'price_mark', mark.id, `引用了不存在的资产 ${mark.assetId}`);
    missing(assetIds.has(mark.quoteAssetId), 'price_mark', mark.id, `引用了不存在的计价资产 ${mark.quoteAssetId}`);
  }
  for (const plan of dcaPlans) {
    try {
      assertDcaPlanShape(plan);
    } catch (error) {
      issues.push({ kind: 'occurrence_invalid', entityType: 'dca_plan', entityId: plan.id, detail: error instanceof Error ? error.message : String(error) });
    }
    missing(assetIds.has(plan.targetAssetId), 'dca_plan', plan.id, `引用了不存在的目标资产 ${plan.targetAssetId}`);
    missing(assetIds.has(plan.baseCurrencyAssetId), 'dca_plan', plan.id, `引用了不存在的投入资产 ${plan.baseCurrencyAssetId}`);
  }
  const dcaOccurrences = new Set<string>();
  for (const execution of dcaExecutions) {
    try {
      assertDcaExecutionShape(execution);
      const plan = dcaPlanById.get(execution.planId);
      if (plan && plan.frequency !== 'manual' && dcaOccurrenceDate(plan, execution.occurrenceIndex) !== execution.scheduledDate) {
        throw new Error('定投执行日期与计划期次不一致');
      }
      const occurrenceKey = `${execution.planId}\0${execution.occurrenceIndex}`;
      if (dcaOccurrences.has(occurrenceKey)) throw new Error('同一定投期次存在重复执行');
      dcaOccurrences.add(occurrenceKey);
    } catch (error) {
      issues.push({ kind: 'occurrence_invalid', entityType: 'dca_execution', entityId: execution.id, detail: error instanceof Error ? error.message : String(error) });
    }
    missing(dcaPlanIds.has(execution.planId), 'dca_execution', execution.id, `引用了不存在的计划 ${execution.planId}`);
    if (execution.chainId) missing(chainIds.has(execution.chainId), 'dca_execution', execution.id, `引用了不存在的链路 ${execution.chainId}`);
  }

  const splitTotals = new Map<string, ReturnType<typeof D>>();
  const splitRemainders = new Map<string, number>();
  for (const split of splits) {
    missing(transactionIds.has(split.transactionId), 'transaction_split', split.id, `引用了不存在的流水 ${split.transactionId}`);
    missing(categoryIds.has(split.category), 'transaction_split', split.id, `引用了不存在的分类 ${split.category}`);
    const parent = transactionById.get(split.transactionId);
    const category = categoryById.get(split.category);
    if (!parent || !['income', 'expense'].includes(parent.type)
      || !category?.parentId || parentCategoryIds.has(category.id) || category.type !== parent.type) {
      issues.push({ kind: 'category_mismatch', entityType: 'transaction_split', entityId: split.id, detail: '拆分项目必须属于收入或支出，并使用类型一致的叶子二级分类' });
    }
    if (split.isRemainder) {
      splitRemainders.set(split.transactionId, (splitRemainders.get(split.transactionId) ?? 0) + 1);
      if (split.category !== parent?.category) issues.push({ kind: 'split_total_mismatch', entityType: 'transaction_split', entityId: split.id, detail: '未拆分余项必须归入流水主分类' });
    }
    try {
      const amount = D(split.amount);
      if (!amount.gt(0)) throw new Error('non-positive');
      splitTotals.set(split.transactionId, (splitTotals.get(split.transactionId) ?? D(0)).plus(amount));
    } catch {
      issues.push({ kind: 'split_total_mismatch', entityType: 'transaction_split', entityId: split.id, detail: '拆分金额必须为正数' });
    }
  }
  for (const [transactionId, total] of splitTotals) {
    const parent = transactionById.get(transactionId);
    if (parent && !total.eq(parent.amount)) issues.push({ kind: 'split_total_mismatch', entityType: 'transaction', entityId: transactionId, detail: `拆分合计 ${total.toString()} 不等于原金额 ${parent.amount}` });
    if ((splitRemainders.get(transactionId) ?? 0) > 1) issues.push({ kind: 'split_total_mismatch', entityType: 'transaction', entityId: transactionId, detail: '同一流水存在多个未拆分余项' });
  }

  const allocationTotals = new Map<string, ReturnType<typeof D>>();
  for (const allocation of refundAllocations) {
    const refund = transactionById.get(allocation.refundTransactionId);
    const source = transactionById.get(allocation.sourceTransactionId);
    const sourceSplit = allocation.sourceSplitId ? splitById.get(allocation.sourceSplitId) : undefined;
    missing(!!refund, 'refund_allocation', allocation.id, `引用了不存在的退款流水 ${allocation.refundTransactionId}`);
    missing(!!source, 'refund_allocation', allocation.id, `引用了不存在的原支出 ${allocation.sourceTransactionId}`);
    missing(categoryIds.has(allocation.categoryId), 'refund_allocation', allocation.id, `引用了不存在的冻结分类 ${allocation.categoryId}`);
    missing(assetIds.has(allocation.assetId), 'refund_allocation', allocation.id, `引用了不存在的冻结币种 ${allocation.assetId}`);
    if (!refund || refund.type !== 'refund' || !source || source.type !== 'expense'
      || refund.refundForId !== source.id || allocation.assetId !== source.assetId
      || (allocation.sourceSplitId && sourceSplit?.transactionId !== source.id)
      || !allocation.categoryPathSnapshot.trim()) {
      issues.push({ kind: 'refund_allocation_invalid', entityType: 'refund_allocation', entityId: allocation.id, detail: '退款分配与退款、原支出、拆分项目或冻结快照不一致' });
    }
    try {
      const amount = D(allocation.amount);
      if (!amount.gt(0)) throw new Error('non-positive');
      allocationTotals.set(allocation.refundTransactionId, (allocationTotals.get(allocation.refundTransactionId) ?? D(0)).plus(amount));
    } catch {
      issues.push({ kind: 'refund_allocation_invalid', entityType: 'refund_allocation', entityId: allocation.id, detail: '退款分配金额必须为正数' });
    }
  }
  for (const refund of transactions.filter((row) => row.type === 'refund')) {
    let expected: ReturnType<typeof D>;
    try { expected = D(refund.refundAppliedAmount ?? '0'); } catch { continue; }
    if (!(allocationTotals.get(refund.id) ?? D(0)).eq(expected)) {
      issues.push({ kind: 'refund_allocation_invalid', entityType: 'transaction', entityId: refund.id, detail: '退款分配合计与冻结冲减金额不一致' });
    }
  }

  for (const record of gameRecords) {
    missing(gameIds.has(record.gameId), 'game_record', record.id, `引用了不存在的游戏 ${record.gameId}`);
    if (record.seasonId) {
      missing(seasonIds.has(record.seasonId), 'game_record', record.id, `引用了不存在的赛季 ${record.seasonId}`);
      if (seasonGame.get(record.seasonId) !== record.gameId) issues.push({ kind: 'game_reference_mismatch', entityType: 'game_record', entityId: record.id, detail: '赛季不属于所选游戏' });
    }
    if (record.gameAccountId) {
      missing(gameAccountIds.has(record.gameAccountId), 'game_record', record.id, `引用了不存在的游戏账号 ${record.gameAccountId}`);
      if (accountGame.get(record.gameAccountId) !== record.gameId) issues.push({ kind: 'game_reference_mismatch', entityType: 'game_record', entityId: record.id, detail: '账号不属于所选游戏' });
    }
    if (record.settlementAssetId) missing(assetIds.has(record.settlementAssetId), 'game_record', record.id, `引用了不存在的结算资产 ${record.settlementAssetId}`);
    if (record.feeAssetId) missing(assetIds.has(record.feeAssetId), 'game_record', record.id, `引用了不存在的手续费资产 ${record.feeAssetId}`);
    if (record.recordType === 'fee' && record.feeAssetId) {
      issues.push({ kind: 'game_fee_record_conflict', entityType: 'game_record', entityId: record.id, detail: '独立手续费记录同时填写了手续费字段，费用会被重复计入' });
    }
  }
  const gameIncomeTypes = new Set(['sell_currency', 'sell_equipment', 'sell_material', 'withdraw', 'other_income']);
  const gameExpenseTypes = new Set(['buy_currency', 'buy_equipment', 'buy_material', 'topup', 'fee', 'account_cost', 'boosting_cost', 'other_expense']);
  const linkedGameTransactions = new Set<string>();
  for (const link of gameCashflowLinks) {
    const record = gameRecordById.get(link.gameRecordId);
    const transaction = transactionById.get(link.transactionId);
    const sourceAssetId = link.role === 'fee' ? record?.feeAssetId : record?.settlementAssetId;
    const sourceAmount = link.role === 'fee' ? record?.feeAmount : record?.settlementAmount;
    const expectedDirection = link.role === 'fee' || (record && gameExpenseTypes.has(record.recordType))
      ? 'outflow'
      : record && gameIncomeTypes.has(record.recordType) ? 'inflow' : undefined;
    const expectedType = expectedDirection === 'inflow' ? 'income' : 'expense';
    missing(!!record, 'game_cashflow_link', link.id, `引用了不存在的游戏记录 ${link.gameRecordId}`);
    missing(!!transaction, 'game_cashflow_link', link.id, `引用了不存在的流水 ${link.transactionId}`);
    missing(assetIds.has(link.sourceAssetId), 'game_cashflow_link', link.id, `引用了不存在的币种 ${link.sourceAssetId}`);
    if (link.accountId) missing(accountIds.has(link.accountId), 'game_cashflow_link', link.id, `引用了不存在的账户 ${link.accountId}`);
    if (linkedGameTransactions.has(link.transactionId)) {
      issues.push({ kind: 'game_cashflow_invalid', entityType: 'game_cashflow_link', entityId: link.id, detail: '同一流水被多个游戏资金项重复引用' });
    }
    linkedGameTransactions.add(link.transactionId);
    let amountMatches = false;
    let transactionAmountMatches = false;
    try {
      amountMatches = !!sourceAmount && D(sourceAmount).gt(0) && D(link.sourceAmount).eq(sourceAmount);
      transactionAmountMatches = !!transaction && D(transaction.amount).eq(link.sourceAmount);
    } catch {
      amountMatches = false;
      transactionAmountMatches = false;
    }
    const accountMatches = !!transaction
      && transaction.accountId === link.accountId
      && (!gameCashflowRequiresAccount || !!transaction.accountId);
    if (!record || !transaction || !isTransactionActive(transaction)
      || !['settlement', 'fee'].includes(link.role)
      || !['linked', 'created'].includes(link.ownership)
      || !expectedDirection || link.direction !== expectedDirection
      || transaction.type !== expectedType
      || sourceAssetId !== link.sourceAssetId
      || transaction.assetId !== link.sourceAssetId
      || !amountMatches || !transactionAmountMatches
      || !accountMatches) {
      issues.push({
        kind: 'game_cashflow_invalid',
        entityType: 'game_cashflow_link',
        entityId: link.id,
        detail: '游戏资金关联与记录金额、流水方向、币种或结算账户不一致',
      });
    }
  }

  const purchasesByAsset = new Map<string, typeof fixedEvents>();
  const eventCashflowDirection = (type: string) =>
    ['sale', 'part_sale'].includes(type) ? 'inflow' : ['purchase', 'repair', 'upgrade'].includes(type) ? 'outflow' : undefined;
  for (const event of fixedEvents) {
    missing(fixedAssetIds.has(event.fixedAssetId), 'fixed_asset_event', event.id, `引用了不存在的固定资产 ${event.fixedAssetId}`);
    if (event.hostAssetId) missing(fixedAssetIds.has(event.hostAssetId), 'fixed_asset_event', event.id, `安装目标物品不存在 ${event.hostAssetId}`);
    if (event.parentSaleEventId) missing(fixedEventById.has(event.parentSaleEventId), 'fixed_asset_event', event.id, `整机出售事件不存在 ${event.parentSaleEventId}`);
    if (event.type === 'install' && (!event.hostAssetId || fixedAssetById.get(event.fixedAssetId)?.role !== 'component')) {
      issues.push({ kind: 'fixed_cashflow_invalid', entityType: 'fixed_asset_event', entityId: event.id, detail: '安装事件必须属于配件并指定目标物品' });
    }
    const direction = eventCashflowDirection(event.type);
    if (direction && !['record_only', 'linked_transaction', 'create_transaction'].includes(event.cashflowMode ?? '')) {
      issues.push({ kind: 'fixed_cashflow_invalid', entityType: 'fixed_asset_event', entityId: event.id, detail: '有资金影响的事件缺少有效资金模式' });
    }
    if (!direction && event.cashflowMode) {
      issues.push({ kind: 'fixed_cashflow_invalid', entityType: 'fixed_asset_event', entityId: event.id, detail: '无资金影响的事件不应设置资金模式' });
    }
    if (event.type === 'purchase') {
      const rows = purchasesByAsset.get(event.fixedAssetId) ?? [];
      rows.push(event);
      purchasesByAsset.set(event.fixedAssetId, rows);
    }
  }
  for (const [assetId, purchases] of purchasesByAsset) {
    if (purchases.length > 1) issues.push({ kind: 'fixed_cashflow_invalid', entityType: 'fixed_asset', entityId: assetId, detail: '同一物品存在多个购买事件' });
  }
  for (const fixed of fixedAssets) {
    missing(assetIds.has(fixed.baseCurrencyAssetId), 'fixed_asset', fixed.id, `引用了不存在的结算资产 ${fixed.baseCurrencyAssetId}`);
    if (fixed.bundledFromAssetId) missing(fixedAssetIds.has(fixed.bundledFromAssetId), 'fixed_asset', fixed.id, `原配件所属物品不存在 ${fixed.bundledFromAssetId}`);
    missing(fixedCategoryIds.has(fixed.categoryId), 'fixed_asset', fixed.id, `引用了不存在的物品分类 ${fixed.categoryId}`);
    const terminal = fixedEvents
      .filter((event) => event.fixedAssetId === fixed.id && ['sale', 'scrap', 'retire', 'gift'].includes(event.type))
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)).at(-1);
    const expected = terminal?.type === 'sale' ? 'sold'
      : terminal?.type === 'scrap' ? 'scrapped'
        : terminal?.type === 'retire' ? 'retired'
          : terminal?.type === 'gift' ? 'gifted' : undefined;
    if (expected && fixed.status !== expected) issues.push({ kind: 'fixed_status_mismatch', entityType: 'fixed_asset', entityId: fixed.id, detail: `${terminal!.type} 事件要求状态为 ${expected}，当前为 ${fixed.status}` });
  }
  const cashflowByTransaction = new Map<string, ReturnType<typeof D>>();
  const cashflowBySource = new Map<string, { count: number; total: ReturnType<typeof D> }>();
  for (const link of fixedCashflowLinks) {
    const fixed = fixedAssetById.get(link.fixedAssetId);
    const source = link.sourceType === 'event'
      ? fixedEventById.get(link.sourceId)
      : link.sourceType === 'consumable' ? fixedConsumableById.get(link.sourceId) : undefined;
    const transaction = transactionById.get(link.transactionId);
    const expectedDirection = link.sourceType === 'event'
      ? eventCashflowDirection(source && 'type' in source ? source.type : '')
      : link.sourceType === 'consumable' ? 'outflow' : undefined;
    const expectedType = expectedDirection === 'inflow' ? 'income' : 'expense';
    const expectedOwnership = source?.cashflowMode === 'create_transaction' ? 'created' : 'linked';
    missing(fixedAssetIds.has(link.fixedAssetId), 'fixed_asset_cashflow_link', link.id, `引用了不存在的物品资产 ${link.fixedAssetId}`);
    missing(!!source, 'fixed_asset_cashflow_link', link.id, `引用了不存在的资金来源 ${link.sourceType}:${link.sourceId}`);
    missing(transactionIds.has(link.transactionId), 'fixed_asset_cashflow_link', link.id, `引用了不存在的流水 ${link.transactionId}`);
    missing(assetIds.has(link.sourceAssetId), 'fixed_asset_cashflow_link', link.id, `引用了不存在的来源币种 ${link.sourceAssetId}`);
    missing(assetIds.has(link.baseAssetId), 'fixed_asset_cashflow_link', link.id, `引用了不存在的记账币种 ${link.baseAssetId}`);
    if (!fixed || !source || source.fixedAssetId !== fixed.id || !expectedDirection || link.direction !== expectedDirection
      || !transaction || transaction.type !== expectedType || !isTransactionActive(transaction)
      || link.ownership !== expectedOwnership
      || link.sourceAssetId !== transaction.assetId || link.baseAssetId !== fixed.baseCurrencyAssetId) {
      issues.push({ kind: 'fixed_cashflow_invalid', entityType: 'fixed_asset_cashflow_link', entityId: link.id, detail: '资金关联与物品来源、流水方向、所有权或币种不一致' });
    }
    try {
      const sourceAmount = D(link.sourceAmount);
      const amountBase = D(link.amountBase);
      const rate = D(link.fxRateSnapshot ?? '0');
      if (!sourceAmount.gt(0) || !amountBase.gt(0) || !rate.gt(0) || !sourceAmount.times(rate).eq(amountBase)
        || !amountBase.eq(source?.amountBase ?? '0')) throw new Error('invalid');
      cashflowByTransaction.set(link.transactionId, (cashflowByTransaction.get(link.transactionId) ?? D(0)).plus(sourceAmount));
      const key = `${link.sourceType}:${link.sourceId}`;
      const aggregate = cashflowBySource.get(key) ?? { count: 0, total: D(0) };
      aggregate.count += 1;
      aggregate.total = aggregate.total.plus(amountBase);
      cashflowBySource.set(key, aggregate);
    } catch {
      issues.push({ kind: 'fixed_cashflow_invalid', entityType: 'fixed_asset_cashflow_link', entityId: link.id, detail: '资金关联金额或冻结汇率无效' });
    }
  }
  for (const [transactionId, total] of cashflowByTransaction) {
    const transaction = transactionById.get(transactionId);
    if (transaction && total.gt(transaction.amount)) issues.push({ kind: 'fixed_cashflow_invalid', entityType: 'transaction', entityId: transactionId, detail: '物品资金关联合计超过来源流水金额' });
  }
  const cashflowSources = [
    ...fixedEvents.filter((event) => !!eventCashflowDirection(event.type)).map((row) => ({ type: 'event', row, entityType: 'fixed_asset_event' })),
    ...fixedConsumables.map((row) => ({ type: 'consumable', row, entityType: 'fixed_asset_consumable' })),
  ];
  for (const source of cashflowSources) {
    const aggregate = cashflowBySource.get(`${source.type}:${source.row.id}`) ?? { count: 0, total: D(0) };
    if (!['record_only', 'linked_transaction', 'create_transaction'].includes(source.row.cashflowMode ?? '')) {
      issues.push({ kind: 'fixed_cashflow_invalid', entityType: source.entityType, entityId: source.row.id, detail: '资金模式无效' });
    } else if ((source.row.cashflowMode === 'record_only' && aggregate.count > 0)
      || (source.row.cashflowMode !== 'record_only' && (aggregate.count !== 1 || !aggregate.total.eq(source.row.amountBase)))) {
      issues.push({ kind: 'fixed_cashflow_invalid', entityType: source.entityType, entityId: source.row.id, detail: '资金关联必须与来源金额和资金模式一一对应' });
    }
  }
  for (const category of fixedCategories) {
    if (!category.name.trim()) issues.push({ kind: 'required_field_missing', entityType: 'fixed_asset_category', entityId: category.id, detail: '物品分类名称为空' });
    if (category.parentId) missing(fixedCategoryIds.has(category.parentId), 'fixed_asset_category', category.id, `引用了不存在的父级分类 ${category.parentId}`);
  }
  for (const metric of fixedMetrics) missing(fixedAssetIds.has(metric.fixedAssetId), 'fixed_asset_usage_metric', metric.id, `引用了不存在的物品资产 ${metric.fixedAssetId}`);
  for (const log of fixedLogs) {
    missing(fixedAssetIds.has(log.fixedAssetId), 'fixed_asset_usage_log', log.id, `引用了不存在的物品资产 ${log.fixedAssetId}`);
    missing(fixedMetricIds.has(log.metricId), 'fixed_asset_usage_log', log.id, `引用了不存在的用量指标 ${log.metricId}`);
  }
  for (const consumable of fixedConsumables) {
    missing(fixedAssetIds.has(consumable.fixedAssetId), 'fixed_asset_consumable', consumable.id, `引用了不存在的物品资产 ${consumable.fixedAssetId}`);
    if (consumable.usageMetricId) missing(fixedMetricIds.has(consumable.usageMetricId), 'fixed_asset_consumable', consumable.id, `引用了不存在的用量指标 ${consumable.usageMetricId}`);
  }
  for (const goal of fixedGoals) {
    missing(fixedAssetIds.has(goal.fixedAssetId), 'fixed_asset_goal', goal.id, `引用了不存在的物品资产 ${goal.fixedAssetId}`);
    if (goal.metricId) missing(fixedMetricIds.has(goal.metricId), 'fixed_asset_goal', goal.id, `引用了不存在的用量指标 ${goal.metricId}`);
  }

  const attachmentTargets: Record<string, Set<string>> = {
    transaction: transactionIds,
    conversion_chain: chainIds,
    game_record: ids(gameRecords),
    fixed_asset: fixedAssetIds,
    fixed_asset_consumable: ids(fixedConsumables),
  };
  for (const attachment of attachments) {
    const targets = attachmentTargets[attachment.entityType];
    missing(!!targets?.has(attachment.entityId), 'attachment', attachment.id, `引用了不存在或不支持的 ${attachment.entityType}:${attachment.entityId}`);
  }
  for (const budget of budgets) {
    missing(categoryIds.has(budget.category), 'budget_category', budget.id, `引用了不存在的分类 ${budget.category}`);
    missing(assetIds.has(budget.assetId), 'budget_category', budget.id, `引用了不存在的预算币种 ${budget.assetId}`);
  }
  for (const template of templates) {
    if (!template.name.trim()) issues.push({ kind: 'required_field_missing', entityType: 'transaction_template', entityId: template.id, detail: '模板名称为空' });
    if (template.type !== 'transfer') missing(categoryIds.has(template.category), 'transaction_template', template.id, `引用了不存在的分类 ${template.category}`);
    if (template.assetId) missing(assetIds.has(template.assetId), 'transaction_template', template.id, `引用了不存在的资产 ${template.assetId}`);
    if (template.accountId) missing(accountIds.has(template.accountId), 'transaction_template', template.id, `引用了不存在的账户 ${template.accountId}`);
  }
  for (const schedule of schedules) {
    missing(assetIds.has(schedule.assetId), 'scheduled_transaction', schedule.id, `引用了不存在的资产 ${schedule.assetId}`);
    if (schedule.type !== 'transfer') missing(categoryIds.has(schedule.category), 'scheduled_transaction', schedule.id, `引用了不存在的分类 ${schedule.category}`);
    if (schedule.accountId) missing(accountIds.has(schedule.accountId), 'scheduled_transaction', schedule.id, `引用了不存在的账户 ${schedule.accountId}`);
    if (schedule.transferAssetId) missing(assetIds.has(schedule.transferAssetId), 'scheduled_transaction', schedule.id, `引用了不存在的目标资产 ${schedule.transferAssetId}`);
    if (schedule.transferAccountId) missing(accountIds.has(schedule.transferAccountId), 'scheduled_transaction', schedule.id, `引用了不存在的目标账户 ${schedule.transferAccountId}`);
    if (schedule.payeeId) missing(payeeIds.has(schedule.payeeId), 'scheduled_transaction', schedule.id, `引用了不存在的商户 ${schedule.payeeId}`);
  }
  for (const execution of scheduleExecutions) {
    try {
      assertScheduledExecutionShape(execution);
    } catch (error) {
      issues.push({ kind: 'occurrence_invalid', entityType: 'scheduled_execution', entityId: execution.id, detail: error instanceof Error ? error.message : String(error) });
    }
    missing(scheduleIds.has(execution.scheduleId), 'scheduled_execution', execution.id, `引用了不存在的定期交易 ${execution.scheduleId}`);
    if (execution.transactionId) missing(transactionIds.has(execution.transactionId), 'scheduled_execution', execution.id, `引用了不存在的流水 ${execution.transactionId}`);
  }
  for (const reconciliation of reconciliations) {
    missing(accountIds.has(reconciliation.accountId), 'reconciliation_session', reconciliation.id, `引用了不存在的账户 ${reconciliation.accountId}`);
    missing(assetIds.has(reconciliation.assetId), 'reconciliation_session', reconciliation.id, `引用了不存在的资产 ${reconciliation.assetId}`);
    try {
      await store.withBackupImportContext((historicalStore) => historicalStore.assertReconciliationAggregate(
        reconciliation,
        reconciliationItems.filter((item) => item.reconciliationId === reconciliation.id),
      ));
    } catch (error) {
      issues.push({
        kind: 'reconciliation_invalid',
        entityType: 'reconciliation_session',
        entityId: reconciliation.id,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const item of reconciliationItems) {
    missing(reconciliationIds.has(item.reconciliationId), 'reconciliation_item', item.id, `引用了不存在的对账批次 ${item.reconciliationId}`);
    missing(transactionIds.has(item.transactionId), 'reconciliation_item', item.id, `引用了不存在的流水 ${item.transactionId}`);
    missing(accountIds.has(item.accountId), 'reconciliation_item', item.id, `引用了不存在的账户 ${item.accountId}`);
    missing(assetIds.has(item.assetId), 'reconciliation_item', item.id, `引用了不存在的资产 ${item.assetId}`);
  }
  return issues;
}

export interface RecomputeResult {
  lots: number;
  chains: number;
}

/** Recompute and rewrite all derived caches. Safe to run anytime. */
export async function recomputeCaches(store: SqlLedgerStore): Promise<RecomputeResult> {
  return store.withBackupImportContext((historicalStore) => historicalStore.transaction(async (txStore) => {
    const costState = await readAssetCostState(txStore);
    const lots = await txStore.lots.list();
    const cons = await txStore.lotConsumptions.list();
    const consByLot = groupBy(cons, (c) => c.lotId);

    let lotN = 0;
    for (const lot of lots) {
      const consumed = sum((consByLot.get(lot.id) ?? []).map((c) => c.consumedAmount));
      const remaining = D(lot.originalAmount).minus(consumed);
      const status = remaining.lte(0) ? 'closed' as const : 'open' as const;
      if (!remaining.eq(D(lot.remainingAmount)) || status !== lot.status) {
        await txStore.lots.put({ ...lot, remainingAmount: remaining.toString(), status });
        lotN += 1;
      }
    }

    let chN = 0;
    for (const ch of await txStore.conversionChains.list()) {
      const exp = await chainExpected(txStore, ch.id, ch.type, costState);
      if (!exp) continue;
      const changed = Object.entries(exp).some(([k, v]) => {
        const cur = (ch as unknown as Record<string, unknown>)[k];
        if (cur == null || cur === '') return v != null;
        const isNumeric = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
        return isNumeric ? !numericEqualWithinTolerance(cur, v) : cur !== v;
      });
      if (changed) {
        await txStore.conversionChains.put({ ...ch, ...exp });
        chN += 1;
      }
    }
    return { lots: lotN, chains: chN };
  }));
}

/**
 * Tombstone GC: age only makes a row a candidate. Physical deletion also
 * requires every active sync replica to acknowledge the producing commit.
 */
export async function purgeTombstones(
  store: SqlLedgerStore,
  olderThanDays = 90,
): Promise<import('./repository.js').TombstonePurgeResult> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  return store.purgeTombstonesBefore(cutoff);
}
