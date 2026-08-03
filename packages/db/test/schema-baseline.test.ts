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

  it('rejects drift even when the current baseline marker exists', async () => {
    const driver = new NodeSqliteDriver();
    await runMigrations(driver, log);
    await driver.exec('ALTER TABLE fixed_assets ADD COLUMN unexpected_extra TEXT');
    await expect(runMigrations(driver, log)).rejects.toThrow(/fixed_assets 列不一致/);
    await driver.close();
  });
});
