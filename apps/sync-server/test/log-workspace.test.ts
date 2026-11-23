import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncServerStore } from '../src/store.js';
import { parseLogQuery, logCsv } from '../src/log-workspace.js';
import { logRequestContext, safeLogValue } from '../src/log-context.js';
import { readContainerLogs } from '../src/container-log-source.js';

describe('shared log workspace records', () => {
  it('distinguishes exchange failures and historical IP failures from rejected password proofs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-login-reasons-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-reasons');
    try {
      await store.ready;
      for (const reason of ['expired', 'already_used', 'ip_changed', 'invalid_proof']) await store.appendLog({
        id: reason, at: new Date().toISOString(), level: 'warn', action: 'login_failed', message: 'Login failed', detail: { reason },
      });
      const result = await store.logWorkspace.query(parseLogQuery('login', new URLSearchParams()));
      expect(Object.fromEntries(result.entries.map(row => [row['reason'], row['reasonCode']])))
        .toEqual({ expired: 'LOGIN_STATE_EXPIRED', already_used: 'LOGIN_STATE_INVALID', ip_changed: 'LOGIN_SOURCE_CHANGED', invalid_proof: 'INVALID_CREDENTIALS' });
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('queries real per-category fields and filters, preserves independent authentication history and task attempts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-log-fields-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-logs');
    const query = (type: string, values: Record<string, string> = {}) => parseLogQuery(type, new URLSearchParams(values));
    try {
      await store.ready;
      await logRequestContext.run({ requestId: 'req-login-fields', ip: '192.0.2.1', userAgent: 'Test Browser', method: 'POST', instanceId: 'instance-test', authMethod: 'totp', role: 'owner' }, async () => {
        await store.appendLog({ id: 'log-login', at: new Date().toISOString(), level: 'info', action: 'login_success', message: 'authenticated', username: 'operator', detail: { requestId: 'req-login-fields', component: 'auth', deviceName: 'Test phone', mfa: true, nested: { password: 'never-return' } } });
        await store.logWorkspace.recordReadAudit('actor-test', 'settings-save', { keys: ['retention'] });
        const first = await store.createJob({ type: 'database.integrity-check', createdBy: 'operator' });
        await store.finishJob(first.jobId, { status: 'failed', errorCode: 'TEST_FAILURE', errorMessage: 'failed safely' });
        await store.createJob({ type: first.type, createdBy: 'operator', retryOf: first.jobId });
      });
      await store.observability.insertEvents([{ id: 'http-test', at: new Date().toISOString(), method: 'GET', route: '/api/test/:id', status: 503, durationMs: 1250, ip: '192.0.2.1', requestId: 'req-http', userAgent: 'Client Browser', origin: 'https://site.test', instanceId: 'instance-test' }]);
      const login = await store.logWorkspace.query(query('login', { result: 'success', authMethod: 'totp', ip: '192.0.2.1' }));
      expect(login.entries).toHaveLength(1);
      expect(login.entries[0]).toMatchObject({ action: 'login.success', result: 'success', device: 'Test phone', userAgent: 'Test Browser', mfa: true, requestId: 'req-login-fields' });
      expect(JSON.stringify(login)).not.toContain('never-return');
      const system = await store.logWorkspace.query(query('system', { component: 'auth' }));
      expect(system.entries[0]).toMatchObject({ component: 'auth', requestId: 'req-login-fields' });
      const access = await store.logWorkspace.query(query('access', { method: 'GET', status: '503', minDuration: '1000' }));
      expect(access.entries[0]).toMatchObject({ durationMs: 1250, userAgent: 'Client Browser', origin: 'https://site.test', instanceId: 'instance-test' });
      expect((await store.logWorkspace.query(query('access', { maxDuration: '100' }))).entries).toHaveLength(0);
      const operations = await store.logWorkspace.query(query('operations', { actor: 'actor-test', result: 'success' }));
      expect(operations.entries[0]).toMatchObject({ actor: 'actor-test', role: 'owner', ip: '192.0.2.1', requestId: 'req-login-fields', action: 'settings-save' });
      const tasks = await store.logWorkspace.query(query('tasks', { jobName: 'database.integrity-check', instanceId: 'instance-test' }));
      expect(tasks.entries).toHaveLength(2);
      expect(tasks.entries.map((row) => row['attempt']).sort()).toEqual([1, 2]);
      expect(tasks.entries.find((row) => row['result'] === 'failed')).toMatchObject({ reasonCode: 'TEST_FAILURE', message: 'failed safely' });
      await store.pruneLogs(0);
      expect((await store.logWorkspace.query(query('login'))).entries).toHaveLength(1);
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('binds cursors to their filters and rejects invalid IP, duration and windows', () => {
    expect(() => parseLogQuery('access', new URLSearchParams({ ip: 'fake-address' }))).toThrow('IP');
    expect(() => parseLogQuery('access', new URLSearchParams({ minDuration: '200', maxDuration: '100' }))).toThrow('耗时');
    expect(() => parseLogQuery('login', new URLSearchParams({ from: '2026-01-01T00:00:00Z', until: '2026-11-01T00:00:00Z' }))).toThrow('90');
    const csv = logCsv('containers', [{ id: 'one', at: '2026-11-16T01:00:00Z', container: 'app', stream: 'stdout', message: '\t=HYPERLINK("evil")' }]);
    expect(csv).toContain("'\t=HYPERLINK");
    expect(safeLogValue({ token: 'hidden', nested: { url: 'https://user:secret@example.test', detail: 'Bearer sensitive-token' } })).toEqual({ token: '[已脱敏]', nested: { url: 'https://[已脱敏]@example.test', detail: 'Bearer [已脱敏]' } });
  });

  it('paginates identical timestamps without repetition and refuses cross-filter cursors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-log-cursor-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-cursor');
    try {
      await store.ready;
      const at = new Date().toISOString();
      for (const id of ['a', 'b', 'c']) await store.appendLog({ id, at, level: 'info', action: 'cursor_test', message: id });
      const first = await store.logWorkspace.query(parseLogQuery('system', new URLSearchParams({ limit: '2' })));
      expect(first.entries.map((row) => row.id)).toEqual(['c', 'b']);
      expect(first.hasMore).toBe(true);
      const second = await store.logWorkspace.query(parseLogQuery('system', new URLSearchParams({ limit: '2', cursor: first.nextCursor! })));
      expect(second.entries.map((row) => row.id)).toEqual(['a']);
      expect(second.hasMore).toBe(false);
      await expect(store.logWorkspace.query(parseLogQuery('system', new URLSearchParams({ level: 'error', cursor: first.nextCursor! })))).rejects.toThrow();
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads only allowlisted container snapshots, redacts content and exposes malformed or absent sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-container-log-'));
    const query = parseLogQuery('containers', new URLSearchParams({ container: 'app', stream: 'stderr' }));
    try {
      expect((await readContainerLogs(dir, query)).sourceState).toBe('unconfigured');
      writeFileSync(join(dir, 'container-logs.json'), 'null');
      expect((await readContainerLogs(dir, query)).sourceState).toBe('error');
      const at = new Date(Date.now() - 1000).toISOString();
      writeFileSync(join(dir, 'container-logs.json'), JSON.stringify({ sampledAt: at, containers: ['app'], entries: [
        { id: 'a', at, container: 'app', stream: 'stderr', message: 'token=private resetCode=private' },
        { id: 'b', at, container: 'app', stream: 'stdout', message: 'excluded stream' },
        { id: 'c', at, container: 'private', stream: 'stderr', message: 'excluded container' },
      ] }));
      const result = await readContainerLogs(dir, query);
      expect(result.sourceState).toBe('available');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.['message']).toBe('token=[已脱敏] resetCode=[已脱敏]');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
