/**
 * Job handlers. Each one works on a bounded, predefined task: no shell command,
 * no caller-supplied path, and no operation that would have to stop the server first.
 */
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NodeSqliteDriver } from '@zichan/db/node';
import { restoreServerBackup, verifyServerBackup } from './backup.js';
import type { EncryptedBlobStore } from './blob-store.js';
import type { JobContext } from './jobs.js';
import type { HashOffload } from './hash-offload.js';
import type { SettingsReader } from './settings.js';
import { ServerStoreError, SyncServerStore, type AdminJobType, type JsonRecord, type ServerLogLevel } from './store.js';

export interface JobHandlerDeps {
  store: SyncServerStore;
  blobStore: EncryptedBlobStore;
  dataDir: string;
  settings: SettingsReader;
  /** Hashes large files off the main thread; verification would otherwise block the loop. */
  hashOffload: HashOffload;
  log: (level: ServerLogLevel, action: string, message: string, meta?: Record<string, unknown>) => Promise<void>;
}

export function createJobHandlers(deps: JobHandlerDeps): Partial<Record<AdminJobType, (context: JobContext) => Promise<JsonRecord>>> {
  const { store, blobStore, dataDir, settings } = deps;

  const requireRecord = async (job: JobContext) => {
    const recordId = typeof job.job.params['recordId'] === 'string' ? job.job.params['recordId'] : '';
    const record = await store.getBackupRecord(recordId);
    if (!record) throw new ServerStoreError('BACKUP_RECORD_NOT_FOUND', 404, '未登记该备份记录');
    if (!record.outputPath) throw new ServerStoreError('BACKUP_PATH_MISSING', 409, '该记录没有可校验的备份路径');
    return record;
  };

  return {
    'database.integrity-check': async (job) => {
      await job.progress({ phase: 'integrity-check' });
      await job.note('info', '开始深度完整性校验（PRAGMA integrity_check）');
      const result = await store.integrityCheck();
      await store.setMaintenanceState('verification:database', result as unknown as JsonRecord);
      await job.note(result.ok ? 'info' : 'error', result.ok ? '数据库完整性校验通过' : `数据库完整性校验失败：${result.result}`);
      return result as unknown as JsonRecord;
    },

    /**
     * `ANALYZE` refreshes the statistics the query planner uses. Without it, the indexes this
     * schema relies on are chosen on stale estimates as the tables grow. It is a task rather
     * than something the sampling loop does, because it rewrites `sqlite_stat1` every time.
     */
    'database.analyze': async (job) => {
      await job.progress({ phase: 'analyzing' });
      await job.note('info', '开始重建查询计划统计（ANALYZE）');
      const result = await store.analyze();
      await job.note(result.tables > 0 ? 'info' : 'warn', result.tables > 0
        ? `统计已重建：${result.tables} 个表的统计信息，用时 ${result.durationMs} 毫秒`
        : '统计未生成：数据库中没有可分析的表或索引');
      return result as unknown as JsonRecord;
    },

    'blobs.verify': async (job) => {
      const accountId = typeof job.job.params['accountId'] === 'string' ? job.job.params['accountId'] : undefined;
      const account = accountId ? await store.userByAccountId(accountId) : undefined;
      if (accountId && !account) throw new ServerStoreError('NOT_FOUND', 404, '账号不存在');
      const resumeFrom = typeof job.job.params['resumeFrom'] === 'string' ? job.job.params['resumeFrom'] : undefined;
      await job.progress({ phase: 'scanning', processed: 0 });
      // The checkpoint is written at batch boundaries, so a restart resumes after the last
      // verified object instead of rescanning everything or losing the progress report.
      let lastCheckpointAt = 0;
      const result = await blobStore.verify({
        ...(resumeFrom ? { resumeFrom } : {}),
        ...(account ? { username: account.username } : {}),
        batchSize: 25,
        // Hashing happens off the main thread for chunks large enough to matter: without this the
        // loop is blocked for the length of the object, which is exactly what the event-loop
        // metric exists to catch.
        hashChunk: (path) => deps.hashOffload.sha256File(path),
        onProgress: async (progress) => {
          await job.progress({ phase: 'scanning', processed: progress.processed, total: progress.total });
          const at = Date.now();
          if (!progress.lastKey || at - lastCheckpointAt < 1_000) return;
          lastCheckpointAt = at;
          await job.checkpoint({ lastKey: progress.lastKey, processed: progress.processed, total: progress.total, checkpointAt: new Date(at).toISOString() });
        },
        shouldCancel: () => job.cancelled(),
      });
      const summary: JsonRecord = {
        checkedObjects: result.checkedObjects,
        checkedChunks: result.checkedChunks,
        issueCount: result.issues.length,
        issues: result.issues.slice(0, 50) as unknown as JsonRecord[],
        cancelled: result.cancelled === true,
        ...(result.lastKey ? { lastKey: result.lastKey } : {}),
        scope: account ? account.username : 'all',
      };
      await store.setMaintenanceState('verification:blobs', summary);
      await job.note(
        result.issues.length ? 'error' : 'info',
        `附件校验完成：${result.checkedObjects} 个对象、${result.checkedChunks} 个分块、${result.issues.length} 个问题`,
      );
      return summary;
    },

    'storage.cleanup': async (job) => {
      await job.progress({ phase: 'cleanup' });
      const status = await blobStore.runCleanup();
      await job.note(status.lastOk ? 'info' : 'error', status.lastOk
        ? `清理完成：移除 ${status.lastRemovedObjects} 个回收对象、${status.lastRemovedUploads} 个暂存上传，释放 ${status.lastFreedBytes} 字节`
        : `清理失败：${status.lastError ?? '未知错误'}`);
      return status as unknown as JsonRecord;
    },

    'logs.prune': async (job) => {
      const retention = Number(settings.effective('logRetention'));
      await job.progress({ phase: 'pruning' });
      const result = await store.pruneLogs(retention);
      await job.note('info', `运行日志裁剪完成，保留 ${retention} 条，移除 ${result.removed} 条`);
      return { removed: result.removed, retention };
    },

    'metrics.prune': async (job) => {
      await job.progress({ phase: 'pruning' });
      const metrics = await store.pruneMetrics(new Date(), Number(settings.effective('metricsMinuteRetentionDays')),
        Number(settings.effective('metricsHourRetentionDays')));
      const events = await store.pruneSyncEvents(Number(settings.effective('syncEventRetention')));
      await job.note('info', `指标与诊断事件裁剪完成：指标 ${metrics.removed} 条、诊断事件 ${events.removed} 条`);
      return { metricsRemoved: metrics.removed, syncEventsRemoved: events.removed };
    },

    /**
     * Audit retention is its own task rather than part of `metrics.prune`, because the audit
     * trail is the record an operator may need to keep longest: running it separately keeps a
     * routine metrics trim from being the thing that shortened it.
     */
    'audit.prune': async (job) => {
      const auditRetention = Number(settings.effective('auditRetention'));
      const failureRetention = Number(settings.effective('auditFailureRetention'));
      await job.progress({ phase: 'pruning' });
      const audit = await store.pruneAdminAudit(auditRetention);
      const failures = await store.pruneAdminFailures(failureRetention);
      await job.note('info', `管理审计裁剪完成：审计 ${audit.removed} 条（保留 ${auditRetention}）、失败尝试 ${failures.removed} 条（保留 ${failureRetention}）`);
      return { auditRemoved: audit.removed, failuresRemoved: failures.removed, auditRetention, failureRetention };
    },

    'backup.verify': async (job) => {
      const record = await requireRecord(job);
      await job.progress({ phase: 'verifying' });
      // A backup holds the database plus every attachment, so this walks whole files: the largest
      // single blocking read in the console. It is hashed off the main thread for that reason.
      const verification = await verifyServerBackup(record.outputPath!, { hashFile: (path) => deps.hashOffload.sha256File(path) });
      await store.upsertBackupRecord({
        ...record,
        verifiedAt: new Date().toISOString(),
        verification: verification as unknown as JsonRecord,
      });
      await job.note(verification.ok ? 'info' : 'error', verification.ok
        ? `备份校验通过：${verification.checkedFiles} 个文件，数据库 ${verification.databaseResult}`
        : `备份校验失败：${verification.issues.join('；')}`);
      return verification as unknown as JsonRecord;
    },

    'restore.drill': async (job) => {
      const record = await requireRecord(job);
      const drillsRoot = join(dataDir, 'drills');
      const drillDir = join(drillsRoot, record.recordId);
      rmSync(drillDir, { recursive: true, force: true });
      mkdirSync(drillsRoot, { recursive: true });
      await job.progress({ phase: 'restoring' });
      await job.note('info', '在隔离目录执行恢复；不会替换生产数据目录', { drillDir });
      try {
        await restoreServerBackup(record.outputPath!, drillDir);
        await job.progress({ phase: 'inspecting' });
        const databaseFile = join(drillDir, 'server.sqlite');
        const driver = new NodeSqliteDriver(databaseFile);
        let activeSessions = 0;
        let pendingResets = 0;
        let pendingLogins = 0;
        let serverId = '';
        try {
          activeSessions = Number((await driver.get<{ value: number }>(
            "SELECT COUNT(*) AS value FROM sync_sessions WHERE revoked_at IS NULL AND expires_at > ?",
            [new Date().toISOString()],
          ))?.value ?? 0);
          pendingResets = Number((await driver.get<{ value: number }>('SELECT COUNT(*) AS value FROM account_password_resets'))?.value ?? 0);
          pendingLogins = Number((await driver.get<{ value: number }>('SELECT COUNT(*) AS value FROM sync_opaque_login_states'))?.value ?? 0);
        } finally {
          await driver.close();
        }
        if (existsSync(join(drillDir, 'server-id'))) serverId = readFileSync(join(drillDir, 'server-id'), 'utf8').trim();
        await job.progress({ phase: 'starting' });
        // Opening the restored copy with the real store proves the server can load it.
        const restored = new SyncServerStore(databaseFile, 'closed', serverId);
        let probe: JsonRecord;
        try {
          probe = await restored.probe() as unknown as JsonRecord;
        } finally {
          await restored.close();
        }
        const result: JsonRecord = {
          recordId: record.recordId,
          ok: activeSessions === 0 && pendingResets === 0 && pendingLogins === 0 && probe['ok'] === true,
          checkedAt: new Date().toISOString(),
          serverId,
          activeSessions,
          pendingResets,
          pendingLogins,
          schemaVersion: Number(probe['schemaVersion'] ?? 0),
          notes: '恢复库可被服务器存储层打开；旧会话与未消费恢复凭据未复活',
        };
        const updated = await store.getBackupRecord(record.recordId);
        await store.upsertBackupRecord({ ...(updated ?? record), drill: result });
        await job.note(result.ok ? 'info' : 'error', result.ok ? '恢复演练通过' : '恢复演练发现异常', result);
        return result;
      } finally {
        rmSync(drillDir, { recursive: true, force: true });
      }
    },
  };
}
