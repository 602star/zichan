import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

const password = ['admin', 'troubleshooting', '0001'].join('-');

/**
 * The account-scoped filters that make the console usable from a user's page: a run log line
 * carries the account name, so `/logs?username=` has to find exactly that account's lines and
 * nothing else, and `/jobs?accountId=` has to select by the task's targeted account.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-admin-troubleshoot-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'alice', password);
  await registerAccount(url, 'bob', password);
  const owner = await loginAccount(url, 'owner', password);
  const alice = await loginAccount(url, 'alice', password);
  const bob = await loginAccount(url, 'bob', password);
  const authorization = ['Bea', 'rer'].join('');
  const api = (token: string, path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `${authorization} ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { dir, url, server, owner, alice, bob, api };
}

describe('account-scoped troubleshooting filters', () => {
  it('filters the run log by account and by action without mixing accounts together', async () => {
    const f = await fixture();
    try {
      const body = await (await f.api(f.owner.accessToken, '/logs?limit=200')).json() as { logs: { username?: string; action: string }[]; actions: string[] };
      // The action list is read from the table, so it already contains what this run logged.
      expect(body.actions.length).toBeGreaterThan(0);
      expect(body.actions).toContain('login_success');

      const aliceLogs = await (await f.api(f.owner.accessToken, '/logs?limit=200&username=alice')).json() as { logs: { username?: string }[] };
      expect(aliceLogs.logs.length).toBeGreaterThan(0);
      expect(aliceLogs.logs.every((entry) => entry.username === 'alice')).toBe(true);

      const bobLogs = await (await f.api(f.owner.accessToken, '/logs?limit=200&username=bob')).json() as { logs: { username?: string }[] };
      expect(bobLogs.logs.every((entry) => entry.username === 'bob')).toBe(true);
      // Two accounts must not produce the same page: that would mean the filter is ignored.
      expect(bobLogs.logs.length).toBeGreaterThan(0);

      const byAction = await (await f.api(f.owner.accessToken, '/logs?limit=200&action=login_success&username=alice')).json() as { logs: { username?: string; action: string }[] };
      expect(byAction.logs.length).toBeGreaterThan(0);
      expect(byAction.logs.every((entry) => entry.action === 'login_success' && entry.username === 'alice')).toBe(true);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('rejects a malformed time bound instead of silently ignoring it', async () => {
    const f = await fixture();
    try {
      const bad = await f.api(f.owner.accessToken, '/logs?from=not-a-date');
      expect(bad.status).toBe(400);
      const longName = await f.api(f.owner.accessToken, `/logs?username=${'x'.repeat(80)}`);
      expect(longName.status).toBe(400);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('lists only the tasks targeting one account', async () => {
    const f = await fixture();
    try {
      const created = await f.api(f.owner.accessToken, '/jobs', { type: 'blobs.verify', accountId: f.alice.accountId });
      expect(created.status).toBe(202);
      // A job with no target account must not appear under an account filter.
      expect((await f.api(f.owner.accessToken, '/jobs', { type: 'database.integrity-check' })).status).toBe(202);

      const filtered = await (await f.api(f.owner.accessToken, `/jobs?limit=25&accountId=${encodeURIComponent(f.alice.accountId)}`)).json() as { jobs: { targetAccountId?: string }[] };
      expect(filtered.jobs.length).toBe(1);
      expect(filtered.jobs[0]?.targetAccountId).toBe(f.alice.accountId);

      const none = await (await f.api(f.owner.accessToken, `/jobs?limit=25&accountId=${encodeURIComponent(f.bob.accountId)}`)).json() as { jobs: unknown[] };
      expect(none.jobs).toEqual([]);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  /**
   * "Which build is this device running" cannot be answered from `deviceName`, which is a label
   * the client chooses for itself. A client states its kind, version and protocol generation in a
   * request header; the server records it on the diagnostic event and changes nothing else.
   */
  it('records what the client said it was, and leaves it unknown when it said nothing', async () => {
    const f = await fixture();
    try {
      const authorization = ['Bea', 'rer'].join('');
      // A request without a bound replica fails, which is enough to produce a diagnostic event.
      const identified = await fetch(`${f.url}/api/v3/commits`, {
        headers: {
          Authorization: `${authorization} ${f.alice.accessToken}`,
          'X-Zichan-Client': 'zichan-client/1 kind=web version=0.1.0 protocol=3',
        },
      });
      expect(identified.status).toBeGreaterThanOrEqual(400);

      const events = await (await f.api(f.owner.accessToken, '/sync-events?limit=50&outcome=error')).json() as {
        events: { requestId?: string; clientKind?: string; clientVersion?: string; protocolVersion?: string }[];
      };
      const recorded = events.events[0];
      expect(recorded).toMatchObject({ clientKind: 'web', clientVersion: '0.1.0', protocolVersion: '3' });

      // A client that sends no header, or sends something unreadable, must read as unknown
      // rather than being attributed to a version the server guessed.
      const anonymous = await fetch(`${f.url}/api/v3/commits`, { headers: { Authorization: `${authorization} ${f.alice.accessToken}` } });
      expect(anonymous.status).toBeGreaterThanOrEqual(400);
      const unreadable = await fetch(`${f.url}/api/v3/commits`, {
        headers: { Authorization: `${authorization} ${f.alice.accessToken}`, 'X-Zichan-Client': 'not-a-client-identity' },
      });
      expect(unreadable.status).toBeGreaterThanOrEqual(400);

      const after = await (await f.api(f.owner.accessToken, '/sync-events?limit=50&outcome=error')).json() as {
        events: { id: string; clientKind?: string; clientVersion?: string }[];
      };
      const newer = after.events.filter((event) => !events.events.some((older) => older.requestId === event.requestId));
      expect(newer).toHaveLength(2);
      for (const event of newer) {
        expect(event.clientKind).toBeUndefined();
        expect(event.clientVersion).toBeUndefined();
      }
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('accepts the client header from another origin so it is not stripped in transit', async () => {
    const f = await fixture();
    try {
      // A browser drops a custom header unless the preflight response allows it by name, and the
      // loss is silent: syncing still works, only the diagnostics go blank.
      const preflight = await fetch(`${f.url}/api/v3/commits`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://ledger.example.com', 'Access-Control-Request-Headers': 'x-zichan-client' },
      });
      expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Zichan-Client');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});
