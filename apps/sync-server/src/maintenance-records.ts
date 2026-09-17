/**
 * Deployment-side maintenance records.
 *
 * Backup and restore must run while the sync service is stopped, so the management
 * console never triggers them. The maintenance CLI writes a small record file next
 * to the data directory and the console imports those records for display only.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerBackupRecord, SyncServerStore } from './store.js';

export const MAINTENANCE_RECORD_DIR = 'maintenance';

export interface MaintenanceRecordInput {
  recordId: string;
  kind: ServerBackupRecord['kind'];
  status: ServerBackupRecord['status'];
  createdAt: string;
  finishedAt?: string;
  outputPath?: string;
  serverId?: string;
  fileCount?: number;
  totalBytes?: number;
  verifiedAt?: string;
  verification?: Record<string, unknown>;
  drill?: Record<string, unknown>;
  /** Retention outcome for the backup location this run looked at. */
  retention?: Record<string, unknown>;
  errorMessage?: string;
  note?: string;
}

export function maintenanceRecordPath(dataDir: string, recordId: string): string {
  return join(dataDir, MAINTENANCE_RECORD_DIR, `${recordId}.json`);
}

/** Called by the maintenance CLI after each deployment-side procedure. */
export function writeMaintenanceRecord(dataDir: string, record: MaintenanceRecordInput): string {
  const directory = join(dataDir, MAINTENANCE_RECORD_DIR);
  mkdirSync(directory, { recursive: true });
  const path = maintenanceRecordPath(dataDir, record.recordId);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  rmSync(path, { force: true });
  renameSync(temporary, path);
  return path;
}

export function readMaintenanceRecords(dataDir: string): MaintenanceRecordInput[] {
  const directory = join(dataDir, MAINTENANCE_RECORD_DIR);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const records: MaintenanceRecordInput[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Partial<MaintenanceRecordInput>;
      if (typeof value.recordId !== 'string' || typeof value.createdAt !== 'string'
        || !['manual', 'scheduled', 'drill'].includes(String(value.kind))
        || !['completed', 'failed', 'planned'].includes(String(value.status))) continue;
      records.push({
        recordId: value.recordId,
        kind: value.kind as ServerBackupRecord['kind'],
        status: value.status as ServerBackupRecord['status'],
        createdAt: value.createdAt,
        ...(value.finishedAt ? { finishedAt: value.finishedAt } : {}),
        ...(value.outputPath ? { outputPath: value.outputPath } : {}),
        ...(value.serverId ? { serverId: value.serverId } : {}),
        ...(Number.isSafeInteger(value.fileCount) ? { fileCount: Number(value.fileCount) } : {}),
        ...(Number.isSafeInteger(value.totalBytes) ? { totalBytes: Number(value.totalBytes) } : {}),
        ...(value.verifiedAt ? { verifiedAt: value.verifiedAt } : {}),
        ...(value.verification ? { verification: value.verification } : {}),
        ...(value.drill ? { drill: value.drill } : {}),
        ...(value.retention ? { retention: value.retention } : {}),
        ...(value.errorMessage ? { errorMessage: value.errorMessage } : {}),
        ...(value.note ? { note: value.note } : {}),
      });
    } catch {
      // A half-written record is skipped; the next run rewrites it.
    }
  }
  return records;
}

/** Import is idempotent: the file is the source of truth for deployment-side runs. */
export async function importMaintenanceRecords(store: SyncServerStore, dataDir: string): Promise<number> {
  let imported = 0;
  for (const record of readMaintenanceRecords(dataDir)) {
    const existing = await store.getBackupRecord(record.recordId);
    if (existing?.verification && !record.verification) {
      await store.upsertBackupRecord({
        ...record,
        verification: existing.verification,
        ...(existing.drill ? { drill: existing.drill } : {}),
        ...(existing.retention ? { retention: existing.retention } : {}),
      });
    } else if (existing?.drill && !record.drill) {
      await store.upsertBackupRecord({ ...record, drill: existing.drill, ...(existing.retention ? { retention: existing.retention } : {}) });
    } else if (existing?.retention && !record.retention) {
      // A console-side retention record must not be wiped by a deployment-side rewrite.
      await store.upsertBackupRecord({ ...record, retention: existing.retention });
    } else {
      await store.upsertBackupRecord(record);
    }
    imported += 1;
  }
  return imported;
}
