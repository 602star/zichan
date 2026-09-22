import { newId } from '@zichan/core';
import { normalizeIdentity, type SqlLedgerStore } from '@zichan/db';

const DRAFT_PREFIX = 'new-tag:';
const GROUP_PREFIX = 'new-group-tag:';
const RESTORE_PREFIX = 'restore-tag:';
export const draftTagValue = (name: string, groupName = '') => GROUP_PREFIX + encodeURIComponent(JSON.stringify([groupName.trim(), name.trim()]));
export const restoreTagValue = (id: string) => RESTORE_PREFIX + encodeURIComponent(id);
export const restoredTagId = (value: string): string | undefined => value.startsWith(RESTORE_PREFIX) ? decodeURIComponent(value.slice(RESTORE_PREFIX.length)) : undefined;
export function draftTag(value: string): { name: string; groupName?: string } | undefined {
  if (value.startsWith(DRAFT_PREFIX)) return { name: decodeURIComponent(value.slice(DRAFT_PREFIX.length)) };
  if (!value.startsWith(GROUP_PREFIX)) return undefined;
  const [groupName, name] = JSON.parse(decodeURIComponent(value.slice(GROUP_PREFIX.length))) as [string, string];
  return { name, groupName };
}
export const draftTagName = (value: string): string | undefined => draftTag(value)?.name;
export function draftTagLabel(value: string): string | undefined {
  const tag = draftTag(value);
  return tag ? tag.groupName ? `${tag.groupName} / ${tag.name}` : tag.name : undefined;
}

/** Called inside the owning record's audit transaction. Restoration requires an explicit ID token. */
export async function resolveTransactionTags(store: SqlLedgerStore, values: string[] = []): Promise<string[]> {
  const tags = await store.transactionTags.list();
  const ids: string[] = [];
  for (const value of values) {
    const restoreId = restoredTagId(value);
    if (restoreId) {
      const existing = tags.find((tag) => tag.id === restoreId && !tag.isDeleted);
      if (!existing) throw new Error('待恢复的标签已删除，请重新选择');
      const restored = existing.isActive ? existing : await store.transactionTags.put({ ...existing, isActive: true });
      tags[tags.indexOf(existing)] = restored;
      ids.push(restored.id);
      continue;
    }
    const draft = draftTag(value);
    if (!draft) { ids.push(value); continue; }
    if (!draft.name.trim()) continue;
    const matches = tags.filter((tag) => !tag.isDeleted && normalizeIdentity(tag.name) === normalizeIdentity(draft.name)
      && (draft.groupName === undefined || normalizeIdentity(tag.groupName) === normalizeIdentity(draft.groupName)));
    if (matches.length > 1) throw new Error('有多个同名标签，请明确选择分组');
    const existing = matches[0];
    if (existing) {
      if (!existing.isActive) throw new Error('标签已停用，请明确选择“恢复并选择”');
      ids.push(existing.id);
    } else {
      const tag = await store.transactionTags.put({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
        name: draft.name.trim(), groupName: draft.groupName?.trim() || undefined, isActive: true, sortOrder: 100 });
      tags.push(tag);
      ids.push(tag.id);
    }
  }
  return [...new Set(ids)];
}
