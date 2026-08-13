import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { addDays, isDateInRange, localToday, type AuditBatch, type OperationLogEntry, type OperationType, type SyncConflictResolution, type Transaction } from '@zichan/core';
import {
  restoreConversion,
  restoreTransaction,
  saveTransaction,
  undoBusinessCompensation,
  voidConversion,
  voidTransaction,
  type BusinessCompensationRecord,
} from '@zichan/db';
import { reconcileAttachmentStorage } from '../db/attachment-storage.js';
import { useStore } from '../db/store.js';
import { useSnapshot, type Snapshot } from '../db/snapshot.js';
import { card, tag as tagStyle, th as thStyle, td as tdStyle } from '../ui/styles.js';
import { categoryLabel, TYPE_LABEL } from '../transactionMeta.js';
import { DateRangeBar, localDateOfInstant, localDateRangeToUtc, type DateRangeValue, type TimelineViewMode } from '../ui/DateRangeBar.js';
import { TimelineExplorer } from '../ui/TimelineExplorer.js';

type EventKind = 'batch' | 'operation' | 'resolution';
type SourceFilter = 'user' | 'all' | 'local' | 'remote_sync' | 'import' | 'system' | 'conflict_resolution';

type HistoryEvent =
  | { kind: 'batch'; id: string; at: string; batch: AuditBatch; logs: OperationLogEntry[] }
  | { kind: 'operation'; id: string; at: string; log: OperationLogEntry }
  | { kind: 'resolution'; id: string; at: string; resolution: SyncConflictResolution };

const ENTITY_LABELS: Record<string, string> = {
  asset: '资产',
  account: '账户',
  setting: '设置',
  conversion_chain: '转换链路',
  conversion_chain_steps: '转换步骤',
  transaction: '流水',
  transaction_split: '拆分',
  transaction_tag: '标签',
  transaction_location: '地点',
  transaction_template: '模板',
  transaction_saved_view: '保存筛选',
  category: '分类',
  payee: '商户',
  attachment: '附件',
  budget_category: '预算',
  scheduled_transaction: '定期交易',
  reconciliation_session: '对账',
  price_mark: '价格标记',
  lot: '持仓批次',
  lot_consumption: '批次消耗',
  dca_plan: '定投计划',
  dca_execution: '定投执行',
  game: '游戏',
  game_account: '游戏账号',
  game_season: '游戏赛季',
  game_record: '游戏记录',
  fixed_asset: '物品资产',
  fixed_asset_category: '物品分类',
  fixed_asset_event: '物品事件',
  fixed_asset_usage_metric: '使用指标',
  fixed_asset_usage_log: '使用记录',
  fixed_asset_consumable: '耗材',
  fixed_asset_goal: '使用成本目标',
};

const OP_LABEL: Record<OperationType, string> = { create: '新增', update: '修改', delete: '删除' };
const SOURCE_LABEL: Record<string, string> = {
  local: '本地',
  remote_sync: '远程同步',
  import: '导入',
  system: '系统',
  conflict_resolution: '冲突解决',
};
const VALUE_LABELS: Record<string, Record<string, string>> = {
  status: {
    pending: '待确认',
    cleared: '已清算',
    reconciled: '已对账',
    active: '启用',
    paused: '暂停',
    ended: '结束',
    open: '打开',
    closed: '已关闭',
    sold: '已售出',
    scrapped: '已报废',
    stored: '闲置/库存',
    retired: '已清退',
    gifted: '已赠出',
  },
  type: TYPE_LABEL,
  frequency: {
    daily: '每日',
    weekly: '每周',
    monthly: '每月',
    yearly: '每年',
  },
  source: SOURCE_LABEL,
  recordState: { active: '有效', voided: '已作废' },
};

