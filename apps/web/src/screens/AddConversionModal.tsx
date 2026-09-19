import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  D,
  conversionStepAmounts,
  localToday,
  newId,
  normalizeConversionAmounts,
  type ConversionChain,
  type ConversionFee,
  type ConversionFeeTreatment,
  type ConversionSourceAmountMode,
  type ConversionStep,
  type ConversionTargetAmountMode,
  type ConversionType,
  type ChainWithSteps,
  type LotMethod,
} from '@zichan/core';
import { previewConversionImpact, saveConversionAggregate, updateConversion, voidConversion } from '@zichan/db';
import { useStore } from '../db/store.js';
import { useSnapshot } from '../db/snapshot.js';
import { amount as fmtAmount } from '../format.js';
import { moduleCurrencyId } from '../currencyPreferences.js';
import { useUndo } from '../ui/UndoToast.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DialogShell } from '../ui/DialogShell.js';
import { buildDcaConversionPreset } from '../dca-conversion-preset.js';
import {
  activeAssetByCode,
  ASSET_PRESETS,
  ensureAssetPreset,
  type AssetPresetCode,
} from '../assetPresets.js';
import { btnOutline, btnPrimary, btnSmall, iconBtn, linkDanger } from '../ui/styles.js';

type FeeSide = 'source' | 'target' | 'third';

interface FeeDraft {
  id: string;
  side: FeeSide;
  assetId: string;
  amount: string;
  valueInBase: string;
  accountId: string;
  note: string;
}

interface StepDraft {
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
    fees: (step.fees ?? []).map((fee) => ({
      id: fee.id,
      side: feeSide(fee),
      assetId: fee.assetId,
      amount: fee.amount,
      valueInBase: fee.valueInBase ?? '',
      accountId: fee.accountId ?? '',
      note: fee.note ?? '',
    })),
  };
}

interface PreparedConversion {
  chain: ConversionChain;
  steps: ConversionStep[];
}

