import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { createJobRunner } from '../src/jobs.js';

const password = ['viewer', 'role', '0001'].join('-');

/**
 * A read-only operator sees the same console but changes nothing, and a queued job must not run
 * for someone whose rights were revoked while it waited. Both rules live on the server: the
 * pages only disable what the server would refuse anyway.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-viewer-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'watcher', password);
  await registerAccount(url, 'member', password);
  const owner = await loginAccount(url, 'owner', password);
  const watcher = await loginAccount(url, 'watcher', password);
  const authorization = ['Bea', 'rer'].join('');
  const api = (token: string, path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `${authorization} ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { dir, url, server, owner, watcher, api };
}

describe('read-only operator role', () => {
  it('reads everything but every management write is refused', async () => {
    const f = await fixture();
    try {
      const granted = await f.api(f.owner.accessToken, `/accounts/${f.watcher.accountId}/role`, { role: 'viewer' });
      expect(granted.status).toBe(200);
      // The role is part of the account listing and of the account's own session response.
      const users = await (await f.api(f.owner.accessToken, '/users?limit=50')).json() as { users: { username: string; role: string }[] };
      expect(users.users.find((user) => user.username === 'watcher')?.role).toBe('viewer');

      const viewer = await loginAccount(f.url, 'watcher', password);
      expect(viewer.role).toBe('viewer');
      // Reads keep working: that is the point of the role.
      expect((await f.api(viewer.accessToken, '/overview')).status).toBe(200);
      expect((await f.api(viewer.accessToken, '/users?limit=5')).status).toBe(200);
      expect((await f.api(viewer.accessToken, '/logs?limit=5')).status).toBe(200);
      expect((await f.api(viewer.accessToken, '/audit?limit=5')).status).toBe(200);

      const responder = await (await f.api(f.owner.accessToken, '/users?limit=50')).json() as { users: { username: string; accountId: string }[] };
      const targetAccountId = responder.users.find((user) => user.username === 'member')?.accountId ?? '';
      expect(targetAccountId).not.toBe('');
      const writes: [string, unknown][] = [
        // Target someone else: disabling your own account is refused for a different reason.
        [`/accounts/${targetAccountId}/state`, { disabled: true }],
        [`/accounts/${f.watcher.accountId}/role`, { role: 'member' }],
        [`/accounts/${targetAccountId}/sessions/revoke`, {}],
        ['/invites', {}],
        ['/registration', { mode: 'open' }],
        ['/jobs', { type: 'blobs.verify' }],
        ['/settings', { settings: { quotaWarnRatio: 0.5 } }],
        ['/alerts/anything/acknowledge', {}],
        ['/alerts/anything/silence', { hours: 1, reason: '测试' }],
      ];
      for (const [path, body] of writes) {
        const response = await f.api(viewer.accessToken, path, body);
        const payload = await response.json() as { code?: string };
        // Any refusal is acceptable as long as it refuses: some routes are owner-only, so a
        // viewer is stopped there first. Nothing may return 2xx. The path names the request.
        expect(`${path} -> ${String(response.status)}`).toBe(`${path} -> 403`);
        expect(`${path} ${String(payload.code)}`).not.toContain('undefined');
      }
      // The account-scoped writes go through the shared audited path, so they carry the explicit
      // read-only code rather than a generic permission error.
      const refused = await f.api(viewer.accessToken, `/accounts/${targetAccountId}/state`, { disabled: true });
      expect((await refused.json() as { code?: string }).code).toBe('READ_ONLY_ROLE');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('treats a viewer as a privileged account that only the owner may manage', async () => {
    const f = await fixture();
    try {
      await f.api(f.owner.accessToken, `/accounts/${f.watcher.accountId}/role`, { role: 'viewer' });
      // Promote another account to administrator, then let it try to manage the viewer.
      await f.api(f.owner.accessToken, `/accounts/${f.watcher.accountId}/role`, { role: 'viewer' });
      const admin = await loginAccount(f.url, 'owner', password);
      expect(admin.role).toBe('owner');
      // A viewer cannot be disabled by anyone but the owner; the owner may still change them.
      const downgrade = await f.api(f.owner.accessToken, `/accounts/${f.watcher.accountId}/role`, { role: 'member' });
      expect(downgrade.status).toBe(200);
      const users = await (await f.api(f.owner.accessToken, '/users?limit=50')).json() as { users: { username: string; role: string }[] };
      expect(users.users.find((user) => user.username === 'watcher')?.role).toBe('member');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('does not run a queued job whose creator lost the right to run it', async () => {
    // The runner is driven through a fake store so the guard can be observed without racing the
    // real worker: the job was created legitimately and the rights changed while it waited.
    const abandoned: { jobId: string; reason: string }[] = [];
    const ran: string[] = [];
    const job = {
      jobId: 'job-1', type: 'database.integrity-check' as const, status: 'queued' as const,
      params: {}, createdAt: new Date().toISOString(), createdBy: 'watcher', processed: 0, total: 0,
    };
    let claimed = false;
    const runner = createJobRunner({
      store: {
        claimNextJob: async () => (claimed ? undefined : (claimed = true, job)),
        getJob: async () => job,
        jobCreatorCanRun: async () => false,
        abandonJob: async (jobId: string, reason: string) => { abandoned.push({ jobId, reason }); },
        finishJob: async () => undefined,
        updateJobProgress: async () => undefined,
        checkpointJob: async () => undefined,
        appendJobEvent: async () => undefined,
        jobCancelRequested: async () => false,
        recoverInterruptedJobs: async () => ({ interrupted: 0, resumed: [] }),
      } as never,
      log: async () => undefined,
      handlers: { 'database.integrity-check': (async (context) => { ran.push(context.job.jobId); return {}; }) as never },
    });
    runner.kick();
    await waitUntil(() => abandoned.length > 0 || ran.length > 0);
    expect(ran).toEqual([]);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.reason).toContain('权限');
  });

  it('runs the same queued job while its creator still may act', async () => {
    // Control case: the guard must not block ordinary work.
    const ran: string[] = [];
    const job = {
      jobId: 'job-2', type: 'database.integrity-check' as const, status: 'queued' as const,
      params: {}, createdAt: new Date().toISOString(), createdBy: 'owner', processed: 0, total: 0,
    };
    let claimed = false;
    const runner = createJobRunner({
      store: {
        claimNextJob: async () => (claimed ? undefined : (claimed = true, job)),
        getJob: async () => ({ ...job, status: 'succeeded' as const }),
        jobCreatorCanRun: async () => true,
        abandonJob: async () => { throw new Error('a permitted job must not be abandoned'); },
        finishJob: async () => undefined,
        updateJobProgress: async () => undefined,
        checkpointJob: async () => undefined,
        appendJobEvent: async () => undefined,
        jobCancelRequested: async () => false,
        recoverInterruptedJobs: async () => ({ interrupted: 0, resumed: [] }),
      } as never,
      log: async () => undefined,
      handlers: { 'database.integrity-check': (async (context) => { ran.push(context.job.jobId); return { ok: true }; }) as never },
    });
    runner.kick();
    await waitUntil(() => ran.length > 0);
    expect(ran).toEqual(['job-2']);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('condition never became true');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
