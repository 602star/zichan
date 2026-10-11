import { describe, expect, it } from 'vitest';
import { createWriteTracker, drainView, isClientWrite, resolveMaintenance } from '../src/maintenance-mode.js';

/**
 * Maintenance mode.
 *
 * The failure modes are all about a window that is declared but does not apply, or applies when it
 * should not: a mode that never expires, a gate that closes admin or auth traffic, or a "safe to
 * stop" reading that ignores work still in flight.
 */
describe('maintenance window', () => {
  it('refuses writes only while the window is open', () => {
    const on = { enabled: true, message: '维护中', until: null, startedAt: '2026-09-20T00:00:00.000Z', startedBy: 'owner' };
    expect(resolveMaintenance(on).active).toBe(true);
    expect(resolveMaintenance({ ...on, enabled: false }).active).toBe(false);
    expect(resolveMaintenance(undefined).active).toBe(false);
  });

  it('lets an expired window stop applying without anyone clearing it', () => {
    // A maintenance flag nobody remembers to clear is an outage with a friendly name.
    const state = { enabled: true, message: '', until: '2026-09-20T01:00:00.000Z', startedAt: null, startedBy: null };
    const view = resolveMaintenance(state, Date.parse('2026-09-20T01:00:01.000Z'));
    expect(view.active).toBe(false);
    expect(view.expired).toBe(true);
    // The stored flag is still reported, so the console can say "expired, writes resumed" rather
    // than silently dropping the record of the window.
    expect(view.enabled).toBe(true);
    expect(view.until).toBe('2026-09-20T01:00:00.000Z');
  });

  it('treats an unparseable end time as an open-ended window', () => {
    // Refusing writes forever because of a typo in a timestamp is worse than the open-ended window
    // the operator already had; the admin route refuses to store one in the first place.
    const view = resolveMaintenance({ enabled: true, message: '', until: 'not-a-date', startedAt: null, startedBy: null });
    expect(view.active).toBe(true);
    expect(view.expired).toBe(false);
  });

  it('always has a message to show a client', () => {
    // A refused write with an empty reason reads as a server fault rather than a planned window.
    expect(resolveMaintenance({ enabled: true, message: '', until: null, startedAt: null, startedBy: null }).message).not.toBe('');
    expect(resolveMaintenance({ enabled: true, message: '升级数据库', until: null, startedAt: null, startedBy: null }).message).toBe('升级数据库');
  });

  it('gates client writes but never admin or auth traffic', () => {
    expect(isClientWrite('POST', '/api/v3/commits')).toBe(true);
    expect(isClientWrite('POST', '/api/v4/replication/commits')).toBe(true);
    expect(isClientWrite('POST', '/api/v4/replication/key-envelope')).toBe(true);
    expect(isClientWrite('PUT', '/api/v4/replication/blobs/uploads/abc/chunks/0')).toBe(true);
    expect(isClientWrite('PUT', '/api/v3/key-envelope')).toBe(true);
    expect(isClientWrite('POST', '/api/v3/blobs/uploads')).toBe(true);
    expect(isClientWrite('DELETE', '/api/v3/blobs/abc')).toBe(true);
    // Reads stay open: a client that cannot pull has no way to learn why it is failing.
    expect(isClientWrite('GET', '/api/v3/commits')).toBe(false);
    expect(isClientWrite('GET', '/api/v4/replication/commits')).toBe(false);
    expect(isClientWrite('POST', '/api/v4/replication/blobs/status')).toBe(false);
    expect(isClientWrite('HEAD', '/api/v3/blobs/abc/chunks/0')).toBe(false);
    // The read-shaped POST is not a write; refusing it would break the diagnostics page for no gain.
    expect(isClientWrite('POST', '/api/v3/blobs/status')).toBe(false);
    // Admin must stay open or the mode could never be cleared; auth so people can still sign in.
    expect(isClientWrite('POST', '/api/admin/maintenance')).toBe(false);
    expect(isClientWrite('POST', '/api/auth/login/start')).toBe(false);
    expect(isClientWrite('POST', '/api/auth/logout')).toBe(false);
  });

  it('counts writes in flight and never goes negative', () => {
    // A leaked count would make the console claim a write is still in flight forever, which is
    // exactly the signal an operator uses to decide it is safe to stop the process.
    const tracker = createWriteTracker();
    expect(tracker.count).toBe(0);
    tracker.begin();
    tracker.begin();
    expect(tracker.count).toBe(2);
    tracker.end();
    expect(tracker.count).toBe(1);
    tracker.end();
    tracker.end();
    expect(tracker.count).toBe(0);
  });

  it('reports stopping as unsafe while a write or job is still running', () => {
    const tracker = createWriteTracker();
    expect(drainView(tracker, { running: 0, queued: 0 }).safeToStop).toBe(true);
    tracker.begin();
    expect(drainView(tracker, { running: 0, queued: 0 }).safeToStop).toBe(false);
    tracker.end();
    expect(drainView(tracker, { running: 1, queued: 0 }).safeToStop).toBe(false);
  });

  it('does not let a queued job block stopping, but still reports it', () => {
    // A queued job has not started; a restart marks it interrupted rather than losing work, so it
    // is information rather than a reason to wait.
    const view = drainView(createWriteTracker(), { running: 0, queued: 3 });
    expect(view.safeToStop).toBe(true);
    expect(view.queuedJobs).toBe(3);
    expect(view.note).toContain('3 个排队任务');
  });

  it('says what is still running when stopping would interrupt it', () => {
    const tracker = createWriteTracker();
    tracker.begin();
    const view = drainView(tracker, { running: 2, queued: 0 });
    expect(view.note).toContain('1 个写入');
    expect(view.note).toContain('2 个任务');
  });
});
