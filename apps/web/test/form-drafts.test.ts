import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { deleteFormDraft, listFormDrafts, saveFormDraft } from '../src/db/form-drafts.js';
import { readRestoreEntryDraft, writeRestoreEntryDraft } from '../src/draft-preferences.js';

const runtime = vi.hoisted(() => ({ account: 'draft-account-A', preferences: new Map<string, string>() }));
vi.mock('../src/account-storage.js', () => ({
  accountDatabaseName: () => runtime.account,
  accountLocalStorage: {
    getItem: (key: string) => runtime.preferences.get(`${runtime.account}:${key}`) ?? null,
    setItem: (key: string, value: string) => runtime.preferences.set(`${runtime.account}:${key}`, value),
  },
}));
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); runtime.account = 'draft-account-A'; runtime.preferences.clear(); });

describe('independent entry drafts', () => {
  it('preserves legacy and separate sessions with attachment blobs, and deletes only the saved session', async () => {
    const attachment = { fileName: 'receipt.png', mimeType: 'image/png', contentBlob: new Blob(['local-image']), sizeBytes: 11 };
    const first = await saveFormDraft('日常收支:new', { amount: '12.50' }, { attachmentDrafts: [attachment] });
    const second = await saveFormDraft('日常收支:new:session:B', { amount: '28' }, {});
    await saveFormDraft('日常收支:new-other', { amount: '99' }, {});
    await saveFormDraft('日常收支:edit-id', { amount: '88' }, {});
    const rows = await listFormDrafts('日常收支:new');
    expect(rows.map((row) => row.key).sort()).toEqual([first.key, second.key].sort());
    const restored = rows.find((row) => row.key === first.key)!;
    expect(await restored.files.attachmentDrafts![0]!.contentBlob!.text()).toBe('local-image');
    await deleteFormDraft(second.key);
    expect((await listFormDrafts('日常收支:new')).map((row) => row.key)).toEqual([first.key]);
    runtime.account = 'draft-account-B';
    expect(await listFormDrafts('日常收支:new')).toEqual([]);
  });
  it('starts fresh by default and scopes the opt-in preference to the account', () => {
    expect(readRestoreEntryDraft()).toBe(false);
    writeRestoreEntryDraft(true); expect(readRestoreEntryDraft()).toBe(true);
    runtime.account = 'draft-account-B'; expect(readRestoreEntryDraft()).toBe(false);
    runtime.account = 'draft-account-A'; writeRestoreEntryDraft(false); expect(readRestoreEntryDraft()).toBe(false);
  });
});
