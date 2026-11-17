import { describe, expect, it } from 'vitest';
import { ADMIN_NAVIGATION, adminWorkspacePath, adminViewTarget } from '../src/admin/navigation.js';
import { LOG_DEFINITIONS, categoryForLogPath, logFieldText } from '../src/admin/log-workspace-schema.js';
import { canonicalAdminRoute } from '../src/admin/workspace-routes.js';
import { LOG_FILTER_KEYS, LOG_EXPORT_FIELDS } from '../../sync-server/src/log-workspace.js';

describe('one primary workspace per administrative capability', () => {
  it('groups related analysis and monitoring pages under one sidebar entry', () => {
    const paths = ADMIN_NAVIGATION.flatMap(group => group.pages.map(page => page.path));
    expect(paths).not.toContain('/traffic'); expect(paths).not.toContain('/host'); expect(paths).not.toContain('/collectors');
    expect(adminWorkspacePath('/traffic')).toBe('/requests');
    expect(adminWorkspacePath('/host')).toBe('/monitor'); expect(adminWorkspacePath('/collectors')).toBe('/monitor');
  });
  it('preserves a long traffic window when entering requests with the same ninety-day limit', () => {
    const target = adminViewTarget('/requests', '', new URLSearchParams('range=custom&from=2026-11-01T00:00:00Z&until=2026-11-15T10:30:00Z&country=CN'));
    const result = new URLSearchParams(target.split('?')[1]);
    expect(result.get('from')).toBe('2026-11-01T00:00:00Z');
    expect(result.get('until')).toBe('2026-11-15T10:30:00Z');
    expect(result.get('country')).toBe('CN');
    expect(result.has('windowAdjusted')).toBe(false);
    expect(adminViewTarget('/traffic', '', new URLSearchParams('range=15m'))).toBe('/traffic?range=1h');
  });
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
    expect(canonicalAdminRoute('/monitor', new URLSearchParams('view=overview&range=90d'))).toBe('/requests?range=90d');
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
