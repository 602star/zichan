import { D } from '@zichan/core';
import { MapPin, CalendarDays, Bell } from 'lucide-react';
import type { FixedCardVM } from '../selectors/fixed.js';
import { money } from '../format.js';
import { AttachmentPreview } from './AttachmentPreview.js';
import { Card, CardMetric } from './Card.js';
import { EntityIcon } from './EntityIcon.js';

export function FixedInventoryCard({ item, icon, selected, onChoose, onOpen, onUsage, onRestore }: {
  item: FixedCardVM; icon?: string; selected: boolean;
  onChoose: () => void; onOpen: () => void; onUsage: () => void;
  onRestore: () => void;
}) {
  const primary = item.metrics.find((metric) => metric.raw.isPrimary) ?? item.metrics[0];
  const measured = primary && D(primary.total).gt(0);
  const cost = primary ? measured ? money(primary.perUnit, item.currencySymbol) : '尚未记录'
    : item.perDay === undefined ? '待补日期' : money(item.perDay, item.currencySymbol);
  const unit = primary ? measured ? primary.unitLabel : undefined : item.perDay === undefined ? undefined : '天';
  const costNote = primary ? measured ? `累计 ${primary.total} ${primary.unitLabel}` : '记录用量后计算单位成本'
    : item.perDay === undefined ? '只记年份，暂不计算日均' : `持有 ${item.days} 天`;
  const reminder = [...item.reminders].sort((a, b) => a.days - b.days)[0];
  const consumables = item.consumables.filter((row) => row.needsAttention).length;
  const pending = item.reminders.length + consumables;
  const usageAction = !!item.metrics.length && ['active', 'stored'].includes(item.raw.status);
  return <Card as="article" className="zc-fixed-item-card" data-fixed-item={item.id} aria-label={item.name}>
    <div className="zc-fixed-card-identity">
      <button type="button" className="zc-fixed-card-photo" aria-label={`查看 ${item.name}`} onClick={onOpen}>
        {item.imageAttachment
          ? <AttachmentPreview attachment={item.imageAttachment} alt={item.name} className="zc-fixed-inventory-photo" />
          : <EntityIcon icon={icon} fallback="package" size={36} />}
      </button>
      <div className="zc-fixed-card-name">
        <h3><button type="button" className="zc-workspace-link" onClick={onOpen}>{item.name}</button></h3>
        <span className="zc-caption">{[item.categoryParent, item.category].filter(Boolean).join(' / ')}</span>
        <span className={`zc-fixed-card-status${!item.raw.archivedAt && item.raw.status === 'active' ? ' is-active' : item.raw.archivedAt || !['active', 'stored'].includes(item.raw.status) ? ' is-disposed' : ''}`}>{item.raw.archivedAt ? '已归档 · ' : ''}{item.status}</span>
      </div>
    </div>
    <div className="zc-fixed-card-context">
      <span><MapPin size={16} aria-hidden="true" />{item.locationPath}</span>
      <span><CalendarDays size={16} aria-hidden="true" />{item.raw.purchaseDate.slice(0, 4)} 年购置</span>
    </div>
    <div className="zc-card-band is-inset zc-fixed-card-costs">
      <CardMetric label="累计净投入" value={money(item.net, item.currencySymbol)} note={D(item.operatingCost).gt(0) ? `含使用费用 ${money(item.operatingCost, item.currencySymbol)}` : item.installedComponents.length ? '含已归属配件' : undefined} />
      <CardMetric label={primary ? '单位使用成本' : '持有日均'} value={<>{cost}{unit && <span className="zc-fixed-card-unit"> / {unit}</span>}</>} note={costNote} />
    </div>
    <div className={`zc-fixed-card-reminder${pending ? ' has-pending' : ''}`}>
      {pending ? <><Bell size={16} aria-hidden="true" /><span>{reminder ? <>{reminder.label} · {reminder.days < 0 ? `逾期 ${-reminder.days} 天` : reminder.days === 0 ? '今天到期' : `剩 ${reminder.days} 天`}<small>{reminder.date}{pending > 1 ? ` · 另有 ${pending - 1} 项待处理` : ''}</small></> : <>有 {consumables} 项耗材待处理<small>打开详情查看余量与更换记录</small></>}</span></>
        : <span>{item.warrantyLabel}</span>}
    </div>
    <div className="zc-fixed-card-footer">
      {item.raw.archivedAt ? <span className="zc-caption">档案已收起</span> : <label className="zc-fixed-check"><input type="checkbox" aria-label={`选择 ${item.name}`} checked={selected} onChange={onChoose} />选择</label>}
      <button type="button" className="zc-btn" onClick={item.raw.archivedAt ? onRestore : usageAction ? onUsage : onOpen}>{item.raw.archivedAt ? '恢复档案' : usageAction ? '记录使用' : item.sold ? '查看结算' : '查看详情'}</button>
    </div>
  </Card>;
}
