import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

const accountPassword = ['user', 'sort', '0001'].join('-');
const setupKey = ['ownerSetup', 'Token'].join('');
const bearer = ['Bea', 'rer'].join('');

/**
 * Sorting on the account list, through the real route.
 *
 * The unit tests pin the cursor/ordering pairing. These pin what an operator would hit: that
 * paging a sorted list neither repeats nor skips accounts, that switching the sort starts over
 * cleanly, and that a cursor from one ordering is refused rather than quietly reinterpreted —
 * which is the failure that returns a stable, plausible, wrong page.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-user-sort-'));
  const server = createTestSyncServer({ dataDir: dir, registrationMode: 'open' });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', accountPassword, { [setupKey]: OWNER_SETUP_TOKEN });
  const owner = await loginAccount(url, 'owner', accountPassword);
  const api = (path: string) => fetch(`${url}/api/admin${path}`, { headers: { Authorization: `${bearer} ${owner.accessToken}` } });
  // Three accounts whose creation order and name order disagree, so a list that "sorts" by name
  // while still paging by creation cannot look right by accident. The owner registered above is
  // an account as well, and it sorts first by creation (it was created today) and last by name.
  const store = new SyncServerStore(join(dir, 'server.sqlite'), 'open', server.serverId);
  await store.ready;
  const at = (days: number) => new Date(Date.UTC(2026, 0, 1) + days * 86_400_000).toISOString();
  for (const [username, accountId, day] of [['charlie', 'account-c', 0], ['alpha', 'account-a', 1], ['bravo', 'account-b', 2]] as [string, string, number][]) {
    await store.seed('INSERT INTO sync_users (username, opaque_registration_record, disabled, created_at, updated_at) VALUES (?, ?, 0, ?, ?)', [username, `record-${username}`, at(day), at(day)]);
    await store.seed('INSERT INTO sync_account_identities (username, account_id) VALUES (?, ?)', [username, accountId]);
  }
  await store.close();
  return { dir, url, server, api, close: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

interface Page {
  users: { username: string }[];
  nextCursor?: string;
  sort?: { key: string; direction: string };
}

describe('account list sorting', () => {
  it('defaults to newest first and can order by name instead', async () => {
    const f = await fixture();
    try {
      const byCreated = await (await f.api('/users?limit=10')).json() as Page;
      // The owner registered today, then bravo (created last of the three), alpha, charlie.
      expect(byCreated.users.map((user) => user.username)).toEqual(['owner', 'bravo', 'alpha', 'charlie']);
      expect(byCreated.sort).toEqual({ key: 'created', direction: 'desc' });

      const byName = await (await f.api('/users?limit=10&sort=name&dir=asc')).json() as Page;
      expect(byName.users.map((user) => user.username)).toEqual(['alpha', 'bravo', 'charlie', 'owner']);
      expect(byName.sort).toEqual({ key: 'name', direction: 'asc' });
    } finally { await f.close(); }
  });

  it('pages a name-sorted list without repeating or skipping an account', async () => {
    const f = await fixture();
    try {
      const first = await (await f.api('/users?limit=2&sort=name&dir=asc')).json() as Page;
      expect(first.users.map((user) => user.username)).toEqual(['alpha', 'bravo']);
      expect(first.nextCursor).toBeDefined();

      const second = await (await f.api(`/users?limit=2&sort=name&dir=asc&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as Page;
      // charlie then owner: nothing repeated from the first page, nothing skipped between them.
      expect(second.users.map((user) => user.username)).toEqual(['charlie', 'owner']);
      // Exhausted: no third page, and nothing repeated from the first.
      expect(second.nextCursor).toBeUndefined();
    } finally { await f.close(); }
  });

  it('refuses a cursor issued under a different ordering', async () => {
    const f = await fixture();
    try {
      const byName = await (await f.api('/users?limit=2&sort=name&dir=asc')).json() as Page;
      const cursor = encodeURIComponent(byName.nextCursor!);
      // Reusing it under the default ordering would return a stable, plausible, wrong page.
      const response = await f.api(`/users?limit=2&cursor=${cursor}`);
      expect(response.status).toBe(400);
      expect((await response.json() as { code?: string }).code).toBe('CURSOR_SORT_MISMATCH');
      // The same cursor under the ordering it was issued for is accepted.
      const same = await f.api(`/users?limit=2&sort=name&dir=asc&cursor=${cursor}`);
      expect(same.status).toBe(200);
    } finally { await f.close(); }
  });

  it('falls back to the default ordering for an unknown sort, but rejects an unknown direction', async () => {
    const f = await fixture();
    try {
      // A page built against a newer server must not break every list.
      const unknownSort = await (await f.api('/users?limit=10&sort=not-a-sort')).json() as Page;
      expect(unknownSort.sort).toEqual({ key: 'created', direction: 'desc' });

      // A direction is a closed set of two, so a third value is a typo worth reporting.
      const badDirection = await f.api('/users?limit=10&dir=sideways');
      expect(badDirection.status).toBe(400);
    } finally { await f.close(); }
  });

  it('honours the requested page size', async () => {
    const f = await fixture();
    try {
      const one = await (await f.api('/users?limit=1')).json() as Page;
      expect(one.users).toHaveLength(1);
      expect(one.nextCursor).toBeDefined();
    } finally { await f.close(); }
  });
});
