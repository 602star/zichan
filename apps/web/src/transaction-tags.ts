import { newId } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';

const DRAFT_PREFIX = 'new-tag:';
export const draftTagValue = (name: string) => DRAFT_PREFIX + encodeURIComponent(name.trim());
export function draftTagName(value: string): string | undefined {
  if (!value.startsWith(DRAFT_PREFIX)) return undefined;
  return decodeURIComponent(value.slice(DRAFT_PREFIX.length));
}

/** Called inside the transaction save batch: cancelling a form creates no tags. */
export async function resolveTransactionTags(store: SqlLedgerStore, values: string[] = []): Promise<string[]> {
  const tags = await store.transactionTags.list();
  const ids: string[] = [];
  for (const value of values) {
    const name = draftTagName(value);
    if (name === undefined) {
      ids.push(value);
      continue;
    }
    if (!name.trim()) continue;
    const existing = tags.find((tag) => !tag.isDeleted && tag.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) {
      if (!existing.isActive) {
        const restored = await store.transactionTags.put({ ...existing, isActive: true });
        tags[tags.indexOf(existing)] = restored;
      }
      ids.push(existing.id);
    } else {
      const tag = await store.transactionTags.put({
        id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
        name, isActive: true, sortOrder: 100,
      });
      tags.push(tag);
      ids.push(tag.id);
    }
  }
  return [...new Set(ids)];
}