const FIELD_LABELS: Record<string, string> = {
  id: 'ID',
  name: '名称',
  title: '标题',
  code: '代码',
  date: '日期',
  time: '时间',
  timezone: '时区',
  type: '类型',
  category: '分类',
  categoryId: '物品分类',
  parentId: '上级分类',
  amount: '金额',
  assetId: '资产',
  accountId: '账户',
  transferAssetId: '转入资产',
  transferAccountId: '转入账户',
  transferAmount: '转入金额',
  status: '状态',
  payeeId: '商户',
  merchant: '商户文本',
  description: '描述',
  note: '备注',
  tagIds: '标签',
  locationId: '地点',
  locationName: '地点文本',
  latitude: '纬度',
  longitude: '经度',
  locationAccuracyMeters: '定位精度（米）',
  month: '月份',
  plannedAmount: '预算金额',
  price: '价格',
  source: '来源',
  fromAssetId: '来源资产',
  toAssetId: '目标资产',
  fees: '手续费明细',
  feeAssetId: '手续费资产',
  feeAmount: '手续费',
  referenceRate: '参考汇率',
  sourceAmountMode: '来源金额口径',
  targetAmountMode: '目标金额口径',
  bookValueInBase: '账面折算',
  finalAssetId: '最终资产',
  settlementAssetId: '结算资产',
  gameId: '游戏',
  seasonId: '赛季',
  payeeName: '商户名称',
  isActive: '启用',
  isDeleted: '已删除',
  valueMode: '残值录入口径',
  enteredAmount: '原始输入金额',
  targetUsage: '目标使用量',
  targetUnitCost: '目标单位成本',
  refundForId: '关联原支出',
  refundAppliedAmount: '冲减原支出金额',
  refundAppliedAssetId: '冲减币种',
  refundAttributionMode: '退款统计归属',
  recordState: '记录状态',
  voidedAt: '作废时间',
  voidReason: '作废原因',
  lotMethod: '卖出匹配方式',
  manualLotIds: '手动匹配批次',
};

const button: CSSProperties = {
  padding: '8px 13px',
  borderRadius: 9,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--fg-muted)',
  fontWeight: 800,
  fontSize: 12,
  cursor: 'pointer',
};

const selectStyle: CSSProperties = {
  height: 38,
  borderRadius: 10,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--fg)',
  padding: '0 12px',
  fontWeight: 700,
  fontSize: 13,
};

