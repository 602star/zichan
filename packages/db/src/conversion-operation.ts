import { accountChainPostings, accountOpeningPostings, accountTransactionPostings, assetCostSourceSummary,
  calculateAssetCostHistory, canonicalJson, conversionStepAmounts, D, dayOfInstant, freezeConversionQuote,
  normalizeOccurrence, sum, conversionFinancialFingerprint, type AssetCostState, type ChainWithSteps, type ConversionOperation, type Posting } from '@zichan/core';
import { ConcurrencyError, type SqlLedgerStore } from './repository.js';
import { readCostLedgerInput } from './asset-cost-service.js';
import { rebuildConversionDerivedInTransaction } from './services.js';
import { saveConversionAggregate, synchronizeConversionDca } from './conversion-aggregate.js';

export interface ConversionOperationInput {
  /** A single independent conversion shares this pure calculator without creating an operation fact. */
  standalone?: boolean;
  operation: ConversionOperation;
  conversions: ChainWithSteps[];
  /** Explicit acknowledgement of each inter-segment quantity change. */
  links: { retainedQuantity: string; supplementalQuantity: string; accountId?: string }[];
  dcaPlanId?: string;
}
export interface ConversionPreview {
  input: ConversionOperationInput;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  accountChanges: { accountId: string | null; assetId: string; before: string; delta: string; after: string }[];
  assetChanges: { assetId: string; delta: string }[];
  historicalBalances: { path: string; accountId: string | null; assetId: string; before: string; after: string }[];
  retained: { assetId: string; accountId: string | null; quantity: string }[];
  beforeCost?: AssetCostState;
  afterCost?: AssetCostState;
  dependencyFingerprint: string;
}

function totals(postings: Posting[]): Map<string, { accountId: string | null; assetId: string; amount: string }> {
  const result = new Map<string, { accountId: string | null; assetId: string; amount: string }>();
  for (const posting of postings) {
    const key = canonicalJson([posting.accountId ?? null, posting.assetId]);
    const before = result.get(key);
    result.set(key, { accountId: posting.accountId ?? null, assetId: posting.assetId, amount: D(before?.amount ?? '0').plus(posting.amount).toString() });
  }
  return result;
}

/** Read-only: the same calculator runs again within the eventual write transaction. */
export async function previewConversionOperation(store: SqlLedgerStore, draft: ConversionOperationInput): Promise<ConversionPreview> {
  return store.transaction(async (transactionStore) => {
    const input = structuredClone(draft);
    const out: ConversionPreview = { input, errors: [], warnings: [], accountChanges: [], assetChanges: [], historicalBalances: [], retained: [], dependencyFingerprint: '' };
    const error = (path: string, message: string) => out.errors.push({ path, message });
    const current = await transactionStore.conversionOperations.get(input.operation.id);
    if (current && current.version !== input.operation.version) error('operation', '连续转换已被修改，请刷新预览');
    if (current?.recordState === 'voided') error('operation', '已作废的连续转换需先恢复');
    const openings = (await transactionStore.costBasisOpenings.list()).sort((a, b) => Date.parse(b.occurredAtUtc) - Date.parse(a.occurredAtUtc) || b.id.localeCompare(a.id));
    let start: string | undefined;
    try { start = input.conversions[0] && normalizeOccurrence(input.conversions[0].chain).occurredAtUtc; } catch { /* The field validator below reports the invalid occurrence. */ }
    const opening = start ? openings.find((row) => Date.parse(row.occurredAtUtc) < Date.parse(start!)) : openings[0];
    if (!opening) { error('opening', '请先核对并确认成本起点'); return out; }
    const ledger = await readCostLedgerInput(transactionStore, opening);
    const assets = await transactionStore.assets.list();
    const ids = input.conversions.map(({ chain }) => chain.id);
    if (!ids.length || new Set(ids).size !== ids.length) error('conversions', '转换段不能为空且记录标识不能重复');
    if (input.standalone && ids.length !== 1) error('conversions', '独立转换预览只能包含一笔转换');
    if (input.links.length !== Math.max(0, ids.length - 1)) error('links', '连续转换衔接信息不完整');
    input.operation.chainIds = ids;
    input.operation.links = input.links;
    for (const [index, aggregate] of input.conversions.entries()) {
      const path = `conversions.${index}`;
      const before = ledger.chains.find((row) => row.chain.id === aggregate.chain.id);
      if (before && (input.standalone ? !!before.chain.operationId : before.chain.operationId !== input.operation.id)) error(path, '该记录属于独立转换或其他连续操作');
      if (before && before.chain.version !== aggregate.chain.version) error(path, '该转换段已被修改，请刷新预览');
      try {
        aggregate.chain = { ...aggregate.chain, ...normalizeOccurrence(aggregate.chain), operationId: input.standalone ? undefined : input.operation.id, operationOrder: input.standalone ? undefined : index, recordState: 'active' };
        if (!aggregate.chain.occurredAtUtc || Date.parse(aggregate.chain.occurredAtUtc) <= Date.parse(opening.occurredAtUtc)) throw new Error('连续转换需要准确时间，且必须在成本起点之后');
        if (openings.find((row) => Date.parse(row.occurredAtUtc) < Date.parse(aggregate.chain.occurredAtUtc!))?.id !== opening.id) throw new Error('连续转换跨越不同的成本核算期间，请分别记录');
        if (aggregate.chain.baseCurrencyAssetId !== opening.baseCurrencyAssetId) throw new Error('转换核算币种与冻结的成本币种不一致');
        aggregate.chain.costQuotes ??= aggregate.steps.map((step) => freezeConversionQuote(step, aggregate.chain.occurredAtUtc!, opening.baseCurrencyAssetId,
          aggregate.steps.length === 1 && aggregate.chain.bookValueInBase ? { valueInBase: aggregate.chain.bookValueInBase, source: 'manual', priceMarkIds: [] } : undefined));
        await transactionStore.validateConversionSnapshot(aggregate.chain, aggregate.steps);
        if (index > 0) {
          const previous = input.conversions[index - 1]!;
          const last = previous.steps.at(-1)!;
          const first = aggregate.steps[0]!;
          if (Date.parse(previous.chain.occurredAtUtc!) > Date.parse(aggregate.chain.occurredAtUtc)) throw new Error('后续转换不能早于上一段');
          if (last.toAssetId !== first.fromAssetId) throw new Error('上一段目标资产与本段来源资产不一致');
          if ((last.accountToId ?? '') !== (first.accountFromId ?? '')) throw new Error('上一段到账账户与本段来源账户不一致，请明确记录账户转移');
          const link = input.links[index - 1];
          if (!link || !D(link.retainedQuantity).isFinite() || D(link.retainedQuantity).lt(0) || !D(link.supplementalQuantity).isFinite() || D(link.supplementalQuantity).lt(0)) throw new Error('保留及补入数量必须为非负数');
          if (D(link.retainedQuantity).gt(0) && D(link.supplementalQuantity).gt(0)) throw new Error('同一衔接不能同时保留和补入');
          const available = D(conversionStepAmounts(last).targetCredit);
          const debit = D(conversionStepAmounts(first).sourceDebit);
          if (!available.minus(link.retainedQuantity).plus(link.supplementalQuantity).eq(debit)) throw new Error('衔接数量与实际扣款不一致（含来源费用）');
          if (D(link.supplementalQuantity).gt(0) && (!first.accountFromId || link.accountId !== first.accountFromId)) throw new Error('请明确补入资金所在的来源账户');
          if (D(link.retainedQuantity).gt(0)) out.retained.push({ assetId: last.toAssetId, accountId: last.accountToId ?? null, quantity: link.retainedQuantity });
        }
      } catch (cause) { error(path, cause instanceof Error ? cause.message : String(cause)); }
    }
    out.dependencyFingerprint = canonicalJson({ input, openings, chains: ledger.chains, transactions: ledger.transactions,
      accounts: ledger.accounts, assets, operations: await transactionStore.conversionOperations.list(),
      plans: await transactionStore.dcaPlans.list(), executions: await transactionStore.dcaExecutions.list() });
    if (input.dcaPlanId) {
      const plan = await transactionStore.dcaPlans.get(input.dcaPlanId);
      const last = input.conversions.at(-1);
      const targetId = last?.steps.at(-1)?.toAssetId;
      if (!plan || plan.isDeleted || plan.status !== 'active' || last?.chain.type !== 'dca'
        || plan.baseCurrencyAssetId !== opening.baseCurrencyAssetId || plan.targetAssetId !== targetId) error('dcaPlanId', '关联计划的状态、核算币种或目标资产与转换不一致');
    }
    if (out.errors.length) return out;
    const replaced = new Set(current?.chainIds ?? ids);
    const remaining = ledger.chains.filter((row) => !replaced.has(row.chain.id));
    const after = { ...ledger, chains: [...remaining, ...input.conversions] };
    out.beforeCost = calculateAssetCostHistory({ ...ledger, openings })!;
    out.afterCost = calculateAssetCostHistory({ ...after, openings })!;
    if (out.afterCost.invalidAssetIds.length) out.warnings.push({ path: 'opening', message: '成本起点需要重新核对，受影响资产的后续盈亏将标为未完整核算' });
    const accounts = [...ledger.accounts];
    const external = new Set(accounts.filter((account) => account.kind === 'other').map((account) => account.id));
    const accountOpenings = accountOpeningPostings(accounts).filter((posting) => !external.has(posting.accountId ?? ''));
    const allPostings = (chains: readonly ChainWithSteps[]) => [...accountOpenings, ...chains.flatMap((row) => accountChainPostings(row, accounts)), ...ledger.transactions.flatMap((row) => accountTransactionPostings(row, accounts))];
    const previousTotals = totals(allPostings(ledger.chains));
    const nextTotals = totals(allPostings(after.chains));
    for (const key of new Set([...previousTotals.keys(), ...nextTotals.keys()])) {
      const before = previousTotals.get(key);
      const after = nextTotals.get(key);
      const row = after ?? before!;
      const delta = D(after?.amount ?? '0').minus(before?.amount ?? '0');
      if (delta.isZero()) continue;
      out.accountChanges.push({ accountId: row.accountId, assetId: row.assetId, before: before?.amount ?? '0', delta: delta.toString(), after: after?.amount ?? '0' });
    }
    out.assetChanges = [...new Set(out.accountChanges.map((row) => row.assetId))].map((assetId) => ({ assetId, delta: sum(out.accountChanges.filter((row) => row.assetId === assetId).map((row) => row.delta)).toString() }));
    const priorSegments: ChainWithSteps[] = [];
    for (const [index, aggregate] of input.conversions.entries()) {
      const instant = Date.parse(aggregate.chain.occurredAtUtc!);
      const operationKey = `1:${aggregate.chain.operationId ?? aggregate.chain.id}`;
      const beforeTime = (row: { id: string; occurredAtUtc?: string; date: string; operationId?: string; isDeleted: boolean; recordState?: string }) => {
        if (row.isDeleted || row.recordState === 'voided') return false;
        if (row.occurredAtUtc) {
          const difference = Date.parse(row.occurredAtUtc) - instant;
          return difference < 0 || (difference === 0 && `1:${row.operationId ?? row.id}`.localeCompare(operationKey) < 0);
        }
        const day = dayOfInstant(aggregate.chain.occurredAtUtc!, ledger.timezone);
        if (row.date === day) error(`conversions.${index}.time`, '当天有仅记录日期的流水，请补充准确时间后核对发生时余额');
        return row.date < day;
      };
      const historical = [...accountOpenings.filter((posting) => Date.parse(accounts.find((account) => account.id === posting.accountId)?.balanceStartAt ?? '') <= instant),
        ...remaining.filter((row) => beforeTime(row.chain)).flatMap((row) => accountChainPostings(row, accounts)),
        ...ledger.transactions.filter(beforeTime).flatMap((row) => accountTransactionPostings(row, accounts)),
        ...priorSegments.flatMap((row) => accountChainPostings(row, accounts))];
      const running = totals(historical);
      for (const [stepIndex, step] of aggregate.steps.entries()) {
        for (const posting of accountChainPostings({ chain: aggregate.chain, steps: [step] }, accounts)) {
          const key = canonicalJson([posting.accountId ?? null, posting.assetId]);
          const before = running.get(key)?.amount ?? '0';
          const after = D(before).plus(posting.amount).toString();
          running.set(key, { accountId: posting.accountId ?? null, assetId: posting.assetId, amount: after });
          const path = `conversions.${index}.steps.${stepIndex}`;
          out.historicalBalances.push({ path, accountId: posting.accountId ?? null, assetId: posting.assetId, before, after });
          if (D(after).lt(0)) out.warnings.push({ path, message: `发生时账户余额不足 ${D(after).abs().toString()} ${assets.find((asset) => asset.id === posting.assetId)?.code ?? posting.assetId}，仍可保存` });
        }
      }
      priorSegments.push(aggregate);
      if (!assetCostSourceSummary(out.afterCost, aggregate.chain.id).complete) out.warnings.push({ path: `conversions.${index}`, message: '成本或处置价值不完整，相关盈亏将显示为未完整核算' });
    }
    return out;
  });
}

