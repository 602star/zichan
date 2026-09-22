import { describe, expect, it } from 'vitest';
import { openLedger } from '@zichan/db/node';
import { draftTagName, draftTagValue, restoreTagValue, resolveTransactionTags } from '../src/transaction-tags.js';

describe('tags created while recording a transaction', () => {
  it('preserves punctuation through form values and drafts', () => {
    const value = draftTagValue('  餐饮,朋友 / 50%  ');
    expect(value.split(',')).toHaveLength(1);
    expect(draftTagName(value)).toBe('餐饮,朋友 / 50%');
    expect(draftTagName('existing-id')).toBeUndefined();
  });
  it('deduplicates names, restores inactive tags, and rolls back failed saves', async () => {
    const store = await openLedger({ deviceId: 'tags-test' });
    try {
      const ids = await store.runInAuditBatch('save tags', (tx) => resolveTransactionTags(tx, [draftTagValue('Travel'), draftTagValue('travel')]));
      expect(ids).toHaveLength(1);
      const tag = (await store.transactionTags.get(ids[0]!))!;
      await store.transactionTags.put({ ...tag, isActive: false });
      expect(await store.runInAuditBatch('restore tag', (tx) => resolveTransactionTags(tx, [restoreTagValue(tag.id), tag.id]))).toEqual(ids);
      expect((await store.transactionTags.get(tag.id))?.isActive).toBe(true);
      await expect(store.runInAuditBatch('failed save', async (tx) => {
        await resolveTransactionTags(tx, [draftTagValue('取消的新标签')]);
        throw new Error('save failed');
      })).rejects.toThrow('save failed');
      expect((await store.transactionTags.list()).map((row) => row.name)).toEqual(['Travel']);
    } finally {
      await store.close();
    }
  });
});


it('resolves grouped tags precisely and requires explicit restoration', async () => {
  const store = await openLedger({ deviceId: 'group-tags' });
  try {
    const ids = await store.runInAuditBatch('groups', (tx) => resolveTransactionTags(tx, [draftTagValue('差旅', '工作'), draftTagValue('差旅', '个人')]));
    expect(ids).toHaveLength(2);
    await expect(store.runInAuditBatch('legacy ambiguous', (tx) => resolveTransactionTags(tx, ['new-tag:' + encodeURIComponent('差旅')]))).rejects.toThrow('多个同名');
    expect(await store.runInAuditBatch('reuse', (tx) => resolveTransactionTags(tx, [draftTagValue('差旅', '工作')]))).toEqual([ids[0]]);
    const tag = (await store.transactionTags.get(ids[0]!))!;
    await store.transactionTags.put({ ...tag, isActive: false });
    await expect(store.runInAuditBatch('implicit', (tx) => resolveTransactionTags(tx, [draftTagValue('差旅', '工作')]))).rejects.toThrow('恢复并选择');
    expect((await store.transactionTags.get(tag.id))?.isActive).toBe(false);
    expect(await store.runInAuditBatch('explicit', (tx) => resolveTransactionTags(tx, [restoreTagValue(tag.id)]))).toEqual([tag.id]);
  } finally { await store.close(); }
});
