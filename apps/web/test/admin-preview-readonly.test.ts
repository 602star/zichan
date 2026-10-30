import { describe, expect, it } from 'vitest';
import { D, newId, type Transaction } from '@zichan/core';
import { createLedgerStore, exportLedger, saveTransaction, type SqlDriver } from '@zichan/db';
import { SqlJsDriver } from '../src/db/sqljs-driver.js';
import { ReadOnlyPreviewError, isReadOnlyPreviewError, readOnlyDriver } from '../src/admin/read-only-driver.js';
import { buildPreviewStore } from '../src/admin/PreviewStoreProvider.js';
import { loadSnapshot } from '../src/db/snapshot.js';

/**
 * The preview reuses the real ledger UI against a user's decrypted ledger. These tests cover the
 * one property that makes that safe: nothing the UI does can write.
 *
 * The guard is deliberately at the driver, so the tests assert on the driver — a screen that
 * forgot to disable a button is not a case the driver can miss.
 */

function base() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

function transaction(id: string, amount: string): Transaction {
  return {
    ...base(), id, date: '2026-08-01', type: 'expense', category: 'food', amount,
    assetId: 'CNY', accountId: 'bank', recordState: 'active', reportingTreatment: 'ordinary',
  } as Transaction;
}

async function seed(store: Awaited<ReturnType<typeof createLedgerStore>>) {
  await store.assets.put({ ...base(), id: 'CNY', code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true } as never);
  await store.accounts.put({ ...base(), id: 'bank', name: 'Bank', kind: 'bank', isActive: true } as never);
  await store.categories.put({ ...base(), id: 'expense-root', name: '支出', type: 'expense', isActive: true } as never);
  await store.categories.put({ ...base(), id: 'food', name: '餐饮', type: 'expense', parentId: 'expense-root', isActive: true } as never);
}

/** A populated ledger, exported the way the server exports a preview. */
async function sampleBackup() {
  const store = await createLedgerStore(await SqlJsDriver.open(null));
  await seed(store);
  await saveTransaction(store, transaction('preview-tx', '42.50'));
  const backup = await exportLedger(store);
  await store.close();
  return backup;
}

describe('read-only preview driver', () => {
  it('refuses every write and passes reads through', async () => {
    const inner = await SqlJsDriver.open(null);
    const writable = await createLedgerStore(inner);
    await seed(writable);
    await writable.assets.put({ ...base(), id: 'USD', code: 'USD', name: '美元', type: 'fiat', decimals: 2, isActive: true } as never);

    // Same connection, read-only view over it: this is what the preview hands the screens.
    const driver = readOnlyDriver(inner);
    // Reads are the whole point of the preview, so they must not be caught by the guard.
    expect((await driver.all<{ code: string }>('SELECT code FROM assets ORDER BY code')).map((row) => row.code)).toEqual(['CNY', 'USD']);
    expect(await driver.get<{ code: string }>('SELECT code FROM assets WHERE id = ?', ['CNY'])).toEqual({ code: 'CNY' });

    await expect(driver.run('UPDATE assets SET code = ? WHERE id = ?', ['X', 'CNY'])).rejects.toBeInstanceOf(ReadOnlyPreviewError);
    await expect(driver.exec('DROP TABLE assets')).rejects.toBeInstanceOf(ReadOnlyPreviewError);
    expect(await driver.transaction(async (tx) => tx.get<{ code: string }>('SELECT code FROM assets WHERE id = ?', ['CNY']))).toEqual({ code: 'CNY' });
    await expect(driver.transaction(async (tx) => tx.run('UPDATE assets SET code = ? WHERE id = ?', ['X', 'CNY']))).rejects.toBeInstanceOf(ReadOnlyPreviewError);

    // The refusals must not have changed anything on the way past.
    expect((await driver.all<{ code: string }>('SELECT code FROM assets ORDER BY code')).map((row) => row.code)).toEqual(['CNY', 'USD']);
    await writable.close();
  });

  it('names the refusal in a sentence an operator can act on', async () => {
    const inner = await SqlJsDriver.open(null);
    const driver = readOnlyDriver(inner);
    const error = await driver.run('SELECT 1').catch((reason: unknown) => reason);
    expect(isReadOnlyPreviewError(error)).toBe(true);
    expect(String((error as Error).message)).toContain('只读预览');
    // The code is what a caller branches on; the message is what a person reads.
    expect((error as { code?: string }).code).toBe('PREVIEW_READ_ONLY');
    await inner.close();
  });
});

describe('preview store', () => {
  it('renders an imported backup and refuses to write through it', async () => {
    const store = await buildPreviewStore(await sampleBackup());

    const rows = await store.transactions.list();
    expect(rows.map((row) => row.id)).toEqual(['preview-tx']);
    // The amount must survive the round trip as the same number. `saveTransactionAggregate`
    // normalises through `D(...).toString()`, so "42.50" is stored as "42.5" — that is the
    // ledger's own canonical form, and the preview must agree with it exactly.
    expect(D(rows[0]!.amount).eq('42.50')).toBe(true);
    const manage = await loadSnapshot(store, 'manage');
    expect(manage.assets.map((asset) => asset.code)).toContain('CNY');

    // A screen that saves anyway — a stray effect, a form submit — must fail here rather than
    // reach the user's ledger.
    await expect(saveTransaction(store, transaction('sneaky', '1.00'))).rejects.toSatisfy(isReadOnlyPreviewError);
    expect((await store.transactions.list()).map((row) => row.id)).toEqual(['preview-tx']);
    await store.close();
  });

  it('opens its own database rather than the local one', async () => {
    // The driver is opened over `null` bytes, so there is no IndexedDB read at all. The check
    // that matters is that a separate local store cannot see the preview's rows — and vice
    // versa: the preview must not be reading the operator's own ledger.
    const preview = await buildPreviewStore(await sampleBackup());
    const local = await createLedgerStore(await SqlJsDriver.open(null));
    await seed(local);
    expect(await local.transactions.list()).toEqual([]);
    expect((await preview.transactions.list()).map((row) => row.id)).toEqual(['preview-tx']);
    await preview.close();
    await local.close();
  });
});

/** Compiles only if the guard keeps the full `SqlDriver` shape. */
const _shapeCheck: (driver: SqlDriver) => SqlDriver = readOnlyDriver;
void _shapeCheck;