export async function saveConversionOperation(store: SqlLedgerStore, preview: ConversionPreview): Promise<ConversionOperation> {
  if (preview.input.standalone) throw new Error('独立转换必须使用独立提交接口');
  return store.runInAuditBatch('保存连续资产转换', async (transactionStore) => {
    const fresh = await previewConversionOperation(transactionStore, preview.input);
    if (fresh.errors.length) throw new Error(fresh.errors[0]!.message);
    if (fresh.dependencyFingerprint !== preview.dependencyFingerprint) throw new Error('账本或表单已变化，请刷新预览后保存');
    const current = await transactionStore.conversionOperations.get(fresh.input.operation.id);
    for (const id of current?.chainIds ?? []) if (!fresh.input.operation.chainIds.includes(id)) {
      const chain = await transactionStore.conversionChains.get(id);
      if (chain && !chain.isDeleted) await transactionStore.conversionChains.remove(id, chain.version);
    }
    for (const aggregate of fresh.input.conversions) await transactionStore.saveChainWithSteps(aggregate.chain, aggregate.steps);
    const saved = await transactionStore.conversionOperations.put(fresh.input.operation);
    await rebuildConversionDerivedInTransaction(transactionStore);
    const last = await transactionStore.conversionChains.get(fresh.input.conversions.at(-1)!.chain.id);
    if (last) await synchronizeConversionDca(transactionStore, last, fresh.input.dcaPlanId);
    return saved;
  });
}

