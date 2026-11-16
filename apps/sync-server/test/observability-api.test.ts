import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginAccount, registerAccount } from '@zichan/db';
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
