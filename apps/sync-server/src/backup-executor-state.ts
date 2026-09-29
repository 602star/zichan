import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BackupExecutorState {
  executorId: string;
  heartbeatAt: string;
  timezone: string;
  status: 'starting' | 'disabled' | 'waiting' | 'running' | 'error' | 'stopped';
  nextRunAt?: string;
  lastSlot?: string;
  recordId?: string;
  lastResult?: 'completed' | 'failed' | 'interrupted';
  lastFinishedAt?: string;
  error?: string;
}

export function writeExecutorState(dataDir: string, state: BackupExecutorState): void {
  const path = join(dataDir, 'backup-executor.json');
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  const handle = openSync(temporary, 'r+');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, path);
}

export function readExecutorState(dataDir: string): BackupExecutorState | undefined {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'backup-executor.json'), 'utf8')) as BackupExecutorState;
    if (!state.executorId || !Number.isFinite(Date.parse(state.heartbeatAt))
      || !['starting', 'disabled', 'waiting', 'running', 'error', 'stopped'].includes(state.status)
      || (state.lastSlot !== undefined && !Number.isFinite(Date.parse(state.lastSlot)))) throw new Error('备份执行器状态文件无效');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error; // A damaged execution journal must never silently re-enable an old slot.
  }
}

export function executorStatus(dataDir: string, now = Date.now()) {
  try {
    const state = readExecutorState(dataDir);
    if (!state) return { status: 'unknown' as const, error: '尚未收到备份执行器心跳' };
    if (now - Date.parse(state.heartbeatAt) > 45_000 || Date.parse(state.heartbeatAt) > now + 5_000) {
      return { ...state, status: 'offline' as const, nextRunAt: undefined };
    }
    return state;
  } catch { return { status: 'unknown' as const, error: '备份执行器状态文件不可读取' }; }
}