export async function previewStandaloneConversion(store: SqlLedgerStore, aggregate: ChainWithSteps, dcaPlanId?: string): Promise<ConversionPreview> {
  return previewConversionOperation(store, { standalone: true, operation: { id: `preview:${aggregate.chain.id}`, createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    chainIds: [aggregate.chain.id] }, conversions: [aggregate], links: [], dcaPlanId });
}

export async function saveStandaloneConversion(store: SqlLedgerStore, preview: ConversionPreview) {
  if (!preview.input.standalone) throw new Error('连续转换必须整组提交');
  return store.runInAuditBatch('保存已预览的资产转换', async (transactionStore) => {
    const fresh = await previewConversionOperation(transactionStore, preview.input);
    if (fresh.errors.length) throw new Error(fresh.errors[0]!.message);
    if (fresh.dependencyFingerprint !== preview.dependencyFingerprint) throw new Error('账本或表单已变化，请刷新预览后保存');
    const aggregate = fresh.input.conversions[0]!;
    const existing = await transactionStore.conversionChains.get(aggregate.chain.id);
    return saveConversionAggregate(transactionStore, { ...aggregate, editing: !!existing, expectedVersion: existing ? aggregate.chain.version : undefined, dcaPlanId: fresh.input.dcaPlanId });
  });
}

