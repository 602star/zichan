import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createServerBackup, verifyServerBackup } from '../src/backup.js';
import { EncryptedBlobStore } from '../src/blob-store.js';
import { createHashOffload } from '../src/hash-offload.js';
import { SyncServerStore } from '../src/store.js';

/**
 * The acceptance test for heavy-task isolation.
 *
 * The event-loop metric already exists and is the stated acceptance basis, so it is the instrument
 * used here rather than a proxy. Two things are deliberately *not* asserted:
 *
 * - **How long an inline hash takes.** That is machine speed, not behaviour: the same 128 MiB
 *   measured 18 ms on one run and 88 ms on another here. A test asserting "inline blocks for over
 *   50 ms" would pass or fail depending on the host, so instead the instrument's own validity is
 *   proven with a *deliberate* 300 ms stall, which takes 300 ms everywhere.
 * - **That offloading is faster.** It is not, and cannot be — the same bytes are hashed. The claim
 *   is that the loop keeps running, which is what the product actually needs.
 *
 * `measureLoopStall` uses a fresh histogram per measurement rather than `reset()`. Resetting and
 * then blocking immediately discards the sample, and the reading comes back at the timer
 * granularity no matter how badly the loop was blocked — a trap that makes a blocking
 * implementation look fine, so the "instrument can see a stall" test below guards against it.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The alert threshold the console uses; verification must not trip it. */
const WARN_THRESHOLD_MS = 50;

/**
 * Measures the worst event-loop delay while `run` executes.
 *
 * A **fresh histogram per measurement**, deliberately not `reset()`. Resetting and then blocking
 * immediately loses the sample entirely — the reading comes back at the timer granularity (~16 ms
 * here) no matter how long the loop was blocked, which is exactly the trap that made a blocking
 * implementation look fine during development. Creating a new monitor and letting it take a short
 * baseline avoids the problem: the baseline is ~16 ms and any real stall is larger, so the maximum
 * is the stall.
 */
async function measureLoopStall(run: () => Promise<unknown>): Promise<number> {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  // Baseline first, so the reading is the work and not process start-up.
  await sleep(150);
  await run();
  // Yield so the timer fires and records the delay the work caused.
  await sleep(150);
  const maxMs = Number((histogram.max / 1e6).toFixed(1));
  histogram.disable();
  return maxMs;
}

describe('verification keeps the event loop responsive', () => {
  it('the instrument can see a stall at all', async () => {
    // A deliberate block of known duration. If this does not register, every other reading in this
    // file is meaningless — which is exactly the failure mode that made a blocking implementation
    // look fine during development.
    const stall = await measureLoopStall(async () => {
      const started = Date.now();
      while (Date.now() - started < 300) { /* deliberate synchronous block */ }
    });
    expect(stall).toBeGreaterThan(200);
  }, 60_000);

  it('hashes a large file off-thread without tripping the event-loop warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-loop-'));
    const offload = createHashOffload({ thresholdBytes: 1024, workers: 1 });
    try {
      const path = join(dir, 'large.bin');
      const payload = Buffer.alloc(128 * 1024 * 1024, 11);
      writeFileSync(path, payload);
      const expected = createHash('sha256').update(payload).digest('hex');

      const offloadedStall = await measureLoopStall(() => offload.sha256File(path));
      // The product requirement: a verification running in the background must not make the console
      // report that the server is struggling to serve requests.
      expect(offloadedStall).toBeLessThan(WARN_THRESHOLD_MS);
      // Same answer as an inline hash; only the thread changed.
      expect(await offload.sha256File(path)).toBe(expected);
      expect(offload.stats().offloaded).toBe(2);
    } finally {
      await offload.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('verifies a real object store through the injected hasher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zichan-verify-blobs-'));
    const offload = createHashOffload({ thresholdBytes: 1024, workers: 1 });
    try {
      const store = new EncryptedBlobStore({ dataDir: dir, maxBlobBytes: 256 * 1024 * 1024 });
      await store.ready;
      try {
        // Build a real upload through the store's own API, so the manifest and the chunk layout are
        // the ones verification will actually meet. Chunks are capped at 4 MiB by the store.
        const payloads = [Buffer.alloc(4 * 1024 * 1024, 1), Buffer.alloc(4 * 1024 * 1024, 2)];
        const manifest = {
          v: 1,
          blobId: 'a'.repeat(64),
          cipherBytes: payloads.reduce((total, payload) => total + payload.byteLength, 0),
          chunkCount: payloads.length,
          chunks: payloads.map((payload, index) => ({
            index,
            sizeBytes: payload.byteLength,
            ciphertextSha256: createHash('sha256').update(payload).digest('hex'),
            iv: 'AAECAwQFBgcICQoL',
          })),
        };
        const plan = await store.beginUpload('owner', 'ledger-1', manifest);
        for (const [index, payload] of payloads.entries()) {
          await store.putChunk('owner', plan.uploadId, index, payload);
        }
        await store.completeUpload('owner', plan.uploadId);

        const result = await store.verify({ hashChunk: (path) => offload.sha256File(path), batchSize: 25 });
        expect(result.issues).toEqual([]);
        expect(result.checkedObjects).toBe(1);
        expect(result.checkedChunks).toBe(payloads.length);
        // The verification really used the injected hasher rather than the inline default. Without
        // this assertion the test would pass even if `hashChunk` were ignored entirely.
        expect(offload.stats().offloaded).toBe(payloads.length);
      } finally { await store.close(); }
    } finally {
      await offload.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('verifies a real backup through the injected hasher', async () => {
    const data = mkdtempSync(join(tmpdir(), 'zichan-verify-data-'));
    const root = mkdtempSync(join(tmpdir(), 'zichan-verify-backup-'));
    const offload = createHashOffload({ thresholdBytes: 1024, workers: 1 });
    try {
      // A real backup, produced by the same code path the deployment uses, so the manifest and the
      // file layout are the ones verification will actually meet.
      writeFileSync(join(data, 'server-id'), 'srv-verify\n', 'utf8');
      writeFileSync(join(data, 'server.secret'), 'a'.repeat(64), 'utf8');
      writeFileSync(join(data, 'opaque.server-setup'), 'b'.repeat(64), 'utf8');
      const store = new SyncServerStore(join(data, 'server.sqlite'), 'invite', 'srv-verify');
      await store.ready;
      await store.close();
      const backupDir = join(root, 'backup');
      await createServerBackup(data, backupDir);

      const verification = await verifyServerBackup(backupDir, { hashFile: (path) => offload.sha256File(path) });
      expect(verification.ok).toBe(true);
      expect(verification.checkedFiles).toBeGreaterThan(0);
      // The injected hasher was really used rather than the inline default; without this the test
      // would pass even if `hashFile` were ignored entirely, which is the regression that matters.
      expect(offload.stats().offloaded).toBeGreaterThan(0);
      // A corrupted copy must still be rejected through the injected hasher, or the offload would
      // have quietly turned verification into a check that always passes.
      writeFileSync(join(backupDir, 'server.secret'), 'tampered'.padEnd(64, 'x'), 'utf8');
      const tampered = await verifyServerBackup(backupDir, { hashFile: (path) => offload.sha256File(path) });
      expect(tampered.ok).toBe(false);
      expect(tampered.issues.join(' ')).toContain('校验和不符');
    } finally {
      await offload.close();
      rmSync(data, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