export function AddConversionModal({
  onClose,
  initial,
  preset,
  assetPresetCode,
}: {
  onClose: () => void;
  initial?: ChainWithSteps;
  preset?: { dcaPlanId: string };
  assetPresetCode?: AssetPresetCode;
}) {
  const titleId = useId();
  const { store, bump } = useStore();
  const undo = useUndo(store, bump);
  const snap = useSnapshot('convert');
  const [date, setDate] = useState(() => initial?.chain.date ?? todayDate());
  const [time, setTime] = useState(() => initial?.chain.time ?? new Date().toTimeString().slice(0, 5));
  const [timezone] = useState(() => initial?.chain.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? '系统默认');
  const [type, setType] = useState<ConversionType>(() => initial?.chain.type ?? 'dca');
  const [title, setTitle] = useState(() => initial?.chain.title ?? '');
  const [method, setMethod] = useState<LotMethod>(() => initial?.chain.lotMethod ?? 'fifo');
  const [dcaPlanId, setDcaPlanId] = useState('');
  const [selectedLotIds, setSelectedLotIds] = useState<string[]>(() => initial?.chain.manualLotIds ?? []);
  const [bookCurrencyId, setBookCurrencyId] = useState(() => initial?.chain.baseCurrencyAssetId ?? '');
  const [bookValueInBase, setBookValueInBase] = useState(() => initial?.chain.bookValueInBase ?? '');
  const [steps, setSteps] = useState<StepDraft[]>(() => initial?.steps.map(draftFromStep) ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<PreparedConversion | null>(null);
  const [impactText, setImpactText] = useState('');
  const [presetNotice, setPresetNotice] = useState('');
  const [createdAssets, setCreatedAssets] = useState<import('@zichan/core').Asset[]>([]);
  const [creatingAssetCode, setCreatingAssetCode] = useState<AssetPresetCode | null>(null);
  const presetApplied = useRef(false);
  const assetPresetApplied = useRef(false);

  const defaultBookCurrencyId = snap
    ? moduleCurrencyId(snap.setting, 'investment', snap.assets[0]?.id ?? '')
    : '';
  const effectiveBookCurrencyId = bookCurrencyId || defaultBookCurrencyId;
  const drafts = useMemo(
    () => steps.length ? steps : [emptyStep(effectiveBookCurrencyId)],
    [effectiveBookCurrencyId, steps],
  );
  const applyAssetPreset = useCallback(async (code: AssetPresetCode, stepIndex = 0) => {
    setCreatingAssetCode(code);
    setErr(null);
    try {
      const result = await ensureAssetPreset(store, code);
      setCreatedAssets((current) => current.some((asset) => asset.id === result.asset.id)
        ? current
        : [...current, result.asset]);
      setType(result.asset.type === 'fiat' ? 'exchange' : 'buy');
      setSteps((current) => {
        const currentDrafts = current.length ? current : [emptyStep(effectiveBookCurrencyId)];
        return currentDrafts.map((step, index) => index === stepIndex
          ? { ...step, toAssetId: result.asset.id }
          : step);
      });
      setPresetNotice(result.change === 'created'
        ? `已添加 ${result.asset.code} 资产定义；未生成余额或转换记录，请继续填写实际数量。`
        : `已选择 ${result.asset.code}；请继续填写实际来源和到账数量。`);
      if (result.change !== 'existing') bump();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingAssetCode(null);
    }
  }, [bump, effectiveBookCurrencyId, store]);
  const usesAccounts = true;
  const existingDcaExecution = initial && snap
    ? snap.dcaExecutions.find((execution) => !execution.isDeleted && execution.chainId === initial.chain.id)
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

  if (!snap) return null;
  const assets = [
    ...snap.assets,
    ...createdAssets.filter((created) => !snap.assets.some((asset) => asset.id === created.id)),
  ].filter((asset) => !asset.isDeleted && asset.isActive && !asset.mergedIntoId);
  const activePlans = snap.dcaPlans.filter((plan) => plan.status === 'active' || plan.id === existingDcaExecution?.planId);
  const code = (id: string) => assets.find((asset) => asset.id === id)?.code ?? '—';
  const update = (index: number, patch: Partial<StepDraft>) => {
    const next = drafts.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step);
    setSteps(next);
  };
  const updateFee = (stepIndex: number, feeId: string, patch: Partial<FeeDraft>) => {
    const step = drafts[stepIndex]!;
    update(stepIndex, { fees: step.fees.map((fee) => fee.id === feeId ? { ...fee, ...patch } : fee) });
  };
  const addFee = (stepIndex: number) => {
    const step = drafts[stepIndex]!;
    update(stepIndex, { fees: [...step.fees, { id: newId(), side: 'source', assetId: step.fromAssetId, amount: '', valueInBase: '', accountId: '', note: '' }] });
  };

  const currentConsumedLotIds = new Set(initial
    ? snap.lotConsumptions.filter((row) => !row.isDeleted && row.sellChainId === initial.chain.id).map((row) => row.lotId)
    : []);
  const sellLots = snap.lots
    .filter((lot) => lot.assetId === drafts[0]?.fromAssetId && !lot.isDeleted && (D(lot.remainingAmount).gt(0) || currentConsumedLotIds.has(lot.id)))
    .sort((a, b) => a.acquiredDate.localeCompare(b.acquiredDate));
  const toggleLot = (id: string) => setSelectedLotIds((ids) => ids.includes(id) ? ids.filter((row) => row !== id) : [...ids, id]);

  function prepare(): PreparedConversion {
    if (!effectiveBookCurrencyId) throw new Error('请选择投资成本记账币种');
    if (bookValueInBase && D(bookValueInBase).lte(0)) throw new Error('账面折算金额必须大于 0');
    const built = drafts.map((draft, index) => {
      if (!draft.fromAssetId || !draft.toAssetId) throw new Error(`步骤 ${index + 1} 需要选择来源和目标资产`);
      const sameAssetAccountMove = (type === 'deposit' || type === 'withdraw')
        && draft.fromAssetId === draft.toAssetId
        && !!draft.accountFromId
        && !!draft.accountToId
        && draft.accountFromId !== draft.accountToId;
      if (draft.fromAssetId === draft.toAssetId && !sameAssetAccountMove) throw new Error(`步骤 ${index + 1} 的来源和目标资产不能相同；同币种入金或提现需选择两个不同账户`);
      if (D(draft.fromInput || 0).lte(0) || D(draft.toInput || 0).lte(0)) throw new Error(`步骤 ${index + 1} 的来源和目标数量必须大于 0`);
      if (draft.referenceRate && D(draft.referenceRate).lte(0)) throw new Error(`步骤 ${index + 1} 的参考汇率必须大于 0`);
      for (const fee of draft.fees) {
        if (D(fee.amount || 0).lte(0)) throw new Error(`步骤 ${index + 1} 的手续费必须大于 0`);
        const assetId = fee.side === 'source' ? draft.fromAssetId : fee.side === 'target' ? draft.toAssetId : fee.assetId;
        if (!assetId) throw new Error(`步骤 ${index + 1} 的第三资产手续费需要选择资产`);
        if (fee.side === 'third' && (assetId === draft.fromAssetId || assetId === draft.toAssetId)) throw new Error(`步骤 ${index + 1} 的“第三资产另付”不能选择来源或目标资产`);
        if (assetId !== effectiveBookCurrencyId && !fee.valueInBase) throw new Error(`步骤 ${index + 1} 的非记账币种手续费需要填写折算价值`);
        if (fee.valueInBase && D(fee.valueInBase).lt(0)) throw new Error(`步骤 ${index + 1} 的手续费折算不能为负数`);
      }
      return normalizeDraft(draft, '', index + 1);
    });
    if (type === 'sell' && sellLots.length === 0) throw new Error('该资产没有可卖批次，请先确认来源资产和已有买入记录');
    if (type === 'sell' && method === 'manual' && selectedLotIds.length === 0) throw new Error('手动匹配需要至少选择一个批次');

    const now = new Date().toISOString();
    const chainId = initial?.chain.id ?? newId();
    const chain: ConversionChain = {
      ...initial?.chain,
      id: chainId,
      date,
      time,
      timezone,
      type,
      title: title || undefined,
      baseCurrencyAssetId: effectiveBookCurrencyId,
      bookValueInBase: bookValueInBase || undefined,
      lotMethod: type === 'sell' ? method : undefined,
      manualLotIds: type === 'sell' && method === 'manual' ? selectedLotIds : undefined,
      recordState: 'active',
      voidedAt: undefined,
      voidReason: undefined,
      createdAt: initial?.chain.createdAt ?? now,
      updatedAt: initial?.chain.updatedAt ?? now,
      version: initial?.chain.version ?? 1,
      isDeleted: false,
    };
    for (const step of built) step.chainId = chain.id;
    return { chain, steps: built };
  }

  async function persist(prepared: PreparedConversion) {
    if (!snap) return;
    setSaving(true);
    setErr(null);
    try {
      const result = await saveConversionAggregate(store, {
        ...prepared,
        editing: !!initial,
        expectedVersion: initial?.chain.version,
        dcaPlanId: dcaPlanId || undefined,
      });
      const savedChain = result.chain;
      bump();
      if (initial) {
        const before = initial;
        undo.offer('资产转换已更新', async () => {
          await store.runInAuditBatch('撤销资产转换更新', async (transactionStore) => {
            const current = await transactionStore.conversionChains.get(savedChain.id);
            if (!current || current.version !== savedChain.version) throw new Error('该转换后来又被修改，不能直接撤销');
            await updateConversion(transactionStore, {
              chain: { ...before.chain, version: current.version },
              steps: before.steps,
              expectedVersion: current.version,
            });
            const currentExecution = (await transactionStore.dcaExecutions.list({ includeDeleted: true })).find((row) => row.chainId === before.chain.id);
            if (existingDcaExecution) await transactionStore.dcaExecutions.put({
              ...existingDcaExecution,
              version: currentExecution?.version ?? existingDcaExecution.version,
              updatedAt: currentExecution?.updatedAt ?? existingDcaExecution.updatedAt,
              isDeleted: false,
            });
            else if (currentExecution && !currentExecution.isDeleted) await transactionStore.dcaExecutions.remove(currentExecution.id, currentExecution.version);
          });
          bump();
        });
      } else {
        undo.offer('资产转换已保存', async () => {
          await voidConversion(store, savedChain.id, '撤销刚才的新增');
          bump();
        });
      }
      onClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setSaving(false);
      setPending(null);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const prepared = prepare();
      if (initial) {
        const impact = await previewConversionImpact(store, prepared.chain);
        setImpactText(`将从 ${impact.fromDate} 起重算 ${impact.chains} 条转换、${impact.lots} 个持仓批次和 ${impact.consumptions} 条卖出匹配。`);
        setPending(prepared);
        setSaving(false);
        return;
      }
      await persist(prepared);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  }

  const assetSelect = (label: string, value: string, onChange: (value: string) => void, allowEmpty = false, disabled = false) => (
    <select aria-label={label} className="zc-select" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      {allowEmpty && <option value="">请选择</option>}
      {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.code} · {asset.name}</option>)}
    </select>
  );
  const accountSelect = (label: string, value: string, onChange: (value: string) => void) => (
    <select aria-label={label} className="zc-select" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">不指定账户</option>
      {snap.accounts.filter((account) => !account.isDeleted && !account.purpose?.startsWith('default_')).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
    </select>
  );

  return (
    <DialogShell
      labelledBy={titleId}
      onDismiss={onClose}
      dismissDisabled={saving}
      panelClassName="zc-conversion-modal"
      panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 24, width: 980, maxHeight: '92vh', overflow: 'auto' }}
    >
        <div className="zc-modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div id={titleId} style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>{initial ? '编辑资产转换' : '新增资产转换'}</div>
          <button type="button" data-dialog-initial-focus aria-label="关闭" title="关闭" onClick={onClose} disabled={saving} style={iconButton}>×</button>
        </div>

        <div className="zc-conversion-head-grid" style={{ display: 'grid', gridTemplateColumns: '140px 110px 130px minmax(180px, 1fr) 180px', gap: 12, marginBottom: 14 }}>
          <Field label="日期"><input aria-label="日期" className="zc-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
          <Field label="时间"><input aria-label="时间" className="zc-input" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></Field>
          <Field label="类型"><select aria-label="类型" className="zc-select" value={type} onChange={(event) => setType(event.target.value as ConversionType)}>{TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="标题（可选）"><input aria-label="标题" className="zc-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="USD → USDT → BTC" /></Field>
          <Field label="投资成本记账币种">{assetSelect('投资成本记账币种', effectiveBookCurrencyId, setBookCurrencyId)}</Field>
        </div>
        <div className="zc-conversion-secondary-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          <Field label="账面成本 / 收入折算（按需）">
            <input aria-label="账面价值折算" className="zc-input" inputMode="decimal" value={bookValueInBase} onChange={(event) => setBookValueInBase(event.target.value)} placeholder={`链路不含 ${code(effectiveBookCurrencyId)} 时填写`} />
          </Field>
          {type === 'dca' && activePlans.length > 0 ? (
            <Field label="关联定投计划">
              <select aria-label="关联定投计划" className="zc-select" value={dcaPlanId} onChange={(event) => setDcaPlanId(event.target.value)}>
                <option value="">不关联计划</option>
                {activePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
              </select>
            </Field>
          ) : <div />}
          <Field label="时区"><input aria-label="时区" className="zc-input" value={timezone} readOnly /></Field>
        </div>
        {presetNotice && <div style={{ color: presetNotice.includes('回退') ? 'var(--warning)' : 'var(--fg-muted)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', marginBottom: 14 }}>{presetNotice}</div>}

        {!initial && (
          <div style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)', marginBottom: 8 }}>常用目标资产</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {ASSET_PRESETS.map((row) => {
                const existing = activeAssetByCode(assets, row.code);
                const selected = !!existing && drafts.some((step) => step.toAssetId === existing.id);
                return (
                  <button
                    key={row.code}
                    type="button"
                    onClick={() => void applyAssetPreset(row.code)}
                    disabled={creatingAssetCode !== null}
                    aria-pressed={selected}
                    style={{
                      ...smallButton,
                      color: selected ? 'var(--accent)' : 'var(--fg-muted)',
                      background: selected ? 'var(--accent-soft)' : 'var(--surface)',
                      opacity: creatingAssetCode && creatingAssetCode !== row.code ? 0.55 : 1,
                    }}
                  >
                    {creatingAssetCode === row.code ? '添加中…' : `${row.code} · ${row.name}${existing ? ' · 已有' : ''}`}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: 8, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>选择后只会补充可选资产，不会自动生成持仓、余额或交易。</div>
          </div>
        )}

        {type === 'sell' && (
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
          return (
            <div key={stepIndex} style={{ border: '1px solid var(--border)', marginBottom: 14, background: 'var(--surface-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
                <b style={{ fontSize: 'var(--fs-body)' }}>步骤 {stepIndex + 1}</b>
                {drafts.length > 1 && <button onClick={() => setSteps(drafts.filter((_, index) => index !== stepIndex))} style={dangerLink}>删除步骤</button>}
              </div>
              <div style={{ padding: 14 }}>
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
                  {usesAccounts && <Field label="来源账户">{accountSelect('来源账户', step.accountFromId, (value) => update(stepIndex, { accountFromId: value }))}</Field>}
                  {usesAccounts && <Field label="目标账户">{accountSelect('目标账户', step.accountToId, (value) => update(stepIndex, { accountToId: value }))}</Field>}
                  <Field label="市场参考汇率">
                    <input aria-label="市场参考汇率" className="zc-input" inputMode="decimal" value={step.referenceRate} onChange={(event) => update(stepIndex, { referenceRate: event.target.value })} placeholder={`1 ${code(step.fromAssetId)} = ? ${code(step.toAssetId)}`} />
                  </Field>
                </div>

                <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: step.fees.length ? 8 : 0 }}>
                    <b style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>手续费</b>
                    <button onClick={() => addFee(stepIndex)} style={smallButton}>+ 添加手续费</button>
                  </div>
                  {step.fees.map((fee) => {
                    const forcedAsset = fee.side === 'source' ? step.fromAssetId : fee.side === 'target' ? step.toAssetId : fee.assetId;
                    return (
                      <div className="zc-conversion-fee-grid" key={fee.id} style={{ display: 'grid', gridTemplateColumns: '170px 1fr 1fr 1fr 32px', gap: 8, alignItems: 'end', marginTop: 8 }}>
                        <Field label="扣费位置"><select aria-label="扣费位置" className="zc-select" value={fee.side} onChange={(event) => updateFee(stepIndex, fee.id, { side: event.target.value as FeeSide })}><option value="source">来源资产</option><option value="target">目标资产扣除</option><option value="third">第三资产另付</option></select></Field>
                        <Field label="手续费资产">{assetSelect('手续费资产', forcedAsset, (value) => updateFee(stepIndex, fee.id, { assetId: value }), true, fee.side !== 'third')}</Field>
                        <Field label="手续费数量"><input aria-label="手续费数量" className="zc-input" inputMode="decimal" value={fee.amount} onChange={(event) => updateFee(stepIndex, fee.id, { amount: event.target.value })} /></Field>
                        <Field label={`折算 ${code(effectiveBookCurrencyId)}`}><input aria-label="手续费折算" className="zc-input" inputMode="decimal" value={fee.valueInBase} onChange={(event) => updateFee(stepIndex, fee.id, { valueInBase: event.target.value })} placeholder={forcedAsset === effectiveBookCurrencyId ? '自动等于手续费' : '必填'} /></Field>
                        <button aria-label="删除手续费" title="删除手续费" onClick={() => update(stepIndex, { fees: step.fees.filter((row) => row.id !== fee.id) })} style={{ ...iconButton, color: 'var(--negative)', marginBottom: 2 }}>×</button>
                      </div>
                    );
                  })}
                </div>

                {calculated && (
                  <div className="zc-conversion-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 1, background: 'var(--border)', border: '1px solid var(--border)', marginTop: 14 }}>
                    <Metric label="成交本金" value={`${fmtAmount(calculated.sourcePrincipal, 8)} ${code(step.fromAssetId)}`} />
                    <Metric label="账户实扣" value={`${fmtAmount(calculated.sourceDebit, 8)} ${code(step.fromAssetId)}`} strong />
                    <Metric label="成交毛额" value={`${fmtAmount(calculated.targetGross, 8)} ${code(step.toAssetId)}`} />
                    <Metric label="实际到账" value={`${fmtAmount(calculated.targetCredit, 8)} ${code(step.toAssetId)}`} strong />
                    <Metric label="成交汇率" value={fmtAmount(calculated.tradeRate ?? '0', 8)} />
                    <Metric label="有效汇率" value={fmtAmount(calculated.effectiveRate ?? '0', 8)} strong />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <button onClick={() => setSteps([...drafts, emptyStep(effectiveBookCurrencyId, drafts.at(-1)?.toAssetId || effectiveBookCurrencyId)])} style={{ ...smallButton, width: '100%', padding: 10, borderStyle: 'dashed', marginBottom: 16 }}>+ 添加转换步骤</button>
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
            <button onClick={onClose} disabled={saving} style={secondaryButton}>取消</button>
            <button onClick={() => void save()} disabled={saving} style={{ ...primaryButton, opacity: saving ? 0.6 : 1 }}>{saving ? '处理中…' : initial ? '预览影响' : '保存转换'}</button>
          </div>
        </div>
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
    </DialogShell>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><label className="zc-label">{label}</label>{children}</div>;
}

function Metric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div style={{ background: 'var(--surface)', padding: '9px 10px', minWidth: 0 }}><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{label}</div><div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: strong ? 'var(--accent)' : 'var(--fg)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div></div>;
}

const iconButton = iconBtn;
const smallButton = btnSmall;
const dangerLink = linkDanger;
const secondaryButton = btnOutline;
const primaryButton = btnPrimary;
const subSelect = { marginTop: 5, height: 30, paddingTop: 3, paddingBottom: 3, fontSize: 'var(--fs-meta)' } as const;
const lotChip = (active: boolean) => ({ display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px solid var(--border)', background: active ? 'var(--accent-soft)' : 'var(--surface)', color: active ? 'var(--accent)' : 'var(--fg-muted)', padding: '6px 9px', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', cursor: 'pointer' } as const);