export async function updateConversionOperationMetadata(store: SqlLedgerStore, input: ConversionOperationInput): Promise<ConversionOperation> {
  return store.transaction(async (transactionStore) => {
    const current = await transactionStore.conversionOperations.get(input.operation.id);
    if (!current || current.version !== input.operation.version) throw new ConcurrencyError('conversion_operation', input.operation.id, input.operation.version, current?.version);
    if (current.recordState === 'voided') throw new Error('请先恢复连续转换');
    if (canonicalJson(current.chainIds) !== canonicalJson(input.conversions.map((row) => row.chain.id))
      || canonicalJson(current.links ?? []) !== canonicalJson(input.links)) throw new Error('转换顺序或衔接已变化，需要重新预览');
    const updates: ChainWithSteps[] = [];
    for (const draft of input.conversions) {
      const before = await transactionStore.getChainWithSteps(draft.chain.id);
      if (!before || before.chain.version !== draft.chain.version) throw new Error('连续转换子记录已被修改');
      if (conversionFinancialFingerprint(before) !== conversionFinancialFingerprint(draft)) throw new Error('资金字段已变化，需要重新预览');
      const steps = before.steps.map((step) => {
        const metadata = draft.steps.find((row) => row.id === step.id)!;
        return { ...step, platform: metadata.platform?.trim() || undefined, note: metadata.note?.trim() || undefined,
          ...(step.fees ? { fees: step.fees.map((fee) => ({ ...fee, note: metadata.fees?.find((row) => row.id === fee.id)?.note?.trim() || undefined })) } : {}) };
      });
      const chain = { ...before.chain, title: draft.chain.title?.trim() || undefined, note: draft.chain.note?.trim() || undefined };
      if (canonicalJson({ chain, steps }) !== canonicalJson(before)) updates.push({ chain, steps });
    }
    const title = input.operation.title?.trim() || undefined;
    if (!updates.length && title === current.title) return current;
    return transactionStore.runInAuditBatch('更新连续转换文字信息', async (batch) => {
      for (const row of updates) await batch.saveChainWithSteps(row.chain, row.steps);
      return batch.conversionOperations.put({ ...current, title });
    });
  });
}

/** Captured after a successful operation; later fact changes prevent destructive undo. */
export async function conversionOperationDependency(store: SqlLedgerStore, id: string): Promise<string> {
  return store.transaction(async (transactionStore) => {
    const operation = await transactionStore.conversionOperations.get(id);
    if (!operation) throw new Error('连续转换不存在');
    return canonicalJson({ operation, ledger: await conversionFinancialDependency(transactionStore) });
  });
}

export async function conversionFinancialDependency(store: SqlLedgerStore): Promise<string> {
  return store.transaction(async (transactionStore) => {
    const openings = await transactionStore.costBasisOpenings.list();
    const chains = await transactionStore.conversionChains.list({ includeDeleted: true });
    const steps = await transactionStore.listStepsByChains(chains.map((chain) => chain.id));
    return canonicalJson({ openings, chains: chains.map((chain) => ({ chain, steps: steps.get(chain.id) ?? [] })),
      transactions: await transactionStore.transactions.list({ includeDeleted: true }), accounts: await transactionStore.accounts.list({ includeDeleted: true }),
      executions: await transactionStore.dcaExecutions.list({ includeDeleted: true }), plans: await transactionStore.dcaPlans.list({ includeDeleted: true }) });
  });
}

export async function setConversionOperationState(store: SqlLedgerStore, id: string, version: number, state: 'active' | 'voided', expectedDependency?: string): Promise<ConversionOperation> {
  return store.runInAuditBatch(state === 'active' ? '恢复连续资产转换' : '作废连续资产转换', async (transactionStore) => {
    const current = await transactionStore.conversionOperations.get(id);
    if (!current || current.version !== version) throw new ConcurrencyError('conversion_operation', id, version, current?.version);
    if (expectedDependency && expectedDependency !== await conversionOperationDependency(transactionStore, id)) throw new Error('连续转换或成本起点依赖已有后续修改，不能直接撤销，请重新预览');
    if ((current.recordState ?? 'active') === state) return current;
    for (const chainId of current.chainIds) {
      const chain = await transactionStore.conversionChains.get(chainId);
      if (!chain || chain.operationId !== id) throw new Error('连续转换子记录缺失或归属不一致');
      await transactionStore.conversionChains.put({ ...chain, recordState: state, voidedAt: state === 'voided' ? new Date().toISOString() : undefined });
    }
    const saved = await transactionStore.conversionOperations.put({ ...current, recordState: state });
    await rebuildConversionDerivedInTransaction(transactionStore);
    return saved;
  });
}
