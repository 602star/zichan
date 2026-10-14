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
