import { afterEach, describe, expect, it } from 'vitest';
import { splitSqlStatements, TauriSqlDriver } from '../src/db/tauri-sql-driver.js';
import { openPlatformDriver, resetPlatformData } from '../src/db/platform-driver.js';
import type { DeviceStorageSession } from '../src/device-storage-key.js';

interface Call {
  command: string;
  args?: Record<string, unknown>;
}

const DATABASE_KEY = '11'.repeat(32);
const TEST_PROTECTION = {
  state: {
    kind: 'native-stronghold',
    initialized: true,
    unlocked: true,
    platform: 'windows',
    storageId: 'test-device-storage-id',
    message: 'test',
  },
  databaseKeyHex: DATABASE_KEY,
  cryptoSession: {
    v: 1,
    ledgerId: 'test-device-storage-id',
    keyringId: 'test-device-keyring-id',
    generation: 1,
    activeKeyId: 'device-storage',
    dataKeys: new Map(),
    attachmentSecret: new Uint8Array(32),
    backupSecret: new Uint8Array(32),
  },
} satisfies DeviceStorageSession;

function installTauriMock(onInvoke?: (command: string, args?: Record<string, unknown>) => void | Promise<void>) {
  const calls: Call[] = [];
  let transactionNumber = 0;
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    await onInvoke?.(command, args);
    if (command === 'native_sql_database_url') return 'sqlite:C:/AppData/Zichan/ledger.sqlite' as T;
    if (command === 'native_sql_database_path') return 'C:/AppData/Zichan/ledger.sqlite' as T;
    if (command === 'native_sql_begin') return `tx-${++transactionNumber}` as T;
    if (command === 'native_sql_select') return [{ value: 'ok' }] as T;
    return undefined as T;
  };
  (globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: { invoke } };
  return calls;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('TauriSqlDriver', () => {
  it('loads ledger.sqlite and routes SQL through the native bridge', async () => {
    const calls = installTauriMock();
    const driver = await TauriSqlDriver.open(DATABASE_KEY);
    await driver.run('INSERT INTO test(value) VALUES (?)', ['one']);
    expect(await driver.all('SELECT value FROM test')).toEqual([{ value: 'ok' }]);
    expect(await driver.dataPath()).toContain('ledger.sqlite');
    await driver.close();

    expect(calls.map((call) => call.command)).toEqual([
      'native_sql_database_url',
      'native_sql_open',
      'native_sql_prepare',
      'native_sql_execute',
      'native_sql_select',
      'native_sql_database_path',
      'native_sql_close',
    ]);
    expect(calls[1]?.args?.['db']).toBe('sqlite:C:/AppData/Zichan/ledger.sqlite');
    expect(calls[1]?.args?.['databaseKeyHex']).toBe(DATABASE_KEY);
    expect(calls[3]?.args?.['db']).toBe('sqlite:C:/AppData/Zichan/ledger.sqlite');
  });

  it('uses a real native transaction and savepoints for nesting', async () => {
    const calls = installTauriMock();
    const driver = await TauriSqlDriver.open(DATABASE_KEY);
    await driver.transaction(async (transaction) => {
      await transaction.run('INSERT INTO test(value) VALUES (?)', ['outer']);
      await transaction.transaction(async (nested) => {
        await nested.run('INSERT INTO test(value) VALUES (?)', ['inner']);
      });
    });

    const commands = calls.map((call) => call.command);
    expect(commands).toContain('native_sql_begin');
    expect(commands).toContain('native_sql_commit');
    expect(calls.filter((call) => call.command === 'native_sql_execute').every((call) => call.args?.['transactionId'] === 'tx-1')).toBe(true);
    expect(calls.some((call) => call.command === 'native_sql_execute' && String(call.args?.['query']).startsWith('SAVEPOINT'))).toBe(true);
    expect(calls.some((call) => call.command === 'native_sql_execute' && String(call.args?.['query']).startsWith('RELEASE'))).toBe(true);
  });

  it('serializes independent root transactions instead of nesting them', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const calls = installTauriMock(async (command, args) => {
      if (command === 'native_sql_execute' && args?.['values'] instanceof Array && args['values'][0] === 'first') {
        markFirstStarted();
        await firstMayFinish;
      }
    });
    const driver = await TauriSqlDriver.open(DATABASE_KEY);

    const first = driver.transaction(async (transaction) => {
      await transaction.run('INSERT INTO test(value) VALUES (?)', ['first']);
    });
    await firstStarted;
    const second = driver.transaction(async (transaction) => {
      await transaction.run('INSERT INTO test(value) VALUES (?)', ['second']);
    });
    await Promise.resolve();

    expect(calls.filter((call) => call.command === 'native_sql_begin')).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls.filter((call) => call.command === 'native_sql_begin')).toHaveLength(2);
    const inserts = calls.filter((call) => call.command === 'native_sql_execute' && String(call.args?.['query']).startsWith('INSERT'));
    expect(inserts.map((call) => call.args?.['transactionId'])).toEqual(['tx-1', 'tx-2']);
  });

  it('splits migration scripts without breaking quoted semicolons or comments', () => {
    expect(splitSqlStatements("CREATE TABLE x(v TEXT); INSERT INTO x VALUES ('a;b'); -- note;\n SELECT * FROM x;"))
      .toEqual(['CREATE TABLE x(v TEXT)', "INSERT INTO x VALUES ('a;b')", '-- note;\n SELECT * FROM x']);
    expect(() => splitSqlStatements("SELECT 'unfinished")).toThrow('unterminated');
  });

  it('selects native SQLite for every Tauri runtime', async () => {
    installTauriMock();
    const platform = await openPlatformDriver(TEST_PROTECTION);
    expect(platform.backend).toBe('native-sqlite');
    expect(platform.dataLocation).toContain('ledger.sqlite');
    await platform.driver.close();
  });

  it('resets the same AppData database URL and native attachments', async () => {
    const calls = installTauriMock();
    await resetPlatformData();
    expect(calls.map((call) => call.command)).toEqual([
      'native_sql_database_url',
      'native_sql_close',
      'native_sql_delete_database',
      'native_attachment_clear',
      'native_reset_security_vault',
    ]);
    expect(calls[1]?.args?.['db']).toBe('sqlite:C:/AppData/Zichan/ledger.sqlite');
  });

  it('can reset after initialization already closed the native SQL plugin', async () => {
    const calls = installTauriMock((command) => {
      if (command === 'native_sql_close') throw new Error('database is not loaded');
    });
    await expect(resetPlatformData()).resolves.toBeUndefined();
    expect(calls.map((call) => call.command)).toContain('native_sql_delete_database');
    expect(calls.map((call) => call.command)).toContain('native_attachment_clear');
  });
});
