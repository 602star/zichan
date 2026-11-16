import { useEffect, useRef, useState } from 'react';
import { D, dayOfInstant, fixedLocationMoves, type Attachment, type FixedAsset, type FixedAssetConsumable, type FixedAssetEvent, type FixedAssetGoal, type FixedAssetUsageMetric } from '@zichan/core';
import type { FixedCardVM, FixedTimelineVM } from '../selectors/fixed.js';
import { amount, money } from '../format.js';
import { Card, CardAlert, CardEmpty, CardFact, CardGroup, CardMetric } from './Card.js';
import { MobilePageHeader } from './MobilePage.js';
import { AttachmentPreview } from './AttachmentPreview.js';
import { useTabSet } from './useTabSet.js';
import { FixedOperatingCosts } from './FixedOperatingCosts.js';
import { FixedRecordHistory } from './FixedRecordHistory.js';
import type { FixedRecordKind } from '../selectors/fixed-records.js';
import type { FixedOperatingPreset } from '../fixed-operating-form.js';

export interface FixedItemActions {
  onEdit: (asset: FixedAsset) => void;
  onEvent: (assetId: string) => void;
  onAddComponent: (hostId: string, bundled: boolean) => void;
  onPlacement: (assetId: string) => void;
  onConvertUpgrade: (host: FixedAsset, event: FixedAssetEvent) => void;
  onMetric: (assetId: string, metric?: FixedAssetUsageMetric) => void;
  onUsage: (metric: FixedAssetUsageMetric) => void;
  onOperating: (assetId: string, preset?: FixedOperatingPreset) => void;
  onConsumable: (assetId: string, item?: FixedAssetConsumable) => void;
  onGoal: (assetId: string, goal?: FixedAssetGoal) => void;
  onTimeline: (item: FixedCardVM, entry: FixedTimelineVM) => void;
  onMaintenance: (item: FixedCardVM) => void;
}

const tabNames = { overview: '概况', usage: '使用与成本', parts: '配件耗材', history: '记录与凭证' } as const;
const attachmentRoleLabels: Record<string, string> = { image: '物品照片', invoice: '发票', warranty: '保修凭证', manual: '说明书' };
type DetailTab = keyof typeof tabNames;

