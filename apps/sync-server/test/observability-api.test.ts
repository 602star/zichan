import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('administrative observability boundaries', () => {
  it('protects metrics, validates windows, returns real SQLite capabilities and marks absent host data unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-obs-api-'));
    const server = createTestSyncServer({ dataDir: dir });
    try {
      await server.ready; await server.started;
      await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const url = `http://127.0.0.1:${address.port}`;
      const secret = 'observability-test-login-000001';
      await registerAccount(url, 'owner', secret, { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'member', secret);
      const owner = await loginAccount(url, 'owner', secret);
      const member = await loginAccount(url, 'member', secret);
      const api = (path: string, token?: string) => fetch(`${url}/api/admin/ops${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      expect((await api('/requests/summary')).status).toBe(401);
      expect((await api('/requests/summary', member.accessToken)).status).toBe(403);
      expect((await api('/requests/summary?range=365d', owner.accessToken)).status).toBe(400);
      const database = await (await api('/database/current', owner.accessToken)).json();
      expect(database).toMatchObject({ data: { engine: 'sqlite', journalMode: 'wal', busyTimeoutMs: 5000, available: true }, meta: { source: 'sqlite_pragma', stale: false } });
      expect(database.data).not.toHaveProperty('pgPool');
      const host = await (await api('/host', owner.accessToken)).json();
      expect(host).toMatchObject({ data: null, meta: { dataAsOf: null, stale: true } });
      const requests = await (await api('/requests/summary?range=15m', owner.accessToken)).json();
      expect(requests).toMatchObject({ data: { latencyMs: { p95: null }, histogramScheme: 'http_latency_v1' }, meta: { source: 'http_finish_histogram' } });
      const custom = new URLSearchParams({ range: 'custom', from: '2026-11-10T01:15:00.000Z', until: '2026-11-10T01:45:00.000Z' });
      const history = (path: string) => fetch(`${url}/api/admin${path}`, { headers: { Authorization: `Bearer ${owner.accessToken}` } });
      const customRequests = await api(`/requests/summary?${custom}`, owner.accessToken);
      expect(customRequests.status).toBe(200);
      expect(await customRequests.json()).toMatchObject({ data: { windowStart: custom.get('from'), windowEnd: custom.get('until'), bucketMs: 60000 } });
      for (const path of ['/metrics', '/system/metrics', '/traffic']) {
        const response = await history(`${path}?${custom}`); expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ range: 'custom', from: custom.get('from'), until: custom.get('until') });
        expect((await history(`${path}?range=custom&from=bad&until=bad`)).status).toBe(400);
      }
      const timing = await history(`/startup-timing?${custom}`);
      expect(timing.status).toBe(200); expect(await timing.json()).toMatchObject({ fromDay: '2026-11-10', untilDay: '2026-11-11' });
      expect((await api('/requests/summary?range=custom&from=2026-11-01T00:00:00Z&until=2026-11-10T00:00:00Z', owner.accessToken)).status).toBe(200);
      for (const range of ['30d', '90d']) expect((await api(`/requests/summary?range=${range}`, owner.accessToken)).status).toBe(200);
      const databaseDriver = new NodeSqliteDriver(join(server.dataDir, 'server.sqlite'));
      const oldHour = new Date(Date.now() - 16 * 86_400_000); oldHour.setUTCHours(3, 0, 0, 0);
      const oldDay = oldHour.toISOString().slice(0, 10);
      const endDay = new Date(oldHour.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
      try { await databaseDriver.run("INSERT INTO obs_http_hour_buckets VALUES (?,'history','/api/auth/login','POST',2,6,30,'[6,0,0,0,0,0,0,0,0,0,0,0]')", [oldHour.toISOString()]); }
      finally { await databaseDriver.close(); }
      const historicalHour = await api(`/requests/summary?range=custom&from=${oldDay}T03:15:00Z&until=${oldDay}T03:45:00Z`, owner.accessToken);
      expect(historicalHour.status).toBe(200);
      expect(await historicalHour.json()).toMatchObject({ data: { totalRequests: 6, sourceResolution: 'hour', bucketMs: 3600000,
        windowStart: `${oldDay}T03:00:00.000Z`, windowEnd: `${oldDay}T04:00:00.000Z`, latencyMs: { p95: 5 } } });
      const longRequests = await (await api(`/requests/summary?range=custom&from=${oldDay}T03:15:00Z&until=${endDay}T10:30:00Z`, owner.accessToken)).json();
      expect(longRequests.data.buckets[0].qpsAverage).toBe(6 / (21 * 3600));
      expect((await api('/requests/summary?range=custom&from=2026-01-01T00:00:00Z&until=2026-11-10T00:00:00Z', owner.accessToken)).status).toBe(400);
      expect((await api('/logs/access?status=bogus', owner.accessToken)).status).toBe(400);
      const logs = (path: string, token?: string) => fetch(`${url}/api/admin/log-workspace${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      expect((await logs('/login')).status).toBe(401);
      expect((await logs('/login', member.accessToken)).status).toBe(403);
      const logins = await (await logs('/login?username=owner&result=success', owner.accessToken)).json();
      expect(logins.entries.length).toBeGreaterThan(0);
      expect(logins.entries[0]).toMatchObject({ username: 'owner', accountId: owner.accountId, ip: '127.0.0.1', authMethod: 'opaque', requestId: expect.stringMatching(/^req-/), device: expect.any(String) });
      const exported = await logs('/login/export?format=json&username=owner&result=success', owner.accessToken);
      expect(exported.headers.get('X-Log-Export-Truncated')).toBe('false');
      const download = await exported.json();
      expect(download.rows.every((row: { username: string }) => row.username === 'owner')).toBe(true);
      expect(download.fields).toContain('device');
      const audit = await (await logs('/operations?action=logs-export', owner.accessToken)).json();
      expect(audit.entries[0]).toMatchObject({ actor: 'owner', ip: '127.0.0.1', role: 'owner', result: 'success' });
      for (const path of ['/livez', '/readyz', '/healthz']) expect((await fetch(url + path)).status).toBe(200);
    } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
