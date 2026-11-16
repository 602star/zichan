import { describe, expect, it } from 'vitest';
import { ADMIN_NAVIGATION } from '../src/admin/navigation.js';
import { LOG_DEFINITIONS, categoryForLogPath, logFieldText } from '../src/admin/log-workspace-schema.js';
import { canonicalAdminRoute } from '../src/admin/workspace-routes.js';
import { LOG_FILTER_KEYS, LOG_EXPORT_FIELDS } from '../../sync-server/src/log-workspace.js';

describe('one primary workspace per administrative capability', () => {
  it('keeps one sidebar log entry and six distinct category schemas', () => {
    const entries = ADMIN_NAVIGATION.flatMap((group) => group.pages);
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
    expect(entries.filter((entry) => Object.values(LOG_DEFINITIONS).some((definition) => definition.path === entry.path)).map((entry) => entry.path)).toEqual(['/logs']);
    for (const [kind, definition] of Object.entries(LOG_DEFINITIONS)) {
      expect(categoryForLogPath(definition.path)).toBe(kind);
      expect(new Set(definition.fields.map((field) => field.key)).size).toBe(definition.fields.length);
      expect(definition.fields.filter((field) => field.filter).map((field) => field.key).sort()).toEqual([...LOG_FILTER_KEYS[kind as keyof typeof LOG_FILTER_KEYS]].sort());
      for (const key of LOG_EXPORT_FIELDS[kind as keyof typeof LOG_EXPORT_FIELDS]) expect(key === 'id' || definition.fields.some((field) => field.key === key)).toBe(true);
    }
    expect(LOG_DEFINITIONS.login.fields.some((field) => field.key === 'authMethod' && field.filter && field.column)).toBe(true);
    expect(LOG_DEFINITIONS.tasks.fields.some((field) => field.key === 'attempt' && field.column)).toBe(true);
    expect(LOG_DEFINITIONS.operations.fields.some((field) => field.key === 'ip' && field.column)).toBe(true);
  });
  it('redirects historical monitor views to their primary page and preserves supported ranges', () => {
    expect(canonicalAdminRoute('/monitor', new URLSearchParams('view=traffic&range=7d'))).toBe('/traffic?range=7d');
    expect(canonicalAdminRoute('/monitor', new URLSearchParams('view=overview&range=90d'))).toBe('/requests?range=7d');
    expect(canonicalAdminRoute('/resources', new URLSearchParams())).toBe('/database');
    expect(canonicalAdminRoute('/monitor', new URLSearchParams('view=service'))).toBe('/monitor?view=application');
    expect(canonicalAdminRoute('/monitor', new URLSearchParams('view=application'))).toBeUndefined();
  });
  it('distinguishes missing measurements from real zero and labels states consistently', () => {
    expect(logFieldText({ key: 'durationMs', label: '耗时', kind: 'duration' }, null)).toBe('未记录');
    expect(logFieldText({ key: 'durationMs', label: '耗时', kind: 'duration' }, 0)).toBe('0.0');
    expect(logFieldText(LOG_DEFINITIONS.login.fields.find((field) => field.key === 'result')!, 'blocked')).toBe('拦截');
  });
});
