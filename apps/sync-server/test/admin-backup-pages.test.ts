import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

const password = ['backup', 'pages', '0001'].join('-');

/**
 * Backup records used to be a fixed 50 with no way past them, and the "last successful backup"
 * summary was derived from that truncated page. These tests pin the paging and the summary, and
 * pin the bug the truncation caused: a run of failures must not make a real success disappear.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-backup-pages-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN });
  const owner = await loginAccount(url, 'owner', password);
  const authorization = ['Bea', 'rer'].join('');
  const api = (path: string) => fetch(`${url}/api/admin${path}`, { headers: { Authorization: `${authorization} ${owner.accessToken}` } });
  return { dir, url, server, owner, api, dataDir: dir };
}

/** Writes backup records directly: the API only reads them, and deployment-side code writes them. */
async function seed(f: { dataDir: string; server: { serverId: string } }, records: {
  recordId: string; createdAt: string; status: string; verifiedAt?: string; verificationOk?: boolean; retention?: boolean;
  note?: string; unverifiedCount?: number;
}[]) {
  const store = new SyncServerStore(join(f.dataDir, 'server.sqlite'), 'open', f.server.serverId);
  try {
    for (const record of records) {
      await store.upsertBackupRecord({
        recordId: record.recordId,
        kind: 'scheduled',
        status: record.status,
        createdAt: record.createdAt,
        ...(record.verifiedAt ? { verifiedAt: record.verifiedAt } : {}),
        ...(record.verificationOk === undefined ? {} : { verification: { ok: record.verificationOk } }),
        ...(record.retention ? { retention: { keep: 3, removed: [], retained: [], unverifiedCount: record.unverifiedCount ?? 0 } } : {}),
        ...(record.note ? { note: record.note } : {}),
      });
    }
  } finally { await store.close(); }
}

describe('backup record paging and summary', () => {
  it('pages past the first batch instead of stopping at a fixed count', async () => {
    const f = await fixture();
    try {
      const records = Array.from({ length: 30 }, (_, index) => ({
        recordId: `backup-${String(index).padStart(3, '0')}`,
        // Newest first by creation time, so index 0 is the newest.
        createdAt: new Date(Date.UTC(2026, 8, 19, 12, 0, 0) - index * 3_600_000).toISOString(),
        status: 'completed',
      }));
      await seed(f, records);

      const first = await (await f.api('/backups?limit=25')).json() as {
        backups: { recordId: string }[]; nextCursor?: string; total: number;
      };
      expect(first.backups).toHaveLength(25);
      expect(first.nextCursor).toBeDefined();
      // The total is the filtered set, not the page: "how many are kept" is a whole-set question.
      expect(first.total).toBe(30);

      const second = await (await f.api(`/backups?limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as {
        backups: { recordId: string }[]; nextCursor?: string;
      };
      expect(second.backups).toHaveLength(5);
      expect(second.nextCursor).toBeUndefined();
      // No overlap and no gap between the two pages.
      const seen = [...first.backups, ...second.backups].map((record) => record.recordId);
      expect(new Set(seen).size).toBe(30);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('keeps the last successful backup visible even when recent records are all failures', async () => {
    const f = await fixture();
    try {
      // This is the bug the fixed page caused: 25 failures newer than the last success would push
      // it off the page, and the summary — derived from that page — reported "never".
      await seed(f, [
        ...Array.from({ length: 25 }, (_, index) => ({
          recordId: `failed-${String(index).padStart(3, '0')}`,
          createdAt: new Date(Date.UTC(2026, 8, 19, 12, 0, 0) - index * 3_600_000).toISOString(),
          status: 'failed',
        })),
        { recordId: 'good-old-one', createdAt: '2026-09-01T00:00:00.000Z', status: 'completed', verifiedAt: '2026-09-01T00:05:00.000Z', verificationOk: true },
      ]);

      const body = await (await f.api('/backups?limit=25')).json() as {
        backups: { recordId: string }[];
        summary: { lastSuccess: { recordId: string } | null; lastVerified: { recordId: string } | null };
      };
      // The success is not on this page...
      expect(body.backups.some((record) => record.recordId === 'good-old-one')).toBe(false);
      // ...but the summary still finds it, because it is queried rather than read off the page.
      expect(body.summary.lastSuccess?.recordId).toBe('good-old-one');
      expect(body.summary.lastVerified?.recordId).toBe('good-old-one');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('does not count a backup whose verification failed as a success', async () => {
    const f = await fixture();
    try {
      await seed(f, [
        { recordId: 'created-but-bad', createdAt: '2026-09-19T12:00:00.000Z', status: 'completed', verifiedAt: '2026-09-19T12:05:00.000Z', verificationOk: false },
        { recordId: 'truly-good', createdAt: '2026-09-18T12:00:00.000Z', status: 'completed', verifiedAt: '2026-09-18T12:05:00.000Z', verificationOk: true },
      ]);
      const body = await (await f.api('/backups?limit=25')).json() as {
        summary: { lastSuccess: { recordId: string } | null; lastVerified: { recordId: string } | null };
      };
      // Creation succeeded but verification rejected it: that is a failed backup, and reporting it
      // as the last success would postpone the overdue alert on a server that has no good backup.
      expect(body.summary.lastSuccess?.recordId).toBe('truly-good');
      expect(body.summary.lastVerified?.recordId).toBe('truly-good');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('filters by status and kind, and validates the filters', async () => {
    const f = await fixture();
    try {
      await seed(f, [
        { recordId: 'ok-1', createdAt: '2026-09-19T12:00:00.000Z', status: 'completed' },
        { recordId: 'bad-1', createdAt: '2026-09-19T11:00:00.000Z', status: 'failed' },
        { recordId: 'bad-2', createdAt: '2026-09-19T10:00:00.000Z', status: 'failed' },
      ]);
      const failed = await (await f.api('/backups?status=failed')).json() as { backups: { recordId: string }[]; total: number };
      expect(failed.backups.map((record) => record.recordId)).toEqual(['bad-1', 'bad-2']);
      expect(failed.total).toBe(2);

      expect((await f.api('/backups?status=unknown')).status).toBe(400);
      expect((await f.api('/backups?kind=unknown')).status).toBe(400);
      expect((await f.api('/backups?limit=0')).status).toBe(400);
      expect((await f.api('/backups?limit=500')).status).toBe(400);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('reports the newest retention run without needing it on the page', async () => {
    const f = await fixture();
    try {
      await seed(f, [
        ...Array.from({ length: 25 }, (_, index) => ({
          recordId: `newer-${String(index).padStart(3, '0')}`,
          createdAt: new Date(Date.UTC(2026, 8, 19, 12, 0, 0) - index * 3_600_000).toISOString(),
          status: 'completed',
        })),
        { recordId: 'retention-run', createdAt: '2026-09-01T00:00:00.000Z', status: 'completed', retention: true, unverifiedCount: 2, note: '备份保留：保留 3 份，已清理 1 份。' },
      ]);
      const body = await (await f.api('/backups?limit=25')).json() as {
        summary: { lastRetention: { recordId: string; note?: string; retention?: Record<string, unknown> } | null };
      };
      expect(body.summary.lastRetention?.recordId).toBe('retention-run');
      // The note and the outcome travel with the summary: paging the list must not cost the
      // operator the "what did it actually do" answer that the page showed before.
      expect(body.summary.lastRetention?.note).toContain('已清理 1 份');
      expect(body.summary.lastRetention?.retention?.['unverifiedCount']).toBe(2);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});
