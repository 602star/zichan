import { isRecord } from './http-util.js';

const STAGES = new Set([
  'account.protectionRequest', 'account.unlockLedgerKey', 'account.unlockDeviceStorage',
  'local.inspectStorage', 'local.openDatabase', 'local.initializeStore', 'local.inspectLedger',
  'remote.authenticate', 'remote.checkReplica', 'remote.fetchKeyEnvelope', 'remote.unlockLedgerKey',
  'remote.openTemporaryStore', 'remote.commit.total', 'remote.commit.connect', 'remote.commit.pull',
  'remote.commit.apply', 'remote.commit.push', 'remote.commit.verify', 'remote.consistency',
  'remote.export', 'remote.importPreflight', 'remote.exportDeviceState',
  'local.importLedger', 'local.ensureBackupKey', 'local.recoverAttachmentOperations',
  'local.maintenance', 'local.scheduledTransactions', 'local.finalSync',
]);
const COUNTS = new Set(['remote.commitsPulled', 'remote.attachments']);
const duration = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 86_400_000;

/** Accept only known numeric diagnostics; never copy arbitrary browser fields into server logs. */
export function parseStartupTiming(value: unknown): { totalMs: number; stages: { name: string; durationMs: number; runs: number }[]; counts: Record<string, number> } | undefined {
  if (!isRecord(value) || value.version !== 1 || !duration(value.totalMs) || !Array.isArray(value.stages)
    || value.stages.length > STAGES.size || !isRecord(value.counts)) return undefined;
  const seen = new Set<string>();
  const stages: { name: string; durationMs: number; runs: number }[] = [];
  for (const item of value.stages) {
    if (!isRecord(item) || typeof item.name !== 'string' || !STAGES.has(item.name) || seen.has(item.name)
      || !duration(item.durationMs) || !Number.isSafeInteger(item.runs) || Number(item.runs) < 1 || Number(item.runs) > 1000) return undefined;
    seen.add(item.name);
    stages.push({ name: item.name, durationMs: item.durationMs as number, runs: item.runs as number });
  }
  const counts: Record<string, number> = {};
  for (const [name, count] of Object.entries(value.counts)) {
    if (!COUNTS.has(name) || !Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 10_000_000) return undefined;
    counts[name] = count as number;
  }
  return { totalMs: value.totalMs as number, stages, counts };
}
