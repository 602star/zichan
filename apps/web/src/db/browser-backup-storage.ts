import { BACKUP_ARCHIVE_STORE, openIdb } from './idb.js';

const LEGACY_BACKUPS_KEY = 'ledger.encryptedBackups.v3';

/** Migrate the old single-Blob catalog atomically, then read independent archives. */
export async function loadBrowserBackupRecords<T extends { id: string }>(): Promise<T[]> {
  const db = await openIdb();
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(['kv', BACKUP_ARCHIVE_STORE], 'readwrite');
      const legacyStore = tx.objectStore('kv');
      const archiveStore = tx.objectStore(BACKUP_ARCHIVE_STORE);
      const legacy = legacyStore.get(LEGACY_BACKUPS_KEY);
      let rows: T[] = [];
      let migrationError: unknown;
      legacy.onsuccess = () => {
        try {
          const old = legacy.result;
          if (Array.isArray(old)) {
            legacyStore.delete(LEGACY_BACKUPS_KEY);
            for (const row of old as T[]) {
              if (row && typeof row.id === 'string') archiveStore.put(row, row.id);
            }
          }
          const all = archiveStore.getAll();
          all.onsuccess = () => { rows = all.result as T[]; };
        } catch (error) { migrationError = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(rows);
      tx.onabort = () => reject(migrationError ?? tx.error ?? new Error('备份目录迁移失败'));
    }).catch(async (error: unknown) => {
      // A full origin can refuse migration bookkeeping. Keep deletion available
      // from the legacy catalog so the user can free space first.
      if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
      return new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(['kv', BACKUP_ARCHIVE_STORE], 'readonly');
        const old = tx.objectStore('kv').get(LEGACY_BACKUPS_KEY);
        const current = tx.objectStore(BACKUP_ARCHIVE_STORE).getAll();
        let legacyRows: T[] = [];
        let currentRows: T[] = [];
        old.onsuccess = () => { legacyRows = Array.isArray(old.result) ? old.result as T[] : []; };
        current.onsuccess = () => { currentRows = current.result as T[]; };
        tx.oncomplete = () => resolve([...currentRows, ...legacyRows.filter((row) => !currentRows.some((currentRow) => currentRow.id === row.id))]);
        tx.onabort = () => reject(tx.error);
      });
    });
  } finally { db.close(); }
}

export async function deleteBrowserBackupRecord<T>(id: string, validate: (rows: T[]) => void): Promise<void> {
  const db = await openIdb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['kv', BACKUP_ARCHIVE_STORE], 'readwrite');
      const legacyStore = tx.objectStore('kv');
      const store = tx.objectStore(BACKUP_ARCHIVE_STORE);
      const old = legacyStore.get(LEGACY_BACKUPS_KEY);
      let validationError: unknown;
      old.onsuccess = () => {
        const legacyRows = Array.isArray(old.result) ? old.result as (T & { id: string })[] : [];
        const all = store.getAll();
        all.onsuccess = () => {
          try {
            validate([...(all.result as T[]), ...legacyRows]);
            if (legacyRows.some((row) => row.id === id)) {
              legacyStore.delete(LEGACY_BACKUPS_KEY);
              const remaining = legacyRows.filter((row) => row.id !== id);
              if (remaining.length) legacyStore.put(remaining, LEGACY_BACKUPS_KEY);
            }
            store.delete(id);
          } catch (error) {
            validationError = error;
            tx.abort();
          }
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(validationError ?? tx.error ?? new Error('删除备份失败'));
    });
  } finally { db.close(); }
}

/** Add one archive and prune expired automatic archives without rewriting retained Blobs. */
export async function putBrowserBackupRecord<T extends { id: string }>(entry: T, pruneIds?: Set<string>): Promise<void> {
  const db = await openIdb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BACKUP_ARCHIVE_STORE, 'readwrite');
      const store = tx.objectStore(BACKUP_ARCHIVE_STORE);
      if (pruneIds) for (const id of pruneIds) store.delete(id);
      store.put(entry, entry.id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('保存备份失败'));
    });
  } finally { db.close(); }
}
