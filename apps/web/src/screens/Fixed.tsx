import { CardAlert } from '../ui/Card.js';
import { fixedOperatingCostForm, type FixedOperatingPreset } from '../fixed-operating-form.js';
import { withCashflowPayee } from '../payee-recording.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMobileSection } from '../ui/MobilePage.js';
import { FixedInventory } from '../ui/FixedInventory.js';
import { FixedLocationManager } from '../ui/FixedLocationManager.js';
import { FixedItemDetail, type FixedItemActions } from '../ui/FixedItemDetail.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { useScreenTarget } from '../screen-target.js';
import {
  isDateInRange,
  D, parseFixedWorkspace, FIXED_STATUS_LABELS,
  componentHostAt,
  localToday,
  newId,
  type Attachment,
  type FixedAsset,
  type FixedAssetCategory,
  type FixedAssetConsumable,
  type FixedAssetEvent,
  type FixedAssetGoal,
  type FixedAssetUsageLog,
  type FixedAssetUsageMetric,
} from '@zichan/core';
import {
  archiveFixedUsageMetric,
  archiveMasterData,
  cancelFixedAssetGoal,
  deleteFixedAssetConsumable,
  deleteFixedAssetEvent,
  deleteFixedUsageLog,
  restoreDeletedFixedAssetConsumable,
  restoreDeletedFixedAssetEvent,
  restoreDeletedFixedUsageLog,
  restoreArchivedMasterData,
  restoreFixedAssetGoalState,
  restoreFixedUsageMetricState,
  saveFixedAssetAcquisition,
  convertFixedUpgradeToComponent,
  saveFixedAssetConsumable,
  saveFixedAssetEvent,
  updateFixedWorkspace, completeFixedMaintenance,
  type FixedAssetCashflowDraft,
  type SqlLedgerStore,
} from '@zichan/db';
import { useSnapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { EntityFormModal } from '../ui/EntityFormModal.js';
import { ensureAttachmentBlobAvailable } from '../attachment-sync.js';
import {
  abortPreparedAttachments,
  commitPreparedAttachment,
  finalizePreparedAttachments,
  prepareAttachmentDraft,
  reconcileAttachmentStorage,
  readAttachmentBlob,
  type PreparedAttachment,
} from '../db/attachment-storage.js';
import {
  fixedAssetForm,
  fixedComponentPlacementForm,
  fixedUpgradeConversionForm,
  fixedConsumableForm,
  fixedEventForm,
  fixedGoalForm,
  fixedUsageLogForm,
  fixedUsageMetricForm,
  type FixedAssetConsumableFormValue,
  type FixedAssetEventFormValue,
  type FixedAssetFormValue,
} from '../forms.js';
import { buildFixed, type FixedCardVM, type FixedTimelineVM } from '../selectors/fixed.js';
import { ledgerAsOfDate } from '../as-of.js';
import { pillBtn } from '../ui/styles.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue, type TimelineViewMode } from '../ui/DateRangeBar.js';
import { TimelineExplorer } from '../ui/TimelineExplorer.js';
import { useUndo } from '../ui/UndoToast.js';
import {
  FIXED_ASSET_QUICK_PRESETS,
  fixedAssetPresetCategoryId,
} from '../assetPresets.js';

type ViewMode = 'overview' | TimelineViewMode;
type AssetModal = FixedAsset | 'new' | { kind: 'preset'; categoryId: string } | { kind: 'component'; hostId: string; bundled: boolean } | { kind: 'transaction'; transactionId: string } | null;
type EventModal = { assetId: string; event?: FixedAssetEvent; placement?: boolean; type?: FixedAssetEvent['type'] } | null;
type MetricModal = { assetId: string; metric?: FixedAssetUsageMetric } | null;
type UsageModal = { metric: FixedAssetUsageMetric; log?: FixedAssetUsageLog } | null;
type ConsumableModal = { assetId: string; item?: FixedAssetConsumable } | null;
type GoalModal = { assetId: string; goal?: FixedAssetGoal } | null;

const todayDate = localToday;

function cashflowDraft(value: {
  cashflowMode?: FixedAssetCashflowDraft['mode'];
  cashflowTransactionId?: string;
  cashflowSourceAmount?: string;
  cashflowCategory?: string;
  cashflowAccountId?: string;
  cashflowPayeeId?: string;
  cashflowMerchant?: string;
  cashflowDescription?: string;
  cashflowReportingTreatment?: 'ordinary' | 'balance_only';
}, fallbackAmount: string): FixedAssetCashflowDraft {
  const mode = value.cashflowMode ?? 'record_only';
  return {
    mode,
    linkedTransactionId: value.cashflowTransactionId,
    sourceAmount: value.cashflowSourceAmount || fallbackAmount,
    createTransaction: mode === 'create_transaction' ? {
      categoryId: value.cashflowCategory ?? '',
      accountId: value.cashflowAccountId,
      payeeId: value.cashflowPayeeId,
      merchant: value.cashflowMerchant,
      description: value.cashflowDescription,
      reportingTreatment: value.cashflowReportingTreatment,
    } : undefined,
  };
}

export function Fixed({ navigationKey = 'fixed' }: { navigationKey?: string } = {}) {
  const [mobileView, openMobile, backMobile] = useMobileSection(navigationKey);
  const snap = useSnapshot('fixed');
  const { store, bump } = useStore();
  const undo = useUndo(store, bump);
  const [view, setView] = useState<ViewMode>('overview');
  const [fromExpense, setFromExpense] = useState(false);
  const [maintenance, setMaintenance] = useState<FixedCardVM | null>(null);
  const [notice, setNotice] = useState('');
  const [initialAttention, setInitialAttention] = useState(false);
  const target = useScreenTarget('fixed');
  const handledTarget = useRef<typeof target>(null);
  const [assetModal, setAssetModal] = useState<AssetModal>(null);
  const [eventModal, setEventModal] = useState<EventModal>(null);
  const [operatingModal, setOperatingModal] = useState<({ assetId: string; event?: FixedAssetEvent } & FixedOperatingPreset) | null>(null);
  const [upgradeConversion, setUpgradeConversion] = useState<{ host: FixedAsset; event: FixedAssetEvent } | null>(null);
  const [metricModal, setMetricModal] = useState<MetricModal>(null);
  const [usageModal, setUsageModal] = useState<UsageModal>(null);
  const [consumableModal, setConsumableModal] = useState<ConsumableModal>(null);
  const [goalModal, setGoalModal] = useState<GoalModal>(null);
  const [focusDate, setFocusDate] = useState(todayDate);
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const vm = useMemo(() => snap ? buildFixed(snap, ledgerAsOfDate(snap)) : [], [snap]);
  useEffect(() => {
    if (!snap || !target || handledTarget.current === target) return;
    handledTarget.current = target;
    if (target.id && snap.fixedAssets.some((asset) => asset.id === target.id)) openMobile(`item:${target.id}`);
    else if (target.tab === 'attention') setInitialAttention(true);
  }, [target, snap, openMobile]);
  if (!snap) return null;
  const readySnap = snap;

  const preferences = parseFixedWorkspace(snap.setting?.fixedAssetWorkspaceJson);
  const availableSource = (transaction: { id: string; amount: string }) => D(transaction.amount).minus(snap.fixedCashflowLinks
    .filter((link) => !link.isDeleted && link.transactionId === transaction.id).reduce((total, link) => total.plus(link.sourceAmount), D(0)));
  const allTimeline = vm
    .flatMap((item) => item.timeline.map((entry) => ({ item, entry })))
    .filter(({ entry }) => !entry.related && entry.datePrecision !== 'year')
    .filter((row) => isDateInRange(row.entry.date, dateRange))
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date));

  async function prepareAttachments(store: SqlLedgerStore, assetId: string, drafts: NonNullable<FixedAssetFormValue['attachmentDrafts']>) {
    const existing = await store.attachments.list({ where: { entityType: 'fixed_asset', entityId: assetId } });
    const managed = existing.filter((attachment) => ['image', 'invoice', 'warranty', 'manual'].includes(attachment.role ?? ''));
    const existingIds = new Set(existing.map((row) => row.id));
    const prepared: Array<PreparedAttachment & { role: Attachment['role'] }> = [];
    try {
      for (const draft of drafts.filter((row) => row.fileName && (row.contentBlob || row.sha256))) {
        const id = draft.id ?? newId();
        prepared.push({
          ...await prepareAttachmentDraft(store, id, draft, existingIds.has(id) ? 'replace' : 'create'),
          role: draft.role,
        });
      }
    } catch (error) {
      await abortPreparedAttachments(store, prepared);
      throw error;
    }
    const kept = new Set(prepared.map((row) => row.attachmentId));
    return { prepared, removeIds: managed.filter((attachment) => !kept.has(attachment.id)).map((attachment) => attachment.id) };
  }

  async function saveAsset(value: FixedAssetFormValue) {
    const clean = { ...value };
    const drafts = clean.attachmentDrafts ?? [];
    const purchaseAmount = clean.purchaseAmount ?? '0';
    const cashflow = cashflowDraft(clean, purchaseAmount);
    delete clean.attachmentDrafts;
    delete clean.purchaseAmount;
    delete clean.cashflowMode;
    delete clean.cashflowTransactionId;
    delete clean.cashflowSourceAmount;
    delete clean.cashflowCategory;
    delete clean.cashflowAccountId;
    delete clean.cashflowPayeeId;
    delete clean.cashflowMerchant;
    delete clean.cashflowDescription;
    const attachmentPlan = await prepareAttachments(store, clean.id, drafts);
    let committed = false;
    try {
      await store.runInAuditBatch('保存物品及附件', async (transactionStore) => {
        const saved = await saveFixedAssetAcquisition(transactionStore, {
          asset: clean,
          purchaseAmount,
          cashflow: await withCashflowPayee(transactionStore, cashflow),
          expectedVersion: clean.version,
        });
        if (saved.asset.storageLocationId) await updateFixedWorkspace(transactionStore, (current) => ({ ...current,
          categoryLocations: { ...current.categoryLocations, [saved.asset.categoryId]: saved.asset.storageLocationId! } }));
        if (assetModal && typeof assetModal === 'object' && 'kind' in assetModal && assetModal.kind === 'component') {
          await saveFixedAssetEvent(transactionStore, {
            event: {
              id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
              fixedAssetId: saved.asset.id, hostAssetId: assetModal.hostId,
              type: 'install', date: saved.asset.purchaseDate, amountBase: '0',
            },
          });
        }
        for (const prepared of attachmentPlan.prepared) {
          await commitPreparedAttachment(transactionStore, prepared, 'fixed_asset', saved.asset.id, prepared.role);
        }
        for (const id of attachmentPlan.removeIds) {
          const attachment = readySnap.attachments.find((row) => row.id === id);
          if (attachment) await transactionStore.attachments.remove(id, attachment.version);
        }
      });
      committed = true;
      await finalizePreparedAttachments(store, attachmentPlan.prepared);
      await reconcileAttachmentStorage(store);
    } catch (error) {
      if (!committed) await abortPreparedAttachments(store, attachmentPlan.prepared);
      throw error;
    }
    bump();
  }

  async function deleteAsset(asset: FixedAsset) {
    const compensation = await archiveMasterData(store, 'fixed_asset', asset.id, asset.version);
    bump();
    undo.offer(`${asset.name} 已归档，历史和资金流水均保留`, async () => {
      await restoreArchivedMasterData(store, compensation);
      bump();
    });
  }

  function openTimeline(item: FixedCardVM, entry: FixedTimelineVM) {
    if (entry.kind === 'event') {
      const event = entry.raw as FixedAssetEvent;
      if (event.type === 'purchase') { const source = readySnap.fixedAssets.find((row) => row.id === event.fixedAssetId); if (source) setAssetModal(source); }
      else if (event.type === 'operating_cost') setOperatingModal({ assetId: event.fixedAssetId, event });
      else setEventModal({ assetId: event.fixedAssetId, event, placement: event.type === 'install' || event.type === 'detach' });
    }
    else if (entry.kind === 'usage') {
      const log = entry.raw as FixedAssetUsageLog;
      const metric = readySnap.fixedUsageMetrics.find((row) => row.id === log.metricId);
      if (metric) setUsageModal({ metric, log });
    } else setConsumableModal({ assetId: item.id, item: entry.raw as FixedAssetConsumable });
  }

  async function saveEventValue(value: FixedAssetEventFormValue) {
    const event = { ...value };
    const cashflow = cashflowDraft(value, value.amountBase);
    delete event.cashflowTransactionId;
    delete event.cashflowSourceAmount;
    delete event.cashflowCategory;
    delete event.cashflowAccountId;
    delete event.cashflowPayeeId;
    delete event.cashflowMerchant;
    delete event.cashflowDescription;
    delete event.cashflowReportingTreatment;
    const includeComponents = event.includeComponents === true;
    delete event.includeComponents;
    await store.runInAuditBatch('保存物品事件与交易对象', async (transactionStore) => saveFixedAssetEvent(transactionStore, {
      event,
      cashflow: await withCashflowPayee(transactionStore, cashflow),
      expectedVersion: value.version,
      includeComponents,
    }));
    bump();
  }

  async function saveConsumableValue(value: FixedAssetConsumableFormValue) {
    const consumable = { ...value };
    const cashflow = cashflowDraft(value, value.amountBase);
    delete consumable.cashflowTransactionId;
    delete consumable.cashflowSourceAmount;
    delete consumable.cashflowCategory;
    delete consumable.cashflowAccountId;
    delete consumable.cashflowPayeeId;
    delete consumable.cashflowMerchant;
    delete consumable.cashflowDescription;
    delete consumable.cashflowReportingTreatment;
    await store.runInAuditBatch('保存耗材与交易对象', async (transactionStore) => saveFixedAssetConsumable(transactionStore, {
      consumable,
      cashflow: await withCashflowPayee(transactionStore, cashflow),
      expectedVersion: consumableModal?.item?.version,
    }));
    bump();
  }

  const mobileItem = mobileView.startsWith('item:') ? vm.find((item) => item.id === mobileView.slice(5)) : undefined;
  const itemActions: FixedItemActions = {
    onEdit: setAssetModal,
    onEvent: (assetId, type) => setEventModal({ assetId, type }),
    onAddComponent: (hostId, bundled) => setAssetModal({ kind: 'component', hostId, bundled }),
    onPlacement: (assetId) => setEventModal({ assetId, placement: true }),
    onConvertUpgrade: (host, event) => setUpgradeConversion({ host, event }),
    onMetric: (assetId, metric) => setMetricModal({ assetId, metric }),
    onUsage: (metric) => setUsageModal({ metric }),
    onOperating: (assetId, preset) => setOperatingModal({ assetId, ...preset }),
    onConsumable: (assetId, item) => setConsumableModal({ assetId, item }),
    onGoal: (assetId, goal) => setGoalModal({ assetId, goal }),
    onTimeline: openTimeline,
    onMaintenance: setMaintenance,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {notice && <CardAlert tone="danger">{notice}</CardAlert>}
      {mobileView === 'locations' ? <FixedLocationManager preferences={preferences} assets={snap.fixedAssets} onBack={backMobile} />
        : mobileItem ? <FixedItemDetail key={mobileItem.id} timezone={snap.setting?.timezone} item={mobileItem} items={vm} actions={itemActions} onBack={backMobile}
          onOpen={(item) => openMobile(`item:${item.id}`)} attachments={snap.attachments.filter((row) => row.entityType === 'fixed_asset' && row.entityId === mobileItem.id)}
          onAttachment={(attachment) => { void (async () => {
            if (!attachment.sha256 || attachment.sizeBytes == null) throw new Error('附件正文信息不足，请从凭证管理页检查');
            await ensureAttachmentBlobAvailable(store, { sha256: attachment.sha256, sizeBytes: attachment.sizeBytes, mimeType: attachment.mimeType ?? 'application/octet-stream' });
            const blob = await readAttachmentBlob(attachment.sha256, attachment.mimeType);
            const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = attachment.fileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
          })().catch((reason) => setNotice(reason instanceof Error ? reason.message : String(reason))); }} /> : <>
      <div className="zc-fixed-page-modes" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['overview', 'list', 'year', 'month', 'day'] as const).map((mode) => <button key={mode} onClick={() => setView(mode)} style={pillBtn(view === mode)}>{mode === 'overview' ? '概览' : mode === 'list' ? '时间线' : mode === 'year' ? '年度' : mode === 'month' ? '月历' : '单日'}</button>)}
        <div style={{ flex: 1 }} />
        {view !== 'overview' && <button onClick={() => setAssetModal('new')} className="zc-btn zc-btn--primary">+ 新增物品</button>}
      </div>

      <label className="zc-fixed-page-view">查看<select className="zc-select" aria-label="物品页面视图" value={view} onChange={(event) => setView(event.target.value as ViewMode)}><option value="overview">物品清单</option><option value="list">生命周期时间线</option><option value="year">年度</option><option value="month">月历</option><option value="day">单日</option></select></label>
      {view !== 'overview' && <><DateRangeBar value={dateRange} onChange={setDateRange} /><p className="zc-caption">只记年份的购入记录在物品详情查看，补齐准确日期后进入日历与时间线。</p></>}

      {view === 'overview' ? (
        <>
        {vm.length === 0 && <FixedEmptyState
          categories={snap.fixedAssetCategories}
          onSelect={(categoryId) => setAssetModal({ kind: 'preset', categoryId })}
        />}
          <FixedInventory key={snap.setting?.id} items={vm} snap={snap} preferences={preferences}
            onOpen={(item) => openMobile(`item:${item.id}`)} onNew={() => setAssetModal('new')}
            onFromExpense={() => setFromExpense(true)} onLocations={() => openMobile('locations')}
            onUsage={(item) => { const metric = item.metrics.find((row) => row.raw.isPrimary) ?? item.metrics[0]; if (metric) setUsageModal({ metric: metric.raw }); }}
            initialAttention={initialAttention} />
        </>
      ) : (
        <TimelineExplorer
          items={allTimeline}
          view={view}
          focusDate={focusDate}
          onFocusDate={setFocusDate}
          onViewChange={setView}
          dateOf={(row) => row.entry.date}
          keyOf={(row) => `${row.item.id}:${row.entry.kind}:${row.entry.id}`}
          renderCompact={(row) => <>{row.entry.date.slice(8)} · {row.entry.amount && row.entry.moneyKind && <><b style={{ color: timelineMoneyVisual[row.entry.moneyKind].color }}>{timelineMoneyVisual[row.entry.moneyKind].label}</b> · </>}<b>{row.item.name}</b> · {row.entry.label}{row.entry.amount && row.entry.moneyKind && <span style={{ color: timelineMoneyVisual[row.entry.moneyKind].color }}> · {timelineMoneyVisual[row.entry.moneyKind].prefix}{row.entry.amount}</span>}</>}
          renderEntry={(row) => <div className="zc-fixed-timeline-entry" style={timelineRow}><span style={{ width: 9, height: 9, background: row.entry.color, borderRadius: 'var(--r-round)' }} /><b style={{ width: 140, textAlign: 'left' }}>{row.item.name}</b><b>{row.entry.label}</b><span style={{ flex: 1, textAlign: 'left' }}>{row.entry.detail}</span><TimelineAmount entry={row.entry} /></div>}
          renderSummary={(rows) => {
            const events = rows.filter((row) => row.entry.kind === 'event').length;
            const usage = rows.filter((row) => row.entry.kind === 'usage').length;
            return <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>事件 {events} · 用量 {usage}</span>;
          }}
          onOpen={(row) => openTimeline(row.item, row.entry)}
          emptyText="该时间范围内没有物品购买、使用或清退记录。"
        />
      )}

      </>}
      {fromExpense && <EntityFormModal spec={{ title: '从已有支出登记物品',
        fields: [{ key: 'transactionId', label: '已有支出流水', type: 'select', required: true, allowEmpty: true,
          options: snap.transactions.filter((row) => row.type === 'expense' && !row.isDeleted && row.recordState !== 'voided' && availableSource(row).gt(0))
            .map((row) => ({ value: row.id, label: `${row.date} · ${row.description || row.merchant || '支出'} · 可分配 ${availableSource(row).toString()} ${snap.assets.find((asset) => asset.id === row.assetId)?.code ?? ''}` })),
          hint: '带入原支出的金额、日期和商户，关联后不重复扣款。已分配部分或包含多件物品时，可在下一步调整金额。' }],
        toValues: (value: { transactionId: string }) => value, fromValues: (value) => ({ transactionId: value.transactionId ?? '' }) }}
        onClose={() => setFromExpense(false)} onSave={async (value) => { setFromExpense(false); setAssetModal({ kind: 'transaction', transactionId: value.transactionId }); }} />}
      {maintenance && <ConfirmDialog title="完成物品保养" confirmLabel="完成保养" onCancel={() => setMaintenance(null)} onConfirm={async () => {
        await completeFixedMaintenance(store, maintenance.id, maintenance.raw.version, todayDate()); setMaintenance(null); bump();
      }}><p>确认 {maintenance.name} 已在今天完成保养。{maintenance.raw.maintenanceIntervalDays ? `下次按 ${maintenance.raw.maintenanceIntervalDays} 天间隔生成。` : '本次完成后清除待办。'}有实际费用时，请在事件入口另记保养费用。</p></ConfirmDialog>}
      {assetModal !== null && (() => {
        const isChoice = typeof assetModal === 'object' && 'kind' in assetModal;
        const isPreset = isChoice && assetModal.kind === 'preset';
        const isComponent = isChoice && assetModal.kind === 'component';
        const sourceExpense = isChoice && assetModal.kind === 'transaction' ? snap.transactions.find((row) => row.id === assetModal.transactionId) : undefined;
        const existing = assetModal === 'new' || isChoice ? undefined : assetModal;
        const attachments = existing ? snap.attachments.filter((row) => row.entityType === 'fixed_asset' && row.entityId === existing.id) : [];
        const purchase = existing ? snap.fixedEvents.find((row) => row.fixedAssetId === existing.id && row.type === 'purchase') : undefined;
        const baseSpec = fixedAssetForm(snap, attachments, purchase);
        const hostCategory = isComponent ? snap.fixedAssetCategories.find((row) => row.id === snap.fixedAssets.find((asset) => asset.id === assetModal.hostId)?.categoryId) : undefined;
        const componentCategoryId = hostCategory?.parentId === 'fixed-electronics' ? 'fixed-electronics-component' : 'fixed-other-component';
        const chosenCategoryId = isPreset ? assetModal.categoryId : isComponent
          ? snap.fixedAssetCategories.some((row) => row.id === componentCategoryId && !row.isDeleted && row.isActive)
            ? componentCategoryId : snap.fixedAssetCategories.find((row) => row.parentId && row.isActive && !row.isDeleted)?.id ?? ''
          : '';
        const presetCashflowCategory = isChoice
          ? baseSpec.onFieldChange?.({ categoryId: chosenCategoryId }, 'categoryId', new Set()).cashflowCategory
          : undefined;
        const preparedSpec = isChoice
          ? {
            ...baseSpec,
            title: isComponent ? assetModal.bundled ? '登记原配件' : '购入配件' : baseSpec.title,
            fields: baseSpec.fields.map((field) => field.key === 'categoryId'
              ? { ...field, defaultValue: chosenCategoryId }
              : field.key === 'role' && isComponent ? { ...field, defaultValue: 'component' }
              : field.key === 'bundledFromAssetId' && isComponent && assetModal.bundled ? { ...field, defaultValue: assetModal.hostId }
              : field.key === 'purchaseAmount' && isComponent && assetModal.bundled ? { ...field, defaultValue: '0', hidden: true }
              : field.key === 'baseCurrencyAssetId' && isComponent ? {
                ...field,
                defaultValue: snap.fixedAssets.find((row) => row.id === assetModal.hostId)?.baseCurrencyAssetId,
                options: snap.assets.filter((row) => row.id === snap.fixedAssets.find((asset) => asset.id === assetModal.hostId)?.baseCurrencyAssetId)
                  .map((row) => ({ value: row.id, label: row.code })),
                singleOptionSummary: true,
              }
              : field.key === 'cashflowMode' && isComponent && assetModal.bundled ? { ...field, defaultValue: 'record_only', hidden: true }
              : field.key === 'cashflowCategory'
                ? { ...field, defaultValue: presetCashflowCategory }
              : field),
          }
          : baseSpec;
        const sourceDefaults: Record<string, string> = sourceExpense ? {
          name: sourceExpense.description || sourceExpense.merchant || '', purchaseDate: sourceExpense.date, purchaseAmount: availableSource(sourceExpense).toString(),
          baseCurrencyAssetId: sourceExpense.assetId, cashflowMode: 'linked_transaction', cashflowTransactionId: sourceExpense.id,
          cashflowSourceAmount: availableSource(sourceExpense).toString(), purchaseMerchant: sourceExpense.merchant || '',
        } : {};
        const spec = { ...preparedSpec, summary: existing ? () => `当前状态：${FIXED_STATUS_LABELS[existing.status]}。状态变更请使用“记录生命周期事件”；归档只隐藏档案。` : preparedSpec.summary, fields: preparedSpec.fields.map((field) => field.key === 'status' ? existing ? { ...field, hidden: true } : { ...field, options: [{ value: 'active', label: FIXED_STATUS_LABELS.active }, { value: 'stored', label: FIXED_STATUS_LABELS.stored }] } : sourceExpense && field.key in sourceDefaults
          ? { ...field, defaultValue: sourceDefaults[field.key] }
          : isComponent && field.key === 'storageLocationId' ? { ...field, defaultValue: snap.fixedAssets.find((row) => row.id === assetModal.hostId)?.storageLocationId } : field) };
        return <EntityFormModal spec={spec} initial={existing} onSave={saveAsset} onDelete={existing ? async () => deleteAsset(existing) : undefined} deleteLabel="归档档案" onClose={() => setAssetModal(null)} />;
      })()}
      {operatingModal && <EntityFormModal spec={fixedOperatingCostForm(snap, operatingModal.assetId, operatingModal, operatingModal.event)} initial={operatingModal.event} onSave={saveEventValue} onDelete={operatingModal.event ? async () => {
        const compensation = await deleteFixedAssetEvent(store, operatingModal.event!);
        bump(); undo.offer('已删除使用费用记录', async () => { await restoreDeletedFixedAssetEvent(store, compensation); bump(); });
      } : undefined} onClose={() => setOperatingModal(null)} />}
      {eventModal && <EntityFormModal spec={eventModal.placement
        ? fixedComponentPlacementForm(snap, eventModal.assetId, componentHostAt(eventModal.assetId,
          snap.fixedEvents.filter((row) => row.id !== eventModal.event?.id), eventModal.event?.date ?? ledgerAsOfDate(snap)))
        : (() => { const spec = fixedEventForm(snap, eventModal.assetId, todayDate(), vm.find((item) => item.id === eventModal.assetId)?.invested ?? '0'); return { ...spec, draftKey: `fixed-event:${eventModal.assetId}:${eventModal.type ?? 'new'}`, fields: spec.fields.map((field) => field.key === 'type' && eventModal.type ? { ...field, defaultValue: eventModal.type } : field) }; })()} initial={eventModal.event} onSave={saveEventValue} onDelete={eventModal.event ? async () => {
        const compensation = await deleteFixedAssetEvent(store, eventModal.event!);
        bump();
        undo.offer('物品事件已删除，关联资金流水已补偿', async () => {
          await restoreDeletedFixedAssetEvent(store, compensation);
          bump();
        });
      } : undefined} onClose={() => setEventModal(null)} />}
      {upgradeConversion && <EntityFormModal
        spec={fixedUpgradeConversionForm(snap, upgradeConversion.host, upgradeConversion.event)}
        onSave={async (component) => {
          await convertFixedUpgradeToComponent(store, {
            upgradeEventId: upgradeConversion.event.id,
            expectedVersion: upgradeConversion.event.version,
            component,
          });
          bump();
        }}
        onClose={() => setUpgradeConversion(null)}
      />}
      {metricModal && <EntityFormModal spec={fixedUsageMetricForm(metricModal.assetId)} initial={metricModal.metric} onSave={async (metric) => {
        await store.runInAuditBatch(
          `${metricModal.metric ? '编辑' : '新增'}物品使用指标`,
          async (transactionStore) => {
            if (metric.isPrimary) {
              for (const row of snap.fixedUsageMetrics.filter((item) => item.fixedAssetId === metric.fixedAssetId && item.id !== metric.id && item.isPrimary)) {
                await transactionStore.fixedAssetUsageMetrics.put({ ...row, isPrimary: false });
              }
            }
            await transactionStore.fixedAssetUsageMetrics.put(metric);
          },
        );
        bump();
      }} onDelete={metricModal.metric ? async () => {
        const compensation = await archiveFixedUsageMetric(store, metricModal.metric!.id, metricModal.metric!.version);
        bump();
        undo.offer(`使用指标“${metricModal.metric!.name}”已停用`, async () => {
          await restoreFixedUsageMetricState(store, compensation);
          bump();
        });
      } : undefined} deleteLabel="停用" onClose={() => setMetricModal(null)} />}
      {usageModal && <EntityFormModal spec={fixedUsageLogForm(usageModal.metric)} initial={usageModal.log} onSave={async (log) => {
        await store.runInAuditBatch(
          `${usageModal.log ? '编辑' : '新增'}物品使用记录`,
          (transactionStore) => transactionStore.fixedAssetUsageLogs.put(log),
        );
        bump();
      }} onDelete={usageModal.log ? async () => {
        const compensation = await deleteFixedUsageLog(store, usageModal.log!.id, usageModal.log!.version);
        bump();
        undo.offer('使用记录已删除', async () => {
          await restoreDeletedFixedUsageLog(store, compensation);
          bump();
        });
      } : undefined} onClose={() => setUsageModal(null)} />}
      {consumableModal && <EntityFormModal spec={fixedConsumableForm(snap, consumableModal.assetId, snap.fixedUsageMetrics, todayDate(), consumableModal.item)} initial={consumableModal.item} onSave={saveConsumableValue} onDelete={consumableModal.item ? async () => {
        const compensation = await deleteFixedAssetConsumable(store, consumableModal.item!);
        bump();
        undo.offer(`耗材“${consumableModal.item!.name}”已删除，关联资金流水已补偿`, async () => {
          await restoreDeletedFixedAssetConsumable(store, compensation);
          bump();
        });
      } : undefined} onClose={() => setConsumableModal(null)} />}
      {goalModal && (() => {
        const asset = vm.find((item) => item.id === goalModal.assetId)!;
        return <EntityFormModal spec={fixedGoalForm(goalModal.assetId, snap.fixedUsageMetrics, asset.net, asset.raw.activatedDate ?? (asset.raw.purchaseDatePrecision === 'year' ? todayDate() : asset.raw.purchaseDate))} initial={goalModal.goal} onSave={async (goal) => {
          await store.runInAuditBatch(
            `${goalModal.goal ? '编辑' : '新增'}物品成本目标`,
            (transactionStore) => transactionStore.fixedAssetGoals.put(goal),
          );
          bump();
        }} onDelete={goalModal.goal ? async () => {
          const compensation = await cancelFixedAssetGoal(store, goalModal.goal!.id, goalModal.goal!.version);
          bump();
          undo.offer(`成本目标“${goalModal.goal!.name}”已取消`, async () => {
            await restoreFixedAssetGoalState(store, compensation);
            bump();
          });
        } : undefined} deleteLabel="取消目标" onClose={() => setGoalModal(null)} />;
      })()}
    </div>
  );
}

