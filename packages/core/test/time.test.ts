import { describe, expect, it } from 'vitest';
import { normalizeOccurrence } from '../src/index.js';

describe('local occurrence normalization', () => {
  it('preserves a 45-minute IANA offset', () => {
    expect(normalizeOccurrence({
      date: '2026-01-01', time: '12:00', timezone: 'Asia/Kathmandu', timePrecision: 'minute',
    })).toMatchObject({
      occurredAtUtc: '2026-01-01T06:15:00.000Z',
      utcOffsetMinutes: 345,
    });
  });

  it('preserves a half-hour IANA offset', () => {
    expect(normalizeOccurrence({
      date: '2026-01-01', time: '12:00', timezone: 'Asia/Kolkata', timePrecision: 'minute',
    })).toMatchObject({
      occurredAtUtc: '2026-01-01T06:30:00.000Z',
      utcOffsetMinutes: 330,
    });
  });

  it('rejects a DST gap and requires disambiguation for an overlap', () => {
    expect(() => normalizeOccurrence({
      date: '2026-03-08', time: '02:30', timezone: 'America/New_York', timePrecision: 'minute',
    })).toThrow('不存在');
    expect(() => normalizeOccurrence({
      date: '2026-11-01', time: '01:30', timezone: 'America/New_York', timePrecision: 'minute',
    })).toThrow('请选择较早或较晚时刻');
    expect(normalizeOccurrence({
      date: '2026-11-01', time: '01:30', timezone: 'America/New_York', timePrecision: 'minute', timeDisambiguation: 'earlier',
    })).toMatchObject({ occurredAtUtc: '2026-11-01T05:30:00.000Z', utcOffsetMinutes: -240 });
    expect(normalizeOccurrence({
      date: '2026-11-01', time: '01:30', timezone: 'America/New_York', timePrecision: 'minute', timeDisambiguation: 'later',
    })).toMatchObject({ occurredAtUtc: '2026-11-01T06:30:00.000Z', utcOffsetMinutes: -300 });
  });
});
