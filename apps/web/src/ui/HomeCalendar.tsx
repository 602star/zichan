import { useEffect, useId, useMemo, useState } from 'react';
import { CalendarDays, Cake, Check, ChevronLeft, ChevronRight, Clock3, FileText, MapPin, Maximize2, Minimize2, Plus, ReceiptText, Settings, SlidersHorizontal, X } from 'lucide-react';
import { addDays, addMonths, calendarDayInfo, calendarWeekStart, CALENDAR_KIND_LABELS, CALENDAR_REPEAT_LABELS, D, daysBetween, endOfMonth, newId, parseCalendarPreferences, parseDay,
  type CalendarEntry, type CalendarKind, type CalendarPreferences, type QueryCursor } from '@zichan/core';
import { newCalendarEntry, setCalendarOccurrenceStatus, type TransactionBrowsePage, type TransactionReportAggregateRow } from '@zichan/db';
import type { Snapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { cacheCalendarDisplay } from '../calendar-display.js';
import { buildHomeCalendar, type HomeCalendarItem, type HomeCalendarSource } from '../selectors/home-calendar.js';
import { createReportCurrency } from '../reportCurrency.js';
import { num } from '../format.js';
import { navigateTo } from '../screen-target.js';
import { CalendarDatePicker } from './CalendarDatePicker.js';
import { CalendarEntryEditor } from './CalendarEntryEditor.js';
import { Card, CardEmpty } from './Card.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DialogShell } from './DialogShell.js';
import './home-calendar.css';

type View = CalendarPreferences['defaultView'];
const viewLabels: Record<View, string> = { month: '月', week: '周', day: '日', year: '年', agenda: '议程' };
const sourceLabels: Record<HomeCalendarSource, string> = { personal: '个人事项', bills: '账单计划', accounts: '账户日期', assets: '物品提醒', dca: '定投计划' };
const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
const isoDays = (from: string, to: string) => Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));

