import { describe, expect, it } from 'vitest';
import { logActionGroup, logActionOption, logActionTitle, logDetailLabel, logDetailValue, logLevelLabel, logRequestId, logSummary } from '../src/admin/log-presentation.js';
import type { LogEntry } from '../src/admin/types.js';

const log = (overrides: Partial<LogEntry>): LogEntry => ({
  id: 'log-1', at: '2026-10-15T08:00:00.000Z', level: 'info',
  action: 'commits_pushed', message: 'Received encrypted commits', ...overrides,
});

describe('run log presentation', () => {
  it('explains known events with their recorded quantities without changing the source event', () => {
    const entry = log({ detail: { count: 3, requestId: 'req-123' } });
    expect(logActionTitle(entry.action)).toBe('加密记录已接收');
    expect(logSummary(entry)).toBe('服务端已接收 3 条加密记录。');
    expect(logRequestId(entry)).toBe('req-123');
    expect(logActionOption(entry.action)).toContain('commits_pushed');
    expect(entry.message).toBe('Received encrypted commits');
  });

  it('leaves unknown events identifiable and avoids inventing an explanation', () => {
    const entry = log({ action: 'new_protocol_event', message: 'Unexpected protocol state', level: 'critical' });
    expect(logActionTitle(entry.action)).toBe('new_protocol_event');
    expect(logActionGroup(entry.action)).toBe('其他事件');
    expect(logSummary(entry)).toContain('原始日志');
    expect(logLevelLabel(entry.level)).toBe('critical');
  });

  it('labels common detail fields but preserves unknown fields and values', () => {
    expect(logDetailLabel('jobId')).toBe('任务 ID');
    expect(logDetailLabel('futureField')).toBe('futureField');
    expect(logDetailValue(['one', 'two'])).toBe('one、two');
    expect(logDetailValue({ code: 'NEW_CODE' })).toBe('{"code":"NEW_CODE"}');
  });
});
