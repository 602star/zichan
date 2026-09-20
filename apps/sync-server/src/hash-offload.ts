/**
 * SHA-256 off the main thread.
 *
 * The server is single-threaded, and hashing runs on it: backup verification reads whole files, and
 * attachment verification hashes every chunk of an object without yielding in between (chunks are
 * capped at 4 MiB, up to 512 per object). Measured on this machine, hashing 128 MiB takes ~89 ms
 * inline — nearly two ticks of the 50 ms event-loop warning threshold, i.e. a window in which
 * logins and syncs are not being served. That is exactly what the event-loop metric exists to show.
 *
 * Measured, rather than assumed: at 4 MiB a hash costs ~2.6 ms inline and ~2.7 ms through the
 * worker. **The worker is not faster in wall-clock** — it cannot be, the same bytes are hashed.
 * What changes is *where*: the main thread stays free to answer requests while the worker hashes.
 * So the threshold exists to avoid paying the round-trip on inputs too small to matter, not to
 * chase throughput.
 *
 * The worker source is passed with `eval` rather than shipped as a second file. The build bundles
 * `src/main.ts` into a single `dist/server.mjs`, and a separate worker file would have to be
 * emitted and located at runtime; an inline source keeps working wherever the bundle is copied.
 */
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

/**
 * Below this, hashing inline is cheaper than the round-trip.
 *
 * 1 MiB measures ~0.7 ms either way, so anything around there is a wash; the value is set at 2 MiB
 * to sit clearly above the noise where the round-trip starts to lose, while still offloading every
 * input large enough to block the loop for a meaningful fraction of a tick.
 */
export const DEFAULT_OFFLOAD_THRESHOLD_BYTES = 2 * 1024 * 1024;

/**
 * Whether to hand this input to a worker.
 *
 * Extracted so the decision is testable without spawning anything, and so the caller's intent is
 * visible at the call site rather than buried in a condition.
 */
export function shouldOffload(bytes: number, thresholdBytes: number = DEFAULT_OFFLOAD_THRESHOLD_BYTES): boolean {
  return Number.isFinite(bytes) && bytes >= thresholdBytes;
}

/** The worker body. Kept as a string so it needs no separate build artifact. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

parentPort.on('message', (job) => {
  try {
    const buffer = job.path === undefined ? Buffer.from(job.bytes) : readFileSync(job.path);
    parentPort.postMessage({ id: job.id, bytes: buffer.byteLength, sha256: createHash('sha256').update(buffer).digest('hex') });
  } catch (error) {
    parentPort.postMessage({ id: job.id, error: error && error.message ? error.message : String(error) });
  }
});
`;

interface PendingJob {
  id: number;
  path?: string;
  bytes?: Uint8Array;
  resolve: (digest: string) => void;
  reject: (error: Error) => void;
}

export interface HashOffload {
  /** Hashes a file, off the main thread when it is large enough to be worth the round-trip. */
  sha256File: (path: string) => Promise<string>;
  /** Hashes a buffer, with the same threshold rule. */
  sha256Bytes: (bytes: Uint8Array) => Promise<string>;
  /** Observable counts, so a test can prove work actually went to a worker. */
  stats: () => { offloaded: number; inline: number; queued: number; workers: number };
  close: () => Promise<void>;
}

export function createHashOffload(options: { thresholdBytes?: number; workers?: number; workerSource?: string } = {}): HashOffload {
  const thresholdBytes = options.thresholdBytes ?? DEFAULT_OFFLOAD_THRESHOLD_BYTES;
  // The source is injectable only so the crash path is reachable from a test: a worker that dies
  // must reject its job rather than leave the caller awaiting forever, and there is no other way to
  // make a worker die on demand.
  const workerSource = options.workerSource ?? WORKER_SOURCE;
  // One worker is enough to unblock the loop; a second helps when a verification and a backup
  // check overlap. Bounded deliberately: each worker is a real thread with its own heap, and a
  // pool sized to the machine would turn a slow verification into a memory problem.
  const workerCount = Math.max(1, Math.min(options.workers ?? 2, Math.max(1, availableParallelism() - 1)));
  const workers = new Set<Worker>();
  const queue: PendingJob[] = [];
  const idle: Worker[] = [];
  const inFlight = new Map<Worker, PendingJob>();
  let nextId = 1;
  let offloaded = 0;
  let inline = 0;
  let closed = false;

  const retire = (worker: Worker): void => {
    workers.delete(worker);
    const idleIndex = idle.indexOf(worker);
    if (idleIndex >= 0) idle.splice(idleIndex, 1);
  };

  const spawn = (): void => {
    const worker = new Worker(workerSource, { eval: true });
    worker.unref?.();
    worker.on('message', (message: { id: number; sha256?: string; error?: string }) => {
      const job = inFlight.get(worker);
      if (!job || job.id !== message.id) return;
      inFlight.delete(worker);
      if (message.error) job.reject(new Error(`哈希计算失败：${message.error}`));
      else if (typeof message.sha256 === 'string') job.resolve(message.sha256);
      else job.reject(new Error('哈希计算返回了无法识别的结果'));
      if (workers.has(worker)) idle.push(worker);
      pump();
    });
    worker.on('error', (error) => {
      // A dead worker must fail its job rather than leave the caller awaiting forever: a
      // verification that never finishes is worse than one that reports it could not run.
      const job = inFlight.get(worker);
      inFlight.delete(worker);
      retire(worker);
      if (job) job.reject(error instanceof Error ? error : new Error(String(error)));
      // Replace it, so one crash does not silently downgrade every later hash to the main thread.
      if (!closed && workers.size < workerCount) spawn();
      pump();
    });
    workers.add(worker);
    idle.push(worker);
  };

  const pump = (): void => {
    if (closed) return;
    while (queue.length && idle.length) {
      const worker = idle.pop()!;
      const job = queue.shift()!;
      inFlight.set(worker, job);
      offloaded += 1;
      worker.postMessage(job.path === undefined ? { id: job.id, bytes: job.bytes } : { id: job.id, path: job.path });
    }
  };

  const offload = (job: { path?: string; bytes?: Uint8Array }): Promise<string> => {
    if (closed) return Promise.reject(new Error('哈希服务已关闭'));
    return new Promise<string>((resolve, reject) => {
      queue.push({ ...job, id: nextId++, resolve, reject });
      if (!workers.size) spawn();
      pump();
    });
  };

  for (let index = 0; index < workerCount; index += 1) spawn();

  return {
    async sha256File(path: string): Promise<string> {
      // A missing file is the caller's to interpret (the verifier reports it as an issue), so it
      // is not turned into a hash failure here.
      const size = statSync(path).size;
      if (!shouldOffload(size, thresholdBytes)) {
        inline += 1;
        return createHash('sha256').update(readFileSync(path)).digest('hex');
      }
      return offload({ path });
    },
    async sha256Bytes(bytes: Uint8Array): Promise<string> {
      if (!shouldOffload(bytes.byteLength, thresholdBytes)) {
        inline += 1;
        return createHash('sha256').update(bytes).digest('hex');
      }
      return offload({ bytes });
    },
    stats: () => ({ offloaded, inline, queued: queue.length, workers: workers.size }),
    async close(): Promise<void> {
      closed = true;
      const pending = [...queue];
      queue.length = 0;
      for (const job of pending) job.reject(new Error('哈希服务已关闭'));
      const live = [...workers];
      workers.clear();
      idle.length = 0;
      inFlight.clear();
      await Promise.all(live.map((worker) => worker.terminate().catch(() => undefined)));
    },
  };
}
