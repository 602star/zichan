import { resolve } from 'node:path';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from './backup.js';
import { applyBackupRetention } from './backup-retention.js';
import { developmentDataDir } from './runtime-config.js';
import { issueOwnerRecovery } from './owner-recovery.js';
import { writeMaintenanceRecord } from './maintenance-records.js';
import { inspectNodeRetirement, retireNodeData } from './retire-node.js';
import { inspectLocalReplicaRetirement, retireLocalReplica } from './retire-local-replica.js';

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value && !value.startsWith('--')) return value;
  if (fallback) return fallback;
  throw new Error(`缺少 --${name}`);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
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
  if (command === 'prune-backups') {
    const backupRoot = resolve(option('backup-dir'));
    const keep = Number(option('keep', '3'));
    const dryRun = flag('dry-run');
    const result = await applyBackupRetention(backupRoot, keep, { dryRun });
    // The console shows the outcome; it never runs retention itself, because deleting backups
    // is a deployment-side decision about files the service does not own.
    writeMaintenanceRecord(dataDir, {
      recordId: `prune-${stamp()}`,
      kind: 'manual',
      status: 'completed',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputPath: backupRoot,
      note: dryRun
        ? `备份保留预演（未删除）：保留 ${String(keep)} 份，可清理 ${String(result.removable.length)} 份。`
        : `备份保留：保留 ${String(keep)} 份，已清理 ${String(result.removed.length)} 份，释放 ${String(result.freedBytes)} 字节。`,
      retention: {
        keep,
        dryRun,
        removed: result.removed,
        freedBytes: result.freedBytes,
        retained: result.retained.map((entry) => entry.recordId),
        unverified: result.unverified,
        skipped: result.skipped,
        // Reported explicitly: these are the backups a retention run refused to touch.
        unverifiedCount: result.unverified.length,
      },
    });
    console.log(JSON.stringify({ ok: true, command, backupRoot, keep, dryRun, removed: result.removed.length, freedBytes: result.freedBytes, unverified: result.unverified.length }, null, 2));
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
  if (command === 'retire-node') {
    // This command removes the complete data directory; never accept the development default.
    const explicitDataDir = resolve(option('data-dir'));
    if (flag('dry-run')) {
      const inspection = await inspectNodeRetirement(explicitDataDir);
      console.log(JSON.stringify({ ok: true, command, dryRun: true, ...inspection,
        eligible: inspection.ledgerIds.length <= 1 && inspection.replicaIds.length <= 1 }, null, 2));
      return;
    }
    const output = resolve(option('output'));
    const confirmedNodeId = option('confirm-node-id');
    const result = await retireNodeData(explicitDataDir, output, confirmedNodeId);
    console.log(JSON.stringify({ ok: true, command, dryRun: false, ...result,
      note: '指定节点数据目录已清理；独立备份和其他副本不在本命令清理范围内。' }, null, 2));
    return;
  }
  if (command === 'retire-local-replica') {
    const explicitDataDir = resolve(option('data-dir'));
    const replicaId = option('replica-id');
    if (flag('dry-run')) {
      const inspection = await inspectLocalReplicaRetirement(explicitDataDir, replicaId);
      console.log(JSON.stringify({ ok: true, command, dryRun: true, ...inspection,
        eligible: inspection.issues.length === 0 }, null, 2));
      return;
    }
    const result = await retireLocalReplica(explicitDataDir, replicaId, resolve(option('output')),
      option('confirm-node-id'), option('confirm-ledger-id'));
    console.log(JSON.stringify({ ok: true, command, dryRun: false, ...result,
      note: '指定账本副本已从此节点清理；其他账本、账号与独立备份保留。' }, null, 2));
    return;
  }
  throw new Error('用法：maintenance <backup|verify-backup|prune-backups|restore|owner-recovery|retire-node|retire-local-replica> [--data-dir PATH] [--output PATH|--backup PATH] [--replica-id ID] [--confirm-node-id ID --confirm-ledger-id ID] [--backup-dir PATH --keep N [--dry-run]] [--vacuum] [--record-id ID]');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
