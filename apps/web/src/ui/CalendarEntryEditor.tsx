import { useEffect, useId, useState, type FormEvent } from 'react';
import { CALENDAR_KIND_LABELS, CALENDAR_REPEAT_LABELS, calendarDayInfo, lunarCalendarDate, type CalendarEntry } from '@zichan/core';
import { saveCalendarEntry } from '@zichan/db';
import { useStore } from '../db/store.js';
import { CalendarDatePicker } from './CalendarDatePicker.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DateTimeInput } from './DateTimeInput.js';
import { DialogShell } from './DialogShell.js';

export function CalendarEntryEditor({ initial, replaceOccurrence, onClose, onSaved }: {
  initial: CalendarEntry;
  replaceOccurrence?: { entryId: string; date: string; version: number };
  onClose: () => void;
  onSaved: (entry: CalendarEntry) => void;
}) {
  const { store, bump } = useStore();
  const [entry, setEntry] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ id: string; label: string }[]>([]);
  const [searchError, setSearchError] = useState('');
  const [linkedLabels, setLinkedLabels] = useState<Record<string, string>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const linkedKey = (entry.transactionIds ?? []).join('\0');
  const id = useId();
  const dirty = JSON.stringify(entry) !== JSON.stringify(initial);
  const patch = (value: Partial<CalendarEntry>) => setEntry(current => ({ ...current, ...value }));
  const close = () => {
    if (busy) return;
    if (dirty) { setConfirmDiscard(true); return; }
    onClose();
  };

  useEffect(() => {
    if (!query.trim()) { setMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void store.transactionBrowsePage({ search: query, limit: 20 }).then(page => {
        if (!cancelled) { setSearchError(''); setMatches(page.transactions.map(t => ({ id: t.id, label: `${t.date} · ${t.description || t.merchant || '流水'} · ${t.amount}` }))); }
      }).catch(cause => { if (!cancelled) setSearchError(String(cause)); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, store]);
  useEffect(() => {
    let cancelled = false;
    const ids = linkedKey ? linkedKey.split('\0') : [];
    void Promise.all(ids.map(async id => {
      const transaction = await store.transactions.get(id);
      return [id, !transaction || transaction.isDeleted ? '关联流水已删除或不存在' : `${transaction.date} · ${transaction.description || transaction.merchant || '收支记录'} · ${transaction.amount}${transaction.recordState === 'voided' ? ' · 已作废' : ''}`] as const;
    })).then(labels => { if (!cancelled) setLinkedLabels(Object.fromEntries(labels)); }).catch(() => { if (!cancelled) setSearchError('关联流水暂时无法读取，可稍后重试。'); });
    return () => { cancelled = true; };
  }, [store, linkedKey]);

  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      let value = { ...entry };
      if (value.calendar === 'lunar') {
        let date: string | null = null;
        const startYear = Number(value.startDate.slice(0, 4));
        for (let year = startYear; year <= Math.min(startYear + 30, 2099) && !date; year++) date = lunarCalendarDate(year, value.lunarMonth!, value.lunarDay!, value.leapPolicy === 'leap', value.missingDayPolicy);
        if (!date) throw new Error('所选农历规则在未来 30 年没有有效日期，请调整闰月或大小月规则');
        value = { ...value, startDate: date, endDate: date, repeat: 'yearly', allDay: true, startTime: undefined, endTime: undefined };
      }
      if (value.kind === 'birthday' || value.kind === 'anniversary') value = { ...value, repeat: 'yearly' };
      if (value.repeat === 'weekdays') value.interval = 1;
      const saved = await saveCalendarEntry(store, value, replaceOccurrence);
      bump(); onSaved(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <DialogShell labelledBy={id} onDismiss={close} dismissDisabled={busy} panelClassName="zc-calendar-editor" panelStyle={{ width: 'min(700px, 100%)', background: 'var(--surface)' }}
    header={<div className="zc-calendar-editor-heading"><h2 id={id}>{initial.createdAt ? '编辑日历事项' : '新增日历事项'}</h2><button type="button" className="zc-btn" onClick={close} disabled={busy}>取消</button></div>}
    footer={<div className="zc-calendar-editor-actions"><span>保存到当前账本，联网后按现有规则同步</span><button className="zc-btn zc-btn--primary" type="submit" form={`${id}-form`} disabled={busy}>{busy ? '保存中…' : '保存事项'}</button></div>}>
    <form id={`${id}-form`} className="zc-calendar-form" onSubmit={event => void submit(event)}>
      {error && <p className="zc-calendar-error" role="alert">{error}</p>}
      <label className="zc-field">标题<input autoFocus className="zc-input" required maxLength={200} value={entry.title} onChange={event => patch({ title: event.target.value })} /></label>
      <div className="zc-calendar-form-pair">
        <label className="zc-field">类型<select className="zc-select" value={entry.kind} onChange={event => {
          const kind = event.target.value as CalendarEntry['kind'];
          patch({ kind, repeat: kind === 'birthday' || kind === 'anniversary' ? 'yearly' : entry.repeat, allDay: kind === 'birthday' ? true : entry.allDay });
        }}>{Object.entries(CALENDAR_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="zc-field">历法<select className="zc-select" value={entry.calendar} onChange={event => {
          const calendar = event.target.value as CalendarEntry['calendar']; const lunar = calendarDayInfo(entry.startDate);
          patch({ calendar, ...(calendar === 'lunar' ? { lunarMonth: Math.abs(lunar.lunarMonth ?? 1), lunarDay: lunar.lunarDay ?? 1, repeat: 'yearly', allDay: true } : {}) });
        }}><option value="solar">公历</option><option value="lunar">农历（每年重复）</option></select></label>
      </div>
      {entry.calendar === 'lunar' ? <>
        <div className="zc-calendar-form-pair"><label className="zc-field">农历月<select className="zc-select" value={entry.lunarMonth ?? 1} onChange={e => patch({ lunarMonth: Number(e.target.value) })}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1} 月</option>)}</select></label><label className="zc-field">农历日<select className="zc-select" value={entry.lunarDay ?? 1} onChange={e => patch({ lunarDay: Number(e.target.value) })}>{Array.from({ length: 30 }, (_, i) => <option key={i} value={i + 1}>{i + 1} 日</option>)}</select></label></div>
        <div className="zc-calendar-form-pair"><label className="zc-field">闰月规则<select className="zc-select" value={entry.leapPolicy} onChange={e => patch({ leapPolicy: e.target.value as CalendarEntry['leapPolicy'] })}><option value="regular">只过普通月</option><option value="leap">只过闰月（无闰月年份跳过）</option><option value="both">普通月和闰月都过</option></select></label><label className="zc-field">小月没有三十时<select className="zc-select" value={entry.missingDayPolicy} onChange={e => patch({ missingDayPolicy: e.target.value as CalendarEntry['missingDayPolicy'] })}><option value="last_day">取该月最后一天</option><option value="skip">跳过这一年</option></select></label></div>
        <p className="zc-caption">根据农历换算每年的公历日期；只过闰月时，无对应闰月的年份不会提醒。</p>
      </> : <>
        <div className="zc-calendar-form-pair"><label className="zc-field">开始日期<CalendarDatePicker required label="事项开始日期" value={entry.startDate} onChange={startDate => patch({ startDate, endDate: entry.endDate < startDate ? startDate : entry.endDate })} /></label><label className="zc-field">结束日期<CalendarDatePicker required label="事项结束日期" value={entry.endDate} onChange={endDate => patch({ endDate })} /></label></div>
        <label className="zc-calendar-checkbox"><input type="checkbox" checked={entry.allDay} onChange={e => patch({ allDay: e.target.checked, startTime: entry.startTime ?? '09:00', endTime: entry.endTime ?? '10:00' })} />全天</label>
        {!entry.allDay && <div className="zc-calendar-form-pair"><label className="zc-field">开始时间<DateTimeInput type="time" className="zc-input" value={entry.startTime ?? ''} onChange={startTime => patch({ startTime })} aria-label="事项开始时间" required /></label><label className="zc-field">结束时间<DateTimeInput type="time" className="zc-input" value={entry.endTime ?? ''} onChange={endTime => patch({ endTime })} aria-label="事项结束时间" required /></label></div>}
        <label className="zc-field">重复<select className="zc-select" value={entry.repeat} disabled={entry.kind === 'birthday' || entry.kind === 'anniversary'} onChange={e => patch({ repeat: e.target.value as CalendarEntry['repeat'] })}>{Object.entries(CALENDAR_REPEAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {(entry.repeat === 'monthly' || entry.repeat === 'yearly') && <label className="zc-field">缺少对应日期时<select className="zc-select" value={entry.missingDayPolicy} onChange={e => patch({ missingDayPolicy: e.target.value as CalendarEntry['missingDayPolicy'] })}><option value="last_day">取月末（如 2 月 29 日改为 2 月末）</option><option value="skip">跳过该期</option></select></label>}
      </>}
      {entry.kind === 'birthday' && <label className="zc-field">出生年份（可不填）<input className="zc-input" type="number" min="1" max={Number(entry.startDate.slice(0, 4))} value={entry.birthYear ?? ''} onChange={e => patch({ birthYear: e.target.value ? Number(e.target.value) : undefined })} /></label>}
      {entry.repeat !== 'none' && <>
        <div className="zc-calendar-form-pair"><label className="zc-field">重复间隔<input className="zc-input" type="number" min="1" max="999" value={entry.interval} disabled={entry.repeat === 'weekdays'} onChange={e => patch({ interval: Number(e.target.value) })} /></label><label className="zc-field">重复次数（留空不限）<input className="zc-input" type="number" min="1" max="10000" value={entry.repeatCount ?? ''} onChange={e => patch({ repeatCount: e.target.value ? Number(e.target.value) : undefined })} /></label></div>
        {entry.repeat === 'weekly' && <fieldset className="zc-calendar-weekdays"><legend>每周哪几天</legend>{['日', '一', '二', '三', '四', '五', '六'].map((label, day) => <label key={day}><input type="checkbox" checked={entry.weekdays?.includes(day) ?? new Date(`${entry.startDate}T12:00:00`).getDay() === day} onChange={e => { const current = entry.weekdays ?? [new Date(`${entry.startDate}T12:00:00`).getDay()]; patch({ weekdays: e.target.checked ? [...new Set([...current, day])] : current.filter(value => value !== day) }); }} />{label}</label>)}</fieldset>}
        <label className="zc-field">重复结束日期（可留空）<CalendarDatePicker label="重复结束日期" value={entry.untilDate ?? ''} onChange={untilDate => patch({ untilDate: untilDate || undefined })} /></label>
      </>}
      <div className="zc-calendar-form-pair"><label className="zc-field">提前提醒<select className="zc-select" value={entry.reminderMinutes?.[0] ?? -1} onChange={e => patch({ reminderMinutes: Number(e.target.value) < 0 ? [] : [Number(e.target.value)] })}><option value="-1">不提醒</option><option value="0">开始时（全天事项当天 09:00）</option><option value="5">提前 5 分钟</option><option value="15">提前 15 分钟</option><option value="60">提前 1 小时</option><option value="1440">提前 1 天</option><option value="4320">提前 3 天</option><option value="10080">提前 1 周</option></select></label><label className="zc-field">时区<input className="zc-input" required value={entry.timezone} onChange={e => patch({ timezone: e.target.value })} /></label></div>
      <label className="zc-field">地点<input className="zc-input" maxLength={500} value={entry.location ?? ''} onChange={e => patch({ location: e.target.value })} /></label>
      <label className="zc-field">{entry.kind === 'note' ? '随记正文' : '说明'}<textarea className="zc-input" rows={4} maxLength={20000} value={entry.description ?? ''} onChange={e => patch({ description: e.target.value })} /></label>
      <details><summary>关联流水{entry.transactionIds?.length ? ` · ${entry.transactionIds.length} 笔` : ''}</summary><label className="zc-field">搜索流水<input className="zc-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="描述、商户或备注" /></label>{searchError && <p role="alert">{searchError}</p>}
        {entry.transactionIds?.map(transactionId => <div className="zc-calendar-linked" key={transactionId}><span>{matches.find(t => t.id === transactionId)?.label ?? linkedLabels[transactionId] ?? '正在读取关联流水…'}</span><button type="button" className="zc-btn zc-btn--sm" onClick={() => patch({ transactionIds: entry.transactionIds?.filter(id => id !== transactionId) })}>移除关联</button></div>)}
        {matches.filter(t => !entry.transactionIds?.includes(t.id)).map(t => <button type="button" key={t.id} className="zc-calendar-search-result" onClick={() => patch({ transactionIds: [...(entry.transactionIds ?? []), t.id] })}>{t.label}</button>)}
      </details>
    </form>
    {confirmDiscard && (
      <ConfirmDialog
        title="放弃未保存的日历内容？"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        tone="danger"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => { setConfirmDiscard(false); onClose(); }}
      >
        <p style={{ margin: 0 }}>尚有未保存的日历内容，确定放弃修改吗？</p>
      </ConfirmDialog>
    )}
  </DialogShell>;
}
