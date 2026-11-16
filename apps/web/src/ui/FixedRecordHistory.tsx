import { useRef, useState } from 'react';
import type { FixedCardVM } from '../selectors/fixed.js';
import { fixedRecordMonths, fixedRecordPage, fixedRecordProject, operatingRecord, type FixedRecordKind } from '../selectors/fixed-records.js';
import type { FixedItemActions } from './FixedItemDetail.js';
import { CardEmpty, CardGroup } from './Card.js';

const kinds: Record<FixedRecordKind, string> = { all: '全部记录', operating: '使用费用与抄表', unpriced: '待补费用', usage: '使用量', lifecycle: '生命周期', consumable: '耗材' };

export function FixedRecordHistory({ item, actions, kind, onKindChange }: {
  item: FixedCardVM; actions: FixedItemActions; kind: FixedRecordKind; onKindChange: (kind: FixedRecordKind) => void;
}) {
  const [month, setMonth] = useState('all');
  const [project, setProject] = useState('all');
  const [page, setPage] = useState(1);
  const heading = useRef<HTMLHeadingElement>(null);
  const result = fixedRecordPage(item, { kind, month, project, page });
  const projects = new Map(item.timeline.flatMap((entry) => {
    const data = operatingRecord(entry);
    return data ? [[fixedRecordProject(entry)!, `${data.name} · ${data.unit}`] as const] : [];
  }));
  function changePage(next: number) {
    setPage(next);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }
  return <CardGroup className="zc-fixed-record-history">
    <h3 tabIndex={-1} ref={heading}>物品记录</h3>
    <div className="zc-fixed-history-filters">
      <label>记录类型<select className="zc-select" value={kind} onChange={(event) => { onKindChange(event.target.value as FixedRecordKind); setProject('all'); setPage(1); }}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>记录月份<select className="zc-select" value={month} onChange={(event) => { setMonth(event.target.value); setPage(1); }}><option value="all">全部月份</option>{fixedRecordMonths(item).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      {['operating', 'unpriced'].includes(kind) && <label>费用项目<select className="zc-select" value={project} onChange={(event) => { setProject(event.target.value); setPage(1); }}><option value="all">全部费用项目</option>{[...projects].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    </div>
    <div className="zc-fixed-toolbar"><p className="zc-caption" role="status">共 {result.total} 条{result.total > 0 ? ` · 当前第 ${result.start + 1}–${result.start + result.rows.length} 条` : ''} · 每页最多 10 条</p>{(kind !== 'all' || month !== 'all') && <button type="button" className="zc-btn" onClick={() => { onKindChange('all'); setMonth('all'); setProject('all'); setPage(1); }}>清除记录筛选</button>}</div>
    <div className="zc-fixed-history-records">
      {result.rows.map((entry) => <button type="button" className="zc-fixed-record-row" key={`${entry.kind}:${entry.id}`} onClick={() => actions.onTimeline(item, entry)}><span>{item.raw.purchaseDatePrecision === 'year' && entry.kind === 'event' && 'type' in entry.raw && entry.raw.type === 'purchase' ? `${entry.date.slice(0, 4)} 年（日期未补）` : entry.date}</span><span>{entry.label}<small>{entry.detail}</small></span><span>{entry.amount ? `${entry.moneyKind === 'spend' ? '−' : entry.moneyKind === 'recover' ? '+' : entry.moneyKind === 'reference' ? '参考 ' : ''}${entry.amount}` : '查看'}</span></button>)}
      {!result.rows.length && <CardEmpty>此筛选下没有记录，可更换月份或清除筛选。</CardEmpty>}
    </div>
    {result.total > 0 && <nav className="zc-fixed-history-pager" aria-label="物品记录翻页"><button type="button" className="zc-btn" disabled={result.page === 1} onClick={() => changePage(result.page - 1)}>上一页</button><span aria-label={`第 ${result.page} 页，共 ${result.pageCount} 页`}>{result.page} / {result.pageCount}</span><button type="button" className="zc-btn" disabled={result.page === result.pageCount} onClick={() => changePage(result.page + 1)}>下一页</button></nav>}
  </CardGroup>;
}
