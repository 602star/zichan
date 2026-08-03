import { performance } from 'node:perf_hooks';
import { createLedgerStore } from '../dist/index.js';
import { NodeSqliteDriver } from '../dist/node.js';

async function ledgerWithTransactions(size) {
  const driver = new NodeSqliteDriver();
  const store = await createLedgerStore(driver);
  await driver.exec(`
    WITH RECURSIVE seq(x) AS (
      SELECT 1
      UNION ALL
      SELECT x + 1 FROM seq WHERE x < ${size}
    )
    INSERT INTO transactions (
      id, created_at, updated_at, version, is_deleted,
      date, type, category, amount, asset_id, account_id,
      status, record_state, tag_ids, description
    )
    SELECT
      printf('bench-%09d', x),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      1,
      0,
      printf(
        '2026-%02d-%02d',
        (CAST((x - 1) / 28 AS INTEGER) % 12) + 1,
        ((x - 1) % 28) + 1
      ),
      CASE WHEN x % 5 = 0 THEN 'income' ELSE 'expense' END,
      CASE WHEN x % 5 = 0 THEN 'salary' WHEN x % 3 = 0 THEN 'transport' ELSE 'food' END,
      CAST((x % 500) + 1 AS TEXT),
      'CNY',
      CASE WHEN x % 2 = 0 THEN 'bank' ELSE 'cash' END,
      'cleared',
      'active',
      '[]',
      CASE WHEN x % 7 = 0 THEN 'coffee commute' ELSE 'daily entry' END
    FROM seq;
  `);
  return store;
}

async function measure(label, fn, options) {
  for (let index = 0; index < 2; index += 1) await fn();
  const samples = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const startedAt = performance.now();
    await fn();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const percentile = (ratio) => samples[Math.min(samples.length - 1, Math.floor(samples.length * ratio))];
  const result = {
    label,
    iterations: samples.length,
    p50Ms: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    maxMs: Number(samples.at(-1).toFixed(2)),
    budgetP95Ms: options.budgetP95Ms,
  };
  console.log(JSON.stringify(result));
  if (result.p95Ms > options.budgetP95Ms) {
    throw new Error(`${label} p95 ${result.p95Ms}ms exceeded ${options.budgetP95Ms}ms`);
  }
}

const stores = [];
try {
  const tenThousand = await ledgerWithTransactions(10_000);
  const hundredThousand = await ledgerWithTransactions(100_000);
  stores.push(tenThousand, hundredThousand);

  await measure('10k filtered first page', () => tenThousand.transactionBrowsePage({
    from: '2026-03-01',
    to: '2026-03-31',
    category: 'food',
    limit: 100,
  }), { iterations: 20, budgetP95Ms: 250 });

  await measure('100k filtered first page', () => hundredThousand.transactionBrowsePage({
    from: '2026-03-01',
    to: '2026-03-31',
    category: 'food',
    limit: 100,
  }), { iterations: 10, budgetP95Ms: 750 });

  await measure('100k six-month aggregate', () => hundredThousand.transactionReportAggregate({
    from: '2026-01-01',
    to: '2026-06-30',
  }), { iterations: 10, budgetP95Ms: 1_500 });

  await measure('100k account balances', () => hundredThousand.accountBalanceAggregates(), {
    iterations: 10,
    budgetP95Ms: 1_500,
  });
} finally {
  await Promise.all(stores.map((store) => store.close()));
}
