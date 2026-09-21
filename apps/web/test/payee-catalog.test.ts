import { describe, expect, it } from 'vitest';
import { newId, SYSTEM_CATEGORY_CATALOG } from '@zichan/core';
import { openLedger } from '@zichan/db/node';
import { initializeEmptyLedger, QUICK_START_LEDGER_OPTIONS } from '../src/db/ledger-initialization.js';
import { catalogPayeeId, findPlatform, matchingPayee, PAYEE_SCENES, PLATFORM_CATALOG, relatedPlatforms } from '../src/payee-catalog.js';
import { rememberTransactionPayee } from '../src/payee-recording.js';
import { optionalTransactionFields } from '../src/transactionFormPrefs.js';

describe('platform suggestions and personal transaction counterparts', () => {
  it('maps the nine browsing scenes to real category IDs without changing classification', () => {
    expect(PAYEE_SCENES).toHaveLength(9);
    const categories = new Set(SYSTEM_CATEGORY_CATALOG.map((category) => category.id));
    for (const scene of PAYEE_SCENES) for (const id of scene.categories) expect(categories.has(id), id).toBe(true);
    for (const entry of PLATFORM_CATALOG) for (const id of entry.categories ?? []) expect(categories.has(id), id).toBe(true);
    expect(new Set(PLATFORM_CATALOG.map((entry) => entry.id)).size).toBe(PLATFORM_CATALOG.length);
    expect(relatedPlatforms('taxi_ride').map((entry) => entry.name)).toContain('滴滴出行');
    expect(relatedPlatforms('taxi_ride').map((entry) => entry.name)).not.toContain('神州租车');
    expect(relatedPlatforms('concert').map((entry) => entry.name)).toContain('大麦');
    expect(relatedPlatforms('concert').map((entry) => entry.name)).not.toContain('淘票票');
    expect(relatedPlatforms('movies').map((entry) => entry.name)).toContain('淘票票');
    expect(relatedPlatforms('salary')).toEqual([]);
    expect(findPlatform('  JD ')?.name).toBe('京东');
    expect(findPlatform('饿了么')?.name).toBe('淘宝闪购');
  });
  it('migrates either old preference to one unified field', () => {
    expect(optionalTransactionFields({ transactionFormOptionalFields: 'merchant,payeeId,note' } as never, true)).toEqual(['payeeId', 'note']);
  });
  it('creates only on save, rolls back failures, reuses renamed platforms and respects deactivation', async () => {
    const store = await openLedger();
    try {
      await initializeEmptyLedger(store, QUICK_START_LEDGER_OPTIONS);
      expect(await store.payees.count()).toBe(0);
      await expect(store.runInAuditBatch('failed record', async (tx) => {
        await rememberTransactionPayee(tx, { merchant: '淘宝' });
        throw new Error('record rejected');
      })).rejects.toThrow('record rejected');
      expect(await store.payees.count()).toBe(0);
      const id = await store.runInAuditBatch('record', (tx) => rememberTransactionPayee(tx, { merchant: 'taobao' }));
      const original = (await store.payees.get(id!))!;
      expect(original.name).toBe('淘宝');
      expect(original.defaultCategory).toBeUndefined();
      expect(original.defaultAccountId).toBeUndefined();
      const renamed = await store.payees.put({ ...original, name: '我的淘宝' });
      expect(await rememberTransactionPayee(store, { merchant: '淘宝' })).toBe(id);
      expect(matchingPayee([renamed], '淘宝')?.name).toBe('我的淘宝');
      expect(await store.payees.count()).toBe(1);
      await store.payees.put({ ...renamed, isActive: false });
      await expect(rememberTransactionPayee(store, { merchant: '淘宝' })).rejects.toThrow('停用');
    } finally { await store.close(); }
  });
  it('reuses existing aliases without overwriting configured defaults and measures usage across the whole ledger', async () => {
    const store = await openLedger();
    try {
      const setting = await initializeEmptyLedger(store, QUICK_START_LEDGER_OPTIONS);
      const payee = await store.payees.put({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
        name: '购物平台', aliases: ['京东'], isActive: true, defaultCategory: 'shopping', defaultAccountId: setting.expenseDefaultAccountId });
      expect(await rememberTransactionPayee(store, { merchant: 'JD' })).toBe(payee.id);
      expect((await store.payees.get(payee.id))?.defaultAccountId).toBe(setting.expenseDefaultAccountId);
      expect(payee.id).not.toBe(catalogPayeeId(findPlatform('JD')!));
      for (const date of ['2020-01-01', '2026-09-21']) {
        await store.transactions.put({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
          date, type: 'expense', category: 'shopping', assetId: setting.baseCurrencyAssetId, amount: '10', payeeId: payee.id });
      }
      const usage = await store.payeeUsage();
      expect(usage).toHaveLength(1);
      expect(usage[0]?.count).toBe(2);
      const first = (await store.transactions.list())[0]!;
      await store.transactions.remove(first.id, first.version);
      expect((await store.payeeUsage())[0]?.count).toBe(1);
    } finally { await store.close(); }
  });
});