export function History() {
  const { store, rev, bump } = useStore();
  const snap = useSnapshot('history');
  const [logs, setLogs] = useState<OperationLogEntry[]>([]);
  const [batches, setBatches] = useState<AuditBatch[]>([]);
  const [compensations, setCompensations] = useState<BusinessCompensationRecord[]>([]);
  const [resolutions, setResolutions] = useState<SyncConflictResolution[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [range, setRange] = useState<DateRangeValue>(() => ({ preset: 'custom', from: addDays(localToday(), -29), to: localToday() }));
  const [view, setView] = useState<TimelineViewMode>('list');
  const [focusDate, setFocusDate] = useState(localToday);
  const [kind, setKind] = useState<'all' | EventKind>('all');
  const [op, setOp] = useState<'all' | OperationType>('all');
  const [entityType, setEntityType] = useState('all');
  const [source, setSource] = useState<SourceFilter>('user');
  const [search, setSearch] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState('');

  async function reverseOperation(log: OperationLogEntry) {
    setActionBusy(true);
    setActionMessage('');
    try {
      if ((log.source ?? 'local') !== 'local') throw new Error('同步、导入和系统操作不能在这里直接撤销');
      if (log.entityType === 'transaction') {
        const current = await store.transactions.get(log.entityId);
        if (!current || current.version !== log.version) throw new Error('该流水后来又发生了变化，请从当前流水处理');
        const before = parseJson(log.beforePayload) as Transaction | null;
        const after = parseJson(log.afterPayload ?? log.payload) as Transaction | null;
        if (log.op === 'create') await voidTransaction(store, log.entityId, '从操作历史撤销新增');
        else if (before && after?.recordState === 'voided' && before.recordState !== 'voided') await restoreTransaction(store, log.entityId);
        else if (before?.recordState === 'voided' && after?.recordState !== 'voided') await voidTransaction(store, log.entityId, '从操作历史撤销恢复');
        else if (before) await saveTransaction(store, { ...before, version: current.version });
        else throw new Error('这条历史记录没有可恢复的操作前快照');
      } else if (log.entityType === 'conversion_chain') {
        const current = await store.conversionChains.get(log.entityId);
        if (!current || current.version !== log.version) throw new Error('该转换后来又发生了变化，请从资产转换页处理');
        const before = parseJson(log.beforePayload) as Record<string, unknown> | null;
        const after = parseJson(log.afterPayload ?? log.payload) as Record<string, unknown> | null;
        if (after?.['recordState'] === 'voided' && before?.['recordState'] !== 'voided') await restoreConversion(store, log.entityId);
        else if (before?.['recordState'] === 'voided' && after?.['recordState'] !== 'voided') await voidConversion(store, log.entityId, '从操作历史撤销恢复');
        else throw new Error('转换内容编辑请使用保存后的全局撤销；历史页只反向作废和恢复');
      } else {
        throw new Error('该对象暂不支持从历史页反向操作');
      }
      setActionMessage('已完成反向操作。');
      bump();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  }

  async function reverseBatch(compensation: BusinessCompensationRecord) {
    if (!window.confirm(`撤销“${compensation.label}”的全部 ${compensation.affectedEntities.length} 项变更？`)) return;
    setActionBusy(true);
    setActionMessage('');
    try {
      await undoBusinessCompensation(store, compensation.id);
      await reconcileAttachmentStorage(store);
      setActionMessage('已完整撤销该批次。');
      bump();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const utc = localDateRangeToUtc({ from: range.from, to: range.to });
    void Promise.all([
      store.operationLog({ desc: true, since: utc.since, until: utc.until }),
      store.listAuditBatches({ since: utc.since, until: utc.until }),
      store.listConflictResolutions({ since: utc.since, until: utc.until }),
      store.listBusinessCompensations(),
    ]).then(([nextLogs, nextBatches, nextResolutions, nextCompensations]) => {
      if (cancelled) return;
      setLogs(nextLogs);
      setBatches(nextBatches);
      setResolutions(nextResolutions);
      setCompensations(nextCompensations);
    });
    return () => { cancelled = true; };
  }, [range.from, range.to, rev, store]);

  const batchMap = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);
  const compensationByBatch = useMemo(
    () => new Map(compensations.map((row) => [row.sourceBatchId, row])),
    [compensations],
  );
  const logsByBatch = useMemo(() => {
    const map = new Map<string, OperationLogEntry[]>();
    for (const log of logs) {
      if (!log.batchId) continue;
      const rows = map.get(log.batchId) ?? [];
      rows.push(log);
      map.set(log.batchId, rows);
    }
    return map;
  }, [logs]);

  const events = useMemo<HistoryEvent[]>(() => {
    const out: HistoryEvent[] = [];
    for (const batch of batches) {
      out.push({ kind: 'batch', id: `batch:${batch.id}`, at: batch.startedAt, batch, logs: logsByBatch.get(batch.id) ?? [] });
    }
    for (const log of logs) {
      if (log.batchId && batchMap.has(log.batchId)) continue;
      out.push({ kind: 'operation', id: `op:${log.id}`, at: log.at, log });
    }
    for (const resolution of resolutions) {
      out.push({ kind: 'resolution', id: `resolution:${resolution.id}`, at: resolution.resolvedAt, resolution });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [batchMap, batches, logs, logsByBatch, resolutions]);

  const initializationBurstSeconds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const log of logs) {
      if (log.batchId || log.op !== 'create') continue;
      const second = log.at.slice(0, 19);
      counts.set(second, (counts.get(second) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count >= 20).map(([second]) => second));
  }, [logs]);

  const entityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const log of logs) set.add(log.entityType);
    for (const resolution of resolutions) for (const type of resolutionEntityTypes(resolution)) set.add(type);
    return [...set].sort();
  }, [logs, resolutions]);

  const filtered = useMemo(() => events.filter((e) => {
    if (!isDateInRange(localDateOfInstant(e.at), range)) return false;
    if (kind !== 'all' && e.kind !== kind) return false;
    if (op !== 'all' && !(e.kind === 'operation' && e.log.op === op)) return false;
    if (entityType !== 'all' && !eventEntityTypes(e).includes(entityType)) return false;
    if (source === 'user') {
      if (eventSource(e) === 'system' || isInitializationBurst(e, initializationBurstSeconds) || isNoBusinessChange(e)) return false;
    } else if (source !== 'all' && eventSource(e) !== source) {
      return false;
    }
    const q = search.trim().toLowerCase();
    if (q && !eventSearchText(e).includes(q)) return false;
    return true;
  }), [entityType, events, initializationBurstSeconds, kind, op, range, search, source]);

  const selected = filtered.find((e) => e.id === selectedId) ?? filtered[0];

  return (
    <div className="zc-history-layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.05fr) minmax(360px, .95fr)', gap: 18, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div style={card}>
          <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 900 }}>操作历史</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 3 }}>共 {filtered.length} 条记录，默认隐藏系统初始化和无业务变化的技术日志；批量操作会折叠显示。</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => downloadText('zichan-audit-history.json', JSON.stringify({ exportedAt: new Date().toISOString(), events: filtered }, null, 2), 'application/json')} style={button}>导出 JSON</button>
              <button onClick={() => downloadText('zichan-audit-history.csv', eventsToCsv(filtered), 'text/csv;charset=utf-8')} style={button}>导出 CSV</button>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}><DateRangeBar value={range} onChange={setRange} view={view} onViewChange={setView} /></div>
          <div className="zc-history-filters" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))', gap: 10 }}>
            <select aria-label="历史记录类型" style={selectStyle} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="all">全部记录</option>
              <option value="operation">实体操作</option>
              <option value="batch">批量操作</option>
              <option value="resolution">冲突解决</option>
            </select>
            <select aria-label="历史操作类型" style={selectStyle} value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
              <option value="all">全部操作</option>
              <option value="create">新增</option>
              <option value="update">修改</option>
              <option value="delete">删除</option>
            </select>
            <select aria-label="历史对象类型" style={selectStyle} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              <option value="all">全部对象</option>
              {entityOptions.map((type) => <option key={type} value={type}>{entityLabel(type)}</option>)}
            </select>
            <select aria-label="历史来源" style={selectStyle} value={source} onChange={(e) => setSource(e.target.value as SourceFilter)}>
              <option value="user">用户相关</option>
              <option value="all">全部来源</option>
              <option value="local">本地</option>
              <option value="remote_sync">远程同步</option>
              <option value="import">导入</option>
              <option value="system">系统</option>
              <option value="conflict_resolution">冲突解决</option>
            </select>
            <input aria-label="历史搜索" className="zc-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索摘要、对象、字段、设备" style={{ gridColumn: 'span 3' }} />
          </div>
        </div>

        {view === 'list' ? <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr><th style={thStyle}>时间</th><th style={thStyle}>类型</th><th style={thStyle}>对象</th><th style={thStyle}>摘要</th><th style={thStyle}>字段</th></tr>
              </thead>
              <tbody>
                {filtered.map((event) => (
                  <tr key={event.id} onClick={() => setSelectedId(event.id)} style={{ cursor: 'pointer', background: selected?.id === event.id ? 'var(--surface-2)' : undefined }}>
                    <td style={tdStyle}>{formatTime(event.at)}</td>
                    <td style={tdStyle}>{eventKindLabel(event)}</td>
                    <td style={tdStyle}>{eventObjectLabel(event)}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'normal', minWidth: 220 }}>{eventSummary(event)}</td>
                    <td style={tdStyle}>{eventChangedKeys(event).slice(0, 4).map(fieldLabel).join(', ') || '—'}</td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={5}>暂无匹配的历史记录</td></tr>}
              </tbody>
            </table>
          </div>
        </div> : (
          <TimelineExplorer
            items={filtered}
            view={view}
            focusDate={focusDate}
            onFocusDate={setFocusDate}
            onViewChange={setView}
            dateOf={(event) => localDateOfInstant(event.at)}
            keyOf={(event) => event.id}
            renderCompact={(event) => <>{formatTime(event.at).slice(11, 16)} · <b>{eventKindLabel(event)}</b> · {eventSummary(event)}</>}
            renderEntry={(event) => <div className="zc-history-entry" style={{ display: 'grid', gridTemplateColumns: '150px 110px 120px minmax(0, 1fr)', gap: 12, alignItems: 'center' }}><span style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>{formatTime(event.at)}</span><b>{eventKindLabel(event)}</b><span>{eventObjectLabel(event)}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{eventSummary(event)}</span></div>}
            renderSummary={(rows) => <span style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>操作 {rows.filter((event) => event.kind === 'operation').length} · 批量 {rows.filter((event) => event.kind === 'batch').length} · 冲突 {rows.filter((event) => event.kind === 'resolution').length}</span>}
            onOpen={(event) => setSelectedId(event.id)}
            emptyText="该时间范围内没有操作历史。"
          />
        )}
      </div>

      <div className="zc-history-detail" style={{ position: 'sticky', top: 92 }}>
        <HistoryDetail
          event={selected}
          snap={snap}
          actionBusy={actionBusy}
          actionMessage={actionMessage}
          compensation={selected?.kind === 'batch' ? compensationByBatch.get(selected.batch.id) : undefined}
          onReverse={reverseOperation}
          onReverseBatch={reverseBatch}
        />
      </div>
    </div>
  );
}

function HistoryDetail({
  event,
  snap,
  actionBusy,
  actionMessage,
  compensation,
  onReverse,
  onReverseBatch,
}: {
  event?: HistoryEvent;
  snap: Snapshot | null;
  actionBusy: boolean;
  actionMessage: string;
  compensation?: BusinessCompensationRecord;
  onReverse: (log: OperationLogEntry) => Promise<void>;
  onReverseBatch: (compensation: BusinessCompensationRecord) => Promise<void>;
}) {
  if (!event) {
    return <div style={card}><div style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>选择一条历史记录查看详情</div></div>;
  }
  if (event.kind === 'batch') {
    return (
      <BatchDetail
        event={event}
        snap={snap}
        actionBusy={actionBusy}
        actionMessage={actionMessage}
        compensation={compensation}
        onReverse={onReverseBatch}
      />
    );
  }
  if (event.kind === 'resolution') return <ResolutionDetail resolution={event.resolution} />;
  return <OperationDetail log={event.log} snap={snap} actionBusy={actionBusy} actionMessage={actionMessage} onReverse={onReverse} />;
}

function OperationDetail({ log, snap, actionBusy, actionMessage, onReverse }: { log: OperationLogEntry; snap: Snapshot | null; actionBusy: boolean; actionMessage: string; onReverse: (log: OperationLogEntry) => Promise<void> }) {
  const diff = parseDiff(log);
  const reversible = (log.source ?? 'local') === 'local' && (log.entityType === 'transaction' || (log.entityType === 'conversion_chain' && Object.hasOwn(diff, 'recordState')));
  return (
    <div style={card}>
      <DetailHeader title={`${OP_LABEL[log.op]} ${entityLabel(log.entityType)}`} sub={`${formatTime(log.at)} · ${log.deviceId ?? '未知设备'} · ${SOURCE_LABEL[log.source ?? 'local'] ?? log.source ?? '本地'}`} />
      {reversible && <button type="button" disabled={actionBusy} onClick={() => void onReverse(log)} style={{ ...button, borderColor: 'var(--accent)', color: 'var(--accent)', marginBottom: 12 }}>{actionBusy ? '处理中…' : '撤销此操作'}</button>}
      {actionMessage && <div style={{ color: actionMessage === '已完成反向操作。' ? 'var(--positive)' : 'var(--negative)', fontSize: 12, fontWeight: 800, marginBottom: 12 }}>{actionMessage}</div>}
      <KeyTags keys={log.changedKeys ?? Object.keys(diff)} />
      <DiffTable diff={diff} snap={snap} />
      <JsonBlock title="操作后快照" value={log.afterPayload ?? log.payload} />
    </div>
  );
}

