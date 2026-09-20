import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

const accountPassword = ['growth', 'test', 'password', '0001'].join('-');

/**
 * Registration growth and invitation attribution.
 *
 * The console counted requests only, so "are we growing, and which batch of invitations did
 * it" had no answer. These pin the two facts the page reports, and the two ways of getting
 * them wrong: counting an account twice, and letting the range change a whole-history total.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-growth-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', accountPassword, { ownerSetupToken: OWNER_SETUP_TOKEN });
  const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', server.serverId);
  return { dir, url, store, server, close: async () => { await store.close(); server.server.closeAllConnections(); await server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('registration growth', () => {
  it('counts accounts once per bucket and separates invited from uninvited', async () => {
    const f = await fixture();
    try {
      await f.store.setRegistrationMode('invite');
      await f.store.createInvite('invite-alpha');
      await f.store.createInvite('invite-beta');
      await registerAccount(f.url, 'invited-one', accountPassword, { inviteCode: 'invite-alpha' });
      await registerAccount(f.url, 'invited-two', accountPassword, { inviteCode: 'invite-beta' });
      await f.store.setRegistrationMode('open');
      await registerAccount(f.url, 'walk-in', accountPassword);

      const growth = await f.store.registrationGrowth();
      expect(growth.granularity).toBe('day');
      expect(growth.totals.accounts).toBe(4);
      expect(growth.totals.invited).toBe(2);
      expect(growth.totals.uninvited).toBe(2);
      // Every bucket adds up to the total: no account is counted twice or dropped.
      expect(growth.buckets.reduce((sum, bucket) => sum + bucket.accounts, 0)).toBe(growth.totals.accounts);
      expect(growth.buckets.reduce((sum, bucket) => sum + bucket.invited, 0)).toBe(growth.totals.invited);
    } finally { await f.close(); }
  });

  it('buckets by month when asked, and by day otherwise', async () => {
    const f = await fixture();
    try {
      await registerAccount(f.url, 'member-day', accountPassword);
      const daily = await f.store.registrationGrowth();
      expect(daily.buckets.every((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket.at))).toBe(true);

      const monthly = await f.store.registrationGrowth({ granularity: 'month' });
      expect(monthly.granularity).toBe('month');
      expect(monthly.buckets.every((bucket) => /^\d{4}-\d{2}$/.test(bucket.at))).toBe(true);
      // The same accounts, grouped differently: the month view must not lose any of them.
      expect(monthly.totals.accounts).toBe(daily.totals.accounts);
      expect(monthly.totals.invited).toBe(daily.totals.invited);
    } finally { await f.close(); }
  });

  it('narrows the buckets to the requested range but never invents accounts', async () => {
    const f = await fixture();
    try {
      await registerAccount(f.url, 'member-recent', accountPassword);
      const all = await f.store.registrationGrowth();
      expect(all.totals.accounts).toBeGreaterThan(0);

      // A window that ends before every account existed has no buckets at all — and says so
      // with zeros rather than by quietly widening itself.
      const past = await f.store.registrationGrowth({ from: '2000-01-01T00:00:00.000Z', until: '2001-01-01T00:00:00.000Z' });
      expect(past.buckets).toEqual([]);
      expect(past.totals).toEqual({ accounts: 0, invited: 0, uninvited: 0 });
    } finally { await f.close(); }
  });

  it('attributes invitations by the day they were issued, with state totals over the whole history', async () => {
    const f = await fixture();
    try {
      await f.store.createInvite('batch-one');
      await f.store.createInvite('batch-two');
      await f.store.createInvite('batch-three');
      await f.store.setRegistrationMode('invite');
      await registerAccount(f.url, 'brought-in', accountPassword, { inviteCode: 'batch-one' });
      await f.store.setInviteDisabled('batch-two', true);

      const attribution = await f.store.inviteAttribution();
      expect(attribution.totals.issued).toBe(3);
      expect(attribution.totals.used).toBe(1);
      expect(attribution.totals.revoked).toBe(1);
      expect(attribution.totals.available).toBe(1);
      expect(attribution.totals.expired).toBe(0);
      // The state buckets partition the whole set: nothing is counted twice or lost.
      const summed = attribution.totals.used + attribution.totals.revoked + attribution.totals.available + attribution.totals.expired;
      expect(summed).toBe(attribution.totals.issued);
      expect(attribution.batches.reduce((sum, batch) => sum + batch.issued, 0)).toBe(3);
      expect(attribution.batches.reduce((sum, batch) => sum + batch.used, 0)).toBe(1);
    } finally { await f.close(); }
  });

  it('counts an expired invitation as expired, not available', async () => {
    const f = await fixture();
    try {
      await f.store.createInvite('goes-stale');
      await f.store.setRegistrationMode('invite');
      await f.store.seed('UPDATE registration_invites SET created_at = ? WHERE code = ?', ['2020-01-01T00:00:00.000Z', 'goes-stale']);
      await f.store.seed('INSERT INTO registration_invite_policy (code, expires_at) VALUES (?, ?)', ['goes-stale', '2020-01-02T00:00:00.000Z']);

      const attribution = await f.store.inviteAttribution();
      expect(attribution.totals.expired).toBe(1);
      expect(attribution.totals.available).toBe(0);
      // The batch view keeps the issue date, so an old batch stays an old batch.
      expect(attribution.batches[0]?.at).toBe('2020-01-01');
    } finally { await f.close(); }
  });
});

describe('registration growth endpoint', () => {
  it('serves the growth payload to an administrator and rejects a bad range', async () => {
    const f = await fixture();
    try {
      await f.store.setRegistrationMode('invite');
      await f.store.createInvite('endpoint-invite');
      await registerAccount(f.url, 'endpoint-member', accountPassword, { inviteCode: 'endpoint-invite' });
      const owner = await loginAccount(f.url, 'owner', accountPassword);
      const headers = { Authorization: 'Bearer ' + owner.accessToken };

      const ok = await fetch(`${f.url}/api/admin/registration/growth?range=90d`, { headers });
      expect(ok.status).toBe(200);
      const body = await ok.json() as { range: string; granularity: string; growth: { totals: { accounts: number; invited: number } }; attribution: { totals: { issued: number; used: number } } };
      expect(body.range).toBe('90d');
      expect(body.granularity).toBe('day');
      expect(body.growth.totals.accounts).toBeGreaterThanOrEqual(2);
      expect(body.growth.totals.invited).toBeGreaterThanOrEqual(1);
      expect(body.attribution.totals.issued).toBe(1);
      expect(body.attribution.totals.used).toBe(1);

      // A year or 'all' defaults to monthly buckets; an unknown range is refused outright.
      const yearly = await fetch(`${f.url}/api/admin/registration/growth?range=365d`, { headers });
      expect((await yearly.json() as { granularity: string }).granularity).toBe('month');
      const bad = await fetch(`${f.url}/api/admin/registration/growth?range=forever`, { headers });
      expect(bad.status).toBe(400);
      const badGranularity = await fetch(`${f.url}/api/admin/registration/growth?granularity=week`, { headers });
      expect(badGranularity.status).toBe(400);
    } finally { await f.close(); }
  });
});
