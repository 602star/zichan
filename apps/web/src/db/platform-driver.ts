import type { SqlDriver } from '@zichan/db';
import { isTauriRuntime } from '../tauri.js';
import { loadDbBytes, saveDbBytes } from './idb.js';
import { SqlJsDriver } from './sqljs-driver.js';
import { TauriSqlDriver } from './tauri-sql-driver.js';
import { tauriInvoke } from '../tauri.js';
import {
  DEVICE_STORAGE_ENVELOPE_KEY,
  requireDeviceStorageSession,
  type DeviceStorageSession,
} from '../device-storage-key.js';

export type StorageBackend = 'browser-indexeddb' | 'native-sqlite';

export interface PlatformDriver {
  driver: SqlDriver;
  backend: StorageBackend;
  dataLocation: string;
}

export async function openPlatformDriver(
  protection: DeviceStorageSession = requireDeviceStorageSession(),
): Promise<PlatformDriver> {
  if (isTauriRuntime()) {
    if (!protection.databaseKeyHex) throw new Error('Stronghold 未提供原生数据库密钥');
    const driver = await TauriSqlDriver.open(protection.databaseKeyHex);
    return {
      driver,
      backend: 'native-sqlite',
      dataLocation: `${await driver.dataPath()} · SQLCipher`,
    };
  }
  const bytes = await loadDbBytes(protection.cryptoSession);
  return {
    driver: await SqlJsDriver.open(bytes, (next) => saveDbBytes(next, protection.cryptoSession)),
    backend: 'browser-indexeddb',
    dataLocation: 'IndexedDB · 加密 ledger.sqlite',
  };
}

export async function resetPlatformData(): Promise<void> {
  if (isTauriRuntime()) {
    const databaseUrl = tauriInvoke<string>('native_sql_database_url');
    if (!databaseUrl) throw new Error('原生数据库路径命令不可用');
    const close = tauriInvoke<void>('native_sql_close', { db: await databaseUrl });
    if (close) await close.catch(() => false);
    const removeDatabase = tauriInvoke('native_sql_delete_database');
    const clearAttachments = tauriInvoke('native_attachment_clear');
    if (!removeDatabase || !clearAttachments) throw new Error('原生数据清理命令不可用');
    await removeDatabase;
    await clearAttachments;
    await tauriInvoke('native_reset_security_vault')?.catch(() => undefined);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('zichan-web');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('浏览器存储仍被占用，请关闭其他本应用页面后重试'));
  });
  globalThis.localStorage?.removeItem(DEVICE_STORAGE_ENVELOPE_KEY);
}