function BatchDetail({
  event,
  snap,
  actionBusy,
  actionMessage,
  compensation,
  onReverse,
}: {
  event: Extract<HistoryEvent, { kind: 'batch' }>;
  snap: Snapshot | null;
  actionBusy: boolean;
  actionMessage: string;
  compensation?: BusinessCompensationRecord;
  onReverse: (compensation: BusinessCompensationRecord) => Promise<void>;
}) {
  return (
    <div style={card}>
      <DetailHeader title={event.batch.label} sub={`${formatTime(event.batch.startedAt)} · ${event.batch.deviceId ?? '未知设备'} · ${event.logs.length || event.batch.entityCount} 条变更`} />
      {compensation?.status === 'pending' && (
        <button
          type="button"
          disabled={actionBusy}
          onClick={() => void onReverse(compensation)}
          style={{ ...button, borderColor: 'var(--accent)', color: 'var(--accent)', marginBottom: 12 }}
        >
          {actionBusy ? '撤销中…' : `撤销整个批次（${compensation.affectedEntities.length} 项）`}
        </button>
      )}
      {compensation?.status === 'applied' && <div style={{ color: 'var(--positive)', fontSize: 12, fontWeight: 800, marginBottom: 12 }}>该批次已完整撤销</div>}
      {compensation?.status === 'blocked' && <div style={{ color: 'var(--negative)', fontSize: 12, fontWeight: 800, marginBottom: 12 }}>不可撤销：{compensation.error ?? '相关对象后来发生了变化'}</div>}
      {actionMessage && <div style={{ color: actionMessage === '已完整撤销该批次。' ? 'var(--positive)' : 'var(--negative)', fontSize: 12, fontWeight: 800, marginBottom: 12 }}>{actionMessage}</div>}
      {event.batch.summary && <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 12 }}>{event.batch.summary}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {event.logs.map((log) => (
          <div key={log.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, fontWeight: 900 }}>
              <span>{OP_LABEL[log.op]} {entityLabel(log.entityType)} · {objectName(log)}</span>
              <span style={{ color: 'var(--fg-subtle)' }}>{(log.changedKeys ?? []).map(fieldLabel).join(', ') || '—'}</span>
            </div>
            <DiffTable diff={parseDiff(log)} compact snap={snap} />
          </div>
        ))}
        {event.logs.length === 0 && <div style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>这个批次暂无可展开的操作日志</div>}
      </div>
    </div>
  );
}

