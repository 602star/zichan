import type { SqlDriver } from '@zichan/db';
import { isTauriRuntime, tauriInvoke } from '../tauri.js';
import { deleteWebDatabase, loadDbBytes, saveDbBytes } from './idb.js';
import { SqlJsDriver } from './sqljs-driver.js';
import { TauriSqlDriver } from './tauri-sql-driver.js';
import { acquireBrowserLedgerLock } from './browser-ledger-lock.js';
import { SharedBrowserSqlDriver } from './shared-browser-driver.js';
import {
  clearDeviceStorageState,
  requireDeviceStorageSession,
  type DeviceStorageSession,
} from '../device-storage-key.js';
import { clearLedgerKey } from '../ledger-key-vault.js';
import { clearSyncConfiguration } from '../sync-config.js';
import { clearCredentialVaultRuntimeState, resetCredentialVault } from '../credential-vault.js';
import { clearCloudIdentity } from './cloud.js';
import { clearSafetyState } from './safety.js';

export type StorageBackend = 'browser-indexeddb' | 'native-sqlite';

export interface PlatformDriver {
  driver: SqlDriver;
  backend: StorageBackend;
  dataLocation: string;
  subscribeChanges?: (listener: () => void) => () => void;
}

export async function openPlatformDriver(
  protection: DeviceStorageSession = requireDeviceStorageSession(),
): Promise<PlatformDriver> {
  if (isTauriRuntime()) {
    if (!protection.databaseKeyHex) throw new Error('Stronghold 未提供原生数据库密钥');
    const driver = await TauriSqlDriver.open(protection.databaseKeyHex);
    try {
      return {
        driver,
        backend: 'native-sqlite',
        dataLocation: `${await driver.dataPath()} · SQLCipher`,
      };
    } catch (error) {
      await driver.close().catch(() => undefined);
      throw error;
    }
  }
  if (typeof SharedWorker !== 'undefined') {
    const driver = await SharedBrowserSqlDriver.open(protection.cryptoSession);
    return {
      driver,
      backend: 'browser-indexeddb',
      dataLocation: 'IndexedDB · 加密 ledger.sqlite（多标签页共享）',
      subscribeChanges: (listener) => driver.subscribeChanges(listener),
    };
  }
  const releaseLock = await acquireBrowserLedgerLock();
  try {
    const bytes = await loadDbBytes(protection.cryptoSession);
    return {
      driver: await SqlJsDriver.open(
        bytes,
        // The quick check catches a lost heartbeat; saveDbBytes also checks the
        // lease version in the same IndexedDB transaction as the snapshot write.
        async (next) => {
          await releaseLock.assertHeld();
          await saveDbBytes(next, protection.cryptoSession, undefined, releaseLock.snapshotLease);
        },
        releaseLock,
      ),
      backend: 'browser-indexeddb',
      dataLocation: 'IndexedDB · 加密 ledger.sqlite（单标签独占）',
    };
  } catch (error) {
    await releaseLock().catch(() => undefined);
    throw error;
  }
}

export async function resetPlatformData(): Promise<void> {
  // A different tab may still be using the shared worker. Refuse to delete its
  // IndexedDB snapshot until all browser connections have closed.
  const releaseResetLock = isTauriRuntime() ? null : await acquireBrowserLedgerLock();
  let webDatabaseDeleted = false;
  try {
    const { forgetOfflineAccess } = await import('../offline-access.js');
    const { clearAccountProtection } = await import('../account-protection.js');
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
      await resetCredentialVault();
    }
    await deleteWebDatabase();
    webDatabaseDeleted = true;

    clearAccountProtection();
    await forgetOfflineAccess().catch(() => undefined);
    clearDeviceStorageState();
    clearLedgerKey();
    clearSyncConfiguration();
    clearCredentialVaultRuntimeState();
    clearCloudIdentity();
    clearSafetyState();
  } finally {
    await releaseResetLock?.(webDatabaseDeleted);
  }
}
