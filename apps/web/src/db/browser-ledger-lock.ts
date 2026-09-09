export const BROWSER_LEDGER_LOCK_NAME = 'zichan-browser-ledger.sqlite';

interface BrowserLockManager {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: object | null) => Promise<void>,
  ): Promise<void>;
}

let localLeaseTail: Promise<void> | null = null;

export class BrowserLedgerAlreadyOpenError extends Error {
  constructor(message = '账本已在另一个标签页打开。为防止本地数据互相覆盖，请关闭其他标签页后重试。') {
    super(message);
    this.name = 'BrowserLedgerAlreadyOpenError';
  }
}

/**
 * Hold one Web Lock for the complete lifetime of the in-memory sql.js store.
 * sql.js persists a whole encrypted SQLite snapshot, so concurrent tabs must
 * never load and later overwrite independent copies of the same database.
 */
export async function acquireBrowserLedgerLock(
  providedManager: BrowserLockManager | null | undefined = (
    typeof navigator === 'undefined'
      ? undefined
      : navigator.locks as unknown as BrowserLockManager | undefined
  ),
): Promise<() => Promise<void>> {
  const manager = providedManager ?? undefined;
  if (!manager) {
    throw new Error('当前浏览器不支持安全账本锁，无法打开本地数据库。请升级浏览器或使用桌面版。');
  }

  const previousLocalLease = localLeaseTail;
  let resolveLocalLease!: () => void;
  const currentLocalLease = new Promise<void>((resolve) => { resolveLocalLease = resolve; });
  localLeaseTail = currentLocalLease;
  if (previousLocalLease) await previousLocalLease;

  let acquiredSettled = false;
  let resolveAcquired!: (value: boolean) => void;
  let rejectAcquired!: (reason: unknown) => void;
  let releaseHold: (() => void) | undefined;
  let requestError: unknown;
  const acquired = new Promise<boolean>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const requestFlight = Promise.resolve().then(() => manager.request(
    accountStorageKey(BROWSER_LEDGER_LOCK_NAME),
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        acquiredSettled = true;
        resolveAcquired(false);
        return;
      }
      await new Promise<void>((resolve) => {
        releaseHold = resolve;
        acquiredSettled = true;
        resolveAcquired(true);
      });
    },
  )).catch((error: unknown) => {
    requestError = error;
    if (!acquiredSettled) {
      acquiredSettled = true;
      rejectAcquired(error);
    }
  });

  let lockAcquired: boolean;
  try {
    lockAcquired = await acquired;
    if (!lockAcquired) {
      await requestFlight;
      throw new BrowserLedgerAlreadyOpenError();
    }
  } catch (error) {
    if (localLeaseTail === currentLocalLease) localLeaseTail = null;
    resolveLocalLease();
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseHold?.();
    await requestFlight;
    if (localLeaseTail === currentLocalLease) localLeaseTail = null;
    resolveLocalLease();
    if (requestError) throw requestError;
  };
}
import { accountStorageKey } from '../account-storage.js';