function ResolutionDetail({ resolution }: { resolution: SyncConflictResolution }) {
  const aggregates = resolutionAggregates(resolution);
  const changedPaths = resolutionChangedPaths(resolution);
  return (
    <div style={card}>
      <DetailHeader title={`冲突解决 · ${resolutionActionLabel(resolution.action)}`} sub={`${formatTime(resolution.resolvedAt)} · ${resolution.resolverDeviceId ?? '未知设备'} · 冲突组 ${resolution.groupId.slice(0, 8)}`} />
      <KeyTags keys={changedPaths} />
      <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: '8px 12px', fontSize: 12 }}>
        <span style={{ color: 'var(--fg-subtle)' }}>合并提交</span><code>{resolution.resolvedCommitId ?? '仅记录，未生成提交'}</code>
        <span style={{ color: 'var(--fg-subtle)' }}>影响聚合</span><span>{aggregates.map((row) => `${entityLabel(row.type)} ${row.id.slice(0, 8)}`).join('；') || '未记录'}</span>
        {resolution.note && <><span style={{ color: 'var(--fg-subtle)' }}>备注</span><span>{resolution.note}</span></>}
      </div>
      <JsonBlock title="解决详情" value={resolution.detailJson} />
    </div>
  );
}

function DetailHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 16, fontWeight: 900 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function KeyTags({ keys }: { keys: string[] }) {
  if (!keys.length) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
      {keys.map((key) => <span key={key} style={tagStyle}>{fieldLabel(key)}</span>)}
    </div>
  );
}

function DiffTable({ diff, compact = false, snap }: { diff: Record<string, { before: unknown; after: unknown }>; compact?: boolean; snap: Snapshot | null }) {
  const rows = Object.entries(diff);
  if (!rows.length) return <div style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>没有业务字段变化</div>;
  return (
    <div style={{ overflowX: 'auto', marginTop: compact ? 8 : 0 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        {!compact && <thead><tr><th style={thStyle}>字段</th><th style={thStyle}>改前</th><th style={thStyle}>改后</th></tr></thead>}
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <td style={tdStyle}>{fieldLabel(key)}</td>
              <td style={{ ...tdStyle, color: 'var(--fg-subtle)', whiteSpace: 'normal' }}>{shortValue(value.before, key, snap)}</td>
              <td style={{ ...tdStyle, whiteSpace: 'normal' }}>{shortValue(value.after, key, snap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value?: string }) {
  if (!value) return null;
  return (
    <details style={{ marginTop: 12 }}>
      <summary style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 900, cursor: 'pointer' }}>{title}</summary>
      <pre style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, color: 'var(--fg-muted)', background: 'var(--surface-2)', borderRadius: 8, padding: 10 }}>
        {prettyJson(value)}
      </pre>
    </details>
  );
}

