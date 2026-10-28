/**
 * Multi-channel alert delivery, end to end.
 *
 * The unit tests pin the parsing and the payload shapes; the lifecycle tests inject a notifier, so
 * they never exercise the real dispatcher. This file drives the real one: real HTTP servers on real
 * sockets receive the notification, and the per-channel outcome is read back off the alert row.
 *
 * The failures that matter here are the quiet ones: a second channel that was never called, one
 * broken destination hiding the ones that worked, a channel list that cannot be parsed turning into
 * "no channels configured", and the legacy single webhook silently stopping.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { createMetricsService, type BackupRecordSummary } from '../src/metrics.js';
import { createSettings, parseSettingValue, SETTING_FIELDS, type SettingsReader } from '../src/settings.js';
import { SyncServerStore } from '../src/store.js';

interface Captured {
  url: string;
  bodies: Record<string, unknown>[];
  close: () => Promise<void>;
}

/** A real HTTP endpoint that records what it was sent. */
async function capture(status = 200, result: Record<string, unknown> = {}): Promise<Captured> {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      try { bodies.push(JSON.parse(body) as Record<string, unknown>); } catch { /* not JSON */ }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    bodies,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

const channel = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'webhook', name: 'ch', url: 'http://127.0.0.1:1/hook', format: 'generic', ...overrides,
});

/** Only the notifications for one alert: several rules can enter at the same time. */
const forKey = (captured: Captured, key: string) => captured.bodies.filter((body) => body['key'] === key);

const failedBackup = (recordId: string): BackupRecordSummary => ({ recordId, createdAt: new Date().toISOString(), status: 'failed' });

interface Harness {
  store: SyncServerStore;
  /** One sampling pass. Two are needed before an alert counts as entered. */
  sample: () => Promise<void>;
  testNotifications: () => Promise<{ state: string; error?: string }>;
  close: () => Promise<void>;
}

/**
 * Real store, real metrics service, and **no injected notifier** — the point of this file is the
 * dispatcher that actually runs in production. `settings` can be replaced to reach a stored value
 * the allow-list would refuse to save.
 */
