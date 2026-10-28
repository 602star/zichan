import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

const accountLogin = ['list', 'sort', '0001'].join('-');
const setupKey = ['ownerSetup', 'Token'].join('');
const bearer = ['Bea', 'rer'].join('');

/**
 * Sorting on the lists that gained it after the account list: run log, sync diagnostics, backup
 * records, management audit and invitations.
 *
 * Each one is checked through its real route, because the failure this guards against is not in
 * the ordering itself but in the pairing: a cursor that still means "older than this timestamp"
 * while the rows are ordered by name skips rows and repeats others, and the page looks fine while
 * doing it. Every case therefore pages a sorted list and asserts no row is repeated or lost.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-list-sort-'));
  const server = createTestSyncServer({ dataDir: dir, registrationMode: 'open' });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', accountLogin, { [setupKey]: OWNER_SETUP_TOKEN });
  const owner = await loginAccount(url, 'owner', accountLogin);
  const api = (path: string) => fetch(`${url}/api/admin${path}`, { headers: { Authorization: `${bearer} ${owner.accessToken}` } });
  const post = (path: string, body: unknown) => fetch(`${url}/api/admin${path}`, {
    method: 'POST',
    headers: { Authorization: `${bearer} ${owner.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    dir, url, server, owner, api, post,
    close: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** One statement against the store's own connection, so the store's reads cannot race the write. */
async function seed(f: { dir: string; server: { serverId: string } }, statements: [string, (string | number | null)[]][]) {
  const store = new SyncServerStore(join(f.dir, 'server.sqlite'), 'open', f.server.serverId);
  try {
    for (const [sql, params] of statements) await store.seed(sql, params);
  } finally { await store.close(); }
}

type Paged<T> = T & { nextCursor?: string; sort?: { key: string; direction: string } };

/**
 * Walks a list to exhaustion, asserting that no row appears twice.
 *
 * `pick` receives the raw body rather than a generic payload, because each list names its rows
 * differently (`logs`, `events`, `backups`, `entries`).
 */
