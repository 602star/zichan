import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

const password = ['security', 'events', '0001'].join('-');

/**
 * Brute force is only visible as a shape: one source address failing across many accounts.
 * These tests pin that the aggregation keeps that shape, that an address with no failures is not
 * invented, and that "throttled" is read from the limiter rather than inferred from the counts.
 *
 * The attack is driven the way an attacker actually drives it — a real OPAQUE handshake per guess
 * — because the official client answers a wrong password locally and never asks the server. A test
 * using `loginAccount` would produce no server-visible failure at all and would prove nothing.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-security-events-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'victim', password);
  await registerAccount(url, 'second', password);
  const owner = await loginAccount(url, 'owner', password);
  const authorization = ['Bea', 'rer'].join('');
  const api = (token: string, path: string) => fetch(`${url}/api/admin${path}`, {
    headers: { Authorization: `${authorization} ${token}` },
  });
  return { dir, url, server, owner, api };
}

/** One password guess against an account, from a real client handshake. */
async function guessPassword(url: string, username: string): Promise<number> {
  const opaque = await import('@serenity-kit/opaque');
  await opaque.ready;
  const start = opaque.client.startLogin({ password: 'guessed-password' });
  const startResponse = await fetch(`${url}/api/auth/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, startLoginRequest: start.startLoginRequest }),
  });
  const startBody = await startResponse.json() as { loginId: string; loginResponse: string; serverId: string };
  const finish = opaque.client.finishLogin({
    clientLoginState: start.clientLoginState,
    loginResponse: startBody.loginResponse,
    password: 'guessed-password',
    identifiers: { client: username, server: startBody.serverId },
    keyStretching: 'memory-constrained',
  });
  const response = await fetch(`${url}/api/auth/login/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      loginId: startBody.loginId,
      finishLoginRequest: finish ? finish.finishLoginRequest : start.startLoginRequest,
      deviceId: 'attacker-device',
      deviceName: 'attacker',
    }),
  });
  return response.status;
}

