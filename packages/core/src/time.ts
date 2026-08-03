import { isValidDay } from './dates.js';
import type { TimeDisambiguation, TimePrecision } from './types.js';

export interface OccurrenceInput {
  date: string;
  time?: string;
  timezone?: string;
  timePrecision?: TimePrecision;
  timeDisambiguation?: TimeDisambiguation;
}

export interface NormalizedOccurrence {
  date: string;
  time?: string;
  timezone: string;
  timePrecision: TimePrecision;
  timeDisambiguation?: TimeDisambiguation;
  occurredAtUtc?: string;
  utcOffsetMinutes?: number;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new Error(`无效的 IANA 时区：${timezone}`);
  }
}

function partsAt(value: number, fmt: Intl.DateTimeFormat): DateParts {
  const values: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(value))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values['year']!,
    month: values['month']!,
    day: values['day']!,
    hour: values['hour'] === 24 ? 0 : values['hour']!,
    minute: values['minute']!,
    second: values['second']!,
  };
}

function sameParts(left: DateParts, right: DateParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function possibleInstants(local: DateParts, timezone: string): { epoch: number; offsetMinutes: number }[] {
  const fmt = formatter(timezone);
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 60 * 60 * 1000;
    const shown = partsAt(sample, fmt);
    offsets.add(Math.round((Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second) - sample) / 60_000));
  }
  const out: { epoch: number; offsetMinutes: number }[] = [];
  for (const offsetMinutes of offsets) {
    const epoch = naive - offsetMinutes * 60_000;
    if (sameParts(partsAt(epoch, fmt), local)) out.push({ epoch, offsetMinutes });
  }
  return out.sort((a, b) => a.epoch - b.epoch);
}

function parseTime(value: string, precision: TimePrecision): Pick<DateParts, 'hour' | 'minute' | 'second'> {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error('时间必须使用 HH:mm 或 HH:mm:ss');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`无效时间：${value}`);
  if (precision === 'minute' && match[3] != null) throw new Error('分钟精度不能包含秒');
  if (precision === 'second' && match[3] == null) throw new Error('秒精度必须填写秒');
  return { hour, minute, second };
}

/** Normalize local calendar semantics and derive the exact UTC instant when one exists. */
export function normalizeOccurrence(input: OccurrenceInput): NormalizedOccurrence {
  if (!isValidDay(input.date)) throw new Error(`无效日期：${input.date}`);
  const timezone = input.timezone?.trim() || systemTimezone();
  const canonicalTimezone = formatter(timezone).resolvedOptions().timeZone;
  const inferred: TimePrecision = !input.time ? 'day' : input.time.length === 5 ? 'minute' : 'second';
  const timePrecision = input.timePrecision ?? inferred;
  if (timePrecision === 'day') {
    if (input.time) throw new Error('日精度记录不能同时保存具体时间');
    return { date: input.date, timezone: canonicalTimezone, timePrecision };
  }
  if (!input.time) throw new Error(`${timePrecision === 'minute' ? '分钟' : '秒'}精度记录必须填写时间`);
  const date = input.date.split('-').map(Number);
  const clock = parseTime(input.time, timePrecision);
  const local: DateParts = { year: date[0]!, month: date[1]!, day: date[2]!, ...clock };
  const instants = possibleInstants(local, canonicalTimezone);
  if (instants.length === 0) throw new Error(`本地时间 ${input.date} ${input.time} 在 ${canonicalTimezone} 中不存在`);
  if (instants.length > 1 && !input.timeDisambiguation) {
    throw new Error(`本地时间 ${input.date} ${input.time} 在 ${canonicalTimezone} 中重复，请选择较早或较晚时刻`);
  }
  const selected = instants.length === 1 || input.timeDisambiguation !== 'later' ? instants[0]! : instants.at(-1)!;
  return {
    date: input.date,
    time: input.time,
    timezone: canonicalTimezone,
    timePrecision,
    timeDisambiguation: instants.length > 1 ? input.timeDisambiguation : undefined,
    occurredAtUtc: new Date(selected.epoch).toISOString(),
    utcOffsetMinutes: selected.offsetMinutes,
  };
}