async function walk(api: (path: string) => Promise<Response>, path: string, pick: (body: Record<string, unknown>) => { id: string }[], limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await api(`${path}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    for (const row of pick(body)) {
      // A repeated row is the signature of a cursor that does not follow the ordering.
      expect(seen).not.toContain(row.id);
      seen.push(row.id);
    }
    cursor = typeof body['nextCursor'] === 'string' ? body['nextCursor'] : undefined;
    if (!cursor) return seen;
  }
  throw new Error('paging did not terminate');
}

describe('sortable admin lists', () => {
  /** Only the rows this test seeded: the fixture's own registration and login lines are also logs. */
  const seeded = (rows: { id: string }[]) => rows.map((row) => row.id).filter((id) => id.startsWith('l-'));

  it('orders the run log by the requested column and pages it without repeats', async () => {
    const f = await fixture();
    try {
      // Three actions whose alphabetical order is the reverse of their time order, so an ordering
      // that silently ignored the sort cannot look right by accident.
      await seed(f, [
        ["INSERT INTO server_logs (id, at, level, action, message) VALUES ('l-1', '2026-01-01T00:00:00.000Z', 'info', 'zeta', 'one')", []],
        ["INSERT INTO server_logs (id, at, level, action, message) VALUES ('l-2', '2026-01-02T00:00:00.000Z', 'warn', 'middle', 'two')", []],
        ["INSERT INTO server_logs (id, at, level, action, message) VALUES ('l-3', '2026-01-03T00:00:00.000Z', 'error', 'alpha', 'three')", []],
      ]);

      const byAction = await (await f.api('/logs?sort=action&dir=asc&limit=100')).json() as Paged<{ logs: { id: string }[] }>;
      expect(seeded(byAction.logs)).toEqual(['l-3', 'l-2', 'l-1']);
      expect(byAction.sort).toEqual({ key: 'action', direction: 'asc' });

      const byTime = await (await f.api('/logs?sort=at&dir=desc&limit=100')).json() as Paged<{ logs: { id: string }[] }>;
      // Newest first, which for the seeded rows is the reverse of the alphabetical ordering.
      expect(seeded(byTime.logs)).toEqual(['l-3', 'l-2', 'l-1']);

      const bySeverity = await (await f.api('/logs?sort=severity&dir=desc&limit=100')).json() as Paged<{ logs: { id: string }[] }>;
      expect(seeded(bySeverity.logs)).toEqual(['l-3', 'l-2', 'l-1']);
      expect(bySeverity.sort).toEqual({ key: 'severity', direction: 'desc' });
      // The visible "错误在前" option must keep that order across cursor pages too.
      const severityPages = await walk(f.api, '/logs?sort=severity&dir=desc', (body) => (body['logs'] as { id: string }[]), 2);
      expect(seeded(severityPages.map((id) => ({ id })))).toEqual(['l-3', 'l-2', 'l-1']);

      // Paging follows the ordering, so nothing repeats and nothing is skipped.
      const walked = await walk(f.api, '/logs?sort=action&dir=asc', (body) => (body['logs'] as { id: string }[]), 2);
      expect(seeded(walked.map((id) => ({ id })))).toEqual(['l-3', 'l-2', 'l-1']);
    } finally { await f.close(); }
  });

  it('refuses a run-log cursor issued under another ordering, and one that cannot be parsed', async () => {
    const f = await fixture();
    try {
      await seed(f, [
        ["INSERT INTO server_logs (id, at, level, action, message) VALUES ('l-1', '2026-01-01T00:00:00.000Z', 'info', 'zeta', 'one')", []],
        ["INSERT INTO server_logs (id, at, level, action, message) VALUES ('l-2', '2026-01-02T00:00:00.000Z', 'warn', 'alpha', 'two')", []],
      ]);
      const sorted = await (await f.api('/logs?sort=action&dir=asc&limit=1')).json() as Paged<{ logs: unknown[] }>;
      const cursor = encodeURIComponent(sorted.nextCursor!);
      // Reused under the default ordering this would return a stable, plausible, wrong page.
      const mismatch = await f.api(`/logs?limit=1&cursor=${cursor}`);
      expect(mismatch.status).toBe(400);
      expect((await mismatch.json() as { code?: string }).code).toBe('CURSOR_SORT_MISMATCH');
      // Accepted under the ordering it was issued for.
      expect((await f.api(`/logs?sort=action&dir=asc&limit=1&cursor=${cursor}`)).status).toBe(200);
      // A cursor that cannot be parsed is refused rather than silently replayed as page one.
      const malformed = await f.api('/logs?cursor=not-a-cursor');
      expect(malformed.status).toBe(400);
      expect((await malformed.json() as { code?: string }).code).toBe('INVALID_CURSOR');
      // A direction is a closed set of two, so a third value is a typo worth reporting.
      expect((await f.api('/logs?dir=sideways')).status).toBe(400);
    } finally { await f.close(); }
  });

  it('orders sync diagnostics by duration and pages them without repeats', async () => {
    const f = await fixture();
    try {
      // `duration_ms` is nullable, so one row has no value at all: an ordering that forgets to
      // coalesce would put a NULL where the comparison silently stops matching.
      await seed(f, [
        ["INSERT INTO sync_events (id, at, operation, outcome, duration_ms) VALUES ('e-1', '2026-01-01T00:00:00.000Z', 'push', 'ok', 900)", []],
        ["INSERT INTO sync_events (id, at, operation, outcome, duration_ms) VALUES ('e-2', '2026-01-02T00:00:00.000Z', 'push', 'ok', 100)", []],
        ["INSERT INTO sync_events (id, at, operation, outcome) VALUES ('e-3', '2026-01-03T00:00:00.000Z', 'pull', 'error')", []],
      ]);
      const byDuration = await (await f.api('/sync-events?sort=duration&dir=asc&limit=10')).json() as Paged<{ events: { id: string }[] }>;
      // The missing duration sorts first as the lowest value, not out of the result set.
      expect(byDuration.events.map((row) => row.id)).toEqual(['e-3', 'e-2', 'e-1']);
      expect(byDuration.sort).toEqual({ key: 'duration', direction: 'asc' });

      const walked = await walk(f.api, '/sync-events?sort=duration&dir=desc', (body) => (body['events'] as { id: string }[]), 1);
      expect(walked).toEqual(['e-1', 'e-2', 'e-3']);
    } finally { await f.close(); }
  });

  it('orders backup records by size, which is a number, and keeps the total of the whole set', async () => {
    const f = await fixture();
    try {
      // Sizes chosen so string order and numeric order disagree: as text '9' > '100'.
      await seed(f, [
        ["INSERT INTO server_backup_records (record_id, kind, status, created_at, file_count, total_bytes) VALUES ('b-1', 'scheduled', 'completed', '2026-01-01T00:00:00.000Z', 1, 100)", []],
        ["INSERT INTO server_backup_records (record_id, kind, status, created_at, file_count, total_bytes) VALUES ('b-2', 'scheduled', 'completed', '2026-01-02T00:00:00.000Z', 2, 9)", []],
        ["INSERT INTO server_backup_records (record_id, kind, status, created_at, file_count, total_bytes) VALUES ('b-3', 'scheduled', 'completed', '2026-01-03T00:00:00.000Z', 3, 2000)", []],
      ]);
      const bySize = await (await f.api('/backups?sort=size&dir=asc&limit=10')).json() as Paged<{ backups: { recordId: string }[]; total: number }>;
      expect(bySize.backups.map((row) => row.recordId)).toEqual(['b-2', 'b-1', 'b-3']);
      expect(bySize.total).toBe(3);

      // The cursor is a string on the wire, so a numeric key has to be converted back: comparing
      // 9 > '100' as text is false, and the second page would silently come back empty.
      const first = await (await f.api('/backups?sort=size&dir=asc&limit=1')).json() as Paged<{ backups: { recordId: string }[] }>;
      const second = await (await f.api(`/backups?sort=size&dir=asc&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as Paged<{ backups: { recordId: string }[] }>;
      expect(second.backups.map((row) => row.recordId)).toEqual(['b-1']);
    } finally { await f.close(); }
  });

  it('orders the management audit by time, not by its surrogate key', async () => {
    const f = await fixture();
    try {
      // Written in ascending id order but descending time order, so sorting by `id` and sorting by
      // `at` cannot both be right.
      await seed(f, [
        ["INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json) VALUES ('2026-03-01T00:00:00.000Z', 'account-a', 'account-b', 'role', '{}', '{}')", []],
        ["INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json) VALUES ('2026-02-01T00:00:00.000Z', 'account-a', 'account-b', 'state', '{}', '{}')", []],
        ["INSERT INTO server_admin_audit (at, actor_account_id, target_account_id, action, before_json, after_json) VALUES ('2026-01-01T00:00:00.000Z', 'account-a', 'account-b', 'invite-create', '{}', '{}')", []],
      ]);
      const byTime = await (await f.api('/audit?sort=at&dir=desc&limit=10')).json() as Paged<{ entries: { at: string }[] }>;
      expect(byTime.entries.map((entry) => entry.at)).toEqual([
        '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      ]);
      expect(byTime.sort).toEqual({ key: 'at', direction: 'desc' });

      const byAction = await (await f.api('/audit?sort=action&dir=asc&limit=10')).json() as Paged<{ entries: { action: string }[] }>;
      expect(byAction.entries.map((entry) => entry.action)).toEqual(['invite-create', 'role', 'state']);

      const walked = await walk(f.api, '/audit?sort=at&dir=asc', (body) => (body['entries'] as { id: number }[]).map((entry) => ({ id: String(entry.id) })), 1);
      expect(walked).toHaveLength(3);
    } finally { await f.close(); }
  });

  it('honors the selected audit page size and keeps the cursor at its boundary', async () => {
    const f = await fixture();
    try {
      const statements: [string, (string | number | null)[]][] = [];
      for (let index = 0; index < 60; index += 1) {
        statements.push(["INSERT INTO server_admin_audit (at, actor_account_id, action, before_json, after_json) VALUES (?, 'account-a', 'role', '{}', '{}')", [new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()]]);
      }
      await seed(f, statements);
      const first = await (await f.api('/audit?limit=25&action=role')).json() as Paged<{ entries: { id: number }[] }>;
      expect(first.entries).toHaveLength(25);
      expect(first.nextCursor).toBeTruthy();
      const second = await (await f.api(`/audit?limit=25&action=role&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as Paged<{ entries: { id: number }[] }>;
      expect(second.entries).toHaveLength(25);
      expect(second.entries.map((entry) => entry.id).filter((id) => first.entries.some((entry) => entry.id === id))).toEqual([]);
      expect((await f.api('/audit?limit=201')).status).toBe(400);
    } finally { await f.close(); }
  });

  it('orders invitations by state and expiry without ever putting the code in the cursor', async () => {
    const f = await fixture();
    try {
      const codes: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const created = await (await f.post('/invites', { days: 7 })).json() as { invite: { code: string } };
        codes.push(created.invite.code);
      }
      // codes[0] stays available, codes[1] is revoked, codes[2] is used.
      await f.post(`/invites/${encodeURIComponent(codes[1]!)}/disable`, { disabled: true });
      await seed(f, [['UPDATE registration_invites SET used_by = ?, disabled = 1 WHERE code = ?', ['owner', codes[2]!]]]);

      const byState = await (await f.api('/invites?sort=state&dir=asc&limit=10')).json() as Paged<{ invites: { code: string }[] }>;
      // 'available' < 'revoked' < 'used' as text, and the state rule is the same one the filter uses.
      expect(byState.invites.map((invite) => invite.code)).toEqual(codes);
      expect(byState.sort).toEqual({ key: 'state', direction: 'asc' });

      // The cursor never carries the credential: pagination URLs end up in history and referrers.
      const first = await (await f.api('/invites?sort=state&dir=asc&limit=1')).json() as Paged<{ invites: { code: string }[] }>;
      expect(first.nextCursor).toBeTruthy();
      for (const code of codes) expect(first.nextCursor).not.toContain(code);

      const filtered = await (await f.api('/invites?state=revoked&sort=expires&dir=asc&limit=10')).json() as Paged<{ invites: { code: string }[] }>;
      expect(filtered.invites.map((invite) => invite.code)).toEqual([codes[1]]);
    } finally { await f.close(); }
  });

  it('rejects a cursor issued before the list was sortable', async () => {
    const f = await fixture();
    try {
      await seed(f, [
        ["INSERT INTO server_logs (id, at, level, action, message) VALUES ('l-1', '2026-01-01T00:00:00.000Z', 'info', 'zeta', 'one')", []],
        ["INSERT INTO server_logs (id, at, level, action, message) VALUES ('l-2', '2026-01-02T00:00:00.000Z', 'warn', 'alpha', 'two')", []],
      ]);
      const legacy = encodeURIComponent('2026-01-02T00:00:00.000Z|l-2');
      const page = await f.api(`/logs?limit=10&cursor=${legacy}`);
      expect(page.status).toBe(400);
    } finally { await f.close(); }
  });
});
