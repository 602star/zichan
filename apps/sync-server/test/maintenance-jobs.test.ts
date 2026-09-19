import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { createServerBackup } from '../src/backup.js';
import { writeMaintenanceRecord } from '../src/maintenance-records.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { objectDirectory, objectNamespace, seedObjects } from './support/blob-fixtures.js';
import { CURRENT_SERVER_SCHEMA, SyncServerStore } from '../src/store.js';

const password = 'correct horse battery staple';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-jobs-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { ownerSetupToken: OWNER_SETUP_TOKEN });
  await registerAccount(url, 'member', password);
  const owner = await loginAccount(url, 'owner', password);
  const member = await loginAccount(url, 'member', password);
  const api = (token: string, path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const user = (token: string, path: string, body?: unknown) => fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { dir, url, server, owner, member, api, user };
}

const waitForJob = async (f: Awaited<ReturnType<typeof fixture>>, jobId: string) => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const body = await (await f.api(f.owner.accessToken, `/jobs/${jobId}`)).json() as { job: { status: string; result?: Record<string, unknown> } };
    if (!['queued', 'running'].includes(body.job.status)) return body;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} never finished`);
};

describe('maintenance jobs', () => {
  it('scans attachments in batches, keeps serving requests, and reports unreadable objects', async () => {
    const f = await fixture();
    try {
      // Bind a ledger through the protection API, then seed 120 real objects and corrupt one.
      const initialized = await (await f.user(f.member.accessToken, '/api/v3/protection/initialize', { mode: 'managed' })).json() as { replica: { ledgerId: string } };
      const ledgerId = initialized.replica.ledgerId;
      const seeded = await seedObjects(f.dir, 'member', ledgerId, 120, true);
      const corrupt = seeded[0]!;
      writeFileSync(join(objectDirectory(f.dir, objectNamespace('member', ledgerId), corrupt), '0.chunk'), Buffer.alloc(32, 9));

      const created = await f.api(f.owner.accessToken, '/jobs', { type: 'blobs.verify' });
      expect(created.status).toBe(202);
      const jobId = ((await created.json()) as { job: { jobId: string } }).job.jobId;
      // The request path stays usable while maintenance is queued or running.
      const duringJob = await fetch(`${f.url}/api/health`);
      expect(duringJob.status).toBe(200);

      const finished = await waitForJob(f, jobId);
      expect(finished.job.status).toBe('succeeded');
      expect(finished.job.result).toMatchObject({ checkedObjects: 119, issueCount: 1 });
      expect(JSON.stringify(finished.job.result?.['issues'])).toContain('checksum mismatch');
      expect((await f.api(f.owner.accessToken, `/jobs/${jobId}`)).status).toBe(200);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('yields between batches and observes cancellation only at a batch boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-yield-'));
    const blobStore = new EncryptedBlobStore({ dataDir: dir });
    try {
      await blobStore.ready;
      await seedObjects(dir, 'member', 'ledger-yield-test-0001', 6, true);
      const observations: string[] = [];
      const result = await blobStore.verify({
        batchSize: 2,
        onProgress: (progress) => { observations.push(`progress:${progress.processed}`); },
        shouldCancel: () => false,
      });
      expect(result).toMatchObject({ checkedObjects: 6, cancelled: false });
      expect(observations).toContain('progress:2');

      // Cancellation is only observed where the scan can stop safely.
      const cancelledRun = await blobStore.verify({ batchSize: 2, shouldCancel: () => true });
      expect(cancelledRun.cancelled).toBe(true);
      expect(cancelledRun.checkedObjects).toBe(2);
      expect(cancelledRun.lastKey).toBeTruthy();

      // A resumed scan continues after the last verified object instead of starting over.
      const resumed = await blobStore.verify({ resumeFrom: cancelledRun.lastKey });
      expect(resumed.checkedObjects).toBe(4);
    } finally { await blobStore.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('marks an abandoned job as interrupted and never as success, resuming only the checkpointed scan', async () => {
    const f = await fixture();
    try {
      const store = new SyncServerStore(join(f.dir, 'server.sqlite'), 'invite', f.server.serverId);
      await store.ready;
      try {
        const scan = await store.createJob({ type: 'blobs.verify', params: {}, createdBy: 'owner' });
        const prune = await store.createJob({ type: 'logs.prune', params: {}, createdBy: 'owner' });
        const driver = new NodeSqliteDriver(join(f.dir, 'server.sqlite'));
        try {
          // Simulate an executor that died without finishing.
          await driver.run("UPDATE admin_jobs SET status = 'running', started_at = ?, result_json = ? WHERE job_id = ?", [new Date().toISOString(), JSON.stringify({ lastKey: 'member|abc' }), scan.jobId]);
          await driver.run("UPDATE admin_jobs SET status = 'running', started_at = ? WHERE job_id = ?", [new Date().toISOString(), prune.jobId]);
        } finally { await driver.close(); }

        const recovery = await store.markInterruptedJobs();
        expect(recovery.interrupted).toEqual(expect.arrayContaining([scan.jobId, prune.jobId]));
        expect((await store.getJob(scan.jobId))?.status).toBe('interrupted');
        expect((await store.getJob(prune.jobId))?.status).toBe('interrupted');
        expect(recovery.resumed).toHaveLength(1);
        const resumed = await store.getJob(recovery.resumed[0]!);
        expect(resumed).toMatchObject({ status: 'queued', type: 'blobs.verify', retryOf: scan.jobId });
        expect(resumed?.params['resumeFrom']).toBe('member|abc');
      } finally { await store.close(); }
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('verifies a registered backup and drills a restore in an isolated directory', async () => {
    const f = await fixture();
    const backupDir = join(f.dir, '..', `backup-${Date.now()}`);
    try {
      await f.server.close();
      const manifest = await createServerBackup(f.dir, backupDir);
      writeMaintenanceRecord(f.dir, {
        recordId: 'backup-0001',
        kind: 'manual',
        status: 'completed',
        createdAt: manifest.createdAt,
        finishedAt: new Date().toISOString(),
        outputPath: backupDir,
        serverId: manifest.serverId,
        fileCount: manifest.files.length,
        totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
        note: '停服备份',
      });

      const restored = createTestSyncServer({ dataDir: f.dir });
      await restored.ready;
      await restored.started;
      await new Promise<void>((resolve) => restored.server.listen(0, '127.0.0.1', resolve));
      const address = restored.server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const url = `http://127.0.0.1:${address.port}`;
      const owner = await loginAccount(url, 'owner', password);
      const api = (path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${owner.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const waitFor = async (jobId: string) => {
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const body = await (await api(`/jobs/${jobId}`)).json() as { job: { status: string; result?: Record<string, unknown> } };
          if (!['queued', 'running'].includes(body.job.status)) return body;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`job ${jobId} never finished`);
      };
      try {
        const backups = await (await api('/backups')).json() as { backups: { recordId: string; outputPath: string }[] };
        expect(backups.backups.map((record) => record.recordId)).toContain('backup-0001');

        const verifyResponse = await api('/jobs', { type: 'backup.verify', recordId: 'backup-0001' });
        expect(verifyResponse.status).toBe(202);
        const verifyJob = await waitFor(((await verifyResponse.json()) as { job: { jobId: string } }).job.jobId);
        expect(verifyJob.job).toMatchObject({ status: 'succeeded', result: { ok: true } });

        const drillResponse = await api('/jobs', { type: 'restore.drill', recordId: 'backup-0001' });
        expect(drillResponse.status).toBe(202);
        const drillJob = await waitFor(((await drillResponse.json()) as { job: { jobId: string } }).job.jobId);
        expect(drillJob.job.status).toBe('succeeded');
        expect(drillJob.job.result).toMatchObject({ ok: true, activeSessions: 0, pendingResets: 0 });
        // The drill directory must not survive the run.
        expect(existsSync(join(f.dir, 'drills')) ? readdirSync(join(f.dir, 'drills')) : []).toEqual([]);

        const missing = await api('/jobs', { type: 'restore.drill', recordId: 'record-missing' });
        expect(missing.status).toBe(202);
        const missingJob = await waitFor(((await missing.json()) as { job: { jobId: string } }).job.jobId);
        expect(missingJob.job).toMatchObject({ status: 'failed', errorCode: 'BACKUP_RECORD_NOT_FOUND' });
      } finally { await restored.close(); }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it('records cleanup outcomes instead of swallowing failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-cleanup-'));
    const blobStore = new EncryptedBlobStore({ dataDir: dir });
    try {
      await blobStore.ready;
      const reports: { lastOk: boolean | null; lastError?: string }[] = [];
      blobStore.onCleanupResult = (status) => { reports.push({ lastOk: status.lastOk, ...(status.lastError ? { lastError: status.lastError } : {}) }); };
      const ok = await blobStore.runCleanup();
      expect(ok).toMatchObject({ lastOk: true, runs: 1, consecutiveFailures: 0 });
      expect(reports[0]).toEqual({ lastOk: true });

      // A closed database turns a scheduled cleanup into a recorded failure.
      await blobStore.close();
      const failed = await blobStore.runCleanup();
      expect(failed.lastOk).toBe(false);
      expect(failed.consecutiveFailures).toBe(1);
      expect(failed.lastError).toBeTruthy();
      expect(reports.at(-1)?.lastOk).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps accounts, roles, quotas, bindings and protection across the schema upgrade', async () => {
    const f = await fixture();
    try {
      await f.api(f.owner.accessToken, `/accounts/${f.member.accountId}/commits`, { commitQuotaBytes: 64 * 1024 ** 2 });
      const initialized = await (await f.user(f.member.accessToken, '/api/v3/protection/initialize', { mode: 'managed' })).json() as { replica: { ledgerId: string; replicaId: string; streamEpoch: string }; mode: string; version: number };
      await f.server.close();

      // Rebuild the database as a v10 shape: old marker, no new columns, no new tables.
      const driver = new NodeSqliteDriver(join(f.dir, 'server.sqlite'));
      try {
        await driver.run('UPDATE server_schema_migrations SET version = 10, name = ?', ['server_key_custody_v10']);
        for (const [table, column] of [['sync_users', 'revision'], ['sync_sessions', 'kind'], ['server_admin_audit', 'reason'], ['server_admin_audit', 'request_id']] as const) {
          await driver.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        }
        for (const table of ['admin_jobs', 'admin_job_events', 'admin_alerts', 'admin_audit_failures', 'admin_idempotency', 'server_metric_buckets', 'sync_events', 'server_backup_records', 'server_maintenance_state']) {
          await driver.exec(`DROP TABLE IF EXISTS ${table}`);
        }
      } finally { await driver.close(); }

      const store = new SyncServerStore(join(f.dir, 'server.sqlite'), 'invite', f.server.serverId);
      try {
        await store.ready;
        expect((await store.probe()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
        const member = await store.getUser('member');
        expect(member).toBeTruthy();
        expect(await store.roleForUser('owner')).toBe('owner');
        expect(await store.roleForUser('member')).toBe('member');
        const quotas = await store.listUsers('', 10);
        const row = quotas.users.find((entry) => entry['username'] === 'member')!;
        expect(row['commitQuotaBytes']).toBe(64 * 1024 ** 2);
        // The additive column restarts at its default on upgrade: the token only has to
        // detect conflicts between reads and writes inside one console session.
        expect(row['revision']).toBe(1);
        expect(row['protectionMode']).toBe('managed');
        const replica = await store.getReplica('member');
        expect(replica).toMatchObject({ ledgerId: initialized.replica.ledgerId, replicaId: initialized.replica.replicaId, streamEpoch: initialized.replica.streamEpoch });
        expect(await store.getLedgerProtection('member')).toMatchObject({ mode: 'managed', version: initialized.version });
        // Upgraded databases get the new tables back and can run maintenance immediately.
        const job = await store.createJob({ type: 'metrics.prune', params: {}, createdBy: 'owner' });
        expect((await store.getJob(job.jobId))?.status).toBe('queued');
      } finally { await store.close(); }
    } finally {
      if (existsSync(join(f.dir, 'server.pid'))) rmSync(join(f.dir, 'server.pid'), { force: true });
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('deployment maintenance records', () => {
  it('ignores a half-written record file instead of importing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-records-'));
    try {
      mkdirSync(join(dir, 'maintenance'), { recursive: true });
      writeFileSync(join(dir, 'maintenance', 'broken.json'), '{ "recordId": ');
      const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-records');
      try {
        await store.ready;
        const { importMaintenanceRecords } = await import('../src/maintenance-records.js');
        expect(await importMaintenanceRecords(store, dir)).toBe(0);
        // The list is paginated now: the records are under `backups`, and the summary fields sit
        // beside it so the console never derives them from a truncated page.
        expect(await store.listBackupRecords()).toMatchObject({ backups: [], total: 0 });
        expect(readFileSync(join(dir, 'maintenance', 'broken.json'), 'utf8')).toContain('recordId');
      } finally { await store.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
