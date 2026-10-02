import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  D,
  canonicalJson,
  freezeConversionQuote,
  normalizeOccurrence,
  conversionFinancialFingerprint,
  usesAssetCostState,
  conversionStepAmounts,
  localToday,
  newId,
  normalizeConversionAmounts,
  type Asset,
  type ConversionChain,
  type ConversionFee,
  type ConversionFeeTreatment,
  type ConversionSourceAmountMode,
  type ConversionStep,
  type ConversionTargetAmountMode,
  type ConversionType,
  type ChainWithSteps,
  type CostQuoteSnapshot,
  type LotMethod,
} from '@zichan/core';
import { previewConversionImpact, saveConversionAggregate, updateConversion, updateConversionMetadata, voidConversion,
  previewConversionOperation, saveConversionOperation, setConversionOperationState, conversionOperationDependency,
  previewStandaloneConversion, saveStandaloneConversion,
  updateConversionOperationMetadata,
  conversionFinancialDependency,
  type ConversionOperationInput, type ConversionPreview } from '@zichan/db';
import { buildConversionOperationDraft } from '../conversion-operation-draft.js';
import { useStore } from '../db/store.js';
import { useSnapshot } from '../db/snapshot.js';
import { financialPostings } from '../db/derive.js';
import { amount as fmtAmount, significant } from '../format.js';
import { conversionRateText } from '../selectors/convert.js';
import { conversionGap, suggestFeeValue } from '../conversion-entry.js';
import { moduleCurrencyId } from '../currencyPreferences.js';
import { useUndo } from '../ui/UndoToast.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DialogShell } from '../ui/DialogShell.js';
import { AssetIcon } from '../ui/AssetIcon.js';
import { useConversionDraft } from '../ui/useConversionDraft.js';
import { buildDcaConversionPreset } from '../dca-conversion-preset.js';
import {
  activeAssetByCode,
  ASSET_PRESETS,
  ASSET_PRESET_GROUPS,
  FEATURED_ASSET_PRESET_CODES,
  ensureAssetPreset,
  type AssetPreset,
  type AssetPresetCode,
} from '../assetPresets.js';
import { btnOutline, btnPrimary, btnSmall, iconBtn, linkDanger } from '../ui/styles.js';

type FeeSide = 'source' | 'target' | 'third';

interface FeeDraft {
  valueEvidence?: ConversionFee['valueEvidence'];
  id: string;
  side: FeeSide;
  assetId: string;
  amount: string;
  valueInBase: string;
  accountId: string;
  note: string;
  confirmedFingerprint?: string;
}

interface StepDraft {
  costValue?: Pick<CostQuoteSnapshot, 'valueInBase' | 'source' | 'priceMarkIds' | 'quoteDate' | 'explanation'>;
  costValueFingerprint?: string;
  retainedBefore?: string;
  supplementalBefore?: string;
  supplementalAccountId?: string;
  manualFields?: string[];
  id: string;
  fromAssetId: string;
  fromInput: string;
  sourceAmountMode: ConversionSourceAmountMode;
  toAssetId: string;
  toInput: string;
  targetAmountMode: ConversionTargetAmountMode;
  referenceRate: string;
  accountFromId: string;
  accountToId: string;
  fees: FeeDraft[];
  platform: string;
  note: string;
}

const TYPES: [ConversionType, string][] = [
  ['dca', '定投'], ['buy', '买入'], ['sell', '卖出'], ['exchange', '换汇'],
  ['deposit', '入金'], ['withdraw', '提现'],
];

function todayDate(): string {
  return localToday();
}

function emptyStep(defaultAsset: string, fromAssetId = defaultAsset): StepDraft {
  return {
    id: newId(),
    fromAssetId,
    fromInput: '',
    sourceAmountMode: 'trade_principal',
    toAssetId: '',
    toInput: '',
    targetAmountMode: 'account_credit',
    referenceRate: '',
    accountFromId: '',
    accountToId: '',
    fees: [],
    platform: '',
    note: '',
  };
}

function treatmentFor(side: FeeSide, mode: ConversionSourceAmountMode): ConversionFeeTreatment {
  if (side === 'source') return mode === 'account_debit' ? 'source_included' : 'source_extra';
  return side === 'target' ? 'target_deducted' : 'third_asset_extra';
}

function buildFees(step: StepDraft): ConversionFee[] {
  return step.fees.map((fee) => ({
    id: fee.id,
    assetId: fee.side === 'source' ? step.fromAssetId : fee.side === 'target' ? step.toAssetId : fee.assetId,
    amount: fee.amount || '0',
    treatment: treatmentFor(fee.side, step.sourceAmountMode),
    valueInBase: fee.valueInBase || undefined,
    valueEvidence: fee.valueEvidence,
    accountId: fee.side === 'source' ? step.accountFromId || undefined
      : fee.side === 'target' ? step.accountToId || undefined : fee.accountId || undefined,
    note: fee.note || undefined,
  }));
}

function normalizeDraft(step: StepDraft, chainId = 'preview', order = 1): ConversionStep {
  const fees = buildFees(step);
  const normalized = normalizeConversionAmounts({
    fromInput: step.fromInput,
    toInput: step.toInput,
    sourceAmountMode: step.sourceAmountMode,
    targetAmountMode: step.targetAmountMode,
    fees,
  });
  return {
    id: step.id,
    chainId,
    order,
    fromAssetId: step.fromAssetId,
    fromAmount: normalized.fromAmount,
    toAssetId: step.toAssetId,
    toAmount: normalized.toAmount,
    sourceAmountMode: step.sourceAmountMode,
    targetAmountMode: step.targetAmountMode,
    fees,
    referenceRate: step.referenceRate || undefined,
    accountFromId: step.accountFromId || undefined,
    accountToId: step.accountToId || undefined,
    platform: step.platform || undefined,
    note: step.note || undefined,
  };
}

function feeSide(fee: ConversionFee): FeeSide {
  if (fee.treatment === 'source_included' || fee.treatment === 'source_extra') return 'source';
  if (fee.treatment === 'target_deducted') return 'target';
  return 'third';
}

function draftFromStep(step: ConversionStep): StepDraft {
  const amounts = conversionStepAmounts(step);
  const sourceAmountMode = step.sourceAmountMode ?? 'trade_principal';
  const targetAmountMode = step.targetAmountMode ?? 'account_credit';
  return {
    manualFields: ['fromAssetId', 'fromInput', 'accountFromId'],
    id: step.id,
    fromAssetId: step.fromAssetId,
    fromInput: sourceAmountMode === 'account_debit' ? amounts.sourceDebit : amounts.sourcePrincipal,
    sourceAmountMode,
    toAssetId: step.toAssetId,
    toInput: targetAmountMode === 'trade_gross' ? amounts.targetGross : amounts.targetCredit,
    targetAmountMode,
    referenceRate: step.referenceRate ?? '',
    accountFromId: step.accountFromId ?? '',
    accountToId: step.accountToId ?? '',
    platform: step.platform ?? '',
    note: step.note ?? '',
    fees: (step.fees ?? []).map((fee) => ({
      id: fee.id,
      side: feeSide(fee),
      assetId: fee.assetId,
      amount: fee.amount,
      valueInBase: fee.valueInBase ?? '',
      valueEvidence: fee.valueEvidence,
      accountId: fee.accountId ?? '',
      note: fee.note ?? '',
    })),
  };
}

function valuationFingerprint(steps: StepDraft[], date: string, time: string, currency: string): string {
  return canonicalJson({ date, time, currency, steps: steps.map((draft) => {
    try {
      const step = normalizeDraft(draft);
      return { fromAssetId: step.fromAssetId, fromAmount: step.fromAmount, toAssetId: step.toAssetId, toAmount: step.toAmount,
        fees: step.fees?.map(({ id, assetId, amount, treatment }) => ({ id, assetId, amount, treatment })) };
    } catch { return { fromAssetId: draft.fromAssetId, fromInput: draft.fromInput, toAssetId: draft.toAssetId, toInput: draft.toInput,
      fees: draft.fees.map(({ id, side, assetId, amount }) => ({ id, side, assetId, amount })) }; }
  }) });
}

interface PreparedConversion {
  chain: ConversionChain;
  steps: ConversionStep[];
}

class ConversionFieldError extends Error {
  constructor(message: string, readonly label: string, readonly stepIndex?: number, readonly feeId?: string) { super(message); }
}

function positiveInput(value: string, label: string, stepIndex?: number, feeId?: string): void {
  if (!value.trim()) throw new ConversionFieldError(`请填写${label}`, label, stepIndex, feeId);
  try { if (D(value).isFinite() && D(value).gt(0)) return; } catch { /* A field-specific message replaces Decimal's parser error. */ }
  throw new ConversionFieldError(`${label}必须是大于 0 的有效数字`, label, stepIndex, feeId);
}

