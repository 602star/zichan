import { withSharedBrowserTaskLock } from './db/shared-browser-driver.js';

let tail: Promise<unknown> = Promise.resolve();
/** Serialize data and attachment synchronization in this document. */
export function withSyncLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = () => withSharedBrowserTaskLock('sync', operation);
  const task = tail.then(run, run);
  tail = task.catch(() => undefined);
  return task;
}
