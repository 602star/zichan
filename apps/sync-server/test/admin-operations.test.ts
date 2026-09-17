import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { describeAudit } from '../src/admin.js';
import { SyncServerStore } from '../src/store.js';

const password = 'correct horse battery staple';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-admin-ops-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { ownerSetupToken: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'manager', password);
  await registerAccount(url, 'member', password);
  const owner = await loginAccount(url, 'owner', password);
  const manager = await loginAccount(url, 'manager', password);
  const member = await loginAccount(url, 'member', password);
  const api = (token: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { dir, url, server, owner, manager, member, api };
}

const waitForJob = async (f: Awaited<ReturnType<typeof fixture>>, jobId: string) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const body = await (await f.api(f.owner.accessToken, `/jobs/${jobId}`)).json() as { job: { status: string; result?: Record<string, unknown> } };
    if (!['queued', 'running'].includes(body.job.status)) return body;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} never finished`);
};

describe('management console operations', () => {
  it('keeps the handshake constant and moves whole-database checks into a job', async () => {
    const f = await fixture();
    try {
      const health = await (await fetch(`${f.url}/api/health`)).json() as Record<string, unknown>;
      expect(health['capabilities']).toEqual(expect.arrayContaining(['admin-console-v2', 'admin-jobs-v1', 'sync-diagnostics-v1']));
      // Aggregates no longer ride along with every handshake.
      for (const key of ['userCount', 'commitCount', 'commitBytes', 'activeSessionCount']) expect(health).not.toHaveProperty(key);

      const ready = await (await fetch(`${f.url}/api/ready`)).json() as { mode: string; database: Record<string, unknown> };
      expect(ready.mode).toBe('light');
      expect(ready.database).toMatchObject({ ok: true, result: 'ok', migrations: 1 });

      expect(await (await f.api(f.owner.accessToken, '/database/verify')).json()).toMatchObject({ mode: 'recorded', verification: { result: 'not-run' } });
      const created = await f.api(f.owner.accessToken, '/database/verify', {});
      expect(created.status).toBe(202);
      const jobId = ((await created.json()) as { job: { jobId: string } }).job.jobId;
      const finished = await waitForJob(f, jobId);
      expect(finished.job).toMatchObject({ status: 'succeeded', result: { ok: true, result: 'ok' } });
      expect(await (await f.api(f.owner.accessToken, '/database/verify')).json()).toMatchObject({ verification: { ok: true } });
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('returns a request id on failures and makes it searchable in the run log', async () => {
    const f = await fixture();
    try {
      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', password);
      const denied = await f.api(manager.accessToken, `/accounts/${f.owner.accountId}/state`, { disabled: true });
      expect(denied.status).toBe(403);
      const deniedBody = await denied.json() as { code: string; requestId: string };
      expect(deniedBody.code).toBe('PROTECTED_ACCOUNT');
      expect(deniedBody.requestId).toMatch(/^req-[a-f0-9]{16}$/);
      expect(denied.headers.get('x-request-id')).toBe(deniedBody.requestId);

      const logs = await (await f.api(f.owner.accessToken, `/logs?requestId=${deniedBody.requestId}`)).json() as { logs: { action: string }[] };
      expect(logs.logs.length).toBeGreaterThanOrEqual(1);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('rejects a stale write instead of overwriting another administrator', async () => {
    const f = await fixture();
    try {
      const listed = await (await f.api(f.owner.accessToken, '/users')).json() as { users: { accountId: string; revision: number }[] };
      const target = listed.users.find((user) => user.accountId === f.member.accountId)!;
      expect(target.revision).toBe(1);
      const first = await f.api(f.owner.accessToken, `/accounts/${target.accountId}/commits`, { commitQuotaBytes: 64 * 1024 ** 2, expectedVersion: target.revision, reason: '容量申请' });
      expect(first.status).toBe(200);
      const second = await f.api(f.owner.accessToken, `/accounts/${target.accountId}/commits`, { commitQuotaBytes: 128 * 1024 ** 2, expectedVersion: target.revision });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ code: 'STALE_WRITE' });

      const after = await (await f.api(f.owner.accessToken, '/users')).json() as { users: { accountId: string; revision: number }[] };
      expect(after.users.find((user) => user.accountId === target.accountId)?.revision).toBe(2);

      const audit = await (await f.api(f.owner.accessToken, '/audit?action=commit-quota')).json() as { entries: { summary: string; reason: string }[] };
      expect(audit.entries[0]!.reason).toBe('容量申请');
      expect(audit.entries[0]!.summary).toContain('提交配额');
      expect(audit.entries[0]!.summary).toContain('原因：容量申请');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('replays an idempotent request and refuses the same key with different parameters', async () => {
    const f = await fixture();
    try {
      const key = 'job-key-0001';
      const first = await f.api(f.owner.accessToken, '/jobs', { type: 'logs.prune' }, { 'Idempotency-Key': key });
      expect(first.status).toBe(202);
      const firstJob = ((await first.json()) as { job: { jobId: string } }).job.jobId;
      const replay = await f.api(f.owner.accessToken, '/jobs', { type: 'logs.prune' }, { 'Idempotency-Key': key });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ job: { jobId: firstJob }, replayed: true });
      const conflict = await f.api(f.owner.accessToken, '/jobs', { type: 'metrics.prune' }, { 'Idempotency-Key': key });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      const invalid = await f.api(f.owner.accessToken, '/jobs', { type: 'logs.prune' }, { 'Idempotency-Key': 'bad key' });
      expect(invalid.status).toBe(400);

      const jobs = await (await f.api(f.owner.accessToken, '/jobs?type=logs.prune')).json() as { jobs: { jobId: string }[] };
      expect(jobs.jobs.filter((job) => job.jobId === firstJob)).toHaveLength(1);
      expect(jobs.jobs).toHaveLength(1);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('rejects unknown job types and job parameters that are not part of the closed set', async () => {
    const f = await fixture();
    try {
      expect((await f.api(f.owner.accessToken, '/jobs', { type: 'shell.exec' })).status).toBe(400);
      expect((await f.api(f.owner.accessToken, '/jobs', { type: 'restore.drill', recordId: 'C:/backups/thing' })).status).toBe(400);
      expect((await f.api(f.owner.accessToken, '/jobs', { type: 'blobs.verify', accountId: 'not-an-account' })).status).toBe(400);
      // Drill and backup verification stay owner-only.
      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', password);
      expect((await f.api(manager.accessToken, '/jobs', { type: 'restore.drill', recordId: 'record-0001' })).status).toBe(403);
      expect((await f.api(manager.accessToken, '/jobs', { type: 'logs.prune' })).status).toBe(202);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('paginates sessions as sessions and hides privileged sessions from administrators', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 3; index += 1) await loginAccount(f.url, 'member', password);
      const first = await (await f.api(f.owner.accessToken, '/sessions?limit=2')).json() as { sessions: { id: string; kind: string }[]; nextCursor?: string; paginationUnit: string };
      expect(first.paginationUnit).toBe('session');
      expect(first.sessions).toHaveLength(2);
      expect(first.nextCursor).toBeTruthy();
      expect(first.sessions.every((session) => session.kind === 'ledger')).toBe(true);
      const second = await (await f.api(f.owner.accessToken, `/sessions?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as { sessions: { id: string }[] };
      expect(second.sessions.some((session) => first.sessions.some((row) => row.id === session.id))).toBe(false);
      expect((await f.api(f.owner.accessToken, '/sessions?state=unknown')).status).toBe(400);
      expect((await f.api(f.owner.accessToken, '/sessions?kind=other')).status).toBe(400);

      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', password);
      const scoped = await (await f.api(manager.accessToken, '/sessions?limit=50')).json() as { sessions: { role: string; username: string }[] };
      expect(scoped.sessions.length).toBeGreaterThan(0);
      expect(scoped.sessions.every((session) => session.role === 'member')).toBe(true);
      expect((await f.api(manager.accessToken, `/accounts/${f.owner.accountId}/sessions/revoke`, {})).status).toBe(403);
      expect((await f.api(manager.accessToken, `/accounts/${f.member.accountId}/sessions/revoke`, {})).status).toBe(200);
      const audit = await (await f.api(f.owner.accessToken, '/audit?action=sessions-revoke-all')).json() as { entries: unknown[] };
      expect(audit.entries.length).toBeGreaterThanOrEqual(1);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('lets an owner revoke their own other sessions while keeping the current one', async () => {
    const f = await fixture();
    try {
      const other = await loginAccount(f.url, 'owner', password);
      const overview = await (await f.api(f.owner.accessToken, '/sessions?limit=50')).json() as { sessions: { id: string; username: string }[] };
      expect(overview.sessions.some((session) => session.id === other.session.id)).toBe(true);

      // Anyone keeps control of their own devices: a freshly authenticated owner may revoke
      // their own other session.
      const revoked = await f.api(f.owner.accessToken, `/sessions/${other.session.id}/revoke`, {});
      expect(revoked.status).toBe(200);
      expect((await f.api(other.accessToken, '/overview')).status).toBe(401);

      // The session used by this console is never revoked from here: it ends through logout.
      const current = await f.api(f.owner.accessToken, `/sessions/${f.owner.session.id}/revoke`, {});
      expect(current.status).toBe(409);
      expect(await current.json()).toMatchObject({ code: 'CURRENT_SESSION' });
      expect((await f.api(f.owner.accessToken, '/overview')).status).toBe(200);

      // Bulk revocation of the owner's own account keeps the calling session and still reports
      // how many sessions it ended, in one transaction with its audit record.
      const extra = await loginAccount(f.url, 'owner', password);
      const all = await f.api(f.owner.accessToken, `/accounts/${f.owner.accountId}/sessions/revoke`, {});
      expect(all.status).toBe(200);
      expect((await all.json()) as { revoked: number }).toMatchObject({ revoked: 1 });
      expect((await f.api(f.owner.accessToken, '/overview')).status).toBe(200);
      expect((await f.api(extra.accessToken, '/overview')).status).toBe(401);

      const audit = await (await f.api(f.owner.accessToken, '/audit?action=sessions-revoke-all')).json() as { entries: { summary: string }[] };
      expect(audit.entries[0]!.summary).toContain('的全部可管理会话被撤销（1 个）');

      // Administrators still cannot touch a privileged account's sessions.
      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', password);
      const denied = await f.api(manager.accessToken, `/accounts/${f.owner.accountId}/sessions/revoke`, {});
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'PROTECTED_ACCOUNT' });
      expect((await f.api(f.owner.accessToken, '/overview')).status).toBe(200);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('records server-visible sync failures as diagnostics with an explicit coverage note', async () => {
    const f = await fixture();
    try {
      // A bound-less replica fails on the server and must show up as a ledger mismatch.
      expect((await fetch(`${f.url}/api/v3/commits`, { headers: { Authorization: `Bearer ${f.member.accessToken}` } })).status).toBe(409);
      const diagnostics = await (await f.api(f.owner.accessToken, '/sync-events?category=ledger-mismatch')).json() as { events: { resultCode: string; category: string }[]; coverage: string };
      expect(diagnostics.events.some((event) => event.resultCode === 'REPLICA_UNBOUND')).toBe(true);
      expect(diagnostics.coverage).toContain('客户端离线');
      expect((await f.api(f.owner.accessToken, '/sync-events?category=made-up')).status).toBe(400);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('exports audit rows without invitation codes, reset codes or tokens', async () => {
    const f = await fixture();
    try {
      const inviteResponse = await f.api(f.owner.accessToken, '/invites', { days: 7 });
      const invite = ((await inviteResponse.json()) as { invite: { code: string } }).invite;
      const reset = await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/password-reset`, { reason: '用户申请' });
      const resetBody = await reset.json() as { code: string };
      const exported = await f.api(f.owner.accessToken, '/audit/export?format=json');
      expect(exported.status).toBe(200);
      const text = await exported.text();
      expect(text).toContain('password-reset-issue');
      expect(text).not.toContain(invite.code);
      expect(text).not.toContain(resetBody.code);
      const csv = await f.api(f.owner.accessToken, '/audit/export?format=csv&action=password-reset-issue');
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toContain('text/csv');
      expect(await csv.text()).toContain('用户申请');
      expect((await f.api(f.owner.accessToken, '/audit/export?format=pdf')).status).toBe(400);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('audits a revoked reset code and lists the audited actions for filtering', async () => {
    const f = await fixture();
    try {
      const issued = await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/password-reset`, { reason: '用户申请' });
      expect(issued.status).toBe(200);

      // Revoking a pending code is a management change, so it is audited like issuing one.
      const revoked = await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/password-reset/revoke`, { reason: '用户已找回设备' });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ ok: true, revoked: true });

      const audit = await (await f.api(f.owner.accessToken, '/audit?action=password-reset-revoke')).json() as {
        entries: { summary: string; reason: string | null; targetAccountId: string }[]; actions: string[];
      };
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]!.targetAccountId).toBe(f.member.accountId);
      expect(audit.entries[0]!.summary).toContain('撤销了未使用的密码重置码');
      expect(audit.entries[0]!.summary).toContain('原因：用户已找回设备');
      // The filter list comes from the server, so it cannot drift from what is written.
      expect(audit.actions).toContain('password-reset-revoke');
      expect(audit.actions).toContain('settings-save');
      expect(audit.actions).toContain('sessions-revoke-all');
      expect((await f.api(f.owner.accessToken, '/audit?action=made-up')).status).toBe(400);

      // A second revoke reports that there was nothing left to clear.
      expect(await (await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/password-reset/revoke`, {})).json()).toMatchObject({ ok: true, revoked: false });

      const member = await loginAccount(f.url, 'member', password);
      expect((await f.api(member.accessToken, `/accounts/${f.owner.accountId}/password-reset/revoke`, {})).status).toBe(403);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('saves only allow-listed settings and labels environment overrides', async () => {
    const f = await fixture();
    try {
      const initial = await (await f.api(f.owner.accessToken, '/settings')).json() as { settings: { name: string; source: string }[]; secrets: Record<string, string>; version: Record<string, unknown> };
      const field = initial.settings.find((setting) => setting.name === 'quotaWarnRatio')!;
      expect(field.source).toBe('default');
      expect(initial.secrets['syncSecret']).toBe('configured');
      expect(initial.version['schema']).toBe(11);
      expect(JSON.stringify(initial)).not.toContain(password);

      const saved = await f.api(f.owner.accessToken, '/settings', { settings: { quotaWarnRatio: 0.95 } });
      expect(saved.status).toBe(200);
      const after = await (await f.api(f.owner.accessToken, '/settings')).json() as { settings: { name: string; source: string; value: number }[] };
      expect(after.settings.find((setting) => setting.name === 'quotaWarnRatio')).toMatchObject({ source: 'database', value: 0.95 });
      expect((await f.api(f.owner.accessToken, '/settings', { settings: { quotaWarnRatio: 5 } })).status).toBe(400);
      expect((await f.api(f.owner.accessToken, '/settings', { settings: { madeUpSetting: 1 } })).status).toBe(400);
      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', password);
      expect((await f.api(manager.accessToken, '/settings', { settings: { quotaWarnRatio: 0.8 } })).status).toBe(403);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('summarises the overview from a cached snapshot and reports storage composition', async () => {
    const f = await fixture();
    try {
      const overview = await (await f.api(f.owner.accessToken, '/overview')).json() as { snapshot: { counts: Record<string, number>; storage: Record<string, unknown>; cleanup: Record<string, unknown>; sampledAt: string } };
      expect(overview.snapshot.counts['userCount']).toBe(3);
      expect(overview.snapshot).toHaveProperty('sampledAt');
      expect(overview.snapshot.storage).toHaveProperty('diskFreeBytes');
      expect(overview.snapshot.cleanup).toMatchObject({ runs: expect.any(Number) });
      const metrics = await (await f.api(f.owner.accessToken, '/metrics?range=1h')).json() as { buckets: unknown[]; totals: Record<string, number | null>; note: string };
      expect(Array.isArray(metrics.buckets)).toBe(true);
      expect(metrics.note).toContain('上线开始积累');
      expect((await f.api(f.owner.accessToken, '/metrics?range=99d')).status).toBe(400);
      const storage = await (await f.api(f.owner.accessToken, '/storage')).json() as Record<string, unknown>;
      expect(storage).toMatchObject({ databaseBytes: expect.any(Number), objectBytes: expect.any(Number) });
      expect(String(storage['note'])).toContain('备份目录不在 Web 静态服务范围内');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('resolves alerts only after recovery is observed twice and supports acknowledgement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-alerts-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-alert-test');
    try {
      await store.ready;
      const first = await store.upsertAlert({ key: 'k1', rule: 'capacity', scope: 'commit', severity: 'warning', active: true });
      expect(first.state).toBe('pending');
      const second = await store.upsertAlert({ key: 'k1', rule: 'capacity', scope: 'commit', severity: 'warning', active: true });
      expect(second).toMatchObject({ state: 'active', occurrences: 2 });
      const recovered = await store.upsertAlert({ key: 'k1', rule: 'capacity', scope: 'commit', severity: 'warning', active: false });
      expect(recovered.state).toBe('active');
      const resolved = await store.upsertAlert({ key: 'k1', rule: 'capacity', scope: 'commit', severity: 'warning', active: false });
      expect(resolved.state).toBe('resolved');
      const acknowledged = await store.acknowledgeAlert('k1', 'account-owner');
      expect(acknowledged).toMatchObject({ acknowledgedBy: 'account-owner' });
      expect((await store.listAlerts({ state: 'resolved' }))).toHaveLength(1);

      // Failed attempts live outside the transactional audit.
      await store.recordAdminFailure({ action: 'state', code: 'PROTECTED_ACCOUNT', message: 'nope', requestId: 'req-1' });
      expect((await store.listAdminFailures(5))[0]).toMatchObject({ action: 'state', code: 'PROTECTED_ACCOUNT', requestId: 'req-1' });
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('readable management audit text', () => {
  it('renders an operator-facing sentence and keeps the raw fields for detail', () => {
    expect(describeAudit({ action: 'blob-quota', before: { bytes: 2 * 1024 ** 3 }, after: { bytes: 5 * 1024 ** 3 }, reason: '容量申请' }, '李四', '张三'))
      .toBe('管理员 李四 将用户 张三的附件配额调整为 5 GiB。 原因：容量申请。');
    expect(describeAudit({ action: 'state', before: { disabled: false }, after: { disabled: true } }, '李四', '张三'))
      .toContain('已禁用（同时撤销全部会话）');
    expect(describeAudit({ action: 'role', before: { role: 'member' }, after: { role: 'admin' } }, '李四', '张三'))
      .toContain('管理员');
    expect(describeAudit({ action: 'registration', before: { value: 'invite' }, after: { mode: 'closed' } }, '李四', ''))
      .toContain('注册策略');
  });
});