function FixedEmptyState({
  categories,
  onSelect,
}: {
  categories: readonly FixedAssetCategory[];
  onSelect: (categoryId: string) => void;
}) {
  return (
    <section className="zc-card">
      <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>记录第一件真实物品</div>
      <div style={{ marginTop: 7, color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', lineHeight: 1.7 }}>
        选择常用类型可直接打开现有新增表单并预选分类。你仍需填写真实名称，取消表单不会留下任何物品或资金记录。
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 16 }}>
        {FIXED_ASSET_QUICK_PRESETS.map((preset) => {
          const categoryId = fixedAssetPresetCategoryId(preset, categories);
          return (
            <button
              key={preset.key}
              type="button"
              aria-label={`新增${preset.label}物品`}
              disabled={!categoryId}
              onClick={() => categoryId && onSelect(categoryId)}
              style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-primary)', padding: '15px 14px', textAlign: 'left', cursor: categoryId ? 'pointer' : 'not-allowed', opacity: categoryId ? 1 : 0.55 }}
            >
              <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{preset.label}</div>
              <div style={{ marginTop: 5, fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{categoryId ? preset.hint : '该分类已被归档'}</div>
              <div style={{ marginTop: 9, fontSize: 'var(--fs-meta)', color: 'var(--accent)', fontWeight: 'var(--fw-medium)' }}>预选分类 · 填写名称</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const timelineMoneyVisual = {
  spend: { label: '支出', prefix: '−', color: 'var(--negative)' },
  recover: { label: '回款', prefix: '＋', color: 'var(--positive)' },
  reference: { label: '参考值', prefix: '', color: 'var(--text-tertiary)' },
} as const;

function TimelineAmount({ entry }: { entry: FixedTimelineVM }) {
  if (!entry.amount || !entry.moneyKind) return null;
  const visual = timelineMoneyVisual[entry.moneyKind];
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, whiteSpace: 'nowrap' }}>
    <span style={{ padding: '2px 5px', border: '1px solid currentColor', borderRadius: 'var(--r-sm)', color: visual.color, fontSize: 'var(--fs-meta)', lineHeight: 1.2 }}>{visual.label}</span>
    <b style={{ color: visual.color }}>{visual.prefix}{entry.amount}</b>
  </span>;
}

const timelineRow = { width: '100%', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', fontSize: 'var(--fs-meta)', cursor: 'pointer' } as const;
