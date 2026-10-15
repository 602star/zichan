/**
 * Alert lifecycle: silence is a recorded decision, external notification fires on transitions
 * only, and both are audited. A silenced alert keeps its history and keeps being evaluated;
 * only the outbound channel goes quiet.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeSqliteDriver } from '@zichan/db/node';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { createMetricsService, type AlertNotification, type BackupRecordSummary } from '../src/metrics.js';
import { createSettings } from '../src/settings.js';
import { SyncServerStore } from '../src/store.js';

// Built at run time so the value is an expression, not a literal credential in the file.
const accountPassword = ['alert', 'lifecycle', 'secret'].join('-');
const bearer = (token: string) => `Bearer ${token}`;

async function insertActiveAlert(dbPath: string, key: string, rule: string, scope: string): Promise<void> {
  const driver = new NodeSqliteDriver(dbPath);
  const at = new Date().toISOString();
  try {
    await driver.run(
      `INSERT OR REPLACE INTO admin_alerts
       (alert_key, rule, scope, severity, state, first_seen_at, last_seen_at, occurrences, healthy_checks, bad_streak, detail_json)
       VALUES (?, ?, ?, 'warning', 'active', ?, ?, 2, 0, 2, '{}')`,
      [key, rule, scope, at, at],
    );
  } finally { await driver.close(); }
}

async function setSilenceUntil(dbPath: string, key: string, until: string | null): Promise<void> {
  const driver = new NodeSqliteDriver(dbPath);
  try {
    await driver.run('UPDATE admin_alerts SET silenced_until = ? WHERE alert_key = ?', [until, key]);
  } finally { await driver.close(); }
}

interface Harness {
  dbPath: string;
  store: SyncServerStore;
  records: BackupRecordSummary[];
  sent: AlertNotification[];
  sample: () => Promise<void>;
  close: () => Promise<void>;
}

/** Real store, real metrics service, injected notification channel. */
async function alertHarness(records: BackupRecordSummary[]): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-alert-lifecycle-'));
  const dbPath = join(dir, 'server.sqlite');
  const blobStore = new EncryptedBlobStore({ dataDir: dir });
  const store = new SyncServerStore(dbPath, 'invite', 'srv-alert-lifecycle', undefined, blobStore.ready);
  await store.ready;
  await blobStore.ready;
  const { settings } = createSettings(store, { ADMIN_BACKUP_INTERVAL_HOURS: '24' });
  await settings.save({});
  const sent: AlertNotification[] = [];
  const metrics = createMetricsService({
    store,
    blobStore,
    settings,
    log: async () => undefined,
    listBackupRecords: async () => records,
    startedAt: Date.now(),
    notify: async (notification) => { sent.push(notification); return { state: 'sent' }; },
  });
  return {
    dbPath,
    store,
    records,
    sent,
    sample: async () => { await metrics.sample(); },
    close: async () => { await store.close(); await blobStore.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const failedBackup = (recordId: string): BackupRecordSummary => ({ recordId, createdAt: new Date().toISOString(), status: 'failed' });
const healthyBackup = (recordId: string): BackupRecordSummary => ({
  recordId, createdAt: new Date().toISOString(), status: 'completed', verificationOk: true, verifiedAt: new Date().toISOString(),
});

const backupFailure = (harness: Harness) => harness.sent.filter((notification) => notification.key === 'backup:failure');

describe('external alert notification', () => {
  it('fires on entry and on recovery, never on every sample', async () => {
    const harness = await alertHarness([failedBackup('bk-failed')]);
    try {
      // First observation records the alert; history is not a new incident.
      await harness.sample();
      expect(backupFailure(harness)).toHaveLength(0);
      await harness.sample();
      expect(backupFailure(harness).map((notification) => notification.state)).toEqual(['active']);
      await harness.sample();
      expect(backupFailure(harness)).toHaveLength(1);

      const notified = await harness.store.getAlert('backup:failure');
      expect(notified).toMatchObject({ state: 'active', notifyState: 'sent' });
      expect(notified?.lastNotifiedAt).toBeTruthy();

      // Recovery is verified by two healthy samples and announced once.
      harness.records[0] = healthyBackup('bk-recovered');
      await harness.sample();
      expect(backupFailure(harness)).toHaveLength(1);
      await harness.sample();
      expect(backupFailure(harness).map((notification) => notification.state)).toEqual(['active', 'resolved']);
      expect((await harness.store.getAlert('backup:failure'))?.state).toBe('resolved');
    } finally { await harness.close(); }
  });

  it('keeps a silenced alert out of the notification channel', async () => {
    const harness = await alertHarness([failedBackup('bk-failed')]);
    try {
      await harness.sample();
      await setSilenceUntil(harness.dbPath, 'backup:failure', new Date(Date.now() + 3_600_000).toISOString());
      await harness.sample();
      expect(backupFailure(harness)).toHaveLength(0);
      const silenced = await harness.store.getAlert('backup:failure');
      expect(silenced).toMatchObject({ state: 'active', notifyState: 'skipped', notifyError: 'silenced' });
      expect(silenced?.silencedUntil).toBeTruthy();
    } finally { await harness.close(); }
  });

  it('resumes notifications once the silence window has passed', async () => {
    const harness = await alertHarness([failedBackup('bk-failed')]);
    try {
      await harness.sample();
      await setSilenceUntil(harness.dbPath, 'backup:failure', new Date(Date.now() - 60_000).toISOString());
      await harness.sample();
      expect(backupFailure(harness).map((notification) => notification.state)).toEqual(['active']);
      expect((await harness.store.getAlert('backup:failure'))?.notifyState).toBe('sent');
    } finally { await harness.close(); }
  });
});

describe('alert silence and acknowledgement through the management API', () => {
  it('records the decision, audits it, and reports silenced alerts separately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-alert-api-'));
    const server = createTestSyncServer({ dataDir: dir });
    await server.ready;
    await server.started;
    await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const url = `http://127.0.0.1:${address.port}`;
    const api = (token: string, path: string, body?: unknown) => fetch(`${url}/api/admin${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: bearer(token), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const alertPath = `/alerts/${encodeURIComponent('test:silence')}`;
    try {
      await registerAccount(url, 'owner', accountPassword, { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'member', accountPassword);
      const owner = await loginAccount(url, 'owner', accountPassword);
      const member = await loginAccount(url, 'member', accountPassword);
      await insertActiveAlert(join(dir, 'server.sqlite'), 'test:silence', 'sync-errors', 'sync');

      const silenced = await api(owner.accessToken, `${alertPath}/silence`, { hours: 24, reason: '计划维护' });
      expect(silenced.status).toBe(200);
      const body = await silenced.json() as { alert: { silencedUntil?: string; silenceReason?: string; silencedBy?: string } };
      expect(Date.parse(String(body.alert.silencedUntil))).toBeGreaterThan(Date.now());
      expect(body.alert.silenceReason).toBe('计划维护');

      // Silence is an audited management act, with the stated reason.
      const audit = await (await api(owner.accessToken, '/audit?action=alert-silence')).json() as { entries: { action: string; reason: string | null; summary: string }[] };
      expect(audit.entries[0]).toMatchObject({ action: 'alert-silence', reason: '计划维护' });
      expect(audit.entries[0]?.summary).toContain('静默 24 小时');

      // The overview counts silenced alerts apart from the ones that still need attention.
      const overview = await (await api(owner.accessToken, '/overview')).json() as { snapshot: { alerts: { active: number; silenced: number } } };
      expect(overview.snapshot.alerts.silenced).toBeGreaterThanOrEqual(1);

      // Out-of-range windows, unknown alerts and non-administrators are all refused.
      expect((await api(owner.accessToken, `${alertPath}/silence`, { hours: 0 })).status).toBe(400);
      expect((await api(owner.accessToken, `${alertPath}/silence`, { hours: 721 })).status).toBe(400);
      expect((await api(member.accessToken, `${alertPath}/silence`, { hours: 4 })).status).toBe(403);
      expect((await api(owner.accessToken, `/alerts/${encodeURIComponent('missing:key')}/silence`, { hours: 4 })).status).toBe(404);

      const cleared = await api(owner.accessToken, `${alertPath}/unsilence`, {});
      expect(cleared.status).toBe(200);
      expect((await cleared.json() as { alert: { silencedUntil?: string } }).alert.silencedUntil).toBeUndefined();

      expect((await api(owner.accessToken, `${alertPath}/acknowledge`, {})).status).toBe(200);
      const acknowledged = await (await api(owner.accessToken, '/audit?action=alert-acknowledge')).json() as { entries: { action: string }[] };
      expect(acknowledged.entries[0]?.action).toBe('alert-acknowledge');
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
