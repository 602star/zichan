import { withSharedBrowserTaskLock } from './db/shared-browser-driver.js';

let tail: Promise<unknown> = Promise.resolve();
let ledgerSwitching = false;
/** Prevent a new sync from starting after the server session has changed ledgers. */
export function suspendSyncForLedgerSwitch(): () => void {
  ledgerSwitching = true;
  return () => { ledgerSwitching = false; };
}
/** Serialize key transitions with all data/attachment synchronization in this document. */
export function withSyncLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = () => ledgerSwitching
    ? Promise.reject<T>(new Error('账本正在切换，请等待页面重新打开'))
    : withSharedBrowserTaskLock('sync', operation);
  const task = tail.then(run, run);
  tail = task.catch(() => undefined);
  return task;
}
