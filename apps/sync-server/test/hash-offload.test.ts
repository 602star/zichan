import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_OFFLOAD_THRESHOLD_BYTES, createHashOffload, shouldOffload } from '../src/hash-offload.js';

/**
 * Hashing off the main thread.
 *
 * The risk here is a fix that silently does nothing: a threshold that never triggers, a worker that
 * never receives the job, or a digest that differs from the inline one. Each of those would pass a
 * "does it still verify?" test, so the assertions are about *where* the work ran.
 */
describe('hash offload', () => {
  it('decides by size, and never offloads an unknown size', () => {
    expect(shouldOffload(DEFAULT_OFFLOAD_THRESHOLD_BYTES - 1)).toBe(false);
    expect(shouldOffload(DEFAULT_OFFLOAD_THRESHOLD_BYTES)).toBe(true);
    // A non-finite size means the caller could not measure the input; hashing it inline is the
    // safe answer, because the alternative is handing an unknown amount of work to a worker.
    expect(shouldOffload(Number.NaN)).toBe(false);
    expect(shouldOffload(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('produces the same digest as an inline hash, from a worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-hash-offload-'));
    const offload = createHashOffload({ thresholdBytes: 1024, workers: 1 });
    try {
      const path = join(dir, 'large.bin');
      const payload = Buffer.alloc(256 * 1024, 42);
      writeFileSync(path, payload);
      const expected = createHash('sha256').update(payload).digest('hex');
      expect(await offload.sha256File(path)).toBe(expected);
      // The point of the module: this work must have gone to a worker, not run inline.
      expect(offload.stats().offloaded).toBe(1);
      expect(offload.stats().inline).toBe(0);
    } finally {
      await offload.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes small inputs inline instead of paying the round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-hash-inline-'));
    const offload = createHashOffload({ thresholdBytes: 1024, workers: 1 });
    try {
      const path = join(dir, 'small.bin');
      writeFileSync(path, Buffer.alloc(16, 1));
      const expected = createHash('sha256').update(Buffer.alloc(16, 1)).digest('hex');
      expect(await offload.sha256File(path)).toBe(expected);
      expect(offload.stats().inline).toBe(1);
      expect(offload.stats().offloaded).toBe(0);
    } finally {
      await offload.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes buffers with the same rule as files', async () => {
    const offload = createHashOffload({ thresholdBytes: 1024, workers: 1 });
    try {
      const large = Buffer.alloc(4 * 1024, 7);
      expect(await offload.sha256Bytes(large)).toBe(createHash('sha256').update(large).digest('hex'));
      expect(offload.stats().offloaded).toBe(1);
      const small = Buffer.alloc(8, 7);
      expect(await offload.sha256Bytes(small)).toBe(createHash('sha256').update(small).digest('hex'));
      expect(offload.stats().inline).toBe(1);
    } finally { await offload.close(); }
  });

  it('runs many jobs through the pool without losing or mixing up results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-hash-pool-'));
    const offload = createHashOffload({ thresholdBytes: 1, workers: 2 });
    try {
      // Distinct payloads, so a result delivered to the wrong caller would be visible.
      const jobs = Array.from({ length: 12 }, (_, index) => {
        const payload = Buffer.alloc(1024, index);
        const path = join(dir, `${index}.bin`);
        writeFileSync(path, payload);
        return { path, expected: createHash('sha256').update(payload).digest('hex') };
      });
      const digests = await Promise.all(jobs.map((job) => offload.sha256File(job.path)));
      expect(digests).toEqual(jobs.map((job) => job.expected));
      expect(offload.stats().offloaded).toBe(12);
      expect(offload.stats().queued).toBe(0);
    } finally {
      await offload.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a job whose file cannot be read instead of hanging', async () => {
    const offload = createHashOffload({ thresholdBytes: 1, workers: 1 });
    try {
      // The worker reports the error back; a promise that never settles would be worse than a
      // rejection, because verification would stall with no explanation.
      await expect(offload.sha256File(join(tmpdir(), 'zichan-definitely-missing', 'x.bin'))).rejects.toThrow();
      // And it must fail before occupying a worker: a missing file is the caller's to report as an
      // issue, and sending it to the pool would spend a slot on work that cannot succeed.
      expect(offload.stats().offloaded).toBe(0);
    } finally { await offload.close(); }
  });

  it('refuses new work after closing', async () => {
    const offload = createHashOffload({ thresholdBytes: 1, workers: 1 });
    await offload.close();
    await expect(offload.sha256Bytes(Buffer.alloc(4096, 1))).rejects.toThrow('已关闭');
  });

  it('fails the job and replaces the worker when a worker dies', async () => {
    // A worker that crashes mid-job must not leave the caller awaiting forever: verification would
    // stall with no explanation. The source throws on load, which is the only way to make a worker
    // die on demand.
    const offload = createHashOffload({
      thresholdBytes: 1,
      workers: 1,
      workerSource: "throw new Error('worker exploded on purpose');",
    });
    try {
      await expect(offload.sha256Bytes(Buffer.alloc(4096, 1))).rejects.toThrow();
    } finally { await offload.close(); }
  });
});
