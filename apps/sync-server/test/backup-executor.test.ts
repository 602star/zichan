import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBackupExecutor, validateBackupDirectory, type BackupPlan } from '../src/backup-executor.js';
import { backupSlot, parseBackupWindow } from '../src/backup-schedule.js';
import { executorStatus, writeExecutorState } from '../src/backup-executor-state.js';
import { readMaintenanceRecords } from '../src/maintenance-records.js';
import { SyncServerStore } from '../src/store.js';
import { verifyServerBackup } from '../src/backup.js';
import { acquireMaintenanceLock } from '../src/maintenance-lock.js';

const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);
describe('backup calendar windows', () => {
  it('runs at most once in a daily window and does not catch up missed windows', () => {
    const window = parseBackupWindow('每天 03:00-04:00');
    expect(backupSlot(window, local(29, 3, 20)).due).toBe(local(29, 3).toISOString());
    expect(backupSlot(window, local(29, 3, 20), local(29, 3).toISOString())).toEqual({ nextAt: local(30, 3).toISOString() });
    expect(backupSlot(window, local(29, 5))).toEqual({ nextAt: local(30, 3).toISOString() });
  });
  it('handles weekly and midnight windows without replay after a clock rollback', () => {
    expect(parseBackupWindow('周日 23:00-01:00')).toEqual(parseBackupWindow('Sun 23:00-01:00'));
    const window = parseBackupWindow('周日 23:00-01:00');
    expect(backupSlot(window, local(28, 0, 30)).due).toBe(local(27, 23).toISOString());
    expect(backupSlot(window, local(28, 0, 30), local(27, 23).toISOString()).nextAt).toBe(new Date(2026, 9, 4, 23).toISOString());
    expect(backupSlot(parseBackupWindow('03:00-04:00'), local(29, 3, 20), local(30, 3).toISOString()).due).toBeUndefined();
  });
  it.each(['每周日 凌晨', '25:00-26:00', '03:60-04:00', '03:00-03:00'])('rejects ambiguous or invalid window %s', (window) => {
    expect(() => parseBackupWindow(window)).toThrow();
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zichan-executor-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const plan: BackupPlan = { enabled: true, directory: join(root, 'backups'), window: '每天 03:00-04:00', serverId: 'executor-test' };
  return { root, dataDir, plan, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('durable backup executor', () => {
  it('waits for the host maintenance lock before claiming a backup window', async () => {
    const f = fixture();
    try {
      const release = acquireMaintenanceLock(f.dataDir, 'host-updater:test');
      expect(release).toBeTypeOf('function');
      const stop = vi.fn(async () => undefined);
      const executor = createBackupExecutor({ dataDir: f.dataDir, now: () => local(29, 3, 15), stopService: stop, startService: async () => undefined });
      await executor.tick(f.plan);
      expect(stop).not.toHaveBeenCalled();
      expect(executor.state.lastSlot).toBeUndefined();
      release!();
      await executor.close();
    } finally { f.cleanup(); }
  });
  it('stops, produces a real verified backup, restarts and never repeats that slot after restart', async () => {
    const f = fixture();
    try {
      for (const [name, value] of [['server-id', f.plan.serverId], ['server.secret', 'a'.repeat(64)], ['opaque.server-setup', 'b'.repeat(64)]]) writeFileSync(join(f.dataDir, name!), value!);
      const quarantine = join(f.dataDir, 'blobs', 'quarantine', 'damaged-object');
      mkdirSync(quarantine, { recursive: true });
      writeFileSync(join(quarantine, '0.chunk'), 'damaged ciphertext retained for diagnosis');
      let store = new SyncServerStore(join(f.dataDir, 'server.sqlite'), 'invite', f.plan.serverId); await store.ready;
      const stop = vi.fn(async () => { await store.close(); });
      const start = vi.fn(async () => { store = new SyncServerStore(join(f.dataDir, 'server.sqlite'), 'invite', f.plan.serverId); await store.ready; });
      const deps = { dataDir: f.dataDir, now: () => local(29, 3, 15), stopService: stop, startService: start };
      const executor = createBackupExecutor(deps);
      await Promise.all([executor.tick(f.plan), executor.tick(f.plan)]);
      const records = readMaintenanceRecords(f.dataDir);
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ kind: 'scheduled', status: 'completed', verification: { ok: true } });
      expect((await verifyServerBackup(records[0]!.outputPath!)).ok).toBe(true);
      expect(readFileSync(join(records[0]!.outputPath!, 'blobs', 'quarantine', 'damaged-object', '0.chunk'), 'utf8'))
        .toBe('damaged ciphertext retained for diagnosis');
      expect(stop).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
      await executor.close();
      const restarted = createBackupExecutor(deps); await restarted.tick(f.plan);
      expect(stop).toHaveBeenCalledTimes(1); expect(restarted.state.lastResult).toBe('completed');
      await restarted.close(); await store.close();
    } finally { f.cleanup(); }
  });
  it('records backup failure, restores service and waits for a new window', async () => {
    const f = fixture();
    try {
      const stop = vi.fn(async () => undefined); const start = vi.fn(async () => undefined);
      const backup = vi.fn(async () => { throw new Error('disk full'); });
      const executor = createBackupExecutor({ dataDir: f.dataDir, now: () => local(29, 3, 15), stopService: stop, startService: start, backup });
      await executor.tick(f.plan); await executor.tick(f.plan);
      expect(backup).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledOnce();
      expect(executor.state.lastResult).toBe('failed'); expect(executor.state.error).toBe('disk full');
      expect(readMaintenanceRecords(f.dataDir)[0]).toMatchObject({ status: 'failed', errorMessage: 'disk full' });
      await executor.close();
    } finally { f.cleanup(); }
  });
  it('never backs up when the service cannot stop, but attempts to restore availability', async () => {
    const f = fixture();
    try {
      const backup = vi.fn(); const start = vi.fn(async () => undefined);
      const executor = createBackupExecutor({ dataDir: f.dataDir, now: () => local(29, 3, 15), stopService: async () => { throw new Error('shutdown failed'); }, startService: start, backup });
      await executor.tick(f.plan);
      expect(backup).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledOnce();
      expect(executor.state.lastResult).toBe('failed'); await executor.close();
    } finally { f.cleanup(); }
  });
  it('records an interrupted claim after a crash and does not repeat it', async () => {
    const f = fixture();
    try {
      writeExecutorState(f.dataDir, { executorId: 'old', heartbeatAt: local(29, 3).toISOString(), timezone: 'test', status: 'running', lastSlot: local(29, 3).toISOString(), recordId: 'crashed-backup' });
      const stop = vi.fn(async () => undefined);
      const executor = createBackupExecutor({ dataDir: f.dataDir, now: () => local(29, 3, 15), stopService: stop, startService: async () => undefined });
      await executor.tick(f.plan);
      expect(stop).not.toHaveBeenCalled(); expect(executor.state.lastResult).toBe('interrupted');
      expect(readMaintenanceRecords(f.dataDir)[0]?.status).toBe('failed'); await executor.close();
    } finally { f.cleanup(); }
  });
  it('refuses unsafe directories before stopping and reports offline heartbeats honestly', async () => {
    const f = fixture();
    try {
      expect(() => validateBackupDirectory(f.dataDir, f.dataDir)).toThrow();
      expect(() => validateBackupDirectory('relative', f.dataDir)).toThrow();
      const web = join(f.root, 'web'); mkdirSync(web);
      expect(() => validateBackupDirectory(join(web, 'backups'), f.dataDir, web)).toThrow();
      const stop = vi.fn(async () => undefined);
      const executor = createBackupExecutor({ dataDir: f.dataDir, now: () => local(29, 3, 15), stopService: stop, startService: async () => undefined });
      await executor.tick({ ...f.plan, directory: f.dataDir });
      expect(stop).not.toHaveBeenCalled(); expect(executor.state.status).toBe('error');
      expect(executorStatus(f.dataDir, local(29, 3, 17).getTime()).status).toBe('offline');
      await executor.close();
      const statePath = join(f.dataDir, 'backup-executor.json');
      expect(readFileSync(statePath, 'utf8')).toContain('stopped');
      writeFileSync(statePath, '{}');
      expect(() => createBackupExecutor({ dataDir: f.dataDir, stopService: stop, startService: async () => undefined })).toThrow();
      expect(executorStatus(f.dataDir).status).toBe('unknown');
    } finally { f.cleanup(); }
  });
});
