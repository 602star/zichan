import { useState } from 'react';
import { ChevronRight, CreditCard, ReceiptText } from 'lucide-react';
import type { Snapshot } from '../db/snapshot.js';
import type { DashboardAgendaItem } from '../selectors/dashboard-agenda.js';
import { navigateTo } from '../screen-target.js';
import { num } from '../format.js';
import { Card, CardEmpty } from './Card.js';

export function DashboardAgenda({ items, assets, today, compact }: { items: DashboardAgendaItem[]; assets: Snapshot['assets']; today: string; compact: boolean }) {
  const [filter, setFilter] = useState<'all' | DashboardAgendaItem['kind']>('all');
  const [expanded, setExpanded] = useState(false);
  const filtered = items.filter((item) => filter === 'all' || item.kind === filter);
  const limit = compact ? 2 : 5;
  const shown = expanded ? filtered : filtered.slice(0, limit);
  return <Card className="zc-dashboard-agenda" title="账单与还款" note="未来 30 天及待补记账单"
    action={<button type="button" className="zc-btn zc-btn--sm" onClick={() => navigateTo({ screen: 'transactions', tab: 'bills', id: 'new' })}>新增账单</button>}
    footer={<div className="zc-dashboard-agenda-foot"><span>按今天 {today} 提醒，无需关联账户</span><button type="button" className="zc-workspace-link" onClick={() => navigateTo({ screen: 'transactions', tab: 'bills' })}>管理全部计划</button><button type="button" className="zc-workspace-link" onClick={() => navigateTo({ screen: 'transactions', tab: 'accounts' })}>账户还款日期</button></div>}>
    <div className="zc-dashboard-agenda-filters" role="group" aria-label="提醒类型">
      {([['all', '全部'], ['scheduled', '账单计划'], ['repayment', '账户日期']] as const).map(([id, label]) => <button key={id} type="button"
        className={`zc-btn zc-btn--sm${filter === id ? ' zc-btn--primary' : ' zc-btn--ghost'}`} aria-label={label} aria-pressed={filter === id}
        onClick={() => { setFilter(id); setExpanded(false); }}>{label}<span className="zc-agenda-count">{id === 'all' ? items.length : items.filter((item) => item.kind === id).length}</span></button>)}
    </div>
    {shown.length ? <ul className="zc-dashboard-agenda-list">{shown.map((item) => {
      const asset = assets.find((row) => row.id === item.assetId);
      const Icon = item.kind === 'repayment' ? CreditCard : ReceiptText;
      return <li key={item.id}><button type="button" className={`zc-agenda-row is-${item.status}`} onClick={() => navigateTo(item.target)}>
        <time dateTime={item.date} className="zc-agenda-date"><span>{item.date.slice(5)}</span><Icon size={18} aria-hidden="true" /></time>
        <span className="zc-agenda-copy"><span className="zc-agenda-heading"><span className="zc-agenda-title">{item.title}</span><span className="zc-agenda-state">{item.statusLabel}</span></span><span className="zc-agenda-detail">{item.detail}</span></span>
        <span className="zc-agenda-value">{item.amount != null ? <span>{num(item.amount, asset?.decimals ?? 8)} {asset?.code ?? item.assetId}</span> : <span className="zc-agenda-calendar-label">日期提醒</span>}<ChevronRight size={16} aria-hidden="true" /></span>
      </button></li>;
    })}</ul> : <CardEmpty>{filter === 'repayment' ? '近期没有还款日提醒，可在账户中设置账单日和还款日。' : filter === 'scheduled' ? '近期没有待登记账单，可添加房租、订阅等定期计划。' : '近期没有账单或还款日提醒，可添加定期账单或设置信用卡日期。'}</CardEmpty>}
    {filtered.length > limit && <button type="button" className="zc-workspace-link zc-agenda-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起提醒' : `展开其余 ${filtered.length - limit} 项`}</button>}
  </Card>;
}
