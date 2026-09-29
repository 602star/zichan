import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createServerBackup } from './backup.js';
import { parseBackupWindow, backupSlot } from './backup-schedule.js';
import { readExecutorState, writeExecutorState, type BackupExecutorState } from './backup-executor-state.js';
import { readMaintenanceRecords, writeMaintenanceRecord } from './maintenance-records.js';

export interface BackupPlan { enabled: boolean; directory: string; window: string; serverId: string }
export interface BackupExecutorDeps {
  dataDir: string;
  webDir?: string;
  stopService: () => Promise<void>;
  startService: () => Promise<void>;
  now?: () => Date;
  backup?: typeof createServerBackup;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Resolve existing ancestors too: a symlink must not put backups in the served tree. */
function physicalPath(path: string): string {
  let cursor = resolve(path);
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    tail.unshift(relative(parent, cursor)); cursor = parent;
  }
  return resolve(realpathSync(cursor), ...tail);
}

export function validateBackupDirectory(directory: string, dataDir: string, webDir?: string): string {
  if (!isAbsolute(directory)) throw new Error('自动备份位置必须为绝对路径');
  const target = physicalPath(directory);
  const data = physicalPath(dataDir);
  if (inside(data, target) || inside(target, data)) throw new Error('自动备份位置不能与服务器数据目录互相包含');
  if (webDir && existsSync(webDir)) {
    const web = physicalPath(webDir);
    if (inside(web, target) || inside(target, web)) throw new Error('自动备份位置不能与网页公开目录互相包含');
  }
  return target;
}

/** One durable calendar slot is claimed before stopping the service; failures are not replayed. */
export function createBackupExecutor(deps: BackupExecutorDeps) {
  const now = deps.now ?? (() => new Date());
  const prior = readExecutorState(deps.dataDir);
  const state: BackupExecutorState = {
    ...prior, executorId: randomUUID(), heartbeatAt: now().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, status: 'starting',
  };
  if (prior?.status === 'running' && prior.recordId) {
    const record = readMaintenanceRecords(deps.dataDir).find((entry) => entry.recordId === prior.recordId);
    if (record?.status === 'completed' || record?.status === 'failed') {
      state.lastResult = record.status;
      state.lastFinishedAt = record.finishedAt;
    } else {
      state.lastResult = 'interrupted'; state.error = '执行器上次在备份期间退出；本窗口不自动重复执行';
      state.lastFinishedAt = now().toISOString();
      writeMaintenanceRecord(deps.dataDir, {
        ...record,
        recordId: prior.recordId, kind: 'scheduled', status: 'failed', createdAt: prior.lastSlot ?? prior.heartbeatAt,
        finishedAt: state.lastFinishedAt, errorMessage: state.error,
      });
    }
  }
  let busy = false;
  let closing = false;
  const publish = () => { state.heartbeatAt = now().toISOString(); writeExecutorState(deps.dataDir, state); };
  publish();
  const tick = async (plan: BackupPlan): Promise<void> => {
    if (closing || busy) return;
    busy = true;
    try {
      state.nextRunAt = undefined;
      if (!plan.enabled) { state.status = 'disabled'; publish(); return; }
      const window = parseBackupWindow(plan.window);
      const directory = validateBackupDirectory(plan.directory, deps.dataDir, deps.webDir);
      const slot = backupSlot(window, now(), state.lastSlot);
      state.nextRunAt = slot.nextAt; state.status = 'waiting';
      if (!slot.due) { publish(); return; }
      const recordId = `scheduled-${slot.due.replace(/[:.]/g, '-')}`;
      state.lastSlot = slot.due; state.recordId = recordId; state.status = 'running'; state.error = undefined;
      publish(); // fsync before any stop or filesystem operation.
      const createdAt = now().toISOString();
      const output = join(directory, recordId);
      try {
        writeMaintenanceRecord(deps.dataDir, { recordId, kind: 'scheduled', status: 'planned', createdAt, outputPath: output });
        await deps.stopService();
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const manifest = await (deps.backup ?? createServerBackup)(deps.dataDir, output);
        const finishedAt = now().toISOString();
        writeMaintenanceRecord(deps.dataDir, {
          recordId, kind: 'scheduled', status: 'completed', createdAt, finishedAt, outputPath: output,
          serverId: manifest.serverId, fileCount: manifest.files.length,
          totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0), verifiedAt: finishedAt,
          verification: { ok: true, checkedFiles: manifest.files.length },
          note: '自动执行器在停服期间创建并校验；未执行历史备份删除。',
        });
        state.lastResult = 'completed'; state.lastFinishedAt = finishedAt;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        state.lastResult = 'failed'; state.lastFinishedAt = now().toISOString();
        writeMaintenanceRecord(deps.dataDir, {
          recordId, kind: 'scheduled', status: 'failed', createdAt, finishedAt: state.lastFinishedAt,
          outputPath: output, errorMessage: state.error,
        });
      } finally {
        // Also recover when shutdown finished with an error. The supervisor's start is idempotent.
        if (!closing) await deps.startService();
      }
      state.status = state.lastResult === 'completed' ? 'waiting' : 'error';
      state.nextRunAt = backupSlot(window, now(), state.lastSlot).nextAt;
      publish();
    } catch (error) {
      state.status = 'error'; state.error = error instanceof Error ? error.message : String(error); publish();
    } finally { busy = false; }
  };
  return {
    state, tick,
    heartbeat() { if (!closing) publish(); },
    async close() {
      closing = true;
      while (busy) await new Promise<void>((done) => setTimeout(done, 50));
      state.status = 'stopped'; state.nextRunAt = undefined; publish();
    },
  };
}