async function harness(input: { alertChannels?: string; alertWebhookUrl?: string; settings?: SettingsReader } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-alert-channels-'));
  const store = new SyncServerStore(join(dir, 'server.sqlite'), 'invite', 'srv-alert-channels');
  await store.ready;
  const blobStore = new EncryptedBlobStore({ dataDir: dir });
  await blobStore.ready;
  const { settings: facade } = createSettings(store);
  const settings = input.settings ?? facade;
  if (!input.settings) {
    // Saving (even with no changes) loads the stored values into the facade's cache, which is what
    // the sampler reads through `effective`.
    await facade.save({
      ...(input.alertChannels === undefined ? {} : { alertChannels: input.alertChannels }),
      ...(input.alertWebhookUrl === undefined ? {} : { alertWebhookUrl: input.alertWebhookUrl }),
    });
  }
  const metrics = createMetricsService({
    store,
    blobStore,
    settings,
    log: async () => undefined,
    listBackupRecords: async () => [failedBackup('bk-failed')],
    startedAt: Date.now(),
  });
  return {
    store,
    sample: async () => { await metrics.sample(); },
    testNotifications: () => metrics.testNotifications(),
    close: async () => { await store.close(); await blobStore.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

describe('multi-channel alert delivery', () => {
  it('sends Bark JSON and treats an application error as a failed delivery', async () => {
    const good = await capture(200, { code: 200, message: 'success' });
    const bad = await capture(200, { code: 400, message: 'invalid device key' });
    cleanup.push(good.close, bad.close);
    const f = await harness({ alertChannels: JSON.stringify([
      channel({ name: 'bark-ok', url: `${good.url}/push`, format: 'bark', deviceKey: 'device-1', group: 'ledger' }),
      channel({ name: 'bark-bad', url: `${bad.url}/push`, format: 'bark', deviceKey: 'device-2' }),
    ]) });
    cleanup.push(f.close);
    await f.sample();
    await f.sample();
    expect(good.bodies[0]).toMatchObject({ device_key: 'device-1', group: 'ledger', title: expect.any(String), body: expect.any(String) });
    expect((await f.store.getAlert('backup:failure'))?.notifyError).toContain('bark-bad');
  });
  it('delivers to every configured channel, not just the first', async () => {
    const first = await capture();
    const second = await capture();
    cleanup.push(first.close, second.close);
    const f = await harness({
      alertChannels: JSON.stringify([
        channel({ name: 'first', url: first.url }),
        channel({ name: 'second', url: second.url, format: 'slack' }),
      ]),
    });
    cleanup.push(f.close);

    await f.sample();
    await f.sample();

    // Both destinations really received it. A dispatcher that stopped at the first channel would
    // still look healthy on the alert row, so the second server is the assertion that matters.
    expect(forKey(first, 'backup:failure')).toHaveLength(1);
    // The second channel asked for the Slack envelope, so every body it got must be Slack-shaped:
    // a dispatcher that ignored the format would send the generic body here and be rejected by the
    // real service. The count is not hardcoded — more than one alert can be active at once — only
    // that both destinations saw the same alerts.
    expect(second.bodies).toHaveLength(first.bodies.length);
    for (const body of second.bodies) {
      expect(typeof body['text']).toBe('string');
      expect(body['key']).toBeUndefined();
    }
    expect((await f.store.getAlert('backup:failure'))?.notifyState).toBe('sent');
  });

  it('reports a broken channel without hiding the one that worked', async () => {
    const good = await capture();
    const broken = await capture(500);
    cleanup.push(good.close, broken.close);
    const f = await harness({
      alertChannels: JSON.stringify([
        channel({ name: 'good', url: good.url }),
        channel({ name: 'broken', url: broken.url }),
      ]),
    });
    cleanup.push(f.close);

    await f.sample();
    await f.sample();

    expect(forKey(good, 'backup:failure')).toHaveLength(1);
    const alert = await f.store.getAlert('backup:failure');
    // The alert did get through, so the state is `sent` — but the operator still has to learn which
    // destination is broken, otherwise the failure is invisible until the other one breaks too.
    expect(alert?.notifyState).toBe('sent');
    expect(alert?.notifyError).toContain('broken');
  });

  it('fails the delivery when every channel is broken', async () => {
    const one = await capture(500);
    const two = await capture(500);
    cleanup.push(one.close, two.close);
    const f = await harness({
      alertChannels: JSON.stringify([
        channel({ name: 'one', url: one.url }),
        channel({ name: 'two', url: two.url }),
      ]),
    });
    cleanup.push(f.close);

    await f.sample();
    await f.sample();

    const alert = await f.store.getAlert('backup:failure');
    expect(alert?.notifyState).toBe('failed');
    expect(alert?.notifyError).toContain('one');
    expect(alert?.notifyError).toContain('two');
  });

  it('refuses a non-http channel when the configuration is saved', () => {
    const field = SETTING_FIELDS.find((entry) => entry.name === 'alertChannels')!;
    expect(() => parseSettingValue(field, JSON.stringify([channel({ name: 'bad', url: 'file:///etc/passwd' })]))).toThrow(/http\(s\) 地址/);
  });

  it('reports an unparseable channel list instead of silently not notifying', async () => {
    // The settings allow-list refuses to store this, so a hand-written settings reader stands in for
    // a value that reached the process some other way. The dispatcher must still say so rather than
    // fall back to "no channels configured", which would look exactly like a quiet period.
    const settings = {
      get stored() { return {}; },
      effective: (name: string) => (name === 'alertChannels' ? '[{"kind":"webhook","name":"bad"' : ''),
      resolve: () => { throw new Error('unused'); },
      save: async () => ({}),
      load: async () => ({}),
    } as unknown as SettingsReader;
    const f = await harness({ settings });
    cleanup.push(f.close);

    await f.sample();
    await f.sample();

    const alert = await f.store.getAlert('backup:failure');
    expect(alert?.notifyState).toBe('failed');
    expect(alert?.notifyError).toContain('无法解析');
  });

  it('keeps notifying through the legacy single webhook when no channel list is set', async () => {
    const legacy = await capture();
    cleanup.push(legacy.close);
    const f = await harness({ alertWebhookUrl: legacy.url });
    cleanup.push(f.close);

    await f.sample();
    await f.sample();

    // A deployment that never adopted the channel list must keep working, which is why the old URL
    // is treated as one more channel rather than removed.
    expect(forKey(legacy, 'backup:failure')).toHaveLength(1);
    expect((await f.store.getAlert('backup:failure'))?.notifyState).toBe('sent');
  });

  it('sends an explicit test through configured channels without creating an incident', async () => {
    const receiver = await capture();
    cleanup.push(receiver.close);
    const f = await harness({ alertChannels: JSON.stringify([channel({ url: receiver.url })]) });
    cleanup.push(f.close);
    expect(await f.testNotifications()).toMatchObject({ state: 'sent' });
    expect(forKey(receiver, 'notification:test')).toHaveLength(1);
    expect(await f.store.getAlert('notification:test')).toBeUndefined();
  });
});