function parseJson(value?: string): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function parseDiff(log: OperationLogEntry): Record<string, { before: unknown; after: unknown }> {
  if (log.diffJson) {
    const parsed = parseJson(log.diffJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, { before: unknown; after: unknown }>;
  }
  const before = parseJson(log.beforePayload);
  const after = parseJson(log.afterPayload ?? log.payload);
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return {};
  const keys = new Set([...Object.keys(before as Record<string, unknown>), ...Object.keys(after as Record<string, unknown>)]);
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of keys) {
    const a = (before as Record<string, unknown>)[key];
    const b = (after as Record<string, unknown>)[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) diff[key] = { before: a ?? null, after: b ?? null };
  }
  return diff;
}

function resolutionDetail(resolution: SyncConflictResolution): Record<string, unknown> {
  const parsed = parseJson(resolution.detailJson);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function resolutionAggregates(resolution: SyncConflictResolution): { type: string; id: string }[] {
  const values = resolutionDetail(resolution)['aggregates'];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const separator = value.indexOf('\u0000');
    if (separator < 1) return [];
    return [{ type: value.slice(0, separator), id: value.slice(separator + 1) }];
  });
}

function resolutionEntityTypes(resolution: SyncConflictResolution): string[] {
  return [...new Set(resolutionAggregates(resolution).map((row) => row.type))];
}

function resolutionChangedPaths(resolution: SyncConflictResolution): string[] {
  const values = resolutionDetail(resolution)['changedPaths'];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
}

function eventEntityTypes(event: HistoryEvent): string[] {
  if (event.kind === 'batch') return [...new Set(event.logs.map((l) => l.entityType))];
  if (event.kind === 'operation') return [event.log.entityType];
  return resolutionEntityTypes(event.resolution);
}

function eventChangedKeys(event: HistoryEvent): string[] {
  if (event.kind === 'batch') return [...new Set(event.logs.flatMap((l) => l.changedKeys ?? []))];
  if (event.kind === 'operation') return event.log.changedKeys ?? Object.keys(parseDiff(event.log));
  return resolutionChangedPaths(event.resolution);
}

function eventSearchText(event: HistoryEvent): string {
  return [
    eventKindLabel(event), eventObjectLabel(event), eventSummary(event), eventChangedKeys(event).join(' '),
    event.kind === 'operation' ? `${event.log.deviceId ?? ''} ${event.log.actorName ?? ''}` : '',
    event.kind === 'batch' ? `${event.batch.deviceId ?? ''} ${event.batch.actorName ?? ''}` : '',
    event.kind === 'resolution' ? `${event.resolution.resolverDeviceId ?? ''}` : '',
  ].join(' ').toLowerCase();
}

function eventSource(event: HistoryEvent): Exclude<SourceFilter, 'user' | 'all'> {
  if (event.kind === 'operation') return event.log.source ?? 'local';
  if (event.kind === 'resolution') return 'conflict_resolution';
  if (event.batch.type === 'system') return 'system';
  if (event.batch.type === 'import') return 'import';
  if (event.batch.type === 'sync') return 'remote_sync';
  if (event.batch.type === 'conflict_resolution') return 'conflict_resolution';
  return 'local';
}

function isInitializationBurst(event: HistoryEvent, burstSeconds: Set<string>): boolean {
  return event.kind === 'operation'
    && event.log.op === 'create'
    && !event.log.batchId
    && burstSeconds.has(event.log.at.slice(0, 19));
}

function isNoBusinessChange(event: HistoryEvent): boolean {
  if (event.kind === 'resolution') return false;
  if (event.kind === 'batch') return event.logs.length > 0 && event.logs.every(isTechnicalLog);
  return isTechnicalLog(event.log);
}

function isTechnicalLog(log: OperationLogEntry): boolean {
  const keys = log.changedKeys ?? Object.keys(parseDiff(log));
  if (keys.length === 0) return true;
  const technicalKeys = new Set(['createdAt', 'updatedAt', 'version']);
  return keys.every((key) => technicalKeys.has(key));
}

