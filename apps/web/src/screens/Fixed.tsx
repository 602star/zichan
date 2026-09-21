import { useMemo, useState } from 'react';
import {
  isDateInRange,
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
  saveFixedAssetConsumable,
  saveFixedAssetEvent,
  type FixedAssetCashflowDraft,
  type SqlLedgerStore,
} from '@zichan/db';
import { useSnapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { CategoryPicker, EntityFormModal } from '../ui/EntityFormModal.js';
import { AttachmentPreview } from '../ui/AttachmentPreview.js';
import {
  abortPreparedAttachments,
  commitPreparedAttachment,
  finalizePreparedAttachments,
  prepareAttachmentDraft,
  reconcileAttachmentStorage,
  type PreparedAttachment,
} from '../db/attachment-storage.js';
import {
  fixedAssetForm,
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
import { amount as fmtAmount, money } from '../format.js';
import { btnPrimary, card, linkAccent, metaText, pillBtn } from '../ui/styles.js';
import { DateRangeBar, dateRangeValue, type DateRangeValue, type TimelineViewMode } from '../ui/DateRangeBar.js';
import { TimelineExplorer } from '../ui/TimelineExplorer.js';
import { useUndo } from '../ui/UndoToast.js';
import {
  FIXED_ASSET_QUICK_PRESETS,
  fixedAssetPresetCategoryId,
} from '../assetPresets.js';

type ViewMode = 'overview' | TimelineViewMode;
type AssetModal = FixedAsset | 'new' | { kind: 'preset'; categoryId: string } | null;
type EventModal = { assetId: string; event?: FixedAssetEvent } | null;
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

export function Fixed() {
  const snap = useSnapshot('fixed');
  const { store, bump } = useStore();
  const undo = useUndo(store, bump);
  const [view, setView] = useState<ViewMode>('overview');
  const [status, setStatus] = useState<'all' | 'active' | 'terminal'>('all');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const [assetModal, setAssetModal] = useState<AssetModal>(null);
  const [eventModal, setEventModal] = useState<EventModal>(null);
  const [metricModal, setMetricModal] = useState<MetricModal>(null);
  const [usageModal, setUsageModal] = useState<UsageModal>(null);
  const [consumableModal, setConsumableModal] = useState<ConsumableModal>(null);
  const [goalModal, setGoalModal] = useState<GoalModal>(null);
  const [focusDate, setFocusDate] = useState(todayDate);
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const vm = useMemo(() => snap ? buildFixed(snap, ledgerAsOfDate(snap)) : [], [snap]);
  if (!snap) return null;
  const readySnap = snap;

  const q = query.trim().toLowerCase();
  const cards = vm.filter((item) => {
    if (status === 'active' && item.sold) return false;
    if (status === 'terminal' && !item.sold) return false;
    if (categoryId !== 'all' && item.raw.categoryId !== categoryId) return false;
    return !q || `${item.name} ${item.categoryParent} ${item.category} ${item.raw.brand ?? ''} ${item.raw.model ?? ''} ${item.raw.barcode ?? ''}`.toLowerCase().includes(q);
  });
  const allTimeline = cards
    .flatMap((item) => item.timeline.map((entry) => ({ item, entry })))
    .filter((row) => isDateInRange(row.entry.date, dateRange))
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date));
  const parents = snap.fixedAssetCategories.filter((category) => !category.parentId && category.isActive && !category.isDeleted);
  const activeCount = vm.filter((item) => !item.sold).length;
  const warrantyWarnings = vm.filter((item) => item.warrantyTone === 'warning').length;
  const consumableWarnings = vm.reduce((sum, item) => sum + item.consumables.filter((row) => row.needsAttention).length, 0);

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
          cashflow,
          expectedVersion: clean.version,
        });
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
      if (event.type === 'purchase') setAssetModal(item.raw);
      else setEventModal({ assetId: item.id, event });
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
    await saveFixedAssetEvent(store, {
      event,
      cashflow,
      expectedVersion: eventModal?.event?.version,
    });
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
    await saveFixedAssetConsumable(store, {
      consumable,
      cashflow,
      expectedVersion: consumableModal?.item?.version,
    });
    bump();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['overview', 'list', 'year', 'month', 'day'] as const).map((mode) => <button key={mode} onClick={() => setView(mode)} style={pillBtn(view === mode)}>{mode === 'overview' ? '概览' : mode === 'list' ? '时间线' : mode === 'year' ? '年度' : mode === 'month' ? '月历' : '单日'}</button>)}
        <div style={{ flex: 1 }} />
        <button onClick={() => setAssetModal('new')} style={primaryButton}>+ 新增物品</button>
      </div>

      {view !== 'overview' && <DateRangeBar value={dateRange} onChange={setDateRange} />}

      {view === 'overview' ? (vm.length === 0 ? (
        <FixedEmptyState
          categories={snap.fixedAssetCategories}
          onSelect={(categoryId) => setAssetModal({ kind: 'preset', categoryId })}
        />
      ) : (
        <>
          <div className="zc-fixed-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Kpi label="物品总数" value={`${vm.length} 件`} />
            <Kpi label="正在使用" value={`${activeCount} 件`} tone="var(--positive)" />
            <Kpi label="已过保" value={`${warrantyWarnings} 件`} tone={warrantyWarnings ? 'var(--negative)' : 'var(--fg)'} />
            <Kpi label="耗材提醒" value={`${consumableWarnings} 项`} tone={consumableWarnings ? 'var(--negative)' : 'var(--fg)'} />
          </div>
          <div className="zc-fixed-filter-grid" style={{ display: 'grid', gridTemplateColumns: '160px minmax(220px, 1fr) 220px 180px', gap: 10 }}>
            <select aria-label="物品状态" className="zc-select" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">全部状态</option><option value="active">在用 / 闲置</option><option value="terminal">已售 / 报废 / 清退</option></select>
            <input aria-label="搜索物品" className="zc-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、品牌、型号或条形码" />
            <CategoryPicker fieldId="fixed-filter-category" name="fixedCategory" ariaLabel="物品分类"
              value={categoryId === 'all' ? '' : categoryId} allowEmpty emptyLabel="全部分类" placeholder="全部分类" defaultShowHidden
              options={parents.flatMap((parent) => snap.fixedAssetCategories.filter((child) => child.parentId === parent.id && child.isActive).map((child) => ({ value: child.id, label: `${parent.name} / ${child.name}`, name: child.name, parentName: parent.name })))}
              onChange={(next) => setCategoryId(next || 'all')} />
            <div style={{ alignSelf: 'center', textAlign: 'right', color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>找到 {cards.length} 件</div>
          </div>
          <Overview cards={cards} onEdit={setAssetModal} onEvent={(assetId) => setEventModal({ assetId })} onMetric={(assetId, metric) => setMetricModal({ assetId, metric })} onUsage={(metric) => setUsageModal({ metric })} onConsumable={(assetId) => setConsumableModal({ assetId })} onGoal={(assetId, goal) => setGoalModal({ assetId, goal })} onTimeline={openTimeline} />
        </>
      )) : (
        <TimelineExplorer
          items={allTimeline}
          view={view}
          focusDate={focusDate}
          onFocusDate={setFocusDate}
          onViewChange={setView}
          dateOf={(row) => row.entry.date}
          keyOf={(row) => `${row.item.id}:${row.entry.kind}:${row.entry.id}`}
          renderCompact={(row) => <>{row.entry.date.slice(8)} · <b>{row.item.name}</b> · {row.entry.label}</>}
          renderEntry={(row) => <div className="zc-fixed-timeline-entry" style={timelineRow}><span style={{ width: 9, height: 9, background: row.entry.color, borderRadius: 'var(--r-round)' }} /><b style={{ width: 140, textAlign: 'left' }}>{row.item.name}</b><b>{row.entry.label}</b><span style={{ flex: 1, textAlign: 'left' }}>{row.entry.detail}</span>{row.entry.amount && <b>{row.entry.amount}</b>}</div>}
          renderSummary={(rows) => {
            const events = rows.filter((row) => row.entry.kind === 'event').length;
            const usage = rows.filter((row) => row.entry.kind === 'usage').length;
            return <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>事件 {events} · 用量 {usage}</span>;
          }}
          onOpen={(row) => openTimeline(row.item, row.entry)}
          emptyText="该时间范围内没有物品购买、使用或清退记录。"
        />
      )}

      {assetModal !== null && (() => {
        const isPreset = typeof assetModal === 'object' && 'kind' in assetModal;
        const existing = assetModal === 'new' || isPreset ? undefined : assetModal;
        const attachments = existing ? snap.attachments.filter((row) => row.entityType === 'fixed_asset' && row.entityId === existing.id) : [];
        const purchase = existing ? snap.fixedEvents.find((row) => row.fixedAssetId === existing.id && row.type === 'purchase') : undefined;
        const baseSpec = fixedAssetForm(snap, attachments, purchase);
        const spec = isPreset
          ? {
            ...baseSpec,
            fields: baseSpec.fields.map((field) => field.key === 'categoryId'
              ? { ...field, defaultValue: assetModal.categoryId }
              : field),
          }
          : baseSpec;
        return <EntityFormModal spec={spec} initial={existing} onSave={saveAsset} onDelete={existing ? async () => deleteAsset(existing) : undefined} deleteLabel="归档" onClose={() => setAssetModal(null)} />;
      })()}
      {eventModal && <EntityFormModal spec={fixedEventForm(snap, eventModal.assetId, todayDate(), vm.find((item) => item.id === eventModal.assetId)?.invested ?? '0')} initial={eventModal.event} onSave={saveEventValue} onDelete={eventModal.event ? async () => {
        const compensation = await deleteFixedAssetEvent(store, eventModal.event!);
        bump();
        undo.offer('物品事件已删除，关联资金流水已补偿', async () => {
          await restoreDeletedFixedAssetEvent(store, compensation);
          bump();
        });
      } : undefined} onClose={() => setEventModal(null)} />}
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
      {consumableModal && <EntityFormModal spec={fixedConsumableForm(snap, consumableModal.assetId, snap.fixedUsageMetrics)} initial={consumableModal.item} onSave={saveConsumableValue} onDelete={consumableModal.item ? async () => {
        const compensation = await deleteFixedAssetConsumable(store, consumableModal.item!);
        bump();
        undo.offer(`耗材“${consumableModal.item!.name}”已删除，关联资金流水已补偿`, async () => {
          await restoreDeletedFixedAssetConsumable(store, compensation);
          bump();
        });
      } : undefined} onClose={() => setConsumableModal(null)} />}
      {goalModal && (() => {
        const asset = vm.find((item) => item.id === goalModal.assetId)!;
        return <EntityFormModal spec={fixedGoalForm(goalModal.assetId, snap.fixedUsageMetrics, asset.net, asset.raw.activatedDate ?? asset.raw.purchaseDate)} initial={goalModal.goal} onSave={async (goal) => {
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
    <section style={{ ...card, padding: 22 }}>
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

function Overview(props: {
  cards: FixedCardVM[];
  onEdit: (asset: FixedAsset) => void;
  onEvent: (assetId: string) => void;
  onMetric: (assetId: string, metric?: FixedAssetUsageMetric) => void;
  onUsage: (metric: FixedAssetUsageMetric) => void;
  onConsumable: (assetId: string) => void;
  onGoal: (assetId: string, goal?: FixedAssetGoal) => void;
  onTimeline: (item: FixedCardVM, entry: FixedTimelineVM) => void;
}) {
  const groups = new Map<string, FixedCardVM[]>();
  for (const item of props.cards) groups.set(item.categoryParent, [...(groups.get(item.categoryParent) ?? []), item]);
  if (!props.cards.length) return <div style={{ ...card, color: 'var(--text-tertiary)', fontSize: 'var(--fs-body)' }}>该筛选下暂无物品资产</div>;
  return <>{[...groups.entries()].map(([group, items]) => <section key={group} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', color: 'var(--text-secondary)' }}>{group}<span style={{ marginLeft: 8, color: 'var(--text-tertiary)' }}>{items.length}</span></div><div className="zc-fixed-card-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>{items.map((item) => <ItemCard key={item.id} item={item} {...props} />)}</div></section>)}</>;
}

function ItemCard({ item, onEdit, onEvent, onMetric, onUsage, onConsumable, onGoal, onTimeline }: Omit<Parameters<typeof Overview>[0], 'cards'> & { item: FixedCardVM }) {
  const cash = (value: string) => money(value, item.currencySymbol);
  return <article style={card}>
    <div className={`zc-fixed-card-header${item.imageAttachment ? ' has-image' : ''}`} style={{ display: 'grid', gridTemplateColumns: item.imageAttachment ? '92px 1fr auto' : '1fr auto', gap: 14, alignItems: 'start' }}>
      {item.imageAttachment && <AttachmentPreview className="zc-fixed-card-image" attachment={item.imageAttachment} alt={item.name} style={{ width: 92, height: 92, objectFit: 'cover', border: '1px solid var(--border)' }} />}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b style={{ fontSize: 'var(--fs-title)' }}>{item.name}</b><span style={statusBadge(item.sold)}>{item.status}</span></div>
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 5 }}>{item.categoryParent} / {item.category}{item.raw.brand ? ` · ${item.raw.brand}` : ''}{item.raw.model ? ` ${item.raw.model}` : ''}</div>
        <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}><span style={infoBadge(item.warrantyTone)}>{item.warrantyLabel}</span>{item.invoiceCount > 0 && <span style={infoBadge('muted')}>发票 {item.invoiceCount}</span>}{item.attachmentCount > 0 && <span style={infoBadge('muted')}>附件 {item.attachmentCount}</span>}</div>
      </div>
      <button onClick={() => onEdit(item.raw)} style={linkButton}>编辑</button>
    </div>
    <div className="zc-fixed-card-metrics" style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr', gap: 18, marginTop: 16, padding: '14px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
      <div><div style={smallLabel}>净使用成本</div><div style={{ fontSize: 'var(--fs-display)', fontWeight: 'var(--fw-bold)', marginTop: 4 }}>{cash(item.net)}</div><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 3 }}>累计投入 {cash(item.invested)} · 残值 {cash(item.residual)}</div></div>
      <div><div style={smallLabel}>按天成本</div><div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)', marginTop: 7 }}>{cash(item.perDay)}<small style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}> / 天</small></div><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 5 }}>{item.days} 天</div></div>
      <div><div style={smallLabel}>主使用指标</div>{item.metrics.length ? <><div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)', marginTop: 7 }}>{fmtAmount(item.metrics.find((row) => row.raw.isPrimary)?.total ?? item.metrics[0]!.total, 2)}<small style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}> {item.metrics.find((row) => row.raw.isPrimary)?.unitLabel ?? item.metrics[0]!.unitLabel}</small></div><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 5 }}>{cash(item.metrics.find((row) => row.raw.isPrimary)?.perUnit ?? item.metrics[0]!.perUnit)} / 单位</div></> : <button onClick={() => onMetric(item.id)} style={{ ...linkButton, marginTop: 12 }}>添加指标</button>}</div>
    </div>
    {item.metrics.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>{item.metrics.map((metric) => <div key={metric.raw.id} style={{ display: 'flex', alignItems: 'stretch' }}><button onClick={() => onUsage(metric.raw)} style={metricButton}><b>{metric.raw.name}</b><span>{fmtAmount(metric.total, 2)} {metric.unitLabel}</span><small>{cash(metric.perUnit)} / {metric.unitLabel}</small></button><button title="编辑使用指标" aria-label={`编辑 ${metric.raw.name}`} onClick={() => onMetric(item.id, metric.raw)} style={{ border: '1px solid var(--border)', borderLeft: 'none', background: 'var(--surface)', color: 'var(--text-tertiary)', cursor: 'pointer', width: 30 }}>⋮</button></div>)}</div>}
    {item.goals.length > 0 && <div style={{ marginTop: 14 }}>{item.goals.map((goal) => <div key={goal.raw.id} style={{ marginTop: 9 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--fs-meta)' }}><button onClick={() => onGoal(item.id, goal.raw)} style={{ ...linkButton, color: 'var(--text-primary)' }}>{goal.raw.name}</button><span>{fmtAmount(goal.currentUsage, 1)} / {fmtAmount(goal.targetUsage, 1)} {goal.unitLabel} · 当前 {cash(goal.currentUnitCost)} / {goal.unitLabel}</span></div><div style={{ height: 7, background: 'var(--surface-2)', border: '1px solid var(--border)', marginTop: 5 }}><div style={{ width: `${Math.max(0, Math.min(100, goal.progress * 100))}%`, height: '100%', background: goal.achieved ? 'var(--positive)' : 'var(--accent)' }} /></div></div>)}</div>}
    {item.consumables.some((row) => row.raw.status === 'active') && <div style={{ marginTop: 13, fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)' }}>在用耗材：{item.consumables.filter((row) => row.raw.status === 'active').map((row) => `${row.raw.name}${row.remaining !== undefined ? `（剩 ${fmtAmount(row.remaining, 1)} ${row.unitLabel ?? ''}）` : ''}`).join(' · ')}</div>}
    <div style={{ display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap' }}><button onClick={() => onEvent(item.id)} style={linkButton}>+ 生命周期事件</button><button onClick={() => onMetric(item.id)} style={linkButton}>+ 使用指标</button><button onClick={() => onConsumable(item.id)} style={linkButton}>+ 耗材</button><button onClick={() => onGoal(item.id)} style={linkButton}>+ 成本目标</button></div>
    <details style={{ marginTop: 13 }}><summary style={{ cursor: 'pointer', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)' }}>完整时间线 ({item.timeline.length})</summary><div style={{ marginTop: 8 }}>{item.timeline.slice(0, 20).map((entry) => <button className="zc-fixed-timeline-entry" key={`${entry.kind}:${entry.id}`} onClick={() => onTimeline(item, entry)} style={timelineRow}><span style={{ width: 8, height: 8, background: entry.color, borderRadius: 'var(--r-round)' }} /><b>{entry.label}</b><span>{entry.date}</span><span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.detail}</span>{entry.amount && <b>{entry.amount}</b>}</button>)}</div></details>
  </article>;
}

function Kpi({ label, value, tone = 'var(--fg)' }: { label: string; value: string; tone?: string }) { return <div style={card}><div style={smallLabel}>{label}</div><div style={{ marginTop: 7, fontSize: 'var(--fs-display)', fontWeight: 'var(--fw-bold)', color: tone }}>{value}</div></div>; }

const primaryButton = btnPrimary;
const linkButton = linkAccent;
const smallLabel = metaText;
const metricButton = { minWidth: 130, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-primary)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start', cursor: 'pointer', fontSize: 'var(--fs-meta)' } as const;
const timelineRow = { width: '100%', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', fontSize: 'var(--fs-meta)', cursor: 'pointer' } as const;
const statusBadge = (terminal: boolean) => ({ padding: '3px 7px', border: '1px solid var(--border)', background: terminal ? 'var(--surface-2)' : 'rgba(63,143,107,.12)', color: terminal ? 'var(--fg-subtle)' : 'var(--positive)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)' } as const);
const infoBadge = (tone: FixedCardVM['warrantyTone']) => ({ padding: '3px 7px', border: '1px solid var(--border)', background: tone === 'positive' ? 'rgba(63,143,107,.12)' : tone === 'warning' ? 'rgba(194,96,74,.12)' : 'var(--surface-2)', color: tone === 'positive' ? 'var(--positive)' : tone === 'warning' ? 'var(--negative)' : 'var(--fg-subtle)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)' } as const);
