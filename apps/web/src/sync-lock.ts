let tail: Promise<unknown> = Promise.resolve();
/** Serialize key transitions with all data/attachment synchronization in this document. */
export function withSyncLock<T>(operation: () => Promise<T>): Promise<T> {
  const task = tail.then(operation, operation);
  tail = task.catch(() => undefined);
  return task;
}
