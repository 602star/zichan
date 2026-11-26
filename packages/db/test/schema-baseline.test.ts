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
  it('preserves schema 128 inventory metadata when adding usage expenses', async () => {
    const driver = new NodeSqliteDriver();
    try {
      await runMigrations(driver, log);
      await driver.run("INSERT INTO fixed_assets (id, name, storage_location_id, is_deleted, version) VALUES ('kept', '净水器', 'kitchen', 0, 1)");
      await driver.exec('ALTER TABLE fixed_asset_events DROP COLUMN operating_cost_json');
      await driver.exec('DROP TABLE calendar_occurrence_states');
      await driver.exec('DROP TABLE calendar_entries');
      await driver.exec('ALTER TABLE settings DROP COLUMN calendar_preferences_json');
      await driver.exec('ALTER TABLE transactions DROP COLUMN order_number');
      await driver.exec('ALTER TABLE transactions DROP COLUMN tracking_number');
      await driver.run("UPDATE schema_migrations SET version = 128, name = 'current_schema_2026_11_16_fixed_workspace'");
      expect(await runMigrations(driver, log)).toBe(1);
      expect(await driver.all('SELECT name, storage_location_id FROM fixed_assets')).toEqual([{ name: '净水器', storage_location_id: 'kitchen' }]);
      expect(await runMigrations(driver, log)).toBe(0);
    } finally { await driver.close(); }
  });
  it('upgrades the immediately preceding schema without losing inventory or settings', async () => {
    const driver = new NodeSqliteDriver();
    try {
      await runMigrations(driver, log);
      await driver.run("INSERT INTO fixed_assets (id, name, is_deleted, version) VALUES ('kept', '保留的物品', 0, 1)");
      await driver.exec('ALTER TABLE settings DROP COLUMN fixed_asset_workspace_json');
      await driver.exec('DROP TABLE calendar_occurrence_states');
      await driver.exec('DROP TABLE calendar_entries');
      await driver.exec('ALTER TABLE settings DROP COLUMN calendar_preferences_json');
      await driver.exec('ALTER TABLE transactions DROP COLUMN order_number');
      await driver.exec('ALTER TABLE transactions DROP COLUMN tracking_number');
      await driver.exec('ALTER TABLE fixed_asset_events DROP COLUMN operating_cost_json');
      for (const column of ['purchase_date_precision', 'storage_location_id', 'location_moves_json', 'return_deadline', 'price_protection_deadline', 'maintenance_due_date', 'maintenance_interval_days', 'reminder_days_before']) await driver.exec(`ALTER TABLE fixed_assets DROP COLUMN ${column}`);
      await driver.run("UPDATE schema_migrations SET version = 127, name = 'current_schema_2026_10_05_consumable_merchant'");
      expect(await runMigrations(driver, log)).toBe(1);
      await assertCurrentSchema(driver);
      expect(await driver.all('SELECT id, name, storage_location_id FROM fixed_assets')).toEqual([{ id: 'kept', name: '保留的物品', storage_location_id: null }]);
      expect(await runMigrations(driver, log)).toBe(0);
    } finally { await driver.close(); }
  });
  it('creates and verifies only the current schema', async () => {
    const driver = new NodeSqliteDriver();
    try {
      expect(await runMigrations(driver, log)).toBe(1);
      await expect(assertCurrentSchema(driver)).resolves.toBeUndefined();
      expect(await driver.all('SELECT version, name FROM schema_migrations')).toEqual([
        { version: CURRENT_SCHEMA_VERSION, name: CURRENT_SCHEMA_NAME },
      ]);
      expect(await runMigrations(driver, log)).toBe(0);
    } finally { await driver.close(); }
  });

  it('rejects a prior schema without changing its records', async () => {
    const driver = new NodeSqliteDriver();
    try {
      await runMigrations(driver, log);
      await driver.run("INSERT INTO fixed_assets (id, name, is_deleted, version) VALUES ('kept', '旧记录', 0, 1)");
      await driver.run("UPDATE schema_migrations SET version = 126, name = 'current_schema_2026_10_04_fixed_components'");
      await expect(runMigrations(driver, log)).rejects.toBeInstanceOf(SchemaResetRequiredError);
      expect(await driver.all('SELECT id, name FROM fixed_assets')).toEqual([{ id: 'kept', name: '旧记录' }]);
    } finally { await driver.close(); }
  });

  it('rejects an unmarked database without adding a schema marker', async () => {
    const driver = new NodeSqliteDriver();
    try {
      await driver.exec('CREATE TABLE legacy_assets (id TEXT PRIMARY KEY, amount TEXT NOT NULL)');
      await driver.run('INSERT INTO legacy_assets (id, amount) VALUES (?, ?)', ['kept', '12.34']);
      await expect(runMigrations(driver, log)).rejects.toBeInstanceOf(SchemaResetRequiredError);
      expect(await driver.all('SELECT * FROM legacy_assets')).toEqual([{ id: 'kept', amount: '12.34' }]);
      expect(await driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'"))
        .toEqual([]);
    } finally { await driver.close(); }
  });

  it('rejects drift under the current marker', async () => {
    const driver = new NodeSqliteDriver();
    try {
      await runMigrations(driver, log);
      await driver.exec('ALTER TABLE fixed_assets ADD COLUMN unexpected_extra TEXT');
      await expect(runMigrations(driver, log)).rejects.toThrow(/fixed_assets 列不一致/);
    } finally { await driver.close(); }
  });

  it('rejects a missing required index', async () => {
    const driver = new NodeSqliteDriver();
    try {
      await runMigrations(driver, log);
      await driver.exec('DROP INDEX idx_settings_single_active');
      await expect(runMigrations(driver, log)).rejects.toThrow(/idx_settings_single_active/);
    } finally { await driver.close(); }
  });
});
