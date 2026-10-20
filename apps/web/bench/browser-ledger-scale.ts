import { createLedgerKeyEnvelope, type Transaction } from '@zichan/core';
import { createBackupArchive, openBackupArchive, type BackupPayload } from '../src/db/backup-archive.js';
import { deleteWebDatabase, loadDbBytes, saveDbBytes } from '../src/db/idb.js';
import { SqlJsDriver } from '../src/db/sqljs-driver.js';

type ScaleRow = {
  count: number;
  databaseBytes: number;
  fillMs: number;
  writeMs: number[];
  persistMs: number[];
  reopenMs: number;
  archiveBytes: number;
  archiveCreateMs: number;
  archiveParseMs: number;
  baselineJsHeapMiB: number | null;
  sampledJsHeapMiB: number | null;
};

function jsHeapMiB(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? Math.round(memory.usedJSHeapSize / 1048576) : null;
}

function backupPayload(count: number): BackupPayload {
  const transactions: Transaction[] = Array.from({ length: count }, (_, index) => ({
    id: `bench-${index}`,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    version: 1,
    isDeleted: false,
    date: '2026-10-20',
    type: 'expense',
    category: 'food',
    amount: '12.34',
    assetId: 'CNY',
    accountId: 'bank',
    recordState: 'active',
    reportingTreatment: 'ordinary',
    note: `${index.toString().padStart(8, '0')}-${'x'.repeat(190)}`,
  }));
  const ledger = {
    version: 7 as const,
    exportedAt: '2026-10-20T00:00:00.000Z',
    chains: [],
    assets: [], accounts: [], settings: [], lots: [], lotConsumptions: [], priceMarks: [],
    dcaPlans: [], dcaExecutions: [], games: [], gameAccounts: [], gameSeasons: [], gameRecords: [],
    gameCashflowLinks: [], fixedAssets: [], fixedAssetCategories: [], fixedAssetEvents: [],
    fixedAssetCashflowLinks: [], fixedAssetUsageMetrics: [], fixedAssetUsageLogs: [],
    fixedAssetConsumables: [], fixedAssetGoals: [], attachments: [], categories: [],
    transactionTags: [], transactionLocations: [], transactionTemplates: [], transactionSavedViews: [],
    payees: [], transactionSplits: [], refundAllocations: [], budgetCategories: [],
    scheduledTransactions: [], scheduledExecutions: [], reconciliationSessions: [], reconciliationItems: [],
    transactions,
  };
  return { version: 2, kind: 'portable', ledger };
}

export async function runBrowserLedgerScale(counts: number[]): Promise<ScaleRow[]> {
  const { envelope, session } = await createLedgerKeyEnvelope('bench-ledger-20261020', 'benchmark-only-passphrase');
  const results: ScaleRow[] = [];
  for (const count of counts) {
    (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
    const baselineJsHeapMiB = jsHeapMiB();
    let sampledJsHeapMiB = baselineJsHeapMiB;
    const sampleHeap = () => {
      const current = jsHeapMiB();
      if (current !== null) sampledJsHeapMiB = Math.max(sampledJsHeapMiB ?? 0, current);
    };
    const heapTimer = setInterval(sampleHeap, 20);
    const databaseName = `zichan-ledger-scale-${crypto.randomUUID()}`;
    let databaseBytes = 0;
    let lastPersistMs = 0;
    let driver: SqlJsDriver | null = null;
    try {
      driver = await SqlJsDriver.open(null, async (bytes) => {
        databaseBytes = bytes.byteLength;
        const started = performance.now();
        await saveDbBytes(bytes, session, databaseName);
        lastPersistMs = performance.now() - started;
      });
      await driver.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
      const fillStarted = performance.now();
      await driver.transaction(async (scope) => {
        await scope.run(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
          INSERT INTO entries(id, payload) SELECT n, printf('%0200d', n) FROM seq`, [count]);
      });
      const fillMs = performance.now() - fillStarted;
      sampleHeap();
      const writeMs: number[] = [];
      const persistMs: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const started = performance.now();
        await driver.transaction(async (scope) => {
          await scope.run('UPDATE entries SET payload = ? WHERE id = 1', [`${attempt}-${'y'.repeat(198)}`]);
        });
        if (attempt > 0) {
          writeMs.push(performance.now() - started);
          persistMs.push(lastPersistMs);
        }
      }
      await driver.close();
      driver = null;
      const reopenStarted = performance.now();
      const reopened = await SqlJsDriver.open(await loadDbBytes(session, databaseName));
      const stored = await reopened.get<{ count: number }>('SELECT COUNT(*) AS count FROM entries');
      if (stored?.count !== count) throw new Error(`Reopened database has ${stored?.count} rows; expected ${count}`);
      await reopened.close();
      const reopenMs = performance.now() - reopenStarted;
      sampleHeap();

      const payload = backupPayload(count);
      const archiveStarted = performance.now();
      const archive = await createBackupArchive(session, envelope, payload, 'manual', 'scale');
      const archiveCreateMs = performance.now() - archiveStarted;
      sampleHeap();
      const parseStarted = performance.now();
      const opened = await openBackupArchive(archive.blob, session);
      if (opened.payload.ledger.transactions.length !== count) throw new Error('Parsed archive row count mismatch');
      const archiveParseMs = performance.now() - parseStarted;
      sampleHeap();
      results.push({ count, databaseBytes, fillMs, writeMs, persistMs, reopenMs,
        archiveBytes: archive.blob.size, archiveCreateMs, archiveParseMs,
        baselineJsHeapMiB, sampledJsHeapMiB });
    } finally {
      clearInterval(heapTimer);
      try {
        await driver?.close();
      } finally {
        await deleteWebDatabase(databaseName);
      }
    }
  }
  return results;
}
