import { describe, expect, it } from 'vitest';
import { createLogger, nullSink } from '@zichan/logger';
import { NodeSqliteDriver } from '../src/drivers/node-sqlite.js';
import {
  assertCurrentSchema,
  CURRENT_SCHEMA_NAME,
  CURRENT_SCHEMA_VERSION,
  runMigrations,
  SchemaResetRequiredError,
} from '../src/migrations.js';

const log = createLogger({ level: 'error', sinks: [nullSink()] });

describe('current development schema baseline', () => {
  it('creates and verifies only the current schema', async () => {
    const driver = new NodeSqliteDriver();
    expect(await runMigrations(driver, log)).toBe(1);
    await expect(assertCurrentSchema(driver)).resolves.toBeUndefined();
    expect(await driver.all('SELECT version, name FROM schema_migrations')).toEqual([
      { version: CURRENT_SCHEMA_VERSION, name: CURRENT_SCHEMA_NAME },
    ]);
    const syncTables = (await driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sync_%' ORDER BY name"))
      .map((row) => row.name);
    expect(syncTables).toContain('sync_commits');
    expect(syncTables).toContain('sync_conflict_groups');
    expect(syncTables).not.toContain('sync_events');
    expect(syncTables).not.toContain('sync_cursors');
    expect(await driver.all<{ name: string; unique: number; partial: number }>('PRAGMA index_list(settings)'))
      .toContainEqual(expect.objectContaining({ name: 'idx_settings_single_active', unique: 1, partial: 1 }));
    await driver.run("INSERT INTO settings (id, is_deleted) VALUES ('first-setting', 0)");
    await expect(driver.run("INSERT INTO settings (id, is_deleted) VALUES ('second-setting', 0)"))
      .rejects.toThrow(/UNIQUE/);
    await expect(driver.run("INSERT INTO settings (id, is_deleted) VALUES ('deleted-setting', 1)"))
      .resolves.toBeDefined();
    expect(await runMigrations(driver, log)).toBe(0);
    await driver.close();
  });

  it('rejects a historical schema instead of upgrading it', async () => {
    const driver = new NodeSqliteDriver();
    await driver.exec(`
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE fixed_assets (id TEXT PRIMARY KEY, name TEXT, category TEXT);
INSERT INTO schema_migrations (version, name, applied_at) VALUES (16, 'old-item-migration', '2026-01-01');`);

    await expect(runMigrations(driver, log)).rejects.toBeInstanceOf(SchemaResetRequiredError);
    expect((await driver.all<{ name: string }>('PRAGMA table_info(fixed_assets)')).map((row) => row.name))
      .toEqual(['id', 'name', 'category']);
    await driver.close();
  });

  it('does not add a migration marker to an unmarked historical database', async () => {
    const driver = new NodeSqliteDriver();
    await driver.exec('CREATE TABLE legacy_assets (id TEXT PRIMARY KEY, amount TEXT NOT NULL)');
    await driver.run('INSERT INTO legacy_assets (id, amount) VALUES (?, ?)', ['kept', '12.34']);
    const before = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );

    await expect(runMigrations(driver, log)).rejects.toBeInstanceOf(SchemaResetRequiredError);

    expect(await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )).toEqual(before);
    expect(await driver.all('SELECT * FROM legacy_assets')).toEqual([{ id: 'kept', amount: '12.34' }]);
    await driver.close();
  });

  it('rejects drift even when the current baseline marker exists', async () => {
    const driver = new NodeSqliteDriver();
    await runMigrations(driver, log);
    await driver.exec('ALTER TABLE fixed_assets ADD COLUMN unexpected_extra TEXT');
    await expect(runMigrations(driver, log)).rejects.toThrow(/fixed_assets 列不一致/);
    await driver.close();
  });

  it('rejects a current marker when the singleton setting index is missing', async () => {
    const driver = new NodeSqliteDriver();
    await runMigrations(driver, log);
    await driver.exec('DROP INDEX idx_settings_single_active');
    await expect(runMigrations(driver, log)).rejects.toThrow(/idx_settings_single_active/);
    await driver.close();
  });
});

it('upgrades the preceding schema without changing existing ledger records', async () => {
  const driver = new NodeSqliteDriver();
  try {
    await runMigrations(driver, log);
    await driver.run("INSERT INTO accounts (id, name, kind, version, is_deleted) VALUES ('wallet-kept', '旧钱包', 'wallet', 7, 0)");
    await driver.run("INSERT INTO transactions (id, date, amount, type, account_id, version, is_deleted) VALUES ('kept', '2026-09-01', '12.34', 'expense', 'wallet-kept', 3, 0)");
    for (const [table, fields] of Object.entries({
      payees: ['icon'],
      accounts: ['purpose', 'opening_balance', 'opening_asset_id', 'balance_start_at', 'balance_start_date', 'balance_checkpoints'],
      settings: ['expense_default_account_id', 'income_default_account_id', 'as_of_mode'],
      transactions: ['balance_timing', 'balance_timing_account_id'],
    })) for (const field of fields) await driver.exec('ALTER TABLE ' + table + ' DROP COLUMN ' + field);
    await driver.run('UPDATE schema_migrations SET version = 117, name = ?', ['current_schema_2026_09_14_ledger_timezone']);
    expect(await runMigrations(driver, log)).toBe(1);
    expect(await driver.all('SELECT id, name, version, opening_balance FROM accounts')).toEqual([{ id: 'wallet-kept', name: '旧钱包', version: 7, opening_balance: null }]);
    expect(await driver.all('SELECT id, amount, account_id, version FROM transactions')).toEqual([{ id: 'kept', amount: '12.34', account_id: 'wallet-kept', version: 3 }]);
    expect(await runMigrations(driver, log)).toBe(0);
  } finally { await driver.close(); }
});

it('upgrades schema 118 while preserving payees and category icons', async () => {
  const driver = new NodeSqliteDriver();
  try {
    await runMigrations(driver, log);
    await driver.run("INSERT INTO payees (id, name, version, is_deleted) VALUES ('kept-payee', '旧商家', 4, 0)");
    await driver.run("INSERT INTO categories (id, name, type, icon, version, is_deleted) VALUES ('kept-category', '旧分类', 'expense', 'lucide:coffee', 2, 0)");
    await driver.exec('ALTER TABLE payees DROP COLUMN icon');
    await driver.run('UPDATE schema_migrations SET version = 118, name = ?', ['current_schema_2026_09_18_account_onboarding']);
    expect(await runMigrations(driver, log)).toBe(1);
    expect(await driver.all('SELECT id, name, version, icon FROM payees')).toEqual([{ id: 'kept-payee', name: '旧商家', version: 4, icon: null }]);
    expect(await driver.all('SELECT id, icon, version FROM categories')).toEqual([{ id: 'kept-category', icon: 'lucide:coffee', version: 2 }]);
    expect(await runMigrations(driver, log)).toBe(0);
  } finally { await driver.close(); }
});
