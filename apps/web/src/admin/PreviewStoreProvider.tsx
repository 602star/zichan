/**
 * Read-only stand-in for `StoreProvider`, used by the ledger preview.
 *
 * The preview wants the *real* ledger UI — the same dashboard, transactions, reports and
 * asset screens — pointed at a user's data that the server decrypted into memory. Reusing
 * `StoreProvider` is not an option: it opens the device's own database, unlocks the ledger
 * key, runs maintenance, generates due scheduled transactions and writes automatic backups.
 * Every one of those acts on the administrator's machine for a ledger that is not theirs.
 *
 * So this provider supplies the same context and nothing else:
 *
 * - the store is built over `readOnlyDriver`, so any write throws instead of landing;
 * - there is no subscription-driven background work to disable, because none is installed;
 * - `store.subscribe` still works, so screens refresh the way they always do;
 * - the local-only capabilities (`resetLocalData`, `exitAccount`) are inert, because there is
 *   no local ledger here to reset or leave.
 *
 * `dataLocation` is deliberately honest text rather than a path: the operator should be able
 * to tell at a glance that this is not their own file.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createLedgerStore, importLedger, SqlLedgerStore, type LedgerBackup } from '@zichan/db';
import { StoreCtxContext, type StoreCtx } from '../db/store.js';
import { SqlJsDriver } from '../db/sqljs-driver.js';
import { readOnlyDriver } from './read-only-driver.js';

/**
 * Populate an in-memory database with the preview backup and hand back a read-only store.
 *
 * The import runs through an unwrapped store over the same driver: the guard exists to stop a
 * human edit, not to stop the preview from being populated. That writable store is local to
 * this function and never reaches the UI.
 *
 * The store the screens get is constructed directly rather than through `createLedgerStore`,
 * which would run migrations again. `migrate()` writes when it finds an interrupted local
 * commit, and that write would hit the guard — failing the whole preview over a repair that
 * has no business running here. Migrations already ran on the writable store above.
 */
export async function buildPreviewStore(backup: LedgerBackup): Promise<SqlLedgerStore> {
  // `null` bytes means a brand-new empty database held in memory by sql.js. No IndexedDB keys
  // are read, so this cannot collide with — or leak into — the operator's own ledger.
  const inner = await SqlJsDriver.open(null);
  try {
    // This one migrates (the import needs the schema) and is discarded immediately after.
    await importLedger(await createLedgerStore(inner), backup);
  } catch (error) {
    await inner.close().catch(() => undefined);
    throw error;
  }
  return new SqlLedgerStore(readOnlyDriver(inner));
}

export function PreviewStoreProvider({ backup, preview, onClose, children }: {
  backup: LedgerBackup;
  preview: StoreCtx['preview'];
  onClose?: () => Promise<void>;
  children: ReactNode;
}) {
  const [store, setStore] = useState<SqlLedgerStore | null>(null);
  const [error, setError] = useState('');
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    let opened: SqlLedgerStore | null = null;
    void (async () => {
      try {
        const next = await buildPreviewStore(backup);
        if (disposed.current) { await next.close().catch(() => undefined); return; }
        opened = next;
        setStore(next);
      } catch (reason) {
        if (!disposed.current) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      disposed.current = true;
      void opened?.close().catch(() => undefined);
    };
  }, [backup]);

  // A store that never changes still needs a stable context object, or every screen would
  // re-render on each parent render.
  const value = useMemo<StoreCtx | null>(() => (store ? {
    store,
    rev: 0,
    bump: () => undefined,
    storageBackend: 'browser-indexeddb',
    dataLocation: '内存预览（无本地文件）',
    firstUseMode: 'server',
    browserStoragePersistent: false,
    resetLocalData: async () => undefined,
    preview,
    closePreview: onClose,
  } : null), [store, preview, onClose]);

  if (error) {
    return (
      <div role="alert" style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: 'var(--text-primary)' }}>
        <strong>预览数据无法打开</strong>
        <p>{error}</p>
      </div>
    );
  }
  if (!value) return <p role="status" style={{ padding: 24 }}>正在载入预览数据…</p>;
  return <StoreCtxContext.Provider value={value}>{children}</StoreCtxContext.Provider>;
}