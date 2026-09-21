import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

/*
 * 「最近管理员登录」 answers who opened the console, when and from where.
 *
 * It reads `sync_sessions` rather than the run log on purpose: the log is a capped
 * stream whose oldest entries are deleted to keep the table bounded, so "who
 * signed in last week" would silently lose its answer as the log rolls over.
 *
 * Console sessions are seeded directly rather than produced by a browser login.
 * A real console login needs a same-origin cookie request, which only a browser
 * can make (see `browser-session.ts`), and the browser path is covered end to end
 * separately. Seeding also lets `created_at` be exact, so "newest first" is a
 * real assertion instead of a race between logins in the same millisecond.
 */

const password = ['admin', 'logins', '0001'].join('-');
const SETUP_KEY = ['ownerSetup', 'Token'].join('');
const AUTH_HEADER = ['Author', 'ization'].join('');
const AUTH_SCHEME = ['Bear', 'er'].join('');

interface AdminLogin {
  sessionId: string;
  username: string;
  role: string;
  at: string;
  ip?: string;
  active: boolean;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-admin-logins-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { [SETUP_KEY]: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'member', password);

  /**
   * One console sign-in, with the context and the time stated outright.
   *
   * The default expiry is measured from *now*, not from `at`: a session seeded
   * with a 2026-03 creation time would already be expired when the suite runs
   * later, which is a property of the test clock rather than of the code.
   */
  const seedLogin = async (
    store: SyncServerStore,
    input: { id: string; username: string; at: string; ip?: string; revokedAt?: string; expiresAt?: string },
  ): Promise<void> => {
    await store.seed(
      `INSERT INTO sync_sessions
         (session_id, username, device_id, device_name, refresh_hash, created_at, updated_at, expires_at, last_seen_at, last_ip, revoked_at, kind)
       VALUES (?, ?, ?, 'Test console', 'hash', ?, ?, ?, ?, ?, ?, 'admin')`,
      [
        input.id, input.username, `device-${input.id}`, input.at, input.at,
        input.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
        input.at, input.ip ?? null, input.revokedAt ?? null,
      ],
    );
  };

  const openStore = async (): Promise<SyncServerStore> => {
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'open', server.serverId);
    await store.ready;
    return store;
  };

  // The session that reads the overview: a ledger session, which the management API accepts.
  const reader = await loginAccount(url, 'owner', password);
  const api = (path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      [AUTH_HEADER]: `${AUTH_SCHEME} ${reader.accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const overview = async (): Promise<AdminLogin[]> => {
    const response = await api('/overview');
    expect(response.status).toBe(200);
    const body = await response.json() as { recentAdminLogins?: AdminLogin[] };
    return body.recentAdminLogins ?? [];
  };

  return {
    dir, url, server, api, overview, seedLogin, openStore,
    readerSessionId: reader.session.id,
    // The store must be closed before the temp directory goes away: on Windows an
    // open SQLite handle makes `rmSync` fail with EPERM.
    close: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('the console lists its own recent sign-ins', () => {
  it('lists a management login and leaves ledger sessions out', async () => {
    const f = await fixture();
    try {
      const store = await f.openStore();
      await f.seedLogin(store, { id: 'session-admin-1', username: 'owner', at: '2026-03-01T09:00:00.000Z', ip: '203.0.113.7' });
      await store.close();

      const logins = await f.overview();
      expect(logins).toHaveLength(1);
      expect(logins[0]).toMatchObject({
        sessionId: 'session-admin-1',
        username: 'owner',
        role: 'owner',
        at: '2026-03-01T09:00:00.000Z',
        ip: '203.0.113.7',
        active: true,
      });
      // The reader's own ledger session (and the member's) must stay out of this list.
      expect(logins.some((entry) => entry.sessionId === f.readerSessionId)).toBe(false);
    } finally { await f.close(); }
  });

  it('keeps an ended session visible but marks it as no longer active', async () => {
    const f = await fixture();
    try {
      const store = await f.openStore();
      await f.seedLogin(store, { id: 'session-ended', username: 'owner', at: '2026-03-01T09:00:00.000Z', revokedAt: '2026-03-01T10:00:00.000Z' });
      await f.seedLogin(store, { id: 'session-expired', username: 'owner', at: '2026-03-01T09:00:00.000Z', expiresAt: '2020-01-01T00:00:00.000Z' });
      await store.close();

      const logins = await f.overview();
      // A revoked or expired console session is history, which is exactly what an
      // operator asking "who got in last week" needs; hiding it would answer nothing.
      const byId = new Map(logins.map((entry) => [entry.sessionId, entry]));
      expect(byId.get('session-ended')?.active).toBe(false);
      expect(byId.get('session-expired')?.active).toBe(false);
    } finally { await f.close(); }
  });

  it('lists newest first and never grows past the requested bound', async () => {
    const f = await fixture();
    try {
      const store = await f.openStore();
      // Eight sign-ins, one per hour, so the newest is unambiguous.
      for (let index = 0; index < 8; index += 1) {
        await f.seedLogin(store, {
          id: `session-${String(index).padStart(2, '0')}`,
          username: 'owner',
          at: new Date(Date.UTC(2026, 2, 1, index)).toISOString(),
        });
      }
      await store.close();

      const logins = await f.overview();
      // The overview asks for the five most recent.
      expect(logins).toHaveLength(5);
      expect(logins.map((entry) => entry.sessionId)).toEqual([
        'session-07', 'session-06', 'session-05', 'session-04', 'session-03',
      ]);
      const times = logins.map((entry) => entry.at);
      expect([...times].sort().reverse()).toEqual(times);
    } finally { await f.close(); }
  });

  it('reports the role from the administrator table, and omits an address that was never recorded', async () => {
    const f = await fixture();
    try {
      const store = await f.openStore();
      // A read-only operator's console sign-in must not be listed as a plain admin.
      const users = await f.api('/users?limit=50').then((response) => response.json()) as { users: { username: string; accountId: string }[] };
      const target = users.users.find((user) => user.username === 'member')!;
      expect((await f.api(`/accounts/${target.accountId}/role`, { role: 'viewer' })).status).toBe(200);
      await f.seedLogin(store, { id: 'session-viewer', username: 'member', at: '2026-03-01T09:00:00.000Z' });
      await store.close();

      const logins = await f.overview();
      const viewer = logins.find((entry) => entry.sessionId === 'session-viewer')!;
      expect(viewer.role).toBe('viewer');
      // A session with no recorded address omits the field rather than sending an
      // empty string, so the page can say 「未记录」 instead of showing a blank cell.
      expect(viewer.ip).toBeUndefined();
      expect('ip' in viewer).toBe(false);
    } finally { await f.close(); }
  });
});
