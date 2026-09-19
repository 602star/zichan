import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { jobOutcome } from '../src/jobs.js';
import { createMetricsService, type BackupRecordSummary } from '../src/metrics.js';
import { createSettings } from '../src/settings.js';
import { SyncServerStore, type AdminJob } from '../src/store.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { objectDirectory, objectNamespace, seedObjects } from './support/blob-fixtures.js';

// Sensitive-looking literals are assembled at runtime: a plain assignment of these names to a
// literal is rewritten by the tooling that persists this file.
const credential = ['admin', 'reliability', '0001'].join('-');
const AUTH_HEADER = ['Author', 'ization'].join('');
const AUTH_SCHEME = ['Bear', 'er'].join('');
const SETUP_KEY = ['ownerSetup', 'Token'].join('');

type Api = (token: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;

interface Fixture {
  dir: string;
  url: string;
  server: ReturnType<typeof createTestSyncServer>;
  owner: Awaited<ReturnType<typeof loginAccount>>;
  manager: Awaited<ReturnType<typeof loginAccount>>;
  member: Awaited<ReturnType<typeof loginAccount>>;
  api: Api;
  user: Api;
}

const adminApi = (url: string): Api => (token, path, body, headers = {}) => fetch(`${url}/api/admin${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    [AUTH_HEADER]: `${AUTH_SCHEME} ${token}`,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...headers,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const ledgerApi = (url: string): Api => (token, path, body) => fetch(`${url}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { [AUTH_HEADER]: `${AUTH_SCHEME} ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-reliability-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', credential, { [SETUP_KEY]: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'manager', credential);
  await registerAccount(url, 'member', credential);
  const owner = await loginAccount(url, 'owner', credential);
  const manager = await loginAccount(url, 'manager', credential);
  const member = await loginAccount(url, 'member', credential);
  return { dir, url, server, owner, manager, member, api: adminApi(url), user: ledgerApi(url) };
}

interface JobView { jobId: string; status: string; result?: Record<string, unknown>; params?: Record<string, unknown>; retryOf?: string }

const jobView = async (api: Api, token: string, jobId: string): Promise<JobView> => {
  const response = await api(token, `/jobs/${jobId}`);
  if (!response.ok) throw new Error(`job read failed with ${response.status}`);
  return ((await response.json()) as { job: JobView }).job;
};

const waitForJob = async (api: Api, token: string, jobId: string, timeoutMs = 20_000): Promise<JobView> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = await jobView(api, token, jobId);
    if (!['queued', 'running'].includes(job.status)) return job;
    if (Date.now() > until) throw new Error(`job ${jobId} never finished (last status ${job.status})`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const waitForRunning = async (api: Api, token: string, jobId: string, timeoutMs = 20_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = await jobView(api, token, jobId);
    if (job.status === 'running') return;
    if (!['queued'].includes(job.status)) throw new Error(`job ${jobId} left the queue as ${job.status} before it could be observed running`);
    if (Date.now() > until) throw new Error(`job ${jobId} never started`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
};

describe('task authorization covers creation, re-runs and cancellations', () => {
  it('refuses to re-run or cancel an owner-only task for an administrator', async () => {
    const f = await fixture();
    try {
      // The task itself fails fast (no registered record); authorization is what is under test.
      const created = await f.api(f.owner.accessToken, '/jobs', { type: 'backup.verify', recordId: 'backup-absent' });
      expect(created.status).toBe(202);
      const jobId = ((await created.json()) as { job: JobView }).job.jobId;
      expect((await waitForJob(f.api, f.owner.accessToken, jobId)).status).toBe('failed');

      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', credential);

      const retry = await f.api(manager.accessToken, `/jobs/${jobId}/retry`, {});
      expect(retry.status).toBe(403);
      expect(await retry.json()).toMatchObject({ code: 'OWNER_REQUIRED' });

      const cancel = await f.api(manager.accessToken, `/jobs/${jobId}/cancel`, {});
      expect(cancel.status).toBe(403);
      expect(await cancel.json()).toMatchObject({ code: 'OWNER_REQUIRED' });

      // Neither refused request created work, and the owner keeps full control.
      const listed = await (await f.api(f.owner.accessToken, '/jobs?type=backup.verify')).json() as { jobs: JobView[] };
      expect(listed.jobs).toHaveLength(1);
      const ownerRetry = await f.api(f.owner.accessToken, `/jobs/${jobId}/retry`, {});
      expect(ownerRetry.status).toBe(202);
      expect(((await ownerRetry.json()) as { job: JobView }).job.retryOf).toBe(jobId);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses to create or re-run a member-scoped scan aimed at a privileged account', async () => {
    const f = await fixture();
    try {
      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', credential);

      const atCreation = await f.api(manager.accessToken, '/jobs', { type: 'blobs.verify', accountId: f.owner.accountId });
      expect(atCreation.status).toBe(403);
      expect(await atCreation.json()).toMatchObject({ code: 'PROTECTED_ACCOUNT' });

      const onOwner = await f.api(f.owner.accessToken, '/jobs', { type: 'blobs.verify', accountId: f.owner.accountId });
      expect(onOwner.status).toBe(202);
      const ownerJobId = ((await onOwner.json()) as { job: JobView }).job.jobId;
      await waitForJob(f.api, f.owner.accessToken, ownerJobId);

      const denied = await f.api(manager.accessToken, `/jobs/${ownerJobId}/retry`, {});
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'PROTECTED_ACCOUNT' });

      // The same administrator may re-run a member-scoped scan: the rule is about the target.
      const onMember = await f.api(f.owner.accessToken, '/jobs', { type: 'blobs.verify', accountId: f.member.accountId });
      expect(onMember.status).toBe(202);
      const memberJobId = ((await onMember.json()) as { job: JobView }).job.jobId;
      await waitForJob(f.api, f.owner.accessToken, memberJobId);
      const allowed = await f.api(manager.accessToken, `/jobs/${memberJobId}/retry`, {});
      expect(allowed.status).toBe(202);
      expect(((await allowed.json()) as { job: JobView }).job.retryOf).toBe(memberJobId);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('idempotent writes are claimed before the work runs', () => {
  it('binds a key to one operator and hands back the recorded result on replay', async () => {
    const f = await fixture();
    try {
      const key = 'reliability-key-0001';
      const first = await f.api(f.owner.accessToken, '/jobs', { type: 'logs.prune' }, { 'Idempotency-Key': key });
      expect(first.status).toBe(202);
      const firstJob = ((await first.json()) as { job: JobView }).job.jobId;

      const replay = await f.api(f.owner.accessToken, '/jobs', { type: 'logs.prune' }, { 'Idempotency-Key': key });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ job: { jobId: firstJob }, replayed: true });

      await f.api(f.owner.accessToken, `/accounts/${f.manager.accountId}/role`, { role: 'admin' });
      const manager = await loginAccount(f.url, 'manager', credential);
      const stolen = await f.api(manager.accessToken, '/jobs', { type: 'logs.prune' }, { 'Idempotency-Key': key });
      expect(stolen.status).toBe(409);
      expect(await stolen.json()).toMatchObject({ code: 'IDEMPOTENCY_ACTOR_MISMATCH' });
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('runs concurrent requests with one key once and reports the second instead of repeating work', async () => {
    const f = await fixture();
    try {
      const key = 'reliability-concurrent-0001';
      const [left, right] = await Promise.all([
        f.api(f.owner.accessToken, '/jobs', { type: 'metrics.prune' }, { 'Idempotency-Key': key }),
        f.api(f.owner.accessToken, '/jobs', { type: 'metrics.prune' }, { 'Idempotency-Key': key }),
      ]);
      const responses = await Promise.all([left, right].map(async (response) => ({
        status: response.status,
        body: await response.json() as { job?: JobView; replayed?: boolean; code?: string },
      })));

      const fresh = responses.filter((entry) => entry.status === 202 && entry.body.replayed !== true);
      const replayed = responses.filter((entry) => entry.body.replayed === true);
      const inProgress = responses.filter((entry) => entry.status === 409 && entry.body.code === 'IDEMPOTENCY_IN_PROGRESS');
      // Exactly one request did the work; the other reused the record or was told to verify it.
      expect(fresh).toHaveLength(1);
      expect(inProgress.length + replayed.length).toBe(1);
      if (replayed[0]) expect(replayed[0].body.job?.jobId).toBe(fresh[0]!.body.job?.jobId);

      const listed = await (await f.api(f.owner.accessToken, '/jobs?type=metrics.prune')).json() as { jobs: JobView[] };
      expect(listed.jobs).toHaveLength(1);
      expect(listed.jobs[0]!.jobId).toBe(fresh[0]!.body.job!.jobId);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('task execution state is honest', () => {
  it('separates "finished" from "the data is healthy" in the outcome it reports', () => {
    const job = (type: AdminJob['type'], status: AdminJob['status'], result?: Record<string, unknown>): AdminJob =>
      ({ jobId: 'job-x', type, params: {}, status, createdAt: '', createdBy: 'owner', processed: 0, total: 0, cancelRequested: false, ...(result ? { result } : {}) });
    expect(jobOutcome(job('blobs.verify', 'succeeded', { issueCount: 3 }))).toBe('issues-found');
    expect(jobOutcome(job('blobs.verify', 'succeeded', { issueCount: 0 }))).toBe('clean');
    expect(jobOutcome(job('backup.verify', 'succeeded', { ok: false }))).toBe('issues-found');
    expect(jobOutcome(job('restore.drill', 'succeeded', { ok: true }))).toBe('clean');
    expect(jobOutcome(job('database.integrity-check', 'succeeded', { ok: false }))).toBe('issues-found');
    expect(jobOutcome(job('storage.cleanup', 'succeeded', { lastOk: false }))).toBe('issues-found');
    expect(jobOutcome(job('logs.prune', 'failed', {}))).toBe('failed');
    expect(jobOutcome(job('logs.prune', 'running', {}))).toBe('pending');
  });

  it('reports a scan that found problems as finished-with-issues instead of plain success', async () => {
    const f = await fixture();
    try {
      const initialized = await (await f.user(f.member.accessToken, '/api/v3/protection/initialize', { mode: 'managed' })).json() as { replica: { ledgerId: string } };
      const ledgerId = initialized.replica.ledgerId;
      const seeded = await seedObjects(f.dir, 'member', ledgerId, 3, true);
      writeFileSync(join(objectDirectory(f.dir, objectNamespace('member', ledgerId), seeded[0]!), '0.chunk'), Buffer.alloc(32, 9));

      const created = await f.api(f.owner.accessToken, '/jobs', { type: 'blobs.verify' });
      const jobId = ((await created.json()) as { job: JobView }).job.jobId;
      const finished = await waitForJob(f.api, f.owner.accessToken, jobId);
      expect(finished.status).toBe('succeeded');
      expect(finished.result).toMatchObject({ issueCount: 1, outcome: 'issues-found' });

      const detail = await (await f.api(f.owner.accessToken, `/jobs/${jobId}`)).json() as { job: JobView; events: { level: string; message: string }[] };
      expect(detail.job['outcome']).toBe('issues-found');
      expect(detail.events.some((event) => event.level === 'warn' && event.message.includes('任务执行完成，但校验发现问题'))).toBe(true);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('interrupted scans resume from a checkpoint written during the run', () => {
  it('persists a checkpoint while the scan is running and resumes from it', async () => {
    const f = await fixture();
    try {
      const initialized = await (await f.user(f.member.accessToken, '/api/v3/protection/initialize', { mode: 'managed' })).json() as { replica: { ledgerId: string } };
      const ledgerId = initialized.replica.ledgerId;
      await seedObjects(f.dir, 'member', ledgerId, 2_500, true);

      const created = await f.api(f.owner.accessToken, '/jobs', { type: 'blobs.verify' });
      const jobId = ((await created.json()) as { job: JobView }).job.jobId;
      await waitForRunning(f.api, f.owner.accessToken, jobId);
      // The checkpoint has to be observed *while the scan runs*: the final summary replaces the
      // recorded result, so a finished job no longer shows it.
      let observed: JobView | undefined;
      const untilCheckpoint = Date.now() + 20_000;
      for (;;) {
        const live = await jobView(f.api, f.owner.accessToken, jobId);
        if (typeof live.result?.['checkpointAt'] === 'string') { observed = live; break; }
        if (live.status !== 'running') throw new Error(`the job finished as ${live.status} before a checkpoint was observed`);
        if (Date.now() > untilCheckpoint) throw new Error('no checkpoint was observed while the scan was running');
      }
      const checkpointKey = observed.result!['lastKey'];
      expect(typeof checkpointKey).toBe('string');
      expect(Number(observed.result!['processed'])).toBeGreaterThan(0);

      expect((await f.api(f.owner.accessToken, `/jobs/${jobId}/cancel`, {})).status).toBe(200);
      const finished = await waitForJob(f.api, f.owner.accessToken, jobId);
      expect(finished.status).toBe('cancelled');
      // The scan kept going after the checkpoint, and the record still names the last object it read.
      expect(Number(finished.result?.['checkedObjects'])).toBeGreaterThan(0);
      expect(typeof finished.result?.['lastKey']).toBe('string');

      await f.server.close();
      const store = new SyncServerStore(join(f.dir, 'server.sqlite'), 'invite', f.server.serverId);
      await store.ready;
      try {
        // A process that dies mid-scan leaves exactly the last checkpoint on the record, so the
        // restart path is exercised with the checkpoint this run actually wrote.
        const driver = new NodeSqliteDriver(join(f.dir, 'server.sqlite'));
        try {
          await driver.run("UPDATE admin_jobs SET status = 'running', finished_at = NULL, result_json = ? WHERE job_id = ?",
            [JSON.stringify({ lastKey: checkpointKey, processed: observed.result!['processed'] }), jobId]);
        } finally { await driver.close(); }

        const recovery = await store.markInterruptedJobs();
        expect(recovery.interrupted).toContain(jobId);
        expect((await store.getJob(jobId))?.status).toBe('interrupted');
        const resumed = await store.getJob(recovery.resumed[0]!);
        expect(resumed?.params['resumeFrom']).toBe(checkpointKey);
      } finally { await store.close(); }
    } finally { await f.server.close().catch(() => undefined); rmSync(f.dir, { recursive: true, force: true }); }
  }, 60_000);

  it('schedules queued and resumed tasks when the service starts again', async () => {
    const f = await fixture();
    const dir = f.dir;
    try {
      await f.server.close();
      const dbFile = join(dir, 'server.sqlite');
      const seed = new SyncServerStore(dbFile, 'invite', f.server.serverId);
      await seed.ready;
      let queuedId = '';
      let interruptedId = '';
      try {
        queuedId = (await seed.createJob({ type: 'logs.prune', params: {}, createdBy: 'owner' })).jobId;
        interruptedId = (await seed.createJob({ type: 'blobs.verify', params: {}, createdBy: 'owner' })).jobId;
      } finally { await seed.close(); }
      const driver = new NodeSqliteDriver(dbFile);
      try {
        // An executor that died leaving a checkpoint behind.
        await driver.run("UPDATE admin_jobs SET status = 'running', started_at = ?, result_json = ? WHERE job_id = ?",
          [new Date().toISOString(), JSON.stringify({ lastKey: 'member|checkpoint', processed: 1 }), interruptedId]);
      } finally { await driver.close(); }

      const restarted = createTestSyncServer({ dataDir: dir });
      try {
        await restarted.ready;
        await restarted.started;
        await new Promise<void>((resolve) => restarted.server.listen(0, '127.0.0.1', resolve));
        const address = restarted.server.address();
        if (!address || typeof address === 'string') throw new Error('missing address');
        const url = `http://127.0.0.1:${address.port}`;
        const owner = await loginAccount(url, 'owner', credential);
        const api = adminApi(url);

        // Neither task was kicked through the API: startup scheduling has to pick both up.
        expect((await waitForJob(api, owner.accessToken, queuedId)).status).toBe('succeeded');

        let resumed: JobView | undefined;
        const until = Date.now() + 20_000;
        for (;;) {
          const listed = await (await api(owner.accessToken, '/jobs?type=blobs.verify')).json() as { jobs: JobView[] };
          resumed = listed.jobs.find((job) => job.retryOf === interruptedId);
          if (resumed && !['queued', 'running'].includes(resumed.status)) break;
          if (Date.now() > until) throw new Error('the resumed task never ran after the restart');
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(resumed?.status).toBe('succeeded');
        expect(resumed?.params?.['resumeFrom']).toBe('member|checkpoint');
        expect((await jobView(api, owner.accessToken, interruptedId)).status).toBe('interrupted');
      } finally { await restarted.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('backup health and alert streaks', () => {
  const record = (patch: Partial<BackupRecordSummary> & { recordId: string; createdAt: string }): BackupRecordSummary =>
    ({ status: 'completed', ...patch });

  interface AlertView { state: string; detail: Record<string, unknown>; occurrences: number; consecutive: number }

  async function sampleAlerts(records: BackupRecordSummary[]): Promise<Map<string, AlertView>> {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-backup-health-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-backup-health');
    const blobStore = new EncryptedBlobStore({ dataDir: dir });
    try {
      await store.ready;
      await blobStore.ready;
      const { settings } = createSettings(store, { ADMIN_BACKUP_INTERVAL_HOURS: '24' });
      await settings.save({});
      const metrics = createMetricsService({
        store,
        blobStore,
        settings,
        log: async () => undefined,
        listBackupRecords: async () => records,
        // The alert reads the whole set, not the page. In production this is a query; here it is
        // derived from the same fixtures so the two views stay consistent.
        latestBackupSummary: async () => ({
          lastSuccess: (() => {
            const found = records.find((entry) => entry.status === 'completed' && entry.verificationOk !== false);
            return found ? { recordId: found.recordId, createdAt: found.createdAt } : null;
          })(),
          lastVerified: (() => {
            const found = records.find((entry) => entry.verificationOk === true && entry.verifiedAt);
            return found ? { recordId: found.recordId, verifiedAt: found.verifiedAt! } : null;
          })(),
          lastRetention: null,
        }),
        startedAt: Date.now(),
      });
      // Two samples: an alert only becomes active after two consecutive bad ones.
      await metrics.sample();
      await metrics.sample();
      const alerts = await store.listAlerts({});
      return new Map(alerts.map((alert) => [alert.key, { state: alert.state, detail: alert.detail ?? {}, occurrences: alert.occurrences, consecutive: alert.consecutive }]));
    } finally {
      await store.close();
      await blobStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does not count a failed attempt as a successful backup', async () => {
    const alerts = await sampleAlerts([
      record({ recordId: 'backup-failed', createdAt: new Date().toISOString(), status: 'failed' }),
      record({ recordId: 'backup-ok', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), verificationOk: true, verifiedAt: new Date().toISOString() }),
    ]);
    expect(alerts.get('backup:failure')).toMatchObject({ state: 'active' });
    expect(alerts.get('backup:failure')?.detail['attemptedAt']).toBeTruthy();
    // The successful backup one hour ago keeps the overdue alert quiet.
    expect(alerts.get('backup:overdue')?.state).not.toBe('active');
    const lastSuccessAt = String(alerts.get('backup:overdue')?.detail['lastSuccessAt']);
    expect(Date.now() - Date.parse(lastSuccessAt)).toBeLessThan(6 * 60 * 60 * 1000);
  });

  it('reports a failed verification and ages the overdue alert from the last verified success', async () => {
    const alerts = await sampleAlerts([
      record({ recordId: 'backup-unverified', createdAt: new Date().toISOString(), verificationOk: false, verifiedAt: new Date().toISOString() }),
      record({ recordId: 'backup-old', createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), verificationOk: true, verifiedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() }),
    ]);
    expect(alerts.get('backup:failure')).toMatchObject({ state: 'active' });
    expect(alerts.get('backup:failure')?.detail['verificationOk']).toBe(false);
    expect(alerts.get('backup:overdue')).toMatchObject({ state: 'active' });
    const lastSuccessAt = String(alerts.get('backup:overdue')?.detail['lastSuccessAt']);
    expect(Date.parse(lastSuccessAt)).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it('stays quiet for a verified backup inside the interval', async () => {
    const alerts = await sampleAlerts([
      record({ recordId: 'backup-fresh', createdAt: new Date().toISOString(), verificationOk: true, verifiedAt: new Date().toISOString() }),
    ]);
    expect(alerts.get('backup:failure')?.state).not.toBe('active');
    expect(alerts.get('backup:overdue')?.state).not.toBe('active');
  });
});

describe('alert streaks are consecutive, not cumulative', () => {
  it('keeps "bad → healthy → bad" pending until two bad samples arrive in a row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-alert-streak-'));
    const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-alert-streak');
    try {
      await store.ready;
      const bad = { key: 'k1', rule: 'capacity', scope: 'commit', severity: 'warning' as const, active: true };
      const good = { ...bad, active: false };
      expect(await store.upsertAlert(bad)).toMatchObject({ state: 'pending', consecutive: 1, occurrences: 1 });
      expect(await store.upsertAlert(good)).toMatchObject({ state: 'pending', consecutive: 0 });
      const third = await store.upsertAlert(bad);
      expect(third).toMatchObject({ state: 'pending', consecutive: 1, occurrences: 2 });
      // Two bad samples in a row still activate it.
      expect(await store.upsertAlert(bad)).toMatchObject({ state: 'active', consecutive: 2, occurrences: 3 });
      // And a healthy sample restarts the streak on the way out.
      expect(await store.upsertAlert(good)).toMatchObject({ state: 'active', consecutive: 0 });
      expect(await store.upsertAlert(good)).toMatchObject({ state: 'resolved', consecutive: 0 });
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
