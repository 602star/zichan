import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STARTUP_TIMING_KEY,
  finishStartupTiming,
  measureStartupStage,
  recordStartupCount,
  recordStartupTiming,
  startStartupTiming,
} from '../src/startup-timing.js';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
  vi.restoreAllMocks();
});

describe('first-open timing diagnostics', () => {
  it('stores only stage durations and aggregate counts without delaying failures', async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    startStartupTiming();
    recordStartupTiming('remote.commit.pull', 2.4);
    recordStartupTiming('remote.commit.pull', 3.6);
    recordStartupCount('remote.commitsPulled', 19);
    await expect(measureStartupStage('remote.import', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    finishStartupTiming();
    recordStartupTiming('remote.commit.pull', 30);
    recordStartupTiming('background.reconcileAttachments', 5);
    const report = JSON.parse(values.get(STARTUP_TIMING_KEY)!) as {
      totalMs: number;
      stages: { name: string; durationMs: number; runs: number }[];
      counts: Record<string, number>;
    };
    expect(report.totalMs).toBeGreaterThanOrEqual(0);
    expect(report.stages.find((row) => row.name === 'remote.commit.pull')).toEqual({
      name: 'remote.commit.pull', durationMs: 6, runs: 2,
    });
    expect(report.stages.some((row) => row.name === 'remote.import')).toBe(true);
    expect(report.stages.find((row) => row.name === 'background.reconcileAttachments')?.durationMs).toBe(5);
    expect(report.counts).toEqual({ 'remote.commitsPulled': 19 });
  });

  it('keeps startup working if browser storage is unavailable', () => {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      setItem: () => { throw new Error('blocked'); },
    } });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(() => { startStartupTiming(); recordStartupTiming('account.unlock', 1); finishStartupTiming(); }).not.toThrow();
  });
});