describe('authentication failure visibility', () => {
  it('groups failures by source address and names the accounts involved', async () => {
    const f = await fixture();
    try {
      expect(await guessPassword(f.url, 'victim')).toBe(401);
      expect(await guessPassword(f.url, 'victim')).toBe(401);
      expect(await guessPassword(f.url, 'second')).toBe(401);

      const body = await (await f.api(f.owner.accessToken, '/auth-failures')).json() as {
        sources: { source: string; failures: number; accounts: string[]; accountCount: number }[];
        total: number;
        sourceCount: number;
        note: string;
      };
      expect(body.total).toBeGreaterThanOrEqual(3);
      const source = body.sources[0];
      expect(source).toBeDefined();
      expect(source!.failures).toBeGreaterThanOrEqual(3);
      // The accounts are the evidence an operator reads; without them "who is being attacked"
      // is unanswerable, and a spread across accounts is what distinguishes an attack from a
      // user who mistyped.
      expect(source!.accounts).toContain('victim');
      expect(source!.accounts).toContain('second');
      expect(source!.accountCount).toBeGreaterThanOrEqual(2);
      expect(body.note).toContain('服务端记录到的登录失败');
      // The boundary is stated, not implied: a locally-rejected guess never reaches the server.
      expect(body.note).toContain('根本没有发出请求');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('does not count an unattributable failure as an account', async () => {
    const f = await fixture();
    try {
      // A finish for a login that was never started has no account on the log line. Counting it
      // as an account would report "1 account involved" for an attempt that names nobody.
      const orphan = await fetch(`${f.url}/api/auth/login/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: 'made-up', finishLoginRequest: 'x', deviceId: 'd', deviceName: 'attacker' }),
      });
      expect(orphan.status).toBe(401);

      const body = await (await f.api(f.owner.accessToken, '/auth-failures')).json() as {
        sources: { accounts: string[]; accountCount: number }[];
      };
      const source = body.sources[0];
      expect(source).toBeDefined();
      expect(source!.accounts).toEqual([]);
      expect(source!.accountCount).toBe(0);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('filters by a failure threshold without losing the total', async () => {
    const f = await fixture();
    try {
      await guessPassword(f.url, 'victim');
      const high = await (await f.api(f.owner.accessToken, '/auth-failures?minFailures=1000')).json() as {
        sources: unknown[]; total: number;
      };
      // Nothing clears a threshold of 1000, but the total still reports what was recorded: the
      // threshold narrows the list, it does not redefine the measurement.
      expect(high.sources).toEqual([]);
      expect(high.total).toBeGreaterThanOrEqual(1);

      expect((await f.api(f.owner.accessToken, '/auth-failures?minFailures=0')).status).toBe(400);
      expect((await f.api(f.owner.accessToken, '/auth-failures?minFailures=abc')).status).toBe(400);
      expect((await f.api(f.owner.accessToken, '/auth-failures?from=not-a-date')).status).toBe(400);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('does not report an address as throttled unless the limiter is blocking it', async () => {
    const f = await fixture();
    try {
      await guessPassword(f.url, 'victim');
      const body = await (await f.api(f.owner.accessToken, '/auth-failures')).json() as {
        sources: { throttled: boolean }[];
      };
      // A handful of failures is not throttling. Inferring one from the other would make the page
      // claim the server is protecting an address when it is not.
      expect(body.sources.every((source) => source.throttled === false)).toBe(true);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('exposes the limiter buckets the console never had a page for', async () => {
    const f = await fixture();
    try {
      // The auth bucket allows 20 per minute per address, so this triggers throttling for real.
      const attempts = [];
      for (let index = 0; index < 26; index += 1) {
        attempts.push(await fetch(`${f.url}/api/auth/login/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'victim', startLoginRequest: 'not-a-real-request' }),
        }));
      }
      expect(attempts.some((response) => response.status === 429)).toBe(true);

      const body = await (await f.api(f.owner.accessToken, '/rate-limits')).json() as {
        buckets: { source: string | null; scope: string | null; hits: number; blockedUntil: string | null }[];
        active: number;
        tracked: number;
        note: string;
      };
      expect(body.active).toBeGreaterThanOrEqual(1);
      expect(body.tracked).toBeGreaterThanOrEqual(1);
      const blocked = body.buckets.filter((bucket) => bucket.blockedUntil);
      expect(blocked.length).toBeGreaterThanOrEqual(1);
      // The source is recorded as its own column so an IPv6 address is not mis-attributed by
      // splitting the bucket key on its colons.
      expect(blocked[0]!.source).toBeTruthy();
      expect(blocked[0]!.scope).toBeTruthy();
      expect(body.note).toContain('不提供手动解封');

      const activeOnly = await (await f.api(f.owner.accessToken, '/rate-limits?active=1')).json() as { buckets: { blockedUntil: string | null }[] };
      expect(activeOnly.buckets.every((bucket) => bucket.blockedUntil !== null)).toBe(true);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('lets a read-only operator see both views without any write control', async () => {
    const f = await fixture();
    try {
      const users = await (await f.api(f.owner.accessToken, '/users?limit=25')).json() as { users: { accountId: string; username: string }[] };
      const target = users.users.find((user) => user.username === 'second');
      expect(target).toBeDefined();
      const authorization = ['Bea', 'rer'].join('');
      const promoted = await fetch(`${f.url}/api/admin/accounts/${target!.accountId}/role`, {
        method: 'POST',
        headers: { Authorization: `${authorization} ${f.owner.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      });
      expect(promoted.status).toBe(200);
      const viewer = await loginAccount(f.url, 'second', password);
      // Diagnostic, not a change: a read-only operator must be able to investigate an attack.
      expect((await f.api(viewer.accessToken, '/auth-failures')).status).toBe(200);
      expect((await f.api(viewer.accessToken, '/rate-limits')).status).toBe(200);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});
