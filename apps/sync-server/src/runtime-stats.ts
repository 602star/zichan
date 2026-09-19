/**
 * Process and runtime resource sampling.
 *
 * These numbers come from what Node itself reports rather than from an OS-specific probe,
 * so the same console works on Windows, Linux and inside a container. Three choices are
 * deliberate:
 *
 * - `external` and `arrayBuffers` are shown next to the heap. Attachment verification reads
 *   whole files and SQLite keeps page cache in native memory: both land outside the V8 heap,
 *   so a healthy `heapUsed` says nothing about whether this process is about to be killed.
 * - Event-loop delay is measured with `monitorEventLoopDelay`, the histogram Node ships for
 *   exactly this purpose. On a single-threaded server it is the only honest signal that a
 *   synchronous scan is blocking request handling.
 * - CPU is a window average, computed from the difference between two readings. A single
 *   `cpuUsage()` reading is a lifetime total and would never fall back down.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

/** Resolution of the event-loop histogram; 10ms matches the default the Node docs suggest. */
const LAG_RESOLUTION_MS = 10;

export interface RuntimeSample {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** Share of one core used since the previous sample; null on the very first sample. */
  cpuPercent: number | null;
  /** Mean event-loop delay in the window; null when the histogram has no samples yet. */
  eventLoopMeanMs: number | null;
  eventLoopMaxMs: number | null;
  eventLoopP99Ms: number | null;
}

export interface RuntimeIdentity {
  pid: number;
  nodeVersion: string;
  uptimeSeconds: number;
  /** V8 heap ceiling; `null` when the runtime does not report one. */
  heapLimitBytes: number | null;
  /** Container memory limit when the runtime can read one, else null. */
  constrainedBytes: number | null;
  /** Memory the OS says is available, else null. */
  availableBytes: number | null;
}

export interface RuntimeStats {
  /** Advances the CPU baseline and resets the lag histogram: call once per sampling tick. */
  sample: () => RuntimeSample;
  /** The most recent sample, without advancing anything. */
  last: () => RuntimeSample | undefined;
  identity: () => RuntimeIdentity;
  stop: () => void;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createRuntimeStats(): RuntimeStats {
  const histogram = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
  histogram.enable();
  let previous: RuntimeSample | undefined;
  let previousCpu: { user: number; system: number; at: number } | undefined;

  const readMemory = () => {
    const usage = process.memoryUsage();
    return {
      rssBytes: Math.max(0, Math.round(usage.rss)),
      heapTotalBytes: Math.max(0, Math.round(usage.heapTotal)),
      heapUsedBytes: Math.max(0, Math.round(usage.heapUsed)),
      externalBytes: Math.max(0, Math.round(usage.external)),
      arrayBuffersBytes: Math.max(0, Math.round(usage.arrayBuffers)),
    };
  };

  /** The histogram accumulates between ticks, so it is read and reset in the same step. */
  const readLag = (): Pick<RuntimeSample, 'eventLoopMeanMs' | 'eventLoopMaxMs' | 'eventLoopP99Ms'> => {
    const count = histogram.count;
    if (!count) return { eventLoopMeanMs: null, eventLoopMaxMs: null, eventLoopP99Ms: null };
    // Histogram values are nanoseconds; the console speaks in milliseconds.
    const toMs = (value: number) => Number((value / 1e6).toFixed(2));
    const reading = {
      eventLoopMeanMs: toMs(histogram.mean),
      eventLoopMaxMs: toMs(histogram.max),
      eventLoopP99Ms: toMs(histogram.percentile(99)),
    };
    histogram.reset();
    return reading;
  };

  const sample = (): RuntimeSample => {
    const memory = readMemory();
    const lag = readLag();
    const cpu = process.cpuUsage();
    const at = Date.now();
    let cpuPercent: number | null = null;
    if (previousCpu) {
      const elapsedMs = at - previousCpu.at;
      if (elapsedMs > 0) {
        const usedMs = (cpu.user - previousCpu.user + (cpu.system - previousCpu.system)) / 1000;
        // Clamped at 0: a counter can appear to move backwards across a clock adjustment.
        cpuPercent = Number((Math.max(0, usedMs / elapsedMs) * 100).toFixed(1));
      }
    }
    previousCpu = { user: cpu.user, system: cpu.system, at };
    previous = { ...memory, ...lag, cpuPercent };
    return previous;
  };

  return {
    sample,
    last: () => previous,
    identity: () => {
      let heapLimitBytes: number | null = null;
      try {
        heapLimitBytes = getHeapStatistics().heap_size_limit;
      } catch {
        // A runtime without v8 statistics still reports memory; the ceiling is simply unknown.
      }
      return {
        pid: process.pid,
        nodeVersion: process.version,
        uptimeSeconds: Math.max(0, Math.round(process.uptime())),
        heapLimitBytes: optionalNumber(heapLimitBytes),
        // Both are Node ≥ 20 APIs and return 0 when no limit is known.
        constrainedBytes: optionalNumber(process.constrainedMemory?.()) || null,
        availableBytes: optionalNumber(process.availableMemory?.()) || null,
      };
    },
    stop: () => { histogram.disable(); },
  };
}
