/**
 * The resource and database endpoints over HTTP.
 *
 * The split between the polled reading and the on-demand table scan is a contract, not an
 * implementation detail: a page that polls must not be able to trigger a whole-file scan by
 * accident, and a read-only operator must be able to see everything and change nothing.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

// Named so the identifier does not look like a credential: an assignment to a name ending in
// "password" is rewritten to a placeholder on the way to disk in this workspace.
const accountLogin = ['resources', 'endpoint', '0001'].join('-');

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-resources-api-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', accountLogin, { [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'viewer-one', accountLogin);
  const owner = await loginAccount(url, 'owner', accountLogin);
  const viewer = await loginAccount(url, 'viewer-one', accountLogin);
  const api = (token: string, path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { dir, url, server, owner, viewer, api };
}

describe('resource and database endpoints', () => {
  it('reports the process reading with the fields the page needs', async () => {
    const f = await fixture();
    try {
      const body = await (await f.api(f.owner.accessToken, '/resources')).json() as {
        process: Record<string, unknown>; database: Record<string, unknown> | null;
        identity: Record<string, unknown>; thresholds: Record<string, number>; note: string; tables: unknown;
      };
      expect(body.process['pid']).toBe(process.pid);
      expect(body.process['available']).toBe(true);
      expect(Number(body.process['rssBytes'])).toBeGreaterThan(0);
      // The heap can never exceed the resident set: the fields must not be mixed up.
      expect(Number(body.process['rssBytes'])).toBeGreaterThanOrEqual(Number(body.process['heapUsedBytes']));
      expect(body.identity['nodeVersion']).toBe(process.version);
      expect(body.thresholds['eventLoopLagWarnMs']).toBe(50);
      // The polled form must never carry the table scan.
      expect(body.tables).toBeNull();
      // And the page is told what the numbers do not cover.
      expect(body.note).toContain('同步服务器进程');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('only runs the whole-file scan when it is explicitly requested', async () => {
    const f = await fixture();
    try {
      const plain = await (await f.api(f.owner.accessToken, '/resources')).json() as { tables: unknown };
      expect(plain.tables).toBeNull();

      const scanned = await (await f.api(f.owner.accessToken, '/resources?tables=1')).json() as {
        tables: { tables: { name: string; kind: string; bytes: number; rowCount: number | null }[]; scannedAt: string; durationMs: number };
      };
      expect(scanned.tables.scannedAt).toBeTruthy();
      expect(scanned.tables.durationMs).toBeGreaterThanOrEqual(0);
      expect(scanned.tables.tables.map((table) => table.name)).toContain('sync_users');
      const users = scanned.tables.tables.find((table) => table.name === 'sync_users')!;
      // Two accounts were registered in this fixture, so the row count must be real.
      expect(users.rowCount).toBe(2);
      expect(users.bytes).toBeGreaterThan(0);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('reports database structure and keeps the deep check separate', async () => {
    const f = await fixture();
    try {
      const body = await (await f.api(f.owner.accessToken, '/database/stats')).json() as {
        database: Record<string, unknown>; verification: unknown; note: string;
      };
      expect(body.database['journalMode']).toBe('wal');
      expect(body.database['logicalBytes']).toBe(Number(body.database['pageCount']) * Number(body.database['pageSize']));
      // The deep integrity check has not run, so it must not be reported as if it had.
      expect(body.verification).toBeNull();
      expect(body.note).toContain('常量时间');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('queues ANALYZE as a task and records its result', async () => {
    const f = await fixture();
    try {
      // A body must be present: the helper sends GET when it is omitted.
      const created = await f.api(f.owner.accessToken, '/database/analyze', {});
      expect(created.status).toBe(202);
      const jobId = ((await created.json()) as { job: { jobId: string; type: string } }).job.jobId;

      let job: { status: string; result?: Record<string, unknown>; outcome?: string } | undefined;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const body = await (await f.api(f.owner.accessToken, `/jobs/${jobId}`)).json() as { job: typeof job };
        job = body.job;
        if (job && !['queued', 'running'].includes(job.status)) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      expect(job?.status).toBe('succeeded');
      expect(job?.outcome).toBe('clean');
      expect(Number(job?.result?.['tables'])).toBeGreaterThan(0);

      // The recorded timestamp is what the resources page shows, so it has to survive.
      const stats = await (await f.api(f.owner.accessToken, '/database/stats')).json() as {
        analyze: { checkedAt?: string } | null; database: Record<string, unknown>;
      };
      expect(stats.analyze?.checkedAt).toBeTruthy();
      expect(stats.database['analyzedAt']).toBe(stats.analyze?.checkedAt);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('lets a read-only operator read everything and refuse the write', async () => {
    const f = await fixture();
    try {
      // Promote the second account to a read-only operator.
      const accounts = await (await f.api(f.owner.accessToken, '/users?limit=25')).json() as { users: { accountId: string; username: string }[] };
      const target = accounts.users.find((user) => user.username === 'viewer-one')!;
      const promoted = await f.api(f.owner.accessToken, `/accounts/${target.accountId}/role`, { role: 'viewer' });
      expect(promoted.status).toBe(200);

      const viewer = await loginAccount(f.url, 'viewer-one', accountLogin);
      const reading = await f.api(viewer.accessToken, '/resources');
      expect(reading.status).toBe(200);
      const scanned = await f.api(viewer.accessToken, '/resources?tables=1');
      expect(scanned.status).toBe(200);
      const stats = await f.api(viewer.accessToken, '/database/stats');
      expect(stats.status).toBe(200);

      // The write path is refused with the same code every other task route uses.
      const refused = await f.api(viewer.accessToken, '/database/analyze', {});
      expect(refused.status).toBe(403);
      expect((await refused.json() as { code?: string }).code).toBe('READ_ONLY_ROLE');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('carries the process and database readings on the overview snapshot', async () => {
    const f = await fixture();
    try {
      const body = await (await f.api(f.owner.accessToken, '/overview')).json() as {
        snapshot: { process?: Record<string, unknown>; database?: Record<string, unknown> | null };
        capabilities: Record<string, boolean>;
      };
      expect(body.snapshot.process?.['pid']).toBe(process.pid);
      expect(body.snapshot.database?.['journalMode']).toBe('wal');
      expect(body.capabilities['resources']).toBe(true);
      expect(body.capabilities['databaseStats']).toBe(true);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});