function eventKindLabel(event: HistoryEvent): string {
  if (event.kind === 'batch') return '批量操作';
  if (event.kind === 'resolution') return '冲突解决';
  return OP_LABEL[event.log.op];
}

function eventObjectLabel(event: HistoryEvent): string {
  if (event.kind === 'batch') return `${event.logs.length || event.batch.entityCount} 条变更`;
  if (event.kind === 'resolution') return `冲突组 · ${event.resolution.groupId.slice(0, 8)}`;
  return `${entityLabel(event.log.entityType)} · ${objectName(event.log)}`;
}

function eventSummary(event: HistoryEvent): string {
  if (event.kind === 'batch') return event.batch.summary ?? event.batch.label;
  if (event.kind === 'resolution') return `${resolutionActionLabel(event.resolution.action)}，${resolutionAggregates(event.resolution).length} 个聚合`;
  return `${OP_LABEL[event.log.op]} ${entityLabel(event.log.entityType)} ${objectName(event.log)}`;
}

function objectName(log: OperationLogEntry): string {
  const obj = parseJson(log.afterPayload ?? log.payload ?? log.beforePayload) as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return log.entityId.slice(0, 8);
  const name = obj['name'] ?? obj['title'] ?? obj['description'] ?? obj['merchant'] ?? obj['code'] ?? obj['id'];
  return String(name ?? log.entityId).slice(0, 32);
}

function entityLabel(type: string): string {
  return ENTITY_LABELS[type] ?? type;
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

function nameById<T extends { id: string }>(rows: T[] | undefined, id: unknown, pick: (row: T) => string): string | undefined {
  if (typeof id !== 'string') return undefined;
  const row = rows?.find((x) => x.id === id);
  return row ? pick(row) : undefined;
}

function humanValue(key: string, value: unknown, snap: Snapshot | null): string {
  if (value === undefined || value === null || value === '') return '空';
  if (Array.isArray(value)) return value.map((v) => humanValue(key, v, snap)).join(' / ') || '空';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (VALUE_LABELS[key]?.[String(value)]) return VALUE_LABELS[key]![String(value)]!;
  if (!snap) return typeof value === 'string' ? value : JSON.stringify(value);
  const id = String(value);
  if (key === 'category' || key === 'parentId') return categoryLabel(id, snap.categories);
  if (key === 'assetId' || key.endsWith('AssetId') || key === 'settlementAssetId' || key === 'finalAssetId') {
    return nameById(snap.assets, id, (a) => `${a.code} · ${a.name}`) ?? id;
  }
  if (key === 'accountId' || key.endsWith('AccountId')) return nameById(snap.accounts, id, (a) => a.name) ?? id;
  if (key === 'payeeId') return nameById(snap.payees, id, (p) => p.name) ?? id;
  if (key === 'locationId') return nameById(snap.transactionLocations, id, (l) => l.name) ?? id;
  if (key === 'tagIds') return nameById(snap.transactionTags, id, (t) => t.groupName ? `${t.groupName} / ${t.name}` : t.name) ?? id;
  if (key === 'gameId') return nameById(snap.games, id, (g) => g.name) ?? id;
  if (key === 'seasonId') return nameById(snap.seasons, id, (s) => s.name) ?? id;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function resolutionActionLabel(action: SyncConflictResolution['action']): string {
  if (action === 'keep_local') return '保留本地';
  if (action === 'keep_branch') return '采用所选分支';
  if (action === 'manual_merge') return '手动合并';
  if (action === 'accept_remote_merge') return '接受远端合并';
  return '仅导出';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

function prettyJson(value: string): string {
  const parsed = parseJson(value);
  return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
}

function shortValue(value: unknown, key = '', snap: Snapshot | null = null): string {
  if (value === undefined || value === null || value === '') return '空';
  const text = humanValue(key, value, snap);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function eventsToCsv(events: HistoryEvent[]): string {
  const rows = [['time', 'kind', 'object', 'summary', 'changedKeys']];
  for (const event of events) {
    rows.push([formatTime(event.at), eventKindLabel(event), eventObjectLabel(event), eventSummary(event), eventChangedKeys(event).map(fieldLabel).join('|')]);
  }
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