function CalendarTransactionLinks({ ids }: { ids: string[] }) {
  const { store } = useStore();
  const [links, setLinks] = useState<{ id: string; text: string; available: boolean }[]>([]);
  const [failed, setFailed] = useState(false);
  const key = ids.join('\0');
  useEffect(() => {
    let cancelled = false;
    void Promise.all(key.split('\0').filter(Boolean).map(async id => {
      const row = await store.transactions.get(id);
      return { id, available: !!row && !row.isDeleted, text: !row || row.isDeleted ? '关联流水已删除或不存在' : `${row.date} · ${row.description || row.merchant || '收支记录'} · ${row.amount}${row.recordState === 'voided' ? ' · 已作废' : ''}` };
    })).then(rows => { if (!cancelled) setLinks(rows); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [key, store]);
  return <>{failed && <p role="alert">关联流水暂时无法读取，请关闭后重试。</p>}{links.map(link => <button type="button" className="zc-calendar-search-result" key={link.id} disabled={!link.available} onClick={() => navigateTo({ screen: 'transactions', tab: 'records', id: link.id })}>{link.text}</button>)}</>;
}

export function HomeCalendar({ snap, today }: { snap: Snapshot; today: string }) {
  const { store, bump, rev, preview } = useStore();
  const [date, setDate] = useState(today);
  const preferences = useMemo(() => parseCalendarPreferences(snap.setting?.calendarPreferencesJson), [snap.setting?.calendarPreferencesJson]);
  const [view, setView] = useState<View>(preferences.defaultView);
  const [expanded, setExpanded] = useState(preferences.defaultView === 'year');
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [hiddenSources, setHiddenSources] = useState<HomeCalendarSource[]>([]);
  const [showCompleted, setShowCompleted] = useState(true);
  const [editor, setEditor] = useState<{ entry: CalendarEntry; replace?: { entryId: string; date: string; version: number } } | null>(null);
  const [detail, setDetail] = useState<HomeCalendarItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HomeCalendarItem | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [summary, setSummary] = useState<{ key: string; rows: TransactionReportAggregateRow[] } | null>(null);
  const [pageData, setPageData] = useState<{ key: string; page: TransactionBrowsePage } | null>(null);
  const [cursor, setCursor] = useState<QueryCursor | undefined>();
  const [agendaPage, setAgendaPage] = useState(0);
  const titleId = useId();
  const timezone = snap.setting?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const month = date.slice(0, 7);
  const from = view === 'year' ? `${date.slice(0, 4)}-01-01` : view === 'agenda' ? date : view === 'day' ? date : view === 'week'
    ? calendarWeekStart(date, preferences.firstDay) : `${month}-01`;
  const to = view === 'year' ? `${date.slice(0, 4)}-12-31` : view === 'agenda' ? addDays(date, 89) : view === 'day' ? date : view === 'week' ? addDays(from, 6) : endOfMonth(date);
  const summaryKey = `${from}:${to}:${rev}:${retry}`;
  const pageKey = `${date}:${rev}:${JSON.stringify(cursor)}:${retry}`;
  const items = useMemo(() => buildHomeCalendar(snap, from, to), [snap, from, to]);
  const filtered = items.filter(item => !hiddenSources.includes(item.source) && (showCompleted || !item.completed)
    && (kind === 'all' || (kind === 'reminders' ? item.source !== 'personal' || item.occurrence?.entry.kind === 'todo' : item.occurrence?.entry.kind === kind))
    && (!search.trim() || `${item.title} ${item.detail}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const selectedItems = filtered.filter(item => item.date <= date && item.endDate >= date);
  const shownAgendaPage = Math.min(agendaPage, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  const info = calendarDayInfo(date);
  const readyPage = pageData?.key === pageKey ? pageData.page : undefined;

  useEffect(() => cacheCalendarDisplay(preferences), [preferences]);
  useEffect(() => { let cancelled = false;
    void store.transactionBrowseAggregate({ from, to, recordState: 'active' }).then(rows => { if (!cancelled) setSummary({ key: summaryKey, rows }); }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [store, from, to, summaryKey]);
  useEffect(() => { let cancelled = false;
    void store.transactionBrowsePage({ from: date, to: date, limit: 20, cursor, recordState: 'active' }).then(page => { if (!cancelled) setPageData({ key: pageKey, page }); }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [store, date, pageKey, cursor]);
  const report = useMemo(() => createReportCurrency(snap), [snap]);
  const dailyTotals = useMemo(() => {
    const values = new Map<string, { income: ReturnType<typeof D>; expense: ReturnType<typeof D>; incomplete: boolean }>();
    for (const row of summary?.key === summaryKey ? summary.rows : []) {
      const current = values.get(row.reportDate) ?? { income: D(0), expense: D(0), incomplete: false };
      const amount = report.toReportAt(row.amounts.reduce((value, part) => value.plus(part), D(0)), row.reportAssetId, row.reportDate);
      if (amount === undefined) current.incomplete = true; else current[row.direction] = current[row.direction].plus(amount);
      values.set(row.reportDate, current);
    }
    return values;
  }, [summary, summaryKey, report]);

  const selectedTotals = dailyTotals.get(date);
  function changeView(next: View) { setView(next); setAgendaPage(0); if (next === 'year') setExpanded(true); }

  function focus(day: string) { setDate(day); setCursor(undefined); setAgendaPage(0); }
  function move(direction: number) { focus(view === 'year' ? addMonths(date, direction * 12) : view === 'month' ? addMonths(date, direction) : addDays(date, direction * (view === 'week' ? 7 : view === 'agenda' ? 30 : 1))); }
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); bump(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  function create(kind: CalendarKind = 'event') { setEditor({ entry: { ...newCalendarEntry(date, timezone), kind, repeat: kind === 'birthday' || kind === 'anniversary' ? 'yearly' : 'none' } }); }
  function edit(item: HomeCalendarItem, onlyThis: boolean) {
    const occurrence = item.occurrence; if (!occurrence) return;
    if (!onlyThis || occurrence.entry.repeat === 'none') setEditor({ entry: occurrence.entry });
    else setEditor({ entry: { ...occurrence.entry, id: newId(), createdAt: '', updatedAt: '', version: 1, startDate: occurrence.date, endDate: occurrence.endDate,
      repeat: 'none', calendar: 'solar', kind: ['birthday', 'anniversary'].includes(occurrence.entry.kind) ? 'event' : occurrence.entry.kind, untilDate: undefined, repeatCount: undefined },
      replace: { entryId: occurrence.entry.id, date: occurrence.date, version: occurrence.entry.version } });
    setDetail(null);
  }
  function itemButton(item: HomeCalendarItem, compact = false) {
    const entry = item.occurrence?.entry; const Icon = entry?.kind === 'birthday' ? Cake : item.source === 'bills' ? ReceiptText : entry?.kind === 'note' ? FileText : CalendarDays;
    return <button type="button" key={item.id} className={`zc-home-calendar-item${item.completed ? ' is-completed' : ''}${compact ? ' is-compact' : ''}`} onClick={() => item.target ? navigateTo(item.target) : setDetail(item)}>
      {!compact && <Icon size={18} aria-hidden="true" />}<span><span className="zc-home-calendar-item-title">{item.completed && <Check size={14} aria-label="已完成" />}{item.time ? `${item.time} ` : ''}{item.title}</span>{!compact && <small>{entry ? CALENDAR_KIND_LABELS[entry.kind] : sourceLabels[item.source]}{item.endDate !== item.date ? ` · ${item.date} 至 ${item.endDate}` : ''}{item.detail ? ` · ${item.detail}` : ''}</small>}</span>
    </button>;
  }
  function dayGrid(targetMonth: string, mini = false) {
    const first = `${targetMonth}-01`; const last = endOfMonth(first); const offset = (new Date(parseDay(first)).getUTCDay() - preferences.firstDay + 7) % 7;
    return <div className={`zc-home-calendar-grid${mini ? ' is-mini' : ''}`} role="group" aria-label={`${targetMonth} 日历`}>
      {Array.from({ length: 7 }, (_, i) => <span key={`weekday-${i}`} className="zc-home-calendar-weekday">{weekdayLabels[(i + preferences.firstDay) % 7]}</span>)}
      {Array.from({ length: offset }, (_, i) => <span className="zc-home-calendar-blank" key={`blank-${i}`} />)}
      {isoDays(first, last).map(day => {
        const meta = calendarDayInfo(day); const daily = filtered.filter(item => item.date <= day && item.endDate >= day); const totals = dailyTotals.get(day);
        const sub = (preferences.showFestivals && (meta.festivals[0] || meta.term)) || (preferences.showLunar ? meta.lunar : '');
        return <button type="button" className={`zc-home-calendar-day${day === date ? ' is-selected' : ''}${day === today ? ' is-today' : ''}${meta.weekend ? ' is-weekend' : ''}`} key={day}
          aria-label={`${day}${daily.length ? `，${daily.length} 项日历事项` : ''}${totals ? '，有流水' : ''}`} aria-describedby={`${titleId}-${day}-metadata`} aria-pressed={day === date} aria-current={day === today ? 'date' : undefined} onClick={() => { focus(day); if (mini) setView('month'); }}>
          <span className="zc-sr-only" id={`${titleId}-${day}-metadata`}>{[preferences.showLunar ? meta.lunarFull : '', preferences.showFestivals ? [...meta.festivals, meta.term].filter(Boolean).join('，') : '', preferences.showHolidays && meta.holiday ? meta.holiday.off ? '放假' : '调休上班' : ''].filter(Boolean).join('，')}</span>
          <span className="zc-home-calendar-dayhead"><span>{Number(day.slice(8))}</span>{!mini && preferences.showHolidays && meta.holiday && <small className="zc-home-calendar-holiday">{meta.holiday.off ? '休' : '班'}</small>}</span>
          {!mini && sub && <span className="zc-home-calendar-subdate">{sub}</span>}
          {!mini && totals && <span className="zc-home-calendar-cash"><span className="is-expense">支 {num(totals.expense, report.decimals)}</span>{!totals.income.isZero() && <span className="is-income">收 {num(totals.income, report.decimals)}</span>}{totals.incomplete && <span>未完整折算</span>}</span>}
          {!mini && daily.slice(0, 2).map(item => <span className="zc-home-calendar-cell-event" key={item.id}>{item.completed ? '已完成 · ' : ''}{item.title}</span>)}
          {daily.length > (mini ? 0 : 2) && <span className="zc-home-calendar-more">{mini ? '·' : `共 ${daily.length} 项`}</span>}
          {!mini && (daily.length > 0 || totals) && <span className="zc-home-calendar-mobile-mark">{daily.length ? `${daily.length} 项` : '流水'}</span>}
        </button>;
      })}
      {Array.from({ length: (7 - (offset + daysBetween(first, last) + 1) % 7) % 7 }, (_, index) => <span className="zc-home-calendar-blank" key={`trailing-${index}`} />)}
    </div>;
  }

  return <Card className={`zc-home-calendar ${expanded ? 'is-expanded' : 'is-condensed'} is-view-${view}`} variant={expanded ? undefined : 'tight'} title="日历" action={<div className="zc-home-calendar-actions"><button type="button" className="zc-btn" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}{expanded ? '收起日历' : '放大日历'}</button><button type="button" className="zc-btn zc-btn--primary" disabled={!!preview} onClick={() => create()}><Plus size={16} aria-hidden="true" />新增事项</button></div>}>
    <div className="zc-home-calendar-toolbar"><div className="zc-home-calendar-monthnav"><button type="button" className="zc-btn zc-btn--icon" aria-label="日历上一期间" onClick={() => move(-1)}><ChevronLeft size={18} /></button><CalendarDatePicker required label="日历定位日期" value={date} onChange={next => { if (next) focus(next); }} today={today} /><button type="button" className="zc-btn zc-btn--icon" aria-label="日历下一期间" onClick={() => move(1)}><ChevronRight size={18} /></button><button type="button" className="zc-btn" hidden={!expanded && date === today} onClick={() => focus(today)}>今天</button></div>
      <div className="zc-home-calendar-views" role="group" aria-label="日历视图">{Object.entries(viewLabels).map(([key, label]) => <button type="button" key={key} className={`zc-btn${view === key ? ' zc-btn--primary' : ''}`} aria-pressed={view === key} onClick={() => changeView(key as View)}>{label}</button>)}</div></div>
    <div className="zc-home-calendar-tools"><button type="button" className="zc-btn zc-home-calendar-filter-toggle" aria-expanded={expanded || showFilters} aria-controls={`${titleId}-filters`} onClick={() => setShowFilters(value => !value)}><SlidersHorizontal size={16} aria-hidden="true" />{showFilters ? '收起筛选' : '筛选事项'}{search || kind !== 'all' || !showCompleted || hiddenSources.length ? ' · 已筛选' : ''}</button>
    <button type="button" className="zc-workspace-link zc-home-calendar-settings-link" onClick={() => navigateTo({ screen: 'settings', tab: 'ledger' })}><Settings size={15} aria-hidden="true" />日历设置</button>
    <div id={`${titleId}-filters`} className="zc-home-calendar-filters" hidden={!expanded && !showFilters}><input className="zc-input" aria-label="搜索日历事项" placeholder="搜索当前期间的事项" value={search} onChange={e => { setSearch(e.target.value); setAgendaPage(0); }} /><select className="zc-select" aria-label="日历事项类型" value={kind} onChange={e => { setKind(e.target.value); setAgendaPage(0); }}><option value="all">全部事项</option><option value="reminders">账单与提醒</option>{Object.entries(CALENDAR_KIND_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><label className="zc-calendar-checkbox"><input type="checkbox" checked={showCompleted} onChange={e => { setShowCompleted(e.target.checked); setAgendaPage(0); }} />显示已完成</label>
      <div className="zc-home-calendar-option-fields zc-home-calendar-sources">{Object.entries(sourceLabels).map(([key, label]) => <label key={key}><input type="checkbox" checked={!hiddenSources.includes(key as HomeCalendarSource)} onChange={e => { setHiddenSources(e.target.checked ? hiddenSources.filter(s => s !== key) : [...hiddenSources, key as HomeCalendarSource]); setAgendaPage(0); }} />{label}</label>)}</div>
    </div></div>
    {error && <p role="alert" className="zc-calendar-error">{error} <button type="button" className="zc-btn" onClick={() => { setError(''); setRetry(value => value + 1); }}>重试读取</button></p>}{notice && <p role="status" className="zc-caption">{notice}</p>}
    <div className="zc-home-calendar-body"><div className="zc-home-calendar-board"><div className="zc-home-calendar-period">{view === 'year' ? `${date.slice(0, 4)} 年` : view === 'month' ? `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月` : `${from} — ${to}`}{summary?.key !== summaryKey && <span role="status">正在读取流水汇总…</span>}</div>
    {view === 'month' && dayGrid(month)}
    {view === 'year' && <div className="zc-home-calendar-year">{Array.from({ length: 12 }, (_, i) => { const target = `${date.slice(0, 4)}-${String(i + 1).padStart(2, '0')}`; return <section key={target}><h3><button type="button" className="zc-workspace-link" onClick={() => { focus(`${target}-01`); setView('month'); }}>{i + 1} 月</button></h3>{dayGrid(target, true)}</section>; })}</div>}
    {view === 'week' && <div className="zc-home-calendar-week">{isoDays(from, to).map(day => {
      const daily = filtered.filter(item => item.date <= day && item.endDate >= day);
      return <section key={day}><button type="button" className="zc-home-calendar-week-heading" onClick={() => { focus(day); setView('day'); }}>{day.slice(5)} · 周{weekdayLabels[new Date(parseDay(day)).getUTCDay()]}</button>{daily.slice(0, expanded ? undefined : 3).map(item => itemButton(item, true))}{!expanded && daily.length > 3 && <button type="button" className="zc-workspace-link zc-home-calendar-show-all" onClick={() => setExpanded(true)}>查看 {daily.length} 项</button>}</section>;
    })}</div>}
    {view === 'agenda' && <div className="zc-home-calendar-agenda">{filtered.length ? filtered.slice(shownAgendaPage * 20, shownAgendaPage * 20 + (expanded ? 20 : 5)).map(item => <div className="zc-home-calendar-agenda-row" key={item.id}><time dateTime={item.date}>{item.date}</time>{itemButton(item)}</div>) : <CardEmpty>这段期间没有匹配事项，可调整类型、搜索或新增安排。</CardEmpty>}{!expanded && filtered.length > 5 && <button type="button" className="zc-workspace-link zc-home-calendar-show-all" onClick={() => setExpanded(true)}>展开全部 {filtered.length} 项议程</button>}{expanded && <div className="zc-home-calendar-pager"><button type="button" className="zc-btn" disabled={shownAgendaPage === 0} onClick={() => setAgendaPage(Math.max(0, shownAgendaPage - 1))}>上一页</button><span>{filtered.length} 项 · 第 {shownAgendaPage + 1} 页</span><button type="button" className="zc-btn" disabled={(shownAgendaPage + 1) * 20 >= filtered.length} onClick={() => setAgendaPage(shownAgendaPage + 1)}>下一页</button></div>}</div>}
    </div><section className="zc-home-calendar-selected" aria-label="选中日期内容"><div className="zc-home-calendar-selected-head"><div><h3>{date}{date === today ? ' · 今天' : ''}</h3><p>{preferences.showLunar && info.lunarFull}{preferences.showFestivals && [info.festivals.join('、'), info.term].filter(Boolean).map(text => ` · ${text}`)}{preferences.showHolidays && info.holiday ? ` · ${info.holiday.off ? '放假' : '调休上班'}` : ''}</p></div><div className="zc-home-calendar-actions">{expanded && <><button type="button" className="zc-btn" disabled={!!preview} onClick={() => create('todo')}>加提醒</button><button type="button" className="zc-btn" disabled={!!preview} onClick={() => create('birthday')}>记生日</button></>}<button type="button" className="zc-btn" disabled={!!preview} onClick={() => create('note')}>写随记</button></div></div>
      {selectedItems.length ? selectedItems.slice(0, expanded ? undefined : 3).map(item => itemButton(item)) : <CardEmpty>这一天没有匹配的日历事项。</CardEmpty>}
      {!expanded && selectedItems.length > 3 && <button type="button" className="zc-workspace-link zc-home-calendar-show-all" onClick={() => setExpanded(true)}>查看全部 {selectedItems.length} 项安排</button>}
      <h3 className="zc-home-calendar-ledger-title">当天流水{readyPage ? ` · ${readyPage.totalCount} 笔` : ''}</h3>
      {!expanded && selectedTotals && <p className="zc-home-calendar-day-totals"><span>收 {num(selectedTotals.income, report.decimals)}</span><span>支 {num(selectedTotals.expense, report.decimals)}</span><span>{report.code}{selectedTotals.incomplete ? ' · 未完整折算' : ''}</span></p>}
      {readyPage ? <>{readyPage.transactions.slice(0, expanded ? undefined : 3).map(tx => <button type="button" className="zc-home-calendar-item" key={tx.id} onClick={() => navigateTo({ screen: 'transactions', tab: 'records', id: tx.id })}><ReceiptText size={18} aria-hidden="true" /><span><span>{tx.description || tx.merchant || '收支记录'}</span><small>{tx.date !== date ? `发生于 ${tx.date} · 归属 ${date}` : tx.time || tx.date} · {tx.type === 'expense' ? '支出' : tx.type === 'income' ? '收入' : tx.type === 'refund' ? '退款' : '转账／调整'}</small></span><strong>{num(tx.amount, snap.assets.find(a => a.id === tx.assetId)?.decimals ?? 2)} {snap.assets.find(a => a.id === tx.assetId)?.code}</strong></button>)}{!readyPage.transactions.length && <CardEmpty>当天没有已发生流水，计划提醒不计入实际收支。</CardEmpty>}{!expanded && (readyPage.totalCount > 3 || cursor) && <button type="button" className="zc-workspace-link zc-home-calendar-show-all" onClick={() => setExpanded(true)}>查看当天全部 {readyPage.totalCount} 笔流水</button>}{expanded && (readyPage.hasMore || cursor) && <div className="zc-home-calendar-pager"><button type="button" className="zc-btn" disabled={!cursor} onClick={() => setCursor(undefined)}>回到首页</button><button type="button" className="zc-btn" disabled={!readyPage.hasMore} onClick={() => setCursor(readyPage.nextCursor)}>下一页流水</button></div>}</> : <p role="status">正在读取当天流水…</p>}
    </section></div>
    {editor && <CalendarEntryEditor initial={editor.entry} replaceOccurrence={editor.replace} onClose={() => setEditor(null)} onSaved={entry => { setEditor(null); focus(entry.startDate); setNotice('日历事项已保存在本机，联网后按现有规则同步。'); }} />}
    {detail?.occurrence && <DialogShell labelledBy={titleId} onDismiss={() => setDetail(null)} panelClassName="zc-calendar-detail" panelStyle={{ width: 'min(620px, 100%)', background: 'var(--surface)' }} header={<div className="zc-calendar-editor-heading"><h2 id={titleId}>{detail.title}</h2><button type="button" className="zc-btn zc-btn--icon" aria-label="关闭日历详情" onClick={() => setDetail(null)}><X size={20} /></button></div>}>
      <dl className="zc-calendar-detail-facts"><div><dt>日期</dt><dd>{detail.date}{detail.endDate !== detail.date ? ` 至 ${detail.endDate}` : ''}</dd></div><div><dt>时间</dt><dd><Clock3 size={16} aria-hidden="true" />{detail.occurrence.entry.allDay ? '全天' : `${detail.occurrence.entry.startTime} — ${detail.occurrence.entry.endTime}`} · {detail.occurrence.entry.timezone}</dd></div><div><dt>类型</dt><dd>{CALENDAR_KIND_LABELS[detail.occurrence.entry.kind]} · {detail.occurrence.entry.calendar === 'lunar' ? `农历 ${detail.occurrence.entry.lunarMonth} 月 ${detail.occurrence.entry.lunarDay} 日` : '公历'} · {CALENDAR_REPEAT_LABELS[detail.occurrence.entry.repeat]}</dd></div>{detail.occurrence.entry.birthYear && <div><dt>年龄</dt><dd>{(detail.occurrence.entry.calendar === 'lunar' ? calendarDayInfo(detail.date).lunarYear! : Number(detail.date.slice(0, 4))) - detail.occurrence.entry.birthYear} 岁</dd></div>}{detail.occurrence.entry.location && <div><dt><MapPin size={16} />地点</dt><dd>{detail.occurrence.entry.location}</dd></div>}</dl>
      {detail.occurrence.entry.description && <p className="zc-calendar-description">{detail.occurrence.entry.description}</p>}
      {!!detail.occurrence.entry.transactionIds?.length && <CalendarTransactionLinks ids={detail.occurrence.entry.transactionIds} />}
      {!preview && <div className="zc-calendar-detail-actions"><button type="button" className="zc-btn zc-btn--primary" disabled={busy} onClick={() => void run(async () => { await setCalendarOccurrenceStatus(store, detail.occurrence!.entry.id, detail.date, detail.completed ? 'open' : 'completed'); setDetail(null); setNotice(detail.completed ? '已恢复为未完成。' : '本次事项已完成，未生成收支流水。'); })}>{detail.completed ? '恢复未完成' : '完成本次'}</button><button type="button" className="zc-btn" disabled={busy} onClick={() => edit(detail, false)}>编辑整个事项</button>{detail.occurrence.entry.repeat !== 'none' && <button type="button" className="zc-btn" disabled={busy} onClick={() => edit(detail, true)}>仅编辑本次</button>}<button type="button" className="zc-btn" disabled={busy} onClick={() => void run(async () => { await setCalendarOccurrenceStatus(store, detail.occurrence!.entry.id, detail.date, 'open', new Date(Date.now() + 10 * 60_000).toISOString()); setDetail(null); setNotice('已设置 10 分钟后再提醒，应用需保持打开且已开启系统提醒。'); })}>10 分钟后再提醒</button>{detail.occurrence.entry.repeat !== 'none' && <button type="button" className="zc-btn" disabled={busy} onClick={() => void run(async () => { await setCalendarOccurrenceStatus(store, detail.occurrence!.entry.id, detail.date, 'skipped'); setDetail(null); })}>跳过本次</button>}<button type="button" className="zc-btn zc-btn--danger" disabled={busy} onClick={() => setConfirmDelete(detail)}>删除整个事项</button></div>}
    </DialogShell>}
    {confirmDelete?.occurrence && (
      <ConfirmDialog
        title="删除日历事项"
        confirmLabel="确认删除"
        cancelLabel="取消"
        tone="danger"
        busy={busy}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          await store.calendarEntries.remove(confirmDelete.occurrence!.entry.id, confirmDelete.occurrence!.entry.version);
          setConfirmDelete(null);
          setDetail(null);
          setNotice('日历事项已删除。');
        }}
      >
        删除“{confirmDelete.title}”及其后续重复？
      </ConfirmDialog>
    )}
  </Card>;
}
