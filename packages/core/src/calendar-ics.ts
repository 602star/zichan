import { addDays, dayOfInstant, isValidDay } from './dates.js';
import { newId } from './ids.js';
import { assertCalendarEntry, type CalendarEntry, type CalendarRepeat } from './calendar.js';

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const unescape = (s: string) => s.replace(/\\([nN,;\\])/g, (_, ch: string) => ch.toLowerCase() === 'n' ? '\n' : ch);
const compact = (d: string) => d.replaceAll('-', '');
const stamp = (entry: CalendarEntry, end = false) => {
  const date = end ? entry.endDate : entry.startDate;
  return entry.allDay ? `;VALUE=DATE:${compact(end ? addDays(date, 1) : date)}`
    : `;TZID=${entry.timezone}:${compact(date)}T${(end ? entry.endTime! : entry.startTime!).replace(':', '')}00`;
};

/** UTF-8 folding follows RFC 5545's 75-octet physical-line limit. */
function fold(line: string): string {
  const out: string[] = []; let chunk = '', bytes = 0;
  for (const char of line) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 75) { out.push(chunk); chunk = ' '; bytes = 1; }
    chunk += char; bytes += size;
  }
  out.push(chunk); return out.join('\r\n');
}
export function exportCalendarIcs(entries: readonly CalendarEntry[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Youben//Personal Calendar//ZH', 'CALSCALE:GREGORIAN'];
  for (const entry of entries.filter(e => !e.isDeleted)) {
    assertCalendarEntry(entry);
    lines.push('BEGIN:VEVENT', `UID:${escape(entry.sourceUid ?? `${entry.id}@youben`)}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `SUMMARY:${escape(entry.title)}`, `DTSTART${stamp(entry)}`, `DTEND${stamp(entry, true)}`);
    if (entry.description) lines.push(`DESCRIPTION:${escape(entry.description)}`);
    if (entry.location) lines.push(`LOCATION:${escape(entry.location)}`);
    if (entry.repeat !== 'none' && entry.calendar === 'solar') {
      const frequency = { daily: 'DAILY', weekdays: 'WEEKLY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[entry.repeat];
      let rule = `RRULE:FREQ=${frequency};INTERVAL=${entry.interval}`;
      if (entry.repeat === 'weekdays') rule += ';BYDAY=MO,TU,WE,TH,FR';
      else if (entry.repeat === 'weekly' && entry.weekdays?.length) rule += `;BYDAY=${entry.weekdays.map(day => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][day]).join(',')}`;
      if (entry.untilDate) rule += `;UNTIL=${compact(entry.untilDate)}`;
      if (entry.repeatCount) rule += `;COUNT=${entry.repeatCount}`;
      lines.push(rule);
    }
    // Preserve lunar recurrence, kinds and reminder offsets when round-tripping with Youben.
    lines.push(`X-YOUBEN-ENTRY:${escape(JSON.stringify(entry))}`);
    for (const minutes of entry.reminderMinutes ?? []) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escape(entry.title)}`, `TRIGGER:-PT${minutes}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR'); return lines.map(fold).join('\r\n') + '\r\n';
}

export function importCalendarIcs(contents: string, timezone: string): CalendarEntry[] {
  if (contents.length > 5_000_000) throw new Error('日历文件不能超过 5 MB');
  const lines = contents.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  if (!lines.includes('BEGIN:VCALENDAR') || !lines.includes('END:VCALENDAR')) throw new Error('请选择有效的 iCalendar 文件');
  const entries: CalendarEntry[] = []; let linesOfEvent: string[] | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { linesOfEvent = []; continue; }
    if (line === 'END:VEVENT' && linesOfEvent) {
      const properties = linesOfEvent.map(raw => { const colon = raw.indexOf(':'); return { key: raw.slice(0, colon), value: raw.slice(colon + 1) }; });
      const get = (key: string) => properties.find(p => p.key.split(';')[0] === key);
      if (get('RECURRENCE-ID') || get('EXDATE') || get('RDATE')) throw new Error('该文件包含单次例外或额外重复日期，请先在源日历展开后导入，避免遗漏');
      const custom = get('X-YOUBEN-ENTRY');
      if (custom) {
        const raw = JSON.parse(unescape(custom.value)) as CalendarEntry;
        const entry = { ...raw, id: newId(), version: 1, createdAt: '', updatedAt: '', isDeleted: false, sourceUid: unescape(get('UID')?.value ?? '') || undefined };
        assertCalendarEntry(entry); entries.push(entry);
      } else {
        const start = get('DTSTART'); if (!start) throw new Error('日程缺少开始日期');
        const allDay = /^\d{8}$/.test(start.value);
        const zone = start.key.match(/TZID=([^;]+)/)?.[1] ?? timezone;
        const parse = (value: string) => {
          if (!/^\d{8}(T\d{6}Z?)?$/.test(value)) throw new Error('日程日期格式不受支持');
          const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
          if (!isValidDay(date)) throw new Error('日程包含无效日期');
          if (value.endsWith('Z')) {
            const instant = `${date}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
            const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
            return { date: dayOfInstant(instant, zone), time: parts };
          }
          return { date, time: allDay ? undefined : `${value.slice(9, 11)}:${value.slice(11, 13)}` };
        };
        const first = parse(start.value);
        const defaultEnd = new Date(`${first.date}T${first.time ?? '00:00'}:00Z`);
        defaultEnd.setUTCHours(defaultEnd.getUTCHours() + 1);
        const last = get('DTEND') ? parse(get('DTEND')!.value) : { date: allDay ? first.date : dayOfInstant(defaultEnd, 'UTC'), time: allDay ? undefined : `${String(defaultEnd.getUTCHours()).padStart(2, '0')}:${String(defaultEnd.getUTCMinutes()).padStart(2, '0')}` };
        const rule = get('RRULE')?.value;
        const fields: Record<string, string | undefined> = Object.fromEntries((rule ?? '').split(';').filter(Boolean).map(part => part.split('=')));
        if (Object.keys(fields).some(key => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(key)) || (fields['BYDAY'] && (fields['FREQ'] !== 'WEEKLY' || /\d/.test(fields['BYDAY'])))) throw new Error('该文件包含暂不支持的复杂重复规则，尚未导入');
        const repeat = ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' } as Record<string, CalendarRepeat>)[fields['FREQ'] ?? ''] ?? 'none';
        if (rule && repeat === 'none') throw new Error('重复频率暂不受支持');
        const entry: CalendarEntry = { id: newId(), version: 1, createdAt: '', updatedAt: '', isDeleted: false, title: unescape(get('SUMMARY')?.value ?? '未命名日程'),
          kind: 'event', startDate: first.date, endDate: allDay && get('DTEND') ? addDays(last.date, -1) : last.date, allDay,
          startTime: first.time, endTime: last.time ?? first.time, timezone: zone, description: unescape(get('DESCRIPTION')?.value ?? ''), location: unescape(get('LOCATION')?.value ?? ''),
          calendar: 'solar', leapPolicy: 'regular', missingDayPolicy: 'skip', repeat, interval: Number(fields['INTERVAL'] ?? 1),
          untilDate: fields['UNTIL'] ? parse(fields['UNTIL']).date : undefined, repeatCount: fields['COUNT'] ? Number(fields['COUNT']) : undefined,
          weekdays: fields['BYDAY']?.split(',').map(day => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(day)),
          sourceUid: unescape(get('UID')?.value ?? '') || undefined,
          reminderMinutes: properties.filter(p => p.key === 'TRIGGER' && /^-PT\d+M$/.test(p.value)).map(p => Number(p.value.slice(3, -1))) };
        assertCalendarEntry(entry); entries.push(entry);
      }
      linesOfEvent = null;
    } else if (linesOfEvent) linesOfEvent.push(line);
  }
  if (!entries.length || entries.length > 2000) throw new Error('文件应包含 1 至 2000 条日程');
  return entries;
}