export function AddConversionModal({
  onClose,
  initial: initialRecord,
  initialOperation,
  preset,
  assetPresetCode,
  entry,
}: {
  onClose: () => void;
  initial?: ChainWithSteps;
  initialOperation?: ConversionOperationInput;
  preset?: { dcaPlanId: string };
  assetPresetCode?: AssetPresetCode;
  entry?: { type: ConversionType; fromAssetId?: string; toAssetId?: string };
}) {
  const initial = useMemo(() => initialOperation ? { chain: { ...initialOperation.conversions[0]!.chain, title: initialOperation.operation.title,
    type: initialOperation.conversions.at(-1)!.chain.type, bookValueInBase: initialOperation.conversions.at(-1)!.chain.bookValueInBase },
    steps: initialOperation.conversions.flatMap((row) => row.steps) } : initialRecord, [initialOperation, initialRecord]);
  const titleId = useId();
  const formRef = useRef<HTMLDivElement>(null);
  const { store, bump } = useStore();
  const undo = useUndo(store, bump);
  const snap = useSnapshot('convert');
  const [date, setDate] = useState(() => initial?.chain.date ?? todayDate());
  const [time, setTime] = useState(() => initial ? initial.chain.time ?? '' : new Date().toTimeString().slice(0, 5));
  const [timezone] = useState(() => initial?.chain.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? '系统默认');
  const [type, setType] = useState<ConversionType>(() => initial?.chain.type ?? entry?.type ?? 'exchange');
  const [title, setTitle] = useState(() => initial?.chain.title ?? '');
  const [method, setMethod] = useState<LotMethod>(() => initial?.chain.lotMethod ?? 'fifo');
  const [dcaPlanId, setDcaPlanId] = useState('');
  const [selectedLotIds, setSelectedLotIds] = useState<string[]>(() => initial?.chain.manualLotIds ?? []);
  const [bookCurrencyId, setBookCurrencyId] = useState(() => initial?.chain.baseCurrencyAssetId ?? '');
  const [bookValueInBase, setBookValueInBase] = useState(() => initial?.chain.bookValueInBase ?? '');
  const [steps, setSteps] = useState<StepDraft[]>(() => {
    const drafts = initial?.steps.map(draftFromStep) ?? [];
    if (initialOperation) for (let index = 1; index < drafts.length; index++) {
      const link = initialOperation.links[index - 1];
      if (link) Object.assign(drafts[index]!, { retainedBefore: link.retainedQuantity, supplementalBefore: link.supplementalQuantity, supplementalAccountId: link.accountId });
    }
    if (initial) {
      const fingerprint = valuationFingerprint(drafts, initial.chain.date, initial.chain.time ?? '', initial.chain.baseCurrencyAssetId);
      for (const draft of drafts) {
        for (const fee of draft.fees) fee.confirmedFingerprint = fingerprint;
        const quote = (initialOperation?.conversions.flatMap((row) => row.chain.costQuotes ?? []) ?? initial.chain.costQuotes ?? []).find((row) => row.stepId === draft.id);
        if (quote && !(draft.id === initial.steps.at(-1)?.id && initial.chain.bookValueInBase) && (quote.source === 'manual' || quote.source === 'price_mark')) {
          const { valueInBase, source, priceMarkIds, quoteDate, explanation } = quote;
          draft.costValue = { valueInBase, source, priceMarkIds, quoteDate, explanation };
          draft.costValueFingerprint = fingerprint;
        }
      }
    }
    return drafts;
  });
  const [bookValueFingerprint, setBookValueFingerprint] = useState(() => initial ? valuationFingerprint(initial.steps.map(draftFromStep), initial.chain.date, initial.chain.time ?? '', initial.chain.baseCurrencyAssetId) : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<ConversionFieldError | null>(null);
  const [pending, setPending] = useState<PreparedConversion | null>(null);
  const [operationPreview, setOperationPreview] = useState<ConversionPreview | null>(null);
  const [operationIdentity] = useState(() => initialOperation?.operation ?? { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false, chainIds: [] });
  const [impactText, setImpactText] = useState('');
  const [presetNotice, setPresetNotice] = useState('');
  const [createdAssets, setCreatedAssets] = useState<import('@zichan/core').Asset[]>([]);
  const [creatingAssetCode, setCreatingAssetCode] = useState<AssetPresetCode | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  const completed = useRef(false);
  const presetApplied = useRef(false);
  const assetPresetApplied = useRef(false);

  const defaultBookCurrencyId = snap
    ? snap.costState?.baseCurrencyAssetId ?? moduleCurrencyId(snap.setting, 'investment', snap.assets[0]?.id ?? '')
    : '';
  const effectiveBookCurrencyId = bookCurrencyId || defaultBookCurrencyId;
  const grouped = !!initialOperation || (!!snap?.costState && !initial && steps.length > 1);
  const drafts = useMemo(
    () => steps.length ? steps : [{ ...emptyStep(effectiveBookCurrencyId, entry?.fromAssetId ?? effectiveBookCurrencyId), toAssetId: entry?.toAssetId ?? '' }],
    [effectiveBookCurrencyId, steps, entry],
  );
  const draftState = useConversionDraft({ date, time, type, title, method, dcaPlanId, selectedLotIds, bookCurrencyId, bookValueInBase, bookValueFingerprint, steps: drafts }, (saved) => {
    setDate(saved.date); setTime(saved.time); setType(saved.type); setTitle(saved.title); setMethod(saved.method);
    setDcaPlanId(saved.dcaPlanId); setSelectedLotIds(saved.selectedLotIds); setBookCurrencyId(saved.bookCurrencyId);
    setBookValueInBase(saved.bookValueInBase); setBookValueFingerprint(saved.bookValueFingerprint); setSteps(saved.steps);
  }, initialOperation?.operation.id ?? initial?.chain.id, initialOperation?.operation.version ?? initial?.chain.version);
  const requestClose = () => {
    if (completed.current || (!draftState.dirty && !draftState.pending)) onClose();
    else setCloseRequested(true);
  };
  const valueFingerprint = valuationFingerprint(drafts, date, time, effectiveBookCurrencyId);
  const bookValueStale = !!bookValueInBase && bookValueFingerprint !== valueFingerprint;
  const showError = (cause: unknown) => {
    setErr(cause instanceof Error ? cause.message : String(cause));
    const field = cause instanceof ConversionFieldError ? cause : null;
    setErrorField(field);
    if (field) requestAnimationFrame(() => {
      const root = formRef.current;
      root?.querySelectorAll('[aria-invalid="true"]').forEach((element) => element.removeAttribute('aria-invalid'));
      const step = field.stepIndex === undefined ? root : root?.querySelector(`[data-conversion-step="${field.stepIndex}"]`);
      const scope = field.feeId ? step?.querySelector(`[data-fee-id="${CSS.escape(field.feeId)}"]`) : step;
      const input = scope?.querySelector<HTMLElement>(`[aria-label="${field.label}"]`);
      if (!input) return;
      for (let parent = input.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      input.setAttribute('aria-invalid', 'true'); input.scrollIntoView({ block: 'center', behavior: 'smooth' }); input.focus({ preventScroll: true });
    });
  };
  const ensureSelectablePreset = useCallback(async (code: AssetPresetCode): Promise<Asset | null> => {
    setCreatingAssetCode(code);
    setErr(null);
    try {
      const result = await ensureAssetPreset(store, code);
      setCreatedAssets((current) => current.some((asset) => asset.id === result.asset.id)
        ? current
        : [...current, result.asset]);
      setPresetNotice(result.change === 'created'
        ? `已添加 ${result.asset.code} 资产定义；未生成余额或转换记录，请继续填写实际数量。`
        : `已选择 ${result.asset.code}；请继续填写实际来源和到账数量。`);
      if (result.change !== 'existing') bump();
      return result.asset;
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setCreatingAssetCode(null);
    }
  }, [bump, store]);
  const applyAssetPreset = useCallback(async (code: AssetPresetCode, stepIndex = 0) => {
    const asset = await ensureSelectablePreset(code);
    if (!asset) return;
    setSteps((current) => {
      const currentDrafts = current.length ? current : [emptyStep(effectiveBookCurrencyId)];
      return currentDrafts.map((step, index) => index === stepIndex
        ? { ...step, toAssetId: asset.id }
        : step);
    });
  }, [effectiveBookCurrencyId, ensureSelectablePreset]);
  const usesAccounts = true;
  const existingDcaExecution = initial && snap
    ? snap.dcaExecutions.find((execution) => !execution.isDeleted && (execution.chainId === initial.chain.id || initialOperation?.operation.chainIds.includes(execution.chainId ?? '')))
    : undefined;

  useEffect(() => {
    if (type === 'sell' && snap?.setting?.defaultLotMethod && (!initial || initial.chain.type !== 'sell')) {
      setMethod(snap.setting.defaultLotMethod);
    }
  }, [initial, type, snap?.setting?.defaultLotMethod]);

  useEffect(() => {
    if (existingDcaExecution?.planId) setDcaPlanId(existingDcaExecution.planId);
  }, [existingDcaExecution?.planId]);

  useEffect(() => {
    if (!snap || initial || !preset?.dcaPlanId || presetApplied.current) return;
    presetApplied.current = true;
    const plan = snap.dcaPlans.find((row) => !row.isDeleted && row.id === preset.dcaPlanId);
    if (!plan || plan.status !== 'active') {
      setErr('定投计划不存在或已经停用');
      return;
    }
    try {
      const built = buildDcaConversionPreset(plan, snap.assets);
      setType('dca');
      setDcaPlanId(built.planId);
      setTitle(built.title);
      setBookCurrencyId(built.bookCurrencyAssetId);
      setDate(todayDate());
      setSteps(built.assetPathIds.slice(0, -1).map((fromAssetId, index) => ({
        ...emptyStep(built.bookCurrencyAssetId, fromAssetId),
        fromInput: index === 0 ? built.plannedAmount : '',
        toAssetId: built.assetPathIds[index + 1]!,
      })));
      setPresetNotice(built.pathWarning ?? '已按计划预填来源金额与资产路径；请填写每一步实际到账数量后保存。');
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  }, [initial, preset?.dcaPlanId, snap]);

  useEffect(() => {
    if (!snap || initial || !assetPresetCode || assetPresetApplied.current) return;
    assetPresetApplied.current = true;
    void applyAssetPreset(assetPresetCode);
  }, [applyAssetPreset, assetPresetCode, initial, snap]);

  const preview = useMemo(() => drafts.map((step) => {
    try {
      if (!step.fromAssetId || !step.toAssetId || !step.fromInput || !step.toInput) return null;
      const normalized = normalizeDraft(step);
      return conversionStepAmounts(normalized);
    } catch {
      return null;
    }
  }), [drafts]);
  const accountPostings = useMemo(() => snap ? financialPostings(snap) : [], [snap]);

  if (!snap) return null;
  const assets = [
    ...snap.assets,
    ...createdAssets.filter((created) => !snap.assets.some((asset) => asset.id === created.id)),
  ].filter((asset) => !asset.isDeleted);
  const activePlans = snap.dcaPlans.filter((plan) => plan.status === 'active' || plan.id === existingDcaExecution?.planId);
  const code = (id: string) => assets.find((asset) => asset.id === id)?.code ?? '—';
  const quantity = (id: string, value: string) => fmtAmount(value, assets.find((asset) => asset.id === id)?.decimals ?? 8);
  const update = (index: number, patch: Partial<StepDraft>) => {
    setSteps((stored) => {
    const currentDrafts = stored.length ? stored : drafts;
    const current = currentDrafts[index]!;
    if (!current) return stored;
    if (patch.sourceAmountMode || patch.targetAmountMode) {
      try {
        const amounts = conversionStepAmounts(normalizeDraft(current));
        if (patch.sourceAmountMode) patch.fromInput = patch.sourceAmountMode === 'account_debit' ? amounts.sourceDebit : amounts.sourcePrincipal;
        if (patch.targetAmountMode) patch.toInput = patch.targetAmountMode === 'account_credit' ? amounts.targetCredit : amounts.targetGross;
      } catch { /* An incomplete amount has no economic value to preserve yet. */ }
    }
    const next = currentDrafts.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch,
      manualFields: [...new Set([...(step.manualFields ?? []), ...Object.keys(patch)])] } : { ...step });
    const changed = next[index]!;
    if (index > 0 && (patch.retainedBefore !== undefined || patch.supplementalBefore !== undefined) && !changed.manualFields?.includes('fromInput')) {
      try {
        const available = D(preview[index - 1]?.targetCredit ?? '0').minus(changed.retainedBefore || 0).plus(changed.supplementalBefore || 0);
        const fees = changed.fees.filter((fee) => fee.side === 'source').reduce((total, fee) => total.plus(fee.amount || 0), D(0));
        changed.fromInput = available.minus(changed.sourceAmountMode === 'trade_principal' ? fees : 0).toString();
      } catch { /* Keep the last input until the retention quantity is valid. */ }
    }
    if ((type === 'deposit' || type === 'withdraw') && changed.fromAssetId === changed.toAssetId && !changed.manualFields?.includes('toInput')) {
      try {
        const sourceFees = changed.fees.filter((fee) => fee.side === 'source').reduce((total, fee) => total.plus(fee.amount || 0), D(0));
        const targetFees = changed.fees.filter((fee) => fee.side === 'target').reduce((total, fee) => total.plus(fee.amount || 0), D(0));
        const principal = D(changed.fromInput || 0).minus(changed.sourceAmountMode === 'account_debit' ? sourceFees : 0);
        changed.toInput = principal.minus(changed.targetAmountMode === 'account_credit' ? targetFees : 0).toString();
      } catch { /* Field validation explains incomplete amounts. */ }
    }
    for (let i = index + 1; i < next.length; i++) {
      const previous = next[i - 1]!;
      const step = next[i]!;
      if (!step.manualFields?.includes('fromAssetId')) step.fromAssetId = previous.toAssetId;
      if (!step.manualFields?.includes('accountFromId')) step.accountFromId = previous.accountToId;
      if (!step.manualFields?.includes('fromInput')) {
        try {
          const available = D(conversionStepAmounts(normalizeDraft(previous)).targetCredit).minus(step.retainedBefore || 0).plus(step.supplementalBefore || 0);
          const fees = step.fees.filter((fee) => fee.side === 'source').reduce((total, fee) => total.plus(fee.amount || 0), D(0));
          step.fromInput = (step.sourceAmountMode === 'account_debit' ? available : available.minus(fees)).toString();
        } catch { step.fromInput = ''; }
      }
    }
    return next;
    });
  };
  const updateFee = (stepIndex: number, feeId: string, patch: Partial<FeeDraft>) => {
    const step = drafts[stepIndex]!;
    if (patch.valueInBase !== undefined) {
      patch.confirmedFingerprint = valueFingerprint;
      patch.valueEvidence ??= { source: 'manual', priceMarkIds: [], explanation: '用户确认手续费折算' };
    }
    update(stepIndex, { fees: step.fees.map((fee) => fee.id === feeId ? { ...fee, ...patch } : fee) });
  };
  const addFee = (stepIndex: number) => {
    const step = drafts[stepIndex]!;
    update(stepIndex, { fees: [...step.fees, { id: newId(), side: 'source', assetId: step.fromAssetId, amount: '', valueInBase: '', accountId: '', note: '' }] });
  };

  const currentConsumedLotIds = new Set(initial
    ? snap.lotConsumptions.filter((row) => !row.isDeleted && row.sellChainId === initial.chain.id).map((row) => row.lotId)
    : []);
  const sellLots = (snap.costState ? snap.costState.lots.map((lot) => ({ id: lot.id, assetId: lot.assetId, remainingAmount: lot.remainingQuantity, acquiredDate: lot.acquiredAtUtc, isDeleted: false })) : snap.lots)
    .filter((lot) => lot.assetId === drafts[0]?.fromAssetId && !lot.isDeleted && (D(lot.remainingAmount).gt(0) || currentConsumedLotIds.has(lot.id)))
    .sort((a, b) => a.acquiredDate.localeCompare(b.acquiredDate));
  const toggleLot = (id: string) => setSelectedLotIds((ids) => ids.includes(id) ? ids.filter((row) => row !== id) : [...ids, id]);

  function prepare(): PreparedConversion {
    if (!effectiveBookCurrencyId) throw new ConversionFieldError('请选择投资成本记账币种', '投资成本记账币种');
    if (bookValueInBase) positiveInput(bookValueInBase, '账面价值折算');
    if (bookValueStale) throw new ConversionFieldError('账面价值的条件已变化，请重新确认，或清除后以未知成本保存', '账面价值折算');
    const built = drafts.map((draft, index) => {
      if (!draft.fromAssetId || !draft.toAssetId) throw new ConversionFieldError(`步骤 ${index + 1} 需要选择来源和目标资产`, !draft.fromAssetId ? '来源资产' : '目标资产', index);
      const sameAssetAccountMove = (type === 'deposit' || type === 'withdraw')
        && draft.fromAssetId === draft.toAssetId
        && !!draft.accountFromId
        && !!draft.accountToId
        && draft.accountFromId !== draft.accountToId;
      if (draft.fromAssetId === draft.toAssetId && !sameAssetAccountMove) throw new Error(`步骤 ${index + 1} 的来源和目标资产不能相同；同币种入金或提现需选择两个不同账户`);
      if (draft.costValue?.valueInBase !== null && draft.costValue?.valueInBase !== undefined) {
        positiveInput(draft.costValue.valueInBase, '本步成交价值', index);
        if (draft.costValueFingerprint !== valueFingerprint) throw new ConversionFieldError('本步成交价值的条件已变化，请重新确认或清除', '本步成交价值', index);
      }
      positiveInput(draft.fromInput, '来源数量', index);
      positiveInput(draft.toInput, '目标数量', index);
      if (draft.referenceRate) positiveInput(draft.referenceRate, '市场参考汇率', index);
      for (const fee of draft.fees) {
        positiveInput(fee.amount, '手续费数量', index, fee.id);
        const assetId = fee.side === 'source' ? draft.fromAssetId : fee.side === 'target' ? draft.toAssetId : fee.assetId;
        if (!assetId) throw new Error(`步骤 ${index + 1} 的第三资产手续费需要选择资产`);
        if (fee.side === 'third' && (assetId === draft.fromAssetId || assetId === draft.toAssetId)) throw new Error(`步骤 ${index + 1} 的“第三资产另付”不能选择来源或目标资产`);
        if (assetId !== effectiveBookCurrencyId && !fee.valueInBase && !snap?.costState) throw new Error(`步骤 ${index + 1} 的非记账币种手续费需要填写折算价值`);
        if (assetId !== effectiveBookCurrencyId && fee.valueInBase && fee.confirmedFingerprint !== valueFingerprint) throw new ConversionFieldError(`步骤 ${index + 1} 的手续费折算条件已变化，请重新确认或清除折算值`, '手续费折算', index, fee.id);
        if (fee.valueInBase && D(fee.valueInBase).lt(0)) throw new Error(`步骤 ${index + 1} 的手续费折算不能为负数`);
      }
      return normalizeDraft(draft, '', index + 1);
    });
    if (type === 'sell' && !snap?.costState && sellLots.length === 0) throw new Error('该资产没有可卖批次，请先确认来源资产和已有买入记录');
    if (type === 'sell' && method === 'manual' && selectedLotIds.length === 0) throw new Error('手动匹配需要至少选择一个批次');

    const now = new Date().toISOString();
    const chainId = initial?.chain.id ?? newId();
    const chain: ConversionChain = {
      ...initial?.chain,
      id: chainId,
      date,
      occurredAtUtc: undefined,
      utcOffsetMinutes: undefined,
      timePrecision: undefined,
      time: time || undefined,
      timezone,
      type,
      title: title.trim() || undefined,
      baseCurrencyAssetId: effectiveBookCurrencyId,
      bookValueInBase: bookValueInBase || undefined,
      lotMethod: type === 'sell' || snap?.costState ? method : undefined,
      manualLotIds: (type === 'sell' || snap?.costState) && method === 'manual' ? selectedLotIds : undefined,
      recordState: 'active',
      voidedAt: undefined,
      voidReason: undefined,
      createdAt: initial?.chain.createdAt ?? now,
      updatedAt: initial?.chain.updatedAt ?? now,
      version: initial?.chain.version ?? 1,
      isDeleted: false,
    };
    for (const step of built) step.chainId = chain.id;
    Object.assign(chain, normalizeOccurrence(chain));
    if (usesAssetCostState(snap?.costState, chain)) {
      chain.costQuotes = built.map((step, index) => {
        const frozen = freezeConversionQuote(step, chain.occurredAtUtc!, effectiveBookCurrencyId,
          index === built.length - 1 && bookValueInBase ? { valueInBase: bookValueInBase, source: 'manual', priceMarkIds: [] } : drafts[index]?.costValue);
        const previous = initial?.chain.costQuotes?.find((quote) => quote.stepId === step.id);
        return previous && previous.dependencyFingerprint === frozen.dependencyFingerprint
          && previous.valueInBase === frozen.valueInBase && previous.source === frozen.source && canonicalJson(previous.priceMarkIds) === canonicalJson(frozen.priceMarkIds) && canonicalJson(previous.feeValues) === canonicalJson(frozen.feeValues)
          ? previous : frozen;
      });
    }
    return { chain, steps: built };
  }

  async function persist(prepared: PreparedConversion, reviewed?: ConversionPreview) {
    if (!snap || completed.current) return;
    setSaving(true);
    setErr(null);
    try {
      const metadataOnly = initial && dcaPlanId === (existingDcaExecution?.planId ?? '')
        && conversionFinancialFingerprint(initial) === conversionFinancialFingerprint(prepared);
      const result = reviewed ? await saveStandaloneConversion(store, reviewed) : metadataOnly ? await updateConversionMetadata(store, {
        chainId: initial.chain.id, expectedVersion: initial.chain.version, title: prepared.chain.title, note: prepared.chain.note,
        steps: prepared.steps.map(({ id, platform, note, fees }) => ({ id, platform, note, fees: fees?.map(({ id, note }) => ({ id, note })) })),
      }) : await saveConversionAggregate(store, {
        ...prepared,
        editing: !!initial,
        expectedVersion: initial?.chain.version,
        dcaPlanId: dcaPlanId || undefined,
      });
      const savedChain = result.chain;
      completed.current = true;
      if (initial && savedChain.version === initial.chain.version) { await draftState.finish(); onClose(); return; }
      const dependency = snap.costState && !metadataOnly ? await conversionFinancialDependency(store) : undefined;
      bump();
      if (initial) {
        const before = initial;
        undo.offer('资产转换已更新', async () => {
          await store.runInAuditBatch('撤销资产转换更新', async (transactionStore) => {
            if (dependency && await conversionFinancialDependency(transactionStore) !== dependency) throw new Error('账务或成本起点已有后续修改，不能直接撤销');
            const current = await transactionStore.conversionChains.get(savedChain.id);
            if (!current || current.version !== savedChain.version) throw new Error('该转换后来又被修改，不能直接撤销');
            await updateConversion(transactionStore, {
              chain: { ...before.chain, version: current.version },
              steps: before.steps,
              expectedVersion: current.version,
            });
            if (!metadataOnly) {
            const currentExecution = (await transactionStore.dcaExecutions.list({ includeDeleted: true })).find((row) => row.chainId === before.chain.id);
            if (existingDcaExecution) await transactionStore.dcaExecutions.put({
              ...existingDcaExecution,
              version: currentExecution?.version ?? existingDcaExecution.version,
              updatedAt: currentExecution?.updatedAt ?? existingDcaExecution.updatedAt,
              isDeleted: false,
            });
            else if (currentExecution && !currentExecution.isDeleted) await transactionStore.dcaExecutions.remove(currentExecution.id, currentExecution.version);
            }
          });
          bump();
        });
      } else {
        undo.offer('资产转换已保存', async () => {
          await store.transaction(async (transactionStore) => {
            if (dependency && await conversionFinancialDependency(transactionStore) !== dependency) throw new Error('账务或成本起点已有后续修改，不能直接撤销');
            await voidConversion(transactionStore, savedChain.id, '撤销刚才的新增');
          });
          bump();
        });
      }
      try { await draftState.finish(); }
      catch (cause) {
        setErr(`转换已保存，但本机草稿清理失败：${cause instanceof Error ? cause.message : String(cause)}。请关闭窗口，不要重复保存。`);
        setSaving(false); setPending(null); return;
      }
      onClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setSaving(false);
      setPending(null);
    }
  }

  async function save() {
    if (completed.current) return;
    if (draftState.pending || draftState.conflict) { setErr('请先处理草稿恢复与版本差异'); return; }
    setSaving(true);
    setErr(null);
    setErrorField(null);
    try {
      const prepared = prepare();
      if (grouped) {
        const input = buildConversionOperationDraft({ prepared, operation: operationIdentity, existing: initialOperation,
          links: drafts.slice(1).map((step) => ({ retainedQuantity: step.retainedBefore || '0', supplementalQuantity: step.supplementalBefore || '0', accountId: step.supplementalAccountId || undefined })), dcaPlanId: dcaPlanId || undefined });
        const metadataOnly = initialOperation && dcaPlanId === (existingDcaExecution?.planId ?? '')
          && canonicalJson(initialOperation.links) === canonicalJson(input.links) && input.conversions.length === initialOperation.conversions.length
          && input.conversions.every((row, index) => conversionFinancialFingerprint(row) === conversionFinancialFingerprint(initialOperation.conversions[index]!));
        if (metadataOnly) {
          const saved = await updateConversionOperationMetadata(store, input);
          completed.current = true; bump();
          if (saved.version !== initialOperation.operation.version) {
            const dependency = await conversionOperationDependency(store, saved.id);
            undo.offer('连续转换文字信息已更新', async () => {
              await store.transaction(async (transactionStore) => {
                if (await conversionOperationDependency(transactionStore, saved.id) !== dependency) throw new Error('记录已有后续修改，不能直接撤销');
                const conversions = await Promise.all(initialOperation.conversions.map(async (row) => ({ ...row, chain: { ...row.chain, version: (await transactionStore.conversionChains.get(row.chain.id))!.version } })));
                await updateConversionOperationMetadata(transactionStore, { ...initialOperation, operation: { ...initialOperation.operation, version: saved.version }, conversions });
              });
              bump();
            });
          }
          try { await draftState.finish(); }
          catch (cause) { throw new Error(`转换已保存，但草稿清理失败：${cause instanceof Error ? cause.message : String(cause)}。请关闭窗口，不要重复保存。`); }
          onClose(); return;
        }
        const result = await previewConversionOperation(store, input);
        setOperationPreview(result); setSaving(false); return;
      }
      const metadataOnly = initial && dcaPlanId === (existingDcaExecution?.planId ?? '') && conversionFinancialFingerprint(initial) === conversionFinancialFingerprint(prepared);
      if (usesAssetCostState(snap?.costState, prepared.chain) && !metadataOnly) {
        setOperationPreview(await previewStandaloneConversion(store, prepared, dcaPlanId || undefined)); setSaving(false); return;
      }
      if (initial && (dcaPlanId !== (existingDcaExecution?.planId ?? '') || conversionFinancialFingerprint(initial) !== conversionFinancialFingerprint(prepared))) {
        const impact = await previewConversionImpact(store, prepared.chain);
        setImpactText(`${snap?.costState ? '此修改位于成本起点之前，受影响资产的成本起点需要重新核对。' : ''}将从 ${impact.fromDate} 起重算 ${impact.chains} 条转换、${impact.lots} 个持仓批次和 ${impact.consumptions} 条卖出匹配。`);
        setPending(prepared);
        setSaving(false);
        return;
      }
      await persist(prepared);
    } catch (error) {
      showError(error);
      setSaving(false);
    }
  }

  async function persistOperation() {
    if (!operationPreview || operationPreview.errors.length) return;
    if (operationPreview.input.standalone) { await persist(operationPreview.input.conversions[0]!, operationPreview); return; }
    setSaving(true); setErr(null);
    try {
      const saved = await saveConversionOperation(store, operationPreview);
      completed.current = true;
      const dependency = await conversionOperationDependency(store, saved.id);
      bump();
      undo.offer('连续转换已整组保存', async () => {
        if (initialOperation) {
          await store.transaction(async (transactionStore) => {
            if (await conversionOperationDependency(transactionStore, saved.id) !== dependency) throw new Error('后续账务已变化，不能直接撤销');
            const conversions = await Promise.all(initialOperation.conversions.map(async (row) => ({ ...row, chain: { ...row.chain, version: (await transactionStore.conversionChains.get(row.chain.id))!.version } })));
            const before = await previewConversionOperation(transactionStore, { ...initialOperation, operation: { ...initialOperation.operation, version: saved.version }, conversions });
            await saveConversionOperation(transactionStore, before);
          });
        } else await setConversionOperationState(store, saved.id, saved.version, 'voided', dependency);
        bump();
      });
      try { await draftState.finish(); } catch (cause) { setErr(`连续转换已保存，但草稿清理失败：${String(cause)}`); setSaving(false); setOperationPreview(null); return; }
      onClose();
    } catch (cause) { setErr(cause instanceof Error ? cause.message : String(cause)); setSaving(false); setOperationPreview(null); }
  }

  const assetSelect = (label: string, value: string, onChange: (value: string) => void, allowEmpty = false, disabled = false) => (
    <div className="zc-asset-select">
      <AssetIcon code={assets.find((asset) => asset.id === value)?.code ?? ''} symbol={assets.find((asset) => asset.id === value)?.symbol} size={24} />
      <select aria-label={label} className="zc-select" value={value} onChange={(event) => {
        const selected = event.target.value;
        if (selected.startsWith('preset:')) {
          void ensureSelectablePreset(selected.slice(7) as AssetPresetCode).then((asset) => { if (asset) onChange(asset.id); });
        } else onChange(selected);
      }} disabled={disabled || creatingAssetCode !== null}>
        {allowEmpty && <option value="">请选择</option>}
        {assets.filter((asset) => asset.id === value || (asset.isActive && !asset.mergedIntoId)).map((asset) => <option key={asset.id} value={asset.id}>{asset.code} · {asset.name}{!asset.isActive ? '（已停用）' : ''}</option>)}
        {ASSET_PRESETS.some((preset) => !activeAssetByCode(assets, preset.code)) && <optgroup label="更多常用资产 · 选择时添加">
          {ASSET_PRESETS.filter((preset) => !activeAssetByCode(assets, preset.code)).map((preset) => <option key={preset.code} value={`preset:${preset.code}`}>{preset.code} · {preset.name}（添加资产定义）</option>)}
        </optgroup>}
      </select>
    </div>
  );
  const presetButton = (row: AssetPreset) => {
    const existing = activeAssetByCode(assets, row.code);
    const selected = !!existing && drafts.some((step) => step.toAssetId === existing.id);
    return <button key={row.code} type="button" className={`zc-asset-preset-button${selected ? ' is-selected' : ''}`}
      onClick={() => void applyAssetPreset(row.code)} disabled={creatingAssetCode !== null} aria-pressed={selected}>
      <AssetIcon code={row.code} symbol={row.symbol} size={26} />
      <span><strong>{row.code} · {row.name}</strong><small>{creatingAssetCode === row.code ? '添加中…' : existing ? '已有定义' : '选择时添加'}</small></span>
    </button>;
  };
  const accountSelect = (label: string, value: string, onChange: (value: string) => void, assetId?: string) => (
    <select aria-label={label} className="zc-select" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">未分配账户</option>
      {snap.accounts.filter((account) => !account.isDeleted && !account.purpose?.startsWith('default_') && account.kind !== 'other' && (account.id === value || account.isActive !== false)).map((account) => {
        const balance = assetId ? accountPostings.filter((posting) => posting.accountId === account.id && posting.assetId === assetId).reduce((total, posting) => total.plus(posting.amount), D(0)) : undefined;
        return <option key={account.id} value={account.id}>{account.name}{balance ? ` · 当前 ${significant(balance)} ${code(assetId!)}${balance.lt(0) ? '（负余额）' : ''}` : ''}{account.isActive === false ? '（已归档）' : ''}</option>;
      })}
    </select>
  );

  return (
    <DialogShell
      labelledBy={titleId}
      onDismiss={requestClose}
      dismissDisabled={saving}
      panelClassName="zc-conversion-modal"
      panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 24, width: 980, maxHeight: '92vh', overflow: 'auto' }}
    >
      <div ref={formRef} className="zc-conversion-form">
        <div className="zc-modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div id={titleId} style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>{initial ? '编辑资产转换' : '新增资产转换'}</div>
          <button type="button" data-dialog-initial-focus aria-label="关闭" title="关闭" onClick={requestClose} disabled={saving} style={iconButton}>×</button>
        </div>

        <div className="zc-conversion-head-grid" style={{ display: 'grid', gridTemplateColumns: '140px 110px 130px minmax(180px, 1fr) 180px', gap: 12, marginBottom: 14 }}>
          <Field label="日期"><input aria-label="日期" className="zc-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
          <Field label="时间"><input aria-label="时间" className="zc-input" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></Field>
          <Field label="类型"><select aria-label="类型" className="zc-select" value={type} onChange={(event) => setType(event.target.value as ConversionType)}>{[...TYPES, ...(snap.costState ? [['swap', '资产互换']] : [])].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="标题（可选）"><input aria-label="标题" className="zc-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="USD → USDT → BTC" /></Field>
          <div style={{ fontSize: 'var(--fs-caption)', alignSelf: 'end' }}>记账币种：{code(effectiveBookCurrencyId)}</div>
        </div>
        <details className="zc-conversion-guidance">
          <summary>操作类型与成本口径说明</summary>
          <p>{snap.costState
            ? '买入／卖出与换汇都是资产兑换；买入强调到账资产，卖出强调转出资产，换汇用于中性记录。全部金融资产按实际转出、到账和费用追踪成本；余额或成本不足仍可保存，相关盈亏标为未完整核算。'
            : '旧成本口径下，换汇只记录余额；买入／定投为投资资产建立成本批次，卖出按批次计算盈亏。启用统一成本核算后，外币和稳定币也能追踪成本。'}标题与参考汇率均可留空。</p>
        </details>
        <details open={!!bookValueInBase || type === 'dca'} style={{ marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>记账设置 · 手动折算、定投关联与时区</summary>
          <div style={{ marginTop: 10 }}><Field label="记账币种">{assetSelect('投资成本记账币种', effectiveBookCurrencyId, setBookCurrencyId, false, !!snap.costState)}</Field></div>
        <div className="zc-conversion-secondary-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          <Field label="账面成本 / 收入折算（按需）">
            <input aria-label="账面价值折算" className="zc-input" inputMode="decimal" value={bookValueInBase} onChange={(event) => { setBookValueInBase(event.target.value); setBookValueFingerprint(valueFingerprint); }} placeholder={`买入/卖出链路不含 ${code(effectiveBookCurrencyId)} 时填写`} />
            {bookValueStale && <div role="alert">条件已变化，请重新确认。<button type="button" style={smallButton} onClick={() => setBookValueFingerprint(valueFingerprint)}>确认原折算值</button><button type="button" style={smallButton} onClick={() => setBookValueInBase('')}>清除折算值</button></div>}
          </Field>
          {type === 'dca' && activePlans.length > 0 ? (
            <Field label="关联定投计划（可选）">
              <select aria-label="关联定投计划（可选）" className="zc-select" value={dcaPlanId} onChange={(event) => setDcaPlanId(event.target.value)}>
                <option value="">不关联计划</option>
                {activePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
              </select>
            </Field>
          ) : <div />}
          <Field label="时区"><input aria-label="时区" className="zc-input" value={timezone} readOnly /></Field>
        </div>
        </details>
        {presetNotice && <div style={{ color: presetNotice.includes('回退') ? 'var(--warning)' : 'var(--fg-muted)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', marginBottom: 14 }}>{presetNotice}</div>}

        {!initial && (
          <div style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)', marginBottom: 8 }}>常用目标资产</div>
            <div className="zc-asset-preset-grid">
              {ASSET_PRESETS.filter((row) => FEATURED_ASSET_PRESET_CODES.includes(row.code)).map(presetButton)}
            </div>
            <details className="zc-asset-preset-more"><summary>更多常用资产</summary>
              {ASSET_PRESET_GROUPS.map((group) => {
                const rows = ASSET_PRESETS.filter((row) => group.codes.includes(row.code) && !FEATURED_ASSET_PRESET_CODES.includes(row.code));
                return rows.length ? <div key={group.label}>
                  <div className="zc-asset-preset-group-title">{group.label}</div>
                  <div className="zc-asset-preset-grid">{rows.map(presetButton)}</div>
                </div> : null;
              })}
            </details>
            <div style={{ marginTop: 8, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>选择后只会补充可选资产，不会自动生成持仓、余额或交易。</div>
          </div>
        )}

        {(type === 'sell' || snap.costState) && (
          <div style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', padding: 12, marginBottom: 14 }}>
            <div className="zc-conversion-sell-grid" style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, alignItems: 'end' }}>
              <Field label="卖出成本匹配">
                <select aria-label="成本匹配方式" className="zc-select" value={method} onChange={(event) => setMethod(event.target.value as LotMethod)}>
                  <option value="fifo">FIFO · 先进先出</option><option value="lifo">LIFO · 后进先出</option>
                  <option value="average">平均成本</option><option value="manual">手动选择批次</option>
                </select>
              </Field>
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', paddingBottom: 10 }}>来源资产手续费会一并消耗持仓批次。</div>
            </div>
            {method === 'manual' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {sellLots.map((lot) => <label key={lot.id} style={lotChip(selectedLotIds.includes(lot.id))}><input type="checkbox" checked={selectedLotIds.includes(lot.id)} onChange={() => toggleLot(lot.id)} />{lot.acquiredDate} · 剩 {fmtAmount(lot.remainingAmount, 8)}</label>)}
                {sellLots.length === 0 && <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>暂无可用批次</span>}
              </div>
            )}
          </div>
        )}

        {drafts.map((step, stepIndex) => {
          const calculated = preview[stepIndex];
          const normalized = calculated ? normalizeDraft(step) : null;
          const previous = stepIndex > 0 && preview[stepIndex - 1] ? normalizeDraft(drafts[stepIndex - 1]!) : null;
          const gap = previous && normalized ? conversionGap(previous, normalized, code(previous.toAssetId)) : null;
          return (
            <div key={stepIndex} data-conversion-step={stepIndex} className="zc-conversion-step">
              <div className="zc-conversion-step-heading">
                <b style={{ fontSize: 'var(--fs-body)' }}>步骤 {stepIndex + 1}</b>
                {drafts.length > 1 && <button onClick={() => setSteps(drafts.filter((_, index) => index !== stepIndex))} style={dangerLink}>删除步骤</button>}
              </div>
              <div style={{ padding: 14 }}>
                {errorField?.stepIndex === stepIndex && <p role="alert" style={{ color: 'var(--negative)' }}>{errorField.message}</p>}
                <div className="zc-conversion-step-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
                  <Field label="来源资产">{assetSelect('来源资产', step.fromAssetId, (value) => update(stepIndex, { fromAssetId: value }))}</Field>
                  <Field label="来源数量">
                    <input aria-label="来源数量" className="zc-input" inputMode="decimal" value={step.fromInput} onChange={(event) => update(stepIndex, { fromInput: event.target.value })} />
                    <select aria-label="来源数量口径" className="zc-select" value={step.sourceAmountMode} onChange={(event) => update(stepIndex, { sourceAmountMode: event.target.value as ConversionSourceAmountMode })} style={subSelect}>
                      <option value="trade_principal">成交本金 · 手续费另付</option>
                      <option value="account_debit">账户实扣 · 已包含来源费</option>
                    </select>
                  </Field>
                  <Field label="目标资产">{assetSelect('目标资产', step.toAssetId, (value) => update(stepIndex, { toAssetId: value }), true)}</Field>
                  <Field label="目标数量">
                    <input aria-label="目标数量" className="zc-input" inputMode="decimal" value={step.toInput} onChange={(event) => update(stepIndex, { toInput: event.target.value })} />
                    <select aria-label="目标数量口径" className="zc-select" value={step.targetAmountMode} onChange={(event) => update(stepIndex, { targetAmountMode: event.target.value as ConversionTargetAmountMode })} style={subSelect}>
                      <option value="account_credit">实际到账 · 已扣目标费</option>
                      <option value="trade_gross">成交毛额 · 尚未扣目标费</option>
                    </select>
                  </Field>
                  {usesAccounts && <Field label="来源账户">{accountSelect('来源账户', step.accountFromId, (value) => update(stepIndex, { accountFromId: value }), step.fromAssetId)}</Field>}
                  {usesAccounts && <Field label="目标账户">{accountSelect('目标账户', step.accountToId, (value) => update(stepIndex, { accountToId: value }), step.toAssetId)}</Field>}
                </div>
                <details open={!!step.referenceRate || !!step.platform || !!step.note} style={{ marginTop: 12 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>参考汇率、平台与备注（可选）</summary>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 8 }}>
                  <Field label="市场参考汇率（可选）">
                    <input aria-label="市场参考汇率" className="zc-input" inputMode="decimal" value={step.referenceRate} onChange={(event) => update(stepIndex, { referenceRate: event.target.value })} placeholder={`1 ${code(step.fromAssetId)} = ? ${code(step.toAssetId)}`} />
                  </Field>
                  <Field label="平台（可选）"><input aria-label="平台" className="zc-input" value={step.platform} onChange={(event) => update(stepIndex, { platform: event.target.value })} /></Field>
                  <Field label="备注（可选）"><input aria-label="步骤备注" className="zc-input" value={step.note} onChange={(event) => update(stepIndex, { note: event.target.value })} /></Field>
                  </div>
                </details>
                {gap && <div role="status" style={{ marginTop: 10, color: 'var(--warning)', fontSize: 'var(--fs-caption)' }}>{grouped ? '与上一步的净到账不一致，请核对资产、账户，并明确保留或补入数量。' : gap}</div>}
                {grouped && stepIndex > 0 && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
                  <Field label="保留上一步余额"><input aria-label="保留余额" className="zc-input" inputMode="decimal" value={step.retainedBefore ?? ''} onChange={(event) => update(stepIndex, { retainedBefore: event.target.value, supplementalBefore: '0' })} /></Field>
                  <Field label="额外补入数量"><input aria-label="补入数量" className="zc-input" inputMode="decimal" value={step.supplementalBefore ?? ''} onChange={(event) => update(stepIndex, { supplementalBefore: event.target.value, retainedBefore: '0' })} /></Field>
                  {!!step.supplementalBefore && step.supplementalBefore !== '0' && <Field label="补入资金所在账户">{accountSelect('补入资金所在账户', step.supplementalAccountId ?? '', (value) => update(stepIndex, { supplementalAccountId: value }))}</Field>}
                  <button type="button" style={smallButton} onClick={() => {
                    const available = D(preview[stepIndex - 1]?.targetCredit ?? '0').minus(step.retainedBefore || 0).plus(step.supplementalBefore || 0);
                    const fees = step.fees.filter((fee) => fee.side === 'source').reduce((total, fee) => total.plus(fee.amount || 0), D(0));
                    update(stepIndex, { fromAssetId: drafts[stepIndex - 1]!.toAssetId, accountFromId: drafts[stepIndex - 1]!.accountToId,
                      fromInput: available.minus(step.sourceAmountMode === 'trade_principal' ? fees : 0).toString() });
                  }}>按上一步净到账更新来源</button>
                </div>}

                <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: step.fees.length ? 8 : 0 }}>
                    <b style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>手续费</b>
                    <button onClick={() => addFee(stepIndex)} style={smallButton}>+ 添加手续费</button>
                  </div>
                  {step.fees.map((fee) => {
                    const forcedAsset = fee.side === 'source' ? step.fromAssetId : fee.side === 'target' ? step.toAssetId : fee.assetId;
                    const suggestion = suggestFeeValue(normalized, forcedAsset, fee.amount, effectiveBookCurrencyId, snap.priceMarks, date);
                    return (
                      <div className="zc-conversion-fee-grid" key={fee.id} data-fee-id={fee.id} style={{ display: 'grid', gridTemplateColumns: '170px 1fr 1fr 1fr 32px', gap: 8, alignItems: 'end', marginTop: 8 }}>
                        <Field label="扣费位置"><select aria-label="扣费位置" className="zc-select" value={fee.side} onChange={(event) => updateFee(stepIndex, fee.id, { side: event.target.value as FeeSide })}><option value="source">来源资产</option><option value="target">目标资产扣除</option><option value="third">第三资产另付</option></select></Field>
                        <Field label="手续费资产">{assetSelect('手续费资产', forcedAsset, (value) => updateFee(stepIndex, fee.id, { assetId: value }), true, fee.side !== 'third')}</Field>
                        <Field label="手续费数量"><input aria-label="手续费数量" className="zc-input" inputMode="decimal" value={fee.amount} onChange={(event) => updateFee(stepIndex, fee.id, { amount: event.target.value })} /></Field>
                        <Field label={`折算 ${code(effectiveBookCurrencyId)}`}>{forcedAsset === effectiveBookCurrencyId ? <div>直接采用手续费数量 {fee.amount || '—'}</div> : <input aria-label="手续费折算" className="zc-input" inputMode="decimal" value={fee.valueInBase} onChange={(event) => updateFee(stepIndex, fee.id, { valueInBase: event.target.value })} placeholder="填写、采用建议值或保留未知" />}
                          {forcedAsset !== effectiveBookCurrencyId && fee.valueInBase && fee.confirmedFingerprint !== valueFingerprint && <div role="alert">条件已变化，请重新确认。<button type="button" style={smallButton} onClick={() => updateFee(stepIndex, fee.id, { valueInBase: fee.valueInBase })}>确认原折算值</button><button type="button" style={smallButton} onClick={() => updateFee(stepIndex, fee.id, { valueInBase: '' })}>清除折算值</button></div>}
                          {forcedAsset !== effectiveBookCurrencyId && (suggestion ? <button type="button" style={smallButton} title={suggestion.basis} onClick={() => updateFee(stepIndex, fee.id, { valueInBase: suggestion.value, valueEvidence: { source: suggestion.priceMarkIds?.length ? 'price_mark' : 'transaction', priceMarkIds: suggestion.priceMarkIds ?? [], quoteDate: suggestion.quoteDate, explanation: suggestion.basis } })}>采用折算值 {significant(suggestion.value)} · {suggestion.basis}</button> : <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>暂无可用汇率，请填写实际折算价值。</span>)}
                        </Field>
                        <button aria-label="删除手续费" title="删除手续费" onClick={() => update(stepIndex, { fees: step.fees.filter((row) => row.id !== fee.id) })} style={{ ...iconButton, color: 'var(--negative)', marginBottom: 2 }}>×</button>
                        {fee.side === 'third' && <Field label="手续费扣款账户">{accountSelect('手续费扣款账户', fee.accountId, (value) => updateFee(stepIndex, fee.id, { accountId: value }), fee.assetId)}</Field>}
                        <Field label="手续费备注（可选）"><input aria-label="手续费备注" className="zc-input" value={fee.note} onChange={(event) => updateFee(stepIndex, fee.id, { note: event.target.value })} /></Field>
                      </div>
                    );
                  })}
                </div>

                {snap.costState && <details style={{ marginTop: 12 }}>
                  <summary>本步成交价值与依据（可选）</summary>
                  <Field label={`本步成交价值 · ${code(effectiveBookCurrencyId)}`}><input aria-label="本步成交价值" className="zc-input" inputMode="decimal"
                    value={step.costValue?.valueInBase ?? ''} onChange={(event) => update(stepIndex, { costValue: { valueInBase: event.target.value || null, source: event.target.value ? 'manual' : 'unknown', priceMarkIds: [], explanation: '用户确认本步成交价值' }, costValueFingerprint: valueFingerprint })} /></Field>
                  {stepIndex === drafts.length - 1 && bookValueInBase && <p>已填写整笔账面价值，本步采用 {significant(bookValueInBase)} {code(effectiveBookCurrencyId)}。如需使用此处价值，请先清除整笔账面价值。</p>}
                  {step.costValue?.valueInBase && step.costValueFingerprint !== valueFingerprint && <p role="alert">条件已变化，请重新确认。
                    <button type="button" style={smallButton} onClick={() => update(stepIndex, { costValue: { ...step.costValue!, source: 'manual', priceMarkIds: [], quoteDate: undefined, explanation: '条件变化后用户重新确认' }, costValueFingerprint: valueFingerprint })}>确认本步价值</button>
                    <button type="button" style={smallButton} onClick={() => update(stepIndex, { costValue: { valueInBase: null, source: 'unknown', priceMarkIds: [] }, costValueFingerprint: valueFingerprint })}>清除本步价值</button></p>}
                  {(() => {
                    const suggestion = normalized && (suggestFeeValue(null, normalized.fromAssetId, normalized.fromAmount, effectiveBookCurrencyId, snap.priceMarks, date)
                      ?? suggestFeeValue(null, normalized.toAssetId, normalized.toAmount, effectiveBookCurrencyId, snap.priceMarks, date));
                    return suggestion ? <button type="button" style={smallButton} title={suggestion.value} onClick={() => update(stepIndex, { costValue: { valueInBase: suggestion.value,
                      source: suggestion.priceMarkIds?.length ? 'price_mark' : 'transaction', priceMarkIds: suggestion.priceMarkIds ?? [], quoteDate: suggestion.quoteDate, explanation: suggestion.basis }, costValueFingerprint: valueFingerprint })}>采用本步价值 {significant(suggestion.value)} · {suggestion.basis}</button> : <p>没有可靠行情时可保留未知。</p>;
                  })()}
                  {step.costValue?.explanation && <p>{step.costValue.explanation}</p>}
                </details>}

                {calculated && normalized && (
                  <div style={{ marginTop: 14 }}>
                    <div className="zc-conversion-amounts-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1, background: 'var(--border)' }}>
                      <Metric label="账户实扣" value={`${quantity(step.fromAssetId, calculated.sourceDebit)} ${code(step.fromAssetId)}`} strong />
                      <Metric label="实际到账" value={`${quantity(step.toAssetId, calculated.targetCredit)} ${code(step.toAssetId)}`} strong />
                    </div>
                    <div style={{ padding: '10px 0', fontSize: 'var(--fs-caption)', overflowWrap: 'anywhere' }}>{conversionRateText(normalized, code(step.fromAssetId), code(step.toAssetId))}</div>
                    <details style={{ fontSize: 'var(--fs-caption)' }}><summary style={{ cursor: 'pointer' }}>成交口径与完整汇率</summary>
                      <div>成交本金 {quantity(step.fromAssetId, calculated.sourcePrincipal)} {code(step.fromAssetId)} · 成交毛额 {quantity(step.toAssetId, calculated.targetGross)} {code(step.toAssetId)}</div>
                      <div style={{ overflowWrap: 'anywhere', userSelect: 'text' }}>{conversionRateText(normalized, code(step.fromAssetId), code(step.toAssetId), true)}</div>
                    </details>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <button onClick={() => {
          const previous = drafts.at(-1)!;
          const next = emptyStep(effectiveBookCurrencyId, previous.toAssetId || effectiveBookCurrencyId);
          next.accountFromId = previous.accountToId;
          try { next.fromInput = conversionStepAmounts(normalizeDraft(previous)).targetCredit; } catch { next.fromInput = ''; }
          setSteps([...drafts, next]);
        }} style={{ ...smallButton, width: '100%', padding: 10, borderStyle: 'dashed', marginBottom: 16 }}>+ 添加转换步骤</button>
        {/*
         * The refusal lives inside the sticky footer on purpose. This form is taller
         * than the panel on a phone, and the save button is pinned to the bottom, so
         * an error rendered at the end of the content sat ~750px below the fold: the
         * tap looked like it did nothing at all. Anchored to the footer it is visible
         * wherever the panel happens to be scrolled.
         */}
        <div className="zc-modal-footer" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
          {err && (
            <div role="alert" style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', lineHeight: 1.6 }}>{err}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={requestClose} disabled={saving} style={secondaryButton}>取消</button>
            <button onClick={() => void save()} disabled={saving || completed.current} style={{ ...primaryButton, opacity: saving ? 0.6 : 1 }}>{saving ? '处理中…' : initial ? '预览影响' : '保存转换'}</button>
          </div>
        </div>
      {(draftState.error || draftState.status) && <div role={draftState.error ? 'alert' : 'status'}>{draftState.error || draftState.status}</div>}
      {draftState.pending && <ConfirmDialog title="发现未完成的转换草稿" confirmLabel="继续草稿" cancelLabel="新建" onConfirm={draftState.resume}
        onCancel={() => void draftState.discard().catch((cause: unknown) => setErr(String(cause)))}>
        草稿保存在本机，保存时间：{draftState.pending.savedAt}。{draftState.pending.entityVersion !== initial?.chain.version && '原记录版本已变化，恢复后需核对差异。'}
      </ConfirmDialog>}
      {draftState.conflict && <ConfirmDialog title="原记录已更新，请核对草稿" confirmLabel="已核对，继续编辑" cancelLabel="保留草稿并返回" onConfirm={draftState.confirmConflict} onCancel={onClose}>
        草稿没有被删除。请核对当前记录与草稿后再继续；正式保存仍会检查记录版本。
        <details><summary>当前记录</summary><p>{initial?.chain.title || '无标题'} · {initial?.chain.date} {initial?.chain.time}</p>{initial?.steps.map((step, index) => <p key={step.id}>步骤 {index + 1}：{step.fromAmount} {code(step.fromAssetId)} → {step.toAmount} {code(step.toAssetId)}{step.platform ? ` · ${step.platform}` : ''}{step.note ? ` · ${step.note}` : ''}</p>)}</details>
        <details><summary>恢复的草稿</summary><p>{title || '无标题'} · {date} {time}</p>{steps.map((step, index) => <p key={step.id}>步骤 {index + 1}：{step.fromInput} {code(step.fromAssetId)} → {step.toInput} {code(step.toAssetId)}{step.platform ? ` · ${step.platform}` : ''}{step.note ? ` · ${step.note}` : ''}</p>)}</details>
      </ConfirmDialog>}
      {closeRequested && <ConfirmDialog title="保留未完成的转换？" confirmLabel="保留草稿并关闭" cancelLabel="继续填写"
        onCancel={() => setCloseRequested(false)} onConfirm={async () => { await draftState.keep(); onClose(); }}>
        草稿会加密保存在当前账号、当前账本的本机存储中。
        <button type="button" style={{ ...dangerLink, display: 'block', marginTop: 12 }} onClick={() => void draftState.finish().then(onClose).catch((cause: unknown) => setErr(String(cause)))}>放弃草稿并关闭</button>
      </ConfirmDialog>}
      {pending && (
        <ConfirmDialog
          title="确认重算资产成本"
          confirmLabel="确认保存"
          cancelLabel="返回修改"
          tone="danger"
          busy={saving}
          onCancel={() => setPending(null)}
          onConfirm={() => persist(pending)}
        >
          {impactText} 若后续卖出不再有足够的历史持仓，保存会被整体拒绝，不会留下半套数据。
        </ConfirmDialog>
      )}
      {operationPreview && <ConfirmDialog title={operationPreview.input.standalone ? '资产转换保存前预览' : '连续转换整组预览'} confirmLabel={operationPreview.errors.length ? '返回修改' : '确认保存'} cancelLabel="返回修改"
        busy={saving} onCancel={() => setOperationPreview(null)} onConfirm={operationPreview.errors.length ? () => setOperationPreview(null) : persistOperation}>
        <div className="zc-conversion-preview">
        {operationPreview.errors.map((row, index) => <p role="alert" key={index}>{row.message}</p>)}
        {operationPreview.warnings.map((row, index) => <p key={index}>{row.message}</p>)}
        <section><h3>各资产净变化</h3>
        {operationPreview.assetChanges.map((row) => <p key={row.assetId}>{code(row.assetId)}：{significant(row.delta)}</p>)}
        </section>
        <section><h3>手续费 <small>已计入扣款和净到账</small></h3>
        {operationPreview.input.conversions.every((row) => row.steps.every((step) => !step.fees?.length)) && <p>无手续费</p>}
        {operationPreview.input.conversions.flatMap((row) => row.steps).flatMap((step) => step.fees ?? []).map((fee) => <p key={fee.id}>{significant(fee.amount)} {code(fee.assetId)} · {fee.treatment === 'third_asset_extra' ? '第三资产费用' : fee.treatment === 'target_deducted' ? '目标扣除' : '来源费用'}</p>)}
        </section>
        <section><h3>成本、保留余额与盈亏</h3>
        {operationPreview.assetChanges.map(({ assetId }) => {
          const before = operationPreview.beforeCost?.positions.find((row) => row.assetId === assetId);
          const after = operationPreview.afterCost?.positions.find((row) => row.assetId === assetId);
          if (!after) return null;
          const cost = (row: typeof after | undefined) => !row ? '无成本状态' : row.costInBase === null ? `未完整核算（已知 ${significant(row.knownCostInBase)}）` : significant(row.costInBase);
          return <p key={`cost-${assetId}`}>{code(assetId)} 持仓成本：{cost(before)} → {cost(after)} {code(operationPreview.afterCost!.baseCurrencyAssetId)}{after.costStatus !== 'known' ? `；未知数量 ${significant(after.unknownQuantity)}，数量缺口 ${significant(after.deficitQuantity)}` : ''}</p>;
        })}
        {operationPreview.retained.map((row, index) => <p key={index}>保留 {significant(row.quantity)} {code(row.assetId)}</p>)}
        {operationPreview.afterCost?.events.filter((row) => operationPreview.input.operation.chainIds.includes(row.sourceId) && row.realize).map((row) => <p key={row.eventId}>{code(row.assetId)} {row.eventId.includes(':1-fee:') ? '第三资产手续费处置盈亏' : '已实现盈亏'}：{row.realizedGainLoss === null ? '未完整核算' : `${significant(row.realizedGainLoss)} ${code(effectiveBookCurrencyId)}`}</p>)}
        </section>
        <section><h3>各账户当前余额变化</h3>
        {operationPreview.accountChanges.map((row, index) => <p key={index}>{snap.accounts.find((account) => account.id === row.accountId)?.name ?? '未分配账户'} · {code(row.assetId)}：{significant(row.before)} → {significant(row.after)}</p>)}
        </section>
        <section><h3>发生时余额 <small>按步骤执行顺序</small></h3>
        {operationPreview.historicalBalances.map((row, index) => <p key={index}>{snap.accounts.find((account) => account.id === row.accountId)?.name ?? '未分配账户'} · {code(row.assetId)}：{significant(row.before)} → {significant(row.after)}</p>)}
        </section>
        </div>
      </ConfirmDialog>}
      </div>
    </DialogShell>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><label className="zc-label">{label}</label>{children}</div>;
}

function Metric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div style={{ background: 'var(--surface)', padding: '9px 10px', minWidth: 0 }}><div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{label}</div><div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-medium)', color: strong ? 'var(--accent)' : 'var(--fg)', marginTop: 3, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{value}</div></div>;
}

const iconButton = iconBtn;
const smallButton = btnSmall;
const dangerLink = linkDanger;
const secondaryButton = btnOutline;
const primaryButton = btnPrimary;
const subSelect = { marginTop: 5, height: 30, paddingTop: 3, paddingBottom: 3, fontSize: 'var(--fs-caption)' } as const;
const lotChip = (active: boolean) => ({ display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px solid var(--border)', background: active ? 'var(--accent-soft)' : 'var(--surface)', color: active ? 'var(--accent)' : 'var(--fg-muted)', padding: '6px 9px', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', cursor: 'pointer' } as const);
