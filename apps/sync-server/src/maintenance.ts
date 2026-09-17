import { resolve } from 'node:path';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from './backup.js';
import { developmentDataDir } from './runtime-config.js';
import { issueOwnerRecovery } from './owner-recovery.js';
import { writeMaintenanceRecord } from './maintenance-records.js';

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value && !value.startsWith('--')) return value;
  if (fallback) return fallback;
  throw new Error(`缺少 --${name}`);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dataDir = resolve(option('data-dir', process.env.DATA_DIR?.trim() || developmentDataDir(import.meta.url)));
  if (command === 'owner-recovery') {
    const output = resolve(option('output'));
    const result = await issueOwnerRecovery(dataDir, output);
    console.log(JSON.stringify({ ok: true, command, output, ...result }, null, 2));
    return;
  }
  if (command === 'backup') {
    const output = resolve(option('output'));
    const manifest = await createServerBackup(dataDir, output);
    const recordId = `backup-${stamp()}`;
    // The console only displays this record; it never triggers the procedure itself.
    writeMaintenanceRecord(dataDir, {
      recordId,
      kind: 'manual',
      status: 'completed',
      createdAt: manifest.createdAt,
      finishedAt: new Date().toISOString(),
      outputPath: output,
      serverId: manifest.serverId,
      fileCount: manifest.files.length,
      totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      note: '停服备份：由部署侧维护程序在服务停止后执行并校验。',
    });
    console.log(JSON.stringify({ ok: true, command, output, recordId, createdAt: manifest.createdAt, files: manifest.files.length }, null, 2));
    return;
  }
  if (command === 'verify-backup') {
    const backup = resolve(option('backup'));
    const result = await verifyServerBackup(backup);
    const recordId = option('record-id', '') || `verify-${stamp()}`;
    writeMaintenanceRecord(dataDir, {
      recordId,
      kind: 'manual',
      status: result.ok ? 'completed' : 'failed',
      createdAt: result.manifest.createdAt,
      finishedAt: new Date().toISOString(),
      outputPath: backup,
      serverId: result.manifest.serverId,
      fileCount: result.manifest.files.length,
      totalBytes: result.manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      verifiedAt: new Date().toISOString(),
      verification: result as unknown as Record<string, unknown>,
      ...(result.ok ? {} : { errorMessage: result.issues.join('；') }),
    });
    console.log(JSON.stringify({ ...result, recordId }, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === 'restore') {
    const backup = resolve(option('backup'));
    const result = await restoreServerBackup(backup, dataDir);
    writeMaintenanceRecord(dataDir, {
      recordId: `restore-${stamp()}`,
      kind: 'manual',
      status: 'completed',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputPath: backup,
      note: `生产恢复已执行；替换前的数据目录保留在 ${result.previousDataDir ?? '（无）'}`,
    });
    console.log(JSON.stringify({ ok: true, command, dataDir, ...result }, null, 2));
    return;
  }
  throw new Error('用法：maintenance <backup|verify-backup|restore|owner-recovery> [--data-dir PATH] [--output PATH|--backup PATH] [--record-id ID]');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
