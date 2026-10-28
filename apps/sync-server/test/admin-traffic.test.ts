import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncServerStore } from '../src/store.js';
import { createTestSyncServer } from './support/server-fixture.js';
import { NodeSqliteDriver } from '@zichan/db/node';

describe('browser traffic aggregation', () => {
  it('counts page views and distinct browser identifiers across buckets and countries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-traffic-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-traffic');
    try {
      await store.ready;
      await store.recordPageView('browser-a', '/app', 'CN', new Date('2026-10-27T10:01:00.000Z'));
      await store.recordPageView('browser-a', '/admin/monitor', 'CN', new Date('2026-10-27T10:02:00.000Z'));
      await store.recordPageView('browser-b', '/app', null, new Date('2026-10-27T11:01:00.000Z'));
      const summary = await store.trafficSummary('2026-10-27T10:00:00.000Z', '2026-10-27T12:00:00.000Z', 'hour');
      expect(summary).toMatchObject({ pv: 3, uv: 2,
        buckets: [
          { bucketAt: '2026-10-27T10:00:00.000Z', pv: 2, uv: 1 },
          { bucketAt: '2026-10-27T11:00:00.000Z', pv: 1, uv: 1 },
        ],
      });
      expect(summary.countries).toEqual(expect.arrayContaining([
        { country: 'CN', pv: 2, uv: 1 }, { country: null, pv: 1, uv: 1 },
      ]));
      expect(summary.pages).toEqual(expect.arrayContaining([
        { page: '/app', pv: 2, uv: 2 }, { page: '/admin/monitor', pv: 1, uv: 1 },
      ]));
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('traffic ingestion boundary', () => {
  it('requires same origin and accepts country only from an explicitly trusted proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-traffic-http-'));
    const server = createTestSyncServer({ dataDir: dir, trustedProxies: ['loopback'], trafficCountryHeader: 'x-geo-country' });
    try {
      await server.ready;
      await server.started;
      await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const url = `http://127.0.0.1:${address.port}`;
      const body = JSON.stringify({ visitorId: '12345678-1234-1234-1234-123456789abc', page: '/app' });
      const headers = { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https', 'x-geo-country': 'CN' };
      const denied = await fetch(`${url}/api/traffic/view`, { method: 'POST', headers: { ...headers, Origin: 'https://elsewhere.test' }, body });
      expect(denied.status).toBe(403);
      const accepted = await fetch(`${url}/api/traffic/view`, { method: 'POST', headers: { ...headers, Origin: `https://127.0.0.1:${address.port}` }, body });
      expect(accepted.status).toBe(202);
      const driver = new NodeSqliteDriver(join(dir, 'server.sqlite'));
      try {
        const rows = await driver.all<{ country: string; visitor_hash: string }>('SELECT country, visitor_hash FROM traffic_page_views');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.country).toBe('CN');
        expect(rows[0]?.visitor_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(rows[0]?.visitor_hash).not.toContain('12345678');
      } finally { await driver.close(); }
    } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
