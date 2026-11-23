/** Account startup diagnostics contain timings and counts only, never account or ledger identifiers. */
export interface StartupTimingReport {
  version: 1;
  startedAt: string;
  totalMs?: number;
  stages: { name: string; durationMs: number; runs: number }[];
  counts: Record<string, number>;
  kind?: 'ready' | 'failure' | 'background';
}

export const STARTUP_TIMING_KEY = 'zichan.startup-timing.v1';
export const STARTUP_READY_EVENT = 'zichan:startup-ready';
export const STARTUP_REPORT_EVENT = 'zichan:startup-report';
let startedAt = 0;
let report: StartupTimingReport | undefined;

function persist(): void {
  try { globalThis.sessionStorage?.setItem(STARTUP_TIMING_KEY, JSON.stringify(report)); }
  catch { /* Diagnostics must never block startup. */ }
}

export function startStartupTiming(fromNavigation = false): void {
  startedAt = fromNavigation ? 0 : performance.now();
  report = { version: 1, startedAt: new Date().toISOString(), stages: [], counts: {} };
  persist();
}

export function recordStartupTiming(name: string, durationMs: number): void {
  if (!report || !Number.isFinite(durationMs)) return;
  if (report.totalMs !== undefined && !name.startsWith('background.')) return;
  const rounded = Math.max(0, Math.round(durationMs));
  const row = report.stages.find((stage) => stage.name === name);
  if (row) { row.durationMs += rounded; row.runs += 1; }
  else report.stages.push({ name, durationMs: rounded, runs: 1 });
  persist();
}

export function ensureStartupTiming(): void { if (!report) startStartupTiming(); }

export function markStartupMilestone(name: string): void {
  if (!report || report.stages.some(stage => stage.name === name)) return;
  recordStartupTiming(name, performance.now() - startedAt);
  if (name === 'background.complete' || name === 'background.syncCaughtUp') {
    const snapshot = startupTimingSnapshot();
    if (snapshot) globalThis.dispatchEvent?.(new CustomEvent(STARTUP_REPORT_EVENT, { detail: {
      ...snapshot, kind: 'background', stages: snapshot.stages.filter(stage => name === 'background.complete'
        ? stage.name.startsWith('background.') && stage.name !== 'background.syncCaughtUp' : stage.name === name),
    } }));
  }
}

export function failStartupTiming(name: string): void {
  if (!report || report.totalMs !== undefined) return;
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  globalThis.dispatchEvent?.(new CustomEvent(STARTUP_REPORT_EVENT, { detail: { ...report,
    totalMs: durationMs, kind: 'failure', stages: [{ name, durationMs, runs: 1 }], counts: {},
  } }));
}

export async function measureStartupStage<T>(name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); }
  finally { recordStartupTiming(name, performance.now() - start); }
}

export function recordStartupCount(name: string, count: number): void {
  if (!report || !Number.isSafeInteger(count) || count < 0) return;
  if (report.totalMs !== undefined) return;
  report.counts[name] = count;
  persist();
}

export function finishStartupTiming(): void {
  if (!report || report.totalMs !== undefined) return;
  report.totalMs = Math.max(0, Math.round(performance.now() - startedAt));
  persist();
  console.info('账本首次打开耗时（毫秒）', report);
  globalThis.dispatchEvent?.(new Event(STARTUP_READY_EVENT));
  globalThis.dispatchEvent?.(new CustomEvent(STARTUP_REPORT_EVENT, { detail: startupTimingSnapshot() }));
}

export function startupTimingSnapshot(): StartupTimingReport | undefined {
  if (!report || report.totalMs === undefined) return undefined;
  return { ...report, stages: report.stages.map((stage) => ({ ...stage })), counts: { ...report.counts } };
}