export function FixedItemDetail({ item, items, attachments, actions, onBack, onOpen, onAttachment, initialTab = 'overview', timezone }: {
  item: FixedCardVM; items: FixedCardVM[]; attachments: Attachment[]; actions: FixedItemActions;
  onBack: () => void; onOpen: (item: FixedCardVM) => void; onAttachment: (attachment: Attachment) => void; initialTab?: DetailTab; timezone?: string;
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [historyKind, setHistoryKind] = useState<FixedRecordKind>('all');
  const historyTarget = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (historyTarget.current && tab === 'history') {
      historyTarget.current = false;
      panel.current?.focus({ preventScroll: true });
      panel.current?.scrollIntoView({ block: 'start' });
    }
  }, [tab]);
  function showHistory(kind: FixedRecordKind) {
    setHistoryKind(kind);
    historyTarget.current = true;
    setTab('history');
  }
  const tabs = useTabSet(['overview', 'usage', 'parts', 'history'] as const, tab, setTab);
  const cash = (value: string) => money(value, item.currencySymbol);
  const primary = item.metrics.find((metric) => metric.raw.isPrimary) ?? item.metrics[0];
  const canPlace = !item.sold && ['active', 'stored'].includes(item.raw.status);
  const parts = items.filter((part) => part.installedHostId === item.id || part.costOwnerId === item.id);
  const history = fixedLocationMoves(item.raw.locationMovesJson).slice().reverse();
  return <div className="zc-fixed-item-detail">
    <MobilePageHeader title={item.name} onBack={onBack} backLabel="返回物品" />
    <div className="zc-fixed-toolbar"><p className="zc-caption">{item.categoryParent} / {item.category} · {item.status} · {item.locationPath}</p><div className="zc-fixed-actions">
      {!item.sold && primary && <button type="button" className="zc-btn zc-btn--primary" onClick={() => actions.onUsage(primary.raw)}>记录使用</button>}
      <button type="button" className="zc-btn" onClick={() => actions.onOperating(item.id)}>记录使用费用</button>
      <button type="button" className="zc-btn" onClick={() => actions.onEdit(item.raw)}>编辑资料</button><button type="button" className="zc-btn" onClick={() => actions.onEvent(item.id)}>记录生命周期事件</button>
    </div></div>
    <div className="zc-tabs" role="tablist" aria-label="物品详情">{(Object.keys(tabNames) as DetailTab[]).map((id) => <button type="button" key={id} {...tabs.tabProps(id)} className={tab === id ? 'zc-tab is-active' : 'zc-tab'}>{tabNames[id]}</button>)}</div>
    <div ref={panel} {...tabs.panelProps}>
      {tab === 'overview' && <Card>
        {item.imageAttachment && <AttachmentPreview attachment={item.imageAttachment} alt={item.name} className="zc-fixed-detail-image" />}
        <div className="zc-card-band is-inset zc-fixed-detail-metrics"><CardMetric label="累计净投入" value={cash(item.net)} note={item.sold ? '处置后的最终净投入' : '实际投入减实际回款'} />
          <CardMetric label="持有日均净投入" value={item.perDay === undefined ? <span className="zc-fixed-metric-empty">待补准确日期</span> : `${cash(item.perDay)} / 天`} note={item.days === undefined ? '购买日期只记到年份' : `${item.days} 天，包含闲置期间`} />
          <CardMetric label="主使用指标" value={primary ? `${amount(primary.total, 2)} ${primary.unitLabel}` : <button type="button" className="zc-workspace-link zc-fixed-metric-empty" onClick={() => actions.onMetric(item.id)}>添加使用指标</button>} note={primary && D(primary.total).gt(0) ? `${cash(primary.perUnit)} / ${primary.unitLabel}` : '可按次数、公里或小时记录'} /></div>
        {item.isComponent && item.costOwner && <CardAlert>配件费用已归属 {item.costOwner}，汇总时不再单独相加。</CardAlert>}
        {(item.reminders.length > 0 || item.consumables.some((row) => row.needsAttention)) && <CardGroup><h3>待处理</h3>{item.reminders.map((reminder) => <div className="zc-fixed-location-row" key={reminder.id}><span>{reminder.label} · {reminder.date} · {reminder.days < 0 ? `逾期 ${-reminder.days} 天` : `剩 ${reminder.days} 天`}</span><button type="button" className="zc-btn" onClick={() => reminder.kind === 'maintenance' ? actions.onMaintenance(item) : setTab('history')}>{reminder.kind === 'maintenance' ? '完成保养' : '查看凭证与记录'}</button></div>)}{item.consumables.some((row) => row.needsAttention) && <button type="button" className="zc-btn" onClick={() => setTab('parts')}>处理耗材</button>}</CardGroup>}
        <CardGroup><h3>物品档案</h3><div className="zc-fixed-facts"><CardFact label="分类" value={`${item.categoryParent} / ${item.category}`} /><CardFact label="存放位置" value={item.locationPath} /><CardFact label="购入日期" value={item.raw.purchaseDatePrecision === 'year' ? `${item.raw.purchaseDate.slice(0, 4)} 年（准确日期未补）` : item.raw.purchaseDate} /><CardFact label="品牌型号" value={[item.raw.brand, item.raw.model].filter(Boolean).join(' ') || '未记录'} /><CardFact label="参考现值" value={item.referenceValue !== undefined ? `${cash(item.referenceValue)}（手动记录）` : '未记录'} /><CardFact label="保修" value={item.warrantyLabel} />{item.raw.serialNumber && <CardFact label="序列号" value={item.raw.serialNumber} />}{item.raw.barcode && <CardFact label="设备码" value={item.raw.barcode} />}{item.raw.purchaseMerchant && <CardFact label="购入商户" value={item.raw.purchaseMerchant} />}{item.raw.orderNumber && <CardFact label="订单号" value={item.raw.orderNumber} />}</div>{item.raw.note && <p className="zc-fixed-note">{item.raw.note}</p>}</CardGroup>
        <CardGroup><h3>净投入从哪里来</h3><div className="zc-fixed-facts">{item.rows.map((row) => <CardFact key={row.l} label={row.l} value={row.v} />)}</div><p className="zc-caption">参考现值单独展示，不抵扣净投入。持有日均不是自动折旧；实际用量只依据使用记录。</p></CardGroup>
      </Card>}
      {tab === 'usage' && <Card title="使用与成本">
        <FixedOperatingCosts item={item} actions={actions} onViewHistory={() => showHistory('operating')} onViewUnpriced={() => showHistory('unpriced')} />
        <CardGroup><div className="zc-fixed-toolbar"><h3>使用量指标</h3><button type="button" className="zc-btn" onClick={() => actions.onMetric(item.id)}>添加使用指标</button></div>
        {!item.metrics.length && <CardEmpty>添加次数、公里、小时或自定义单位，即可记录使用并查看单位成本。</CardEmpty>}
        {item.metrics.map((metric) => <div className="zc-fixed-location-row" key={metric.raw.id}><div><span>{metric.raw.name}{metric.raw.isPrimary ? ' · 主指标' : ''}</span><small>累计 {amount(metric.total, 4)} {metric.unitLabel} · {D(metric.total).gt(0) ? `${cash(metric.perUnit)} / ${metric.unitLabel}` : '待记录用量'} · {metric.raw.entryMode === 'meter' ? '累计读数' : '每次增加用量'}</small></div><div className="zc-fixed-actions"><button type="button" className="zc-btn" onClick={() => actions.onUsage(metric.raw)}>记录使用</button><button type="button" className="zc-btn" aria-label={`编辑指标 ${metric.raw.name}`} onClick={() => actions.onMetric(item.id, metric.raw)}>编辑</button></div></div>)}
        </CardGroup>
        <CardGroup><div className="zc-fixed-toolbar"><h3>成本目标</h3><button type="button" className="zc-btn" onClick={() => actions.onGoal(item.id)}>新增成本目标</button></div>{!item.goals.length && <CardEmpty>可设置目标使用量或目标单位成本。</CardEmpty>}{item.goals.map((goal) => <div className="zc-fixed-location-row" key={goal.raw.id}><div><span>{goal.raw.name} · {goal.achieved ? '已达成' : '进行中'}</span><small>{amount(goal.currentUsage, 2)} / {amount(goal.targetUsage, 2)} {goal.unitLabel} · 目标采用保存时冻结的成本基数</small></div><button type="button" className="zc-btn" aria-label={`编辑目标 ${goal.raw.name}`} onClick={() => actions.onGoal(item.id, goal.raw)}>编辑</button></div>)}</CardGroup>
        <CardGroup><h3>使用记录</h3>{item.timeline.filter((entry) => entry.kind === 'usage').slice(0, 5).map((entry) => <button type="button" className="zc-fixed-record-row" key={entry.id} onClick={() => actions.onTimeline(item, entry)}><span>{entry.date}</span><span>{entry.label} · {entry.detail}</span><span>编辑</span></button>)}{!item.timeline.some((entry) => entry.kind === 'usage') && <CardEmpty>还没有使用记录。</CardEmpty>}<button type="button" className="zc-btn" onClick={() => showHistory('usage')}>查看全部使用记录</button></CardGroup>
      </Card>}
      {tab === 'parts' && <Card title="配件与耗材">
        <div className="zc-fixed-actions">{canPlace && (item.isComponent ? <button type="button" className="zc-btn" onClick={() => actions.onPlacement(item.id)}>{item.installedIn ? '拆下或转装配件' : '安装配件'}</button> : <><button type="button" className="zc-btn" onClick={() => actions.onAddComponent(item.id, false)}>购入配件</button><button type="button" className="zc-btn" onClick={() => actions.onAddComponent(item.id, true)}>登记原配件</button></>)}<button type="button" className="zc-btn" onClick={() => actions.onConsumable(item.id)}>登记耗材</button></div>
        <CardGroup><h3>可追踪配件</h3>{!parts.length && <CardEmpty>{item.isComponent ? `当前${item.installedIn ? `安装于 ${item.installedIn}` : '未安装'}` : '还没有关联配件。'}</CardEmpty>}{parts.map((part) => <div className="zc-fixed-location-row" key={part.id}><div><button type="button" className="zc-workspace-link" onClick={() => onOpen(part)}>{part.name}</button><small>{part.installedIn ? `安装于 ${part.installedIn}` : '未安装'} · {part.costOwner ? `费用归属 ${part.costOwner}` : '独立计算费用'}</small></div><button type="button" className="zc-btn" onClick={() => actions.onPlacement(part.id)}>安装与转装</button></div>)}</CardGroup>
        <CardGroup><h3>耗材</h3>{!item.consumables.length && <CardEmpty>可登记滤芯、刷头等耗材及其寿命阈值。</CardEmpty>}{item.consumables.map((row) => <div className="zc-fixed-location-row" key={row.raw.id}><div><span>{row.raw.name}</span><small>{row.remaining !== undefined ? `预计剩余 ${amount(row.remaining, 2)} ${row.unitLabel ?? ''}` : '未设置寿命指标'} · {cash(row.raw.amountBase)}{row.needsAttention ? ' · 已到提醒阈值' : ''}</small></div><button type="button" className="zc-btn" aria-label={`管理耗材 ${row.raw.name}`} onClick={() => actions.onConsumable(item.id, row.raw)}>管理与更换</button></div>)}</CardGroup>
        {canPlace && !item.isComponent && <CardGroup><h3>已有升级支出</h3>{item.timeline.filter((entry) => entry.kind === 'event' && (entry.raw as FixedAssetEvent).type === 'upgrade' && D((entry.raw as FixedAssetEvent).amountBase).gt(0)).map((entry) => <button type="button" className="zc-btn" key={entry.id} onClick={() => actions.onConvertUpgrade(item.raw, entry.raw as FixedAssetEvent)}>将 {entry.date} 的升级支出转为配件</button>)}</CardGroup>}
      </Card>}
      {tab === 'history' && <Card title="记录与凭证" action={<button type="button" className="zc-btn" onClick={() => actions.onEdit(item.raw)}>管理图片与凭证</button>}>
        <FixedRecordHistory item={item} actions={actions} kind={historyKind} onKindChange={setHistoryKind} />
        <CardGroup><h3>位置变更</h3>{!history.length && <CardEmpty>还没有位置变更记录。</CardEmpty>}{history.map((move, index) => <div className="zc-fixed-record-row" key={`${move.at}:${index}`}><span>{dayOfInstant(move.at, timezone)}</span><span>{move.from} → {move.to}</span></div>)}</CardGroup>
        <CardGroup><h3>图片、发票与保修凭证</h3>{!attachments.length && <CardEmpty>尚未添加凭证，可从“管理图片与凭证”补充。</CardEmpty>}{attachments.map((attachment) => <button type="button" className="zc-fixed-record-row" key={attachment.id} onClick={() => onAttachment(attachment)}><span>{attachmentRoleLabels[attachment.role ?? ''] ?? '附件'}</span><span>{attachment.fileName}</span><span>下载</span></button>)}</CardGroup>
      </Card>}

    </div>
  </div>;
}
