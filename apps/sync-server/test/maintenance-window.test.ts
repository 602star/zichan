import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

const password = ['maintenance', 'window', '0001'].join('-');

/**
 * The maintenance window, end to end.
 *
 * The point of the window is that a snapshot is not racing new commits, so the tests that matter
 * are: a client write is actually refused while it is open, reads and admin traffic keep working,
 * and the mode can always be turned back off.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-maintenance-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'member', password);
  const owner = await loginAccount(url, 'owner', password);
  const member = await loginAccount(url, 'member', password);
  const authorization = ['Bea', 'rer'].join('');
  const api = (token: string, path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `${authorization} ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // A member's own data-plane call, to observe the gate the way a client would.
  const client = (path: string, method = 'GET') => fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `${authorization} ${member.accessToken}`, 'Content-Type': 'application/json' },
  });
  return { dir, url, server, owner, member, api, client };
}

describe('maintenance window', () => {
  it('refuses client writes, keeps reads and admin open, and can be cleared', async () => {
    const f = await fixture();
    try {
      // Baseline: the member's data-plane read works and is not a write.
      expect((await f.client('/api/v3/commits?after=0')).status).not.toBe(503);

      const declared = await f.api(f.owner.accessToken, '/maintenance', { enabled: true, message: '升级数据库' });
      expect(declared.status).toBe(200);
      expect(await declared.json()).toMatchObject({ maintenance: { active: true, message: '升级数据库', expired: false } });

      // A write is refused with a reason the client can show, and a Retry-After.
      const refused = await f.client('/api/v3/commits', 'POST');
      expect(refused.status).toBe(503);
      const refusedBody = await refused.json() as { code: string; error: string };
      expect(refusedBody.code).toBe('MAINTENANCE');
      expect(refusedBody.error).toBe('升级数据库');

      // Reads stay open: a client that cannot even pull has no way to learn why it is failing.
      expect((await f.client('/api/v3/commits?after=0')).status).not.toBe(503);
      // Admin stays open, or the mode could never be cleared.
      expect((await f.api(f.owner.accessToken, '/overview')).status).toBe(200);

      const cleared = await f.api(f.owner.accessToken, '/maintenance', { enabled: false });
      expect(await cleared.json()).toMatchObject({ maintenance: { active: false } });
      // The gate is really off, not just reported as off.
      expect((await f.client('/api/v3/commits', 'POST')).status).not.toBe(503);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('audits the window as who took sync down and when', async () => {
    const f = await fixture();
    try {
      await f.api(f.owner.accessToken, '/maintenance', { enabled: true, message: '升级', reason: '数据库迁移' });
      const audit = await (await f.api(f.owner.accessToken, '/audit?action=maintenance-on')).json() as { entries: { action: string; actor: string; summary: string }[] };
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]?.summary).toContain('进入维护模式');
      expect(audit.entries[0]?.summary).toContain('数据库迁移');

      await f.api(f.owner.accessToken, '/maintenance', { enabled: false });
      const off = await (await f.api(f.owner.accessToken, '/audit?action=maintenance-off')).json() as { entries: { summary: string }[] };
      expect(off.entries[0]?.summary).toContain('写入恢复');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('reports an expired window as no longer applying, without anyone clearing it', async () => {
    const f = await fixture();
    try {
      const soon = new Date(Date.now() + 1_000).toISOString();
      await f.api(f.owner.accessToken, '/maintenance', { enabled: true, until: soon });
      // Wait past the declared end rather than mocking the clock: this is the real read path.
      await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      const view = await (await f.api(f.owner.accessToken, '/maintenance')).json() as { maintenance: { active: boolean; expired: boolean; enabled: boolean } };
      expect(view.maintenance).toMatchObject({ active: false, expired: true, enabled: true });
      // And writes really resumed.
      expect((await f.client('/api/v3/commits', 'POST')).status).not.toBe(503);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses a window that would silently not apply', async () => {
    const f = await fixture();
    try {
      // An end time in the past, and an unparseable one, both describe a window that does not
      // exist; accepting either would look identical to a working declaration.
      const past = await f.api(f.owner.accessToken, '/maintenance', { enabled: true, until: new Date(Date.now() - 60_000).toISOString() });
      expect(past.status).toBe(400);
      expect((await past.json() as { code: string }).code).toBe('INVALID_MAINTENANCE');
      const garbage = await f.api(f.owner.accessToken, '/maintenance', { enabled: true, until: 'tomorrow-ish' });
      expect(garbage.status).toBe(400);
      const notBoolean = await f.api(f.owner.accessToken, '/maintenance', { enabled: 'yes' });
      expect(notBoolean.status).toBe(400);
      // Nothing was stored, so writes are still open.
      const view = await (await f.api(f.owner.accessToken, '/maintenance')).json() as { maintenance: { active: boolean } };
      expect(view.maintenance.active).toBe(false);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('keeps the switch owner-only', async () => {
    const f = await fixture();
    try {
      const asMember = await f.api(f.member.accessToken, '/maintenance', { enabled: true });
      expect(asMember.status).toBe(403);
      const view = await (await f.api(f.owner.accessToken, '/maintenance')).json() as { maintenance: { active: boolean } };
      expect(view.maintenance.active).toBe(false);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('says whether stopping the process now would interrupt work', async () => {
    const f = await fixture();
    try {
      const body = await (await f.api(f.owner.accessToken, '/maintenance')).json() as { drain: { safeToStop: boolean; inFlightWrites: number; note: string } };
      expect(body.drain.safeToStop).toBe(true);
      expect(body.drain.inFlightWrites).toBe(0);
      expect(body.drain.note).toContain('不会中断');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});
