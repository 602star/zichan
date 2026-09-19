import { describe, expect, it } from 'vitest';
import { newId, type Attachment, type BaseEntity, type Category, type Collection } from '@zichan/core';
import { openLedger } from '@zichan/db/node';
import type { SqlLedgerStore } from '@zichan/db';
import { loadSnapshot } from '../src/db/snapshot.js';
import { checkAllAttachmentFiles, cleanupAllTestTransactions } from '../src/db/settings-maintenance.js';

function base(id = newId()) {
  return { id, createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

function pagedCollection<T extends BaseEntity>(rows: T[]): Pick<Collection<T>, 'count' | 'listPage'> {
  return {
    async count() {
      return rows.length;
    },
    async listPage(query = {}) {
      const limit = query.limit ?? 100;
      const start = query.cursor
        ? rows.findIndex((row) => row.id === query.cursor!.id) + 1
        : 0;
      const pageRows = rows.slice(start, start + limit);
      const hasMore = start + pageRows.length < rows.length;
      const last = pageRows.at(-1);
      return {
        rows: pageRows,
        hasMore,
        ...(hasMore && last ? { nextCursor: { value: last.id, id: last.id } } : {}),
      };
    },
  };
}

function attachment(index: number): Attachment {
  return {
    ...base(`attachment-${String(index).padStart(4, '0')}`),
    entityType: 'transaction',
    entityId: `transaction-${index}`,
    fileName: `${index}.txt`,
    sizeBytes: 1,
    sha256: String(index % 10).repeat(64),
  };
}

describe('Settings maintenance reads', () => {
  it('loads the complete lightweight category catalog without loading transactions', async () => {
    const categories = Array.from({ length: 405 }, (_, index): Category => ({
      ...base(`category-${String(index).padStart(4, '0')}`),
      name: `Category ${index}`,
      type: 'expense',
      parentId: 'expense-root',
      isActive: true,
    }));
    const empty = pagedCollection<BaseEntity>([]);
    const store = {
      assets: empty,
      accounts: empty,
      settings: empty,
      categories: pagedCollection(categories),
      listStepsByChains: async () => new Map(),
    } as unknown as SqlLedgerStore;

    const snapshot = await loadSnapshot(store, 'settings');

    expect(snapshot.categories).toHaveLength(405);
    expect(snapshot.rowCounts?.categories).toBe(405);
    expect(snapshot.transactions).toEqual([]);
    expect(snapshot.attachments).toEqual([]);
  });

  it('checks attachments after the first 400-row page and reports failures independently', async () => {
    const rows = Array.from({ length: 405 }, (_, index) => attachment(index));
    const visited: string[] = [];
    const issues = await checkAllAttachmentFiles(
      { attachments: pagedCollection(rows) as Collection<Attachment> },
      async (row) => {
        visited.push(row.id);
        if (row.id.endsWith('0403')) throw new Error('read failed');
        return !row.id.endsWith('0404');
      },
    );

    expect(visited).toHaveLength(405);
    expect(issues.map((issue) => issue.entityId)).toEqual(['attachment-0403', 'attachment-0404']);
  });

  it('cleans more than one SQL page and removes attachments belonging to late matches', async () => {
    const store = await openLedger({ deviceId: 'settings-maintenance-test' });
    try {
      await store.assets.put({
        ...base('GBP'), code: 'GBP', name: 'Pound', type: 'fiat', decimals: 2, isActive: true,
      } as never);
      await store.categories.put({
        ...base('income-root'), name: 'Income', type: 'income', isActive: true,
      } as never);
      await store.categories.put({
        ...base('salary'), name: 'Salary', type: 'income', parentId: 'income-root', isActive: true,
      } as never);
      await store.transaction(async (transactionStore) => {
        for (let index = 0; index < 405; index += 1) {
          const id = `test-transaction-${String(index).padStart(4, '0')}`;
          await transactionStore.transactions.put({
            ...base(id),
            date: '2026-08-13',
            type: 'income',
            category: 'salary',
            amount: '1',
            assetId: 'GBP',
            ...(index === 1
              ? { merchant: '测试商户' }
              : index === 2
                ? { note: 'cleanup TEST note' }
                : { description: index % 2 === 0 ? `batch TEST ${index}` : `批量测试 ${index}` }),
          } as never);
        }
        await transactionStore.transactions.put({
          ...base('production-transaction'),
          date: '2026-08-13',
          type: 'income',
          category: 'salary',
          amount: '2',
          assetId: 'GBP',
          description: 'production entry',
        } as never);
        await transactionStore.attachments.put({
          ...attachment(404),
          id: 'late-test-attachment',
          entityId: 'test-transaction-0404',
        });
      });

      const cleaned = await cleanupAllTestTransactions(store);

      expect(cleaned).toEqual({ transactions: 405, attachments: 1 });
      expect((await store.transactionBrowsePage({ recordState: 'active' })).totalCount).toBe(1);
      expect((await store.transactions.get('production-transaction'))?.recordState).not.toBe('voided');
      expect((await store.transactions.get('test-transaction-0404'))?.recordState).toBe('voided');
      expect((await store.attachments.get('late-test-attachment'))?.isDeleted).toBe(true);
    } finally {
      await store.close();
    }
  }, 20_000);
});
