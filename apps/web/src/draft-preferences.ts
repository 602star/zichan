import { accountLocalStorage } from './account-storage.js';
const KEY = 'zichan.restore-entry-draft.v1';
export function readRestoreEntryDraft(): boolean {
  try { return accountLocalStorage.getItem(KEY) === 'true'; } catch { return false; }
}
export function writeRestoreEntryDraft(enabled: boolean): void {
  accountLocalStorage.setItem(KEY, String(enabled));
}
