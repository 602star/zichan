/**
 * Maintenance job execution.
 *
 * Long work leaves the request path: HTTP only creates a job and reads progress.
 * A single worker runs heavy jobs, batches its work between event-loop turns, and
 * only observes cancellation at safe boundaries instead of killing a transaction.
 */
import {
  ServerStoreError,
  type AdminJob,
  type AdminJobType,
  type JsonRecord,
  type ServerLogLevel,
  type SyncServerStore,
} from './store.js';

export interface JobContext {
  job: AdminJob;
  /** Reports a batch boundary; also the point where cancellation is observed. */
  progress: (patch: { phase?: string; processed?: number; total?: number }) => Promise<void>;
  note: (level: ServerLogLevel, message: string, detail?: JsonRecord) => Promise<void>;
  cancelled: () => Promise<boolean>;
  /** Yields to the event loop so HTTP requests stay responsive during a scan. */
  yieldToLoop: () => Promise<void>;
}

export interface JobRunnerDeps {
  store: SyncServerStore;
  log: (level: ServerLogLevel, action: string, message: string, meta?: Record<string, unknown>) => Promise<void>;
  handlers: Partial<Record<AdminJobType, (context: JobContext) => Promise<JsonRecord>>>;
}

export const JOB_TYPES: AdminJobType[] = [
  'database.integrity-check',
  'blobs.verify',
  'storage.cleanup',
  'logs.prune',
  'metrics.prune',
  'backup.verify',
  'restore.drill',
];

export function isJobType(value: unknown): value is AdminJobType {
  return typeof value === 'string' && (JOB_TYPES as string[]).includes(value);
}

/** Task parameters are a closed set: no shell command and no arbitrary path is accepted. */
export function jobParamsFor(type: AdminJobType, raw: unknown): JsonRecord {
  if (type === 'backup.verify' || type === 'restore.drill') {
    const recordId = typeof raw === 'object' && raw !== null ? (raw as { recordId?: unknown }).recordId : undefined;
    if (typeof recordId !== 'string' || !/^[A-Za-z0-9._-]{4,128}$/.test(recordId)) {
      throw new ServerStoreError('JOB_PARAMETER_INVALID', 400, '该任务需要一个已登记的备份记录 ID');
    }
    return { recordId };
  }
  if (type === 'blobs.verify') {
    const accountId = typeof raw === 'object' && raw !== null ? (raw as { accountId?: unknown }).accountId : undefined;
    if (accountId === undefined || accountId === null || accountId === '') return {};
    if (typeof accountId !== 'string' || !/^account-[a-f0-9]{8,64}$/.test(accountId)) {
      throw new ServerStoreError('JOB_PARAMETER_INVALID', 400, '附件校验的账号参数无效');
    }
    return { accountId };
  }
  return {};
}

export function createJobRunner(deps: JobRunnerDeps) {
  const { store, log, handlers } = deps;
  let draining = false;

  const execute = async (job: AdminJob): Promise<void> => {
    const handler = handlers[job.type];
    if (!handler) {
      await store.finishJob(job.jobId, { status: 'failed', errorCode: 'JOB_TYPE_UNAVAILABLE', errorMessage: `未实现的任务类型：${job.type}` });
      return;
    }
    const context: JobContext = {
      job,
      progress: (patch) => store.updateJobProgress(job.jobId, patch),
      note: async (level, message, detail) => {
        await store.appendJobEvent(job.jobId, level, message, detail);
        await log(level, `job_${job.type.replace(/[.]/g, '_')}`, message, { detail: { ...detail, jobId: job.jobId } });
      },
      cancelled: () => store.jobCancelRequested(job.jobId),
      yieldToLoop: () => new Promise<void>((resolve) => { setImmediate(resolve); }),
    };
    await store.appendJobEvent(job.jobId, 'info', `开始执行 ${job.type}`, { createdBy: job.createdBy });
    try {
      const result = await handler(context);
      const cancelled = await context.cancelled();
      await store.finishJob(job.jobId, {
        status: cancelled ? 'cancelled' : 'succeeded',
        result,
        ...(cancelled ? { errorCode: 'CANCELLED', errorMessage: '任务在安全边界被取消' } : {}),
      });
      await store.appendJobEvent(job.jobId, 'info', cancelled ? '任务已取消' : '任务完成', result);
    } catch (error) {
      const code = error instanceof ServerStoreError ? error.code : 'JOB_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      await store.finishJob(job.jobId, { status: 'failed', errorCode: code, errorMessage: message });
      await store.appendJobEvent(job.jobId, 'error', '任务失败', { code, message });
    }
  };

  /** Runs queued jobs until the queue is empty. Never rejects: failures stay on the job record. */
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const job = await store.claimNextJob();
        if (!job) return;
        await execute(job);
      }
    } finally {
      draining = false;
    }
  };

  return {
    /**
     * A restart marks abandoned jobs as interrupted, and resumes only the job type
     * that keeps a checkpoint.
     */
    async recover(): Promise<{ interrupted: string[]; resumed: string[] }> {
      const result = await store.markInterruptedJobs();
      if (result.interrupted.length) {
        await log('warn', 'jobs_interrupted', '服务重启后发现失去执行者的任务', {
          detail: { interrupted: result.interrupted.length, resumed: result.resumed.length },
        });
      }
      return result;
    },
    kick: (): void => { void drain().catch(() => undefined); },
    drain,
    async runPending(): Promise<number> {
      let executed = 0;
      for (;;) {
        const job = await store.claimNextJob();
        if (!job) return executed;
        await execute(job);
        executed += 1;
      }
    },
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;
