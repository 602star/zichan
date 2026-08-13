import {
  createContext, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import type { LedgerKind, Setting } from '@zichan/core';
import { createLedgerStore, runDueScheduledTransactions, type SqlLedgerStore } from '@zichan/db';
import { createLogger, consoleSink } from '@zichan/logger';
import { getDeviceId } from './cloud.js';
import {
  maybeAutoBackup,
  suspendAutomaticBackups,
  type AutomaticBackupSuspension,
} from './backups.js';
import { runLedgerMaintenance } from './maintenance.js';
import { writeSafetyState } from './safety.js';
import { openPlatformDriver, resetPlatformData, type StorageBackend } from './platform-driver.js';
import { recoverAttachmentStorage } from './attachment-storage.js';
import { isInitializationResetRequiredError } from './initialization-error.js';
import { initializedLedgerSetting } from './ledger-initialization.js';
import { FirstRunWizard } from '../ui/FirstRunWizard.js';
import {
  lockDeviceStorage,
  refreshDeviceStorageState,
  unlockDeviceStorage,
  type DeviceStorageState,
} from '../device-storage-key.js';

interface StoreCtx {
  store: SqlLedgerStore;
  /** Bumped after a write so data hooks reload. */
  rev: number;
  bump: () => void;
  storageBackend: StorageBackend;
  dataLocation: string;
  resetLocalData: () => Promise<void>;
}

const Ctx = createContext<StoreCtx | null>(null);
const storeCloseFlights = new WeakMap<object, Promise<void>>();

type ClosableStore = Pick<SqlLedgerStore, 'close'>;
type LifecycleErrorReporter = (message: string, detail: unknown) => void;

export type VoidSingleFlight = (task: () => Promise<void>) => Promise<void>;

/** Start the task synchronously and return the same Promise to every concurrent caller. */
export function createVoidSingleFlight(): VoidSingleFlight {
  let active: Promise<void> | null = null;
  return (task) => {
    if (active) return active;
    let flight: Promise<void>;
    try {
      flight = Promise.resolve(task());
    } catch (error) {
      flight = Promise.reject(error);
    }
    active = flight;
    void flight.then(
      () => { if (active === flight) active = null; },
      () => { if (active === flight) active = null; },
    );
    return flight;
  };
}

interface PendingInitialization {
  store: SqlLedgerStore;
  storageBackend: StorageBackend;
  dataLocation: string;
}

export async function closeStoreWhenCancelled(
  store: Pick<SqlLedgerStore, 'close'>,
  isCancelled: () => boolean,
): Promise<boolean> {
  if (!isCancelled()) return false;
  await closeStoreOnce(store);
  return true;
}

/** Await one shared close flight so retry cannot race a still-open SQLite connection. */
export function closeStoreOnce(store: Pick<SqlLedgerStore, 'close'>): Promise<void> {
  const existing = storeCloseFlights.get(store);
  if (existing) return existing;
  const flight = Promise.resolve().then(() => store.close()).catch((error) => {
    storeCloseFlights.delete(store);
    throw error;
  });
  storeCloseFlights.set(store, flight);
  return flight;
}

async function closeUniqueStores(stores: Array<ClosableStore | null | undefined>): Promise<void> {
  const unique = [...new Set(stores.filter((value): value is ClosableStore => !!value))];
  for (const current of unique) await closeStoreOnce(current);
}

/** Close every live ledger and clear published references before the key vault is locked. */
export async function closeStoresBeforeStorageLock(
  stores: Array<ClosableStore | null | undefined>,
  clearStores: () => void,
  lockStorage: () => Promise<void>,
): Promise<void> {
  await closeUniqueStores(stores);
  clearStores();
  await lockStorage();
}

interface ResetStoreLifecycleOptions {
  stores: Array<ClosableStore | null | undefined>;
  clearStores: () => void;
  lockStorage: () => Promise<void>;
  resetPlatform: () => Promise<void>;
  suspendBackups?: () => AutomaticBackupSuspension;
}

/**
 * Pause and drain automatic backups before closing SQLite and deleting platform data.
 * A successful reset intentionally leaves backups paused until the document reloads.
 */
export async function resetStoreLifecycle(options: ResetStoreLifecycleOptions): Promise<void> {
  const suspension = (options.suspendBackups ?? suspendAutomaticBackups)();
  try {
    await suspension.drain();
    await closeUniqueStores(options.stores);
    options.clearStores();
    await options.lockStorage();
    await options.resetPlatform();
  } catch (error) {
    suspension.resume();
    throw error;
  }
}

export async function refreshLedgerKindSafely(
  store: Pick<SqlLedgerStore, 'settings'>,
  apply: (kind: LedgerKind) => void,
  report: LifecycleErrorReporter = (message, detail) => console.warn(message, detail),
): Promise<void> {
  try {
    const settings = await store.settings.list({ limit: 1 });
    apply(settings[0]?.ledgerKind === 'demo' ? 'demo' : 'personal');
  } catch (error) {
    report('setting subscription refresh failed', error);
  }
}

export async function runScheduledTransactionsSafely(
  store: SqlLedgerStore,
  onChanged: () => void,
  execute: typeof runDueScheduledTransactions = runDueScheduledTransactions,
  report: LifecycleErrorReporter = (message, detail) => console.warn(message, detail),
): Promise<void> {
  try {
    const result = await execute(store);
    if (result.created || result.skipped || result.failed) onChanged();
    if (result.errors.length) report('scheduled transaction execution failed', result.errors);
  } catch (error) {
    report('scheduled transaction execution rejected', error);
  }
}

function Splash({ label }: { label: string }) {
  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#f0e9dc', color: '#6b6155', fontFamily: 'system-ui, sans-serif', fontSize: 14,
    }}>
      {label}
    </div>
  );
}

function DeviceStorageGate(props: {
  state: DeviceStorageState;
  busy: boolean;
  error: string;
  onUnlock: (password: string) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const creating = !props.state.initialized;
  const canSubmit = password.length >= 8 && (!creating || password === confirmation);
  return (
    <div style={{
      minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24,
      background: '#f0e9dc', color: '#4e473f', fontFamily: 'system-ui, sans-serif',
    }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void props.onUnlock(password);
        }}
        style={{ width: 'min(420px, 100%)', border: '1px solid #d6ccbd', background: '#fffdf9', padding: 24, boxShadow: '0 18px 48px rgba(75,61,43,.12)' }}
      >
        <div style={{ fontSize: 20, fontWeight: 900 }}>{creating ? '保护本机账本' : '解锁本机账本'}</div>
        <div style={{ marginTop: 7, color: '#756b60', fontSize: 13, lineHeight: 1.55 }}>{props.state.message}</div>
        <label style={{ display: 'block', marginTop: 20, fontSize: 12, fontWeight: 800 }}>
          本机数据密码
          <input
            autoFocus
            autoComplete={creating ? 'new-password' : 'current-password'}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={{ width: '100%', minHeight: 44, marginTop: 6, border: '1px solid #cfc4b4', padding: '0 11px', boxSizing: 'border-box', fontSize: 15 }}
          />
        </label>
        {creating && (
          <label style={{ display: 'block', marginTop: 12, fontSize: 12, fontWeight: 800 }}>
            再输入一次
            <input
              autoComplete="new-password"
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              style={{ width: '100%', minHeight: 44, marginTop: 6, border: '1px solid #cfc4b4', padding: '0 11px', boxSizing: 'border-box', fontSize: 15 }}
            />
          </label>
        )}
        <div style={{ minHeight: 20, marginTop: 8, color: '#a43f36', fontSize: 12 }}>
          {props.error || (password && password.length < 8 ? '密码至少需要 8 个字符' : creating && confirmation && password !== confirmation ? '两次输入不一致' : '')}
        </div>
        <button
          type="submit"
          disabled={!canSubmit || props.busy}
          style={{ width: '100%', minHeight: 44, marginTop: 6, border: 0, background: '#9b5b35', color: '#fff', fontWeight: 850, cursor: canSubmit && !props.busy ? 'pointer' : 'not-allowed', opacity: canSubmit && !props.busy ? 1 : 0.55 }}
        >
          {props.busy ? '正在解锁…' : creating ? '创建并打开' : '解锁'}
        </button>
        {props.state.initialized && (
          <button
            type="button"
            disabled={props.busy}
            onClick={() => void props.onReset()}
            style={{ width: '100%', marginTop: 12, border: 0, background: 'transparent', color: '#8c8175', fontSize: 12, cursor: props.busy ? 'not-allowed' : 'pointer' }}
          >
            忘记密码并重置本机开发数据
          </button>
        )}
      </form>
    </div>
  );
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<SqlLedgerStore | null>(null);
  const [rev, setRev] = useState(0);
  const [error, setError] = useState<{ message: string; resetRequired: boolean } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [storageBackend, setStorageBackend] = useState<StorageBackend>('browser-indexeddb');
  const [dataLocation, setDataLocation] = useState('');
  const [storageProtection, setStorageProtection] = useState<DeviceStorageState | null>(null);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [pendingInitialization, setPendingInitialization] = useState<PendingInitialization | null>(null);
  const [ledgerKind, setLedgerKind] = useState<LedgerKind>('personal');
  const unlockStorageFlight = useRef(createVoidSingleFlight()).current;
  const resetStorageFlight = useRef(createVoidSingleFlight()).current;
  const storageLockFlight = useRef(createVoidSingleFlight()).current;

  useEffect(() => {
    let active = true;
    void refreshDeviceStorageState()
      .then((state) => { if (active) setStorageProtection(state); })
      .catch((reason) => {
        if (active) setUnlockError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!storageProtection?.unlocked) return;
    let cancelled = false;
    let openedStore: SqlLedgerStore | null = null;
    let published = false;
    const closeOpenedStore = async () => {
      const current = openedStore;
      openedStore = null;
      published = false;
      if (current) await closeStoreOnce(current);
    };
    (async () => {
      try {
        const platform = await openPlatformDriver();
        if (await closeStoreWhenCancelled(platform.driver, () => cancelled)) return;
        const log = createLogger({ level: 'info', sinks: [consoleSink()], fields: { app: platform.backend === 'native-sqlite' ? 'native' : 'web' } });
        let s: SqlLedgerStore;
        try {
          s = await createLedgerStore(platform.driver, { logger: log, deviceId: getDeviceId() });
        } catch (error) {
          await platform.driver.close().catch(() => undefined);
          throw error;
        }
        openedStore = s;
        if (await closeStoreWhenCancelled(s, () => cancelled)) {
          openedStore = null;
          return;
        }
        const setting = await initializedLedgerSetting(s);
        if (await closeStoreWhenCancelled(s, () => cancelled)) {
          openedStore = null;
          return;
        }
        if (!setting) {
          published = true;
          setStorageBackend(platform.backend);
          setDataLocation(platform.dataLocation);
          setPendingInitialization({
            store: s,
            storageBackend: platform.backend,
            dataLocation: platform.dataLocation,
          });
          return;
        }
        await recoverAttachmentStorage(s);
        await runLedgerMaintenance(s);
        await runDueScheduledTransactions(s);
        if (await closeStoreWhenCancelled(s, () => cancelled)) {
          openedStore = null;
          return;
        }
        published = true;
        setStorageBackend(platform.backend);
        setDataLocation(platform.dataLocation);
        setLedgerKind(setting.ledgerKind ?? 'personal');
        setStore(s);
        void maybeAutoBackup(s)
          .then((entry) => {
            if (entry?.externalSaved) writeSafetyState({ lastExternalBackupAt: entry.createdAt, lastBackupError: undefined, lastBackupErrorAt: undefined });
          })
          .catch((backupError) => writeSafetyState({ lastBackupErrorAt: new Date().toISOString(), lastBackupError: backupError instanceof Error ? backupError.message : String(backupError) }));
      } catch (e) {
        await closeOpenedStore().catch(() => undefined);
        if (!cancelled) {
          setError({
            message: e instanceof Error ? e.message : String(e),
            resetRequired: isInitializationResetRequiredError(e),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (published) void closeOpenedStore().catch(() => undefined);
    };
  }, [storageProtection?.unlocked, initializationAttempt]);

  useEffect(() => {
    if (!store || rev === 0) return;
    void maybeAutoBackup(store)
      .then((entry) => {
        if (entry?.externalSaved) writeSafetyState({ lastExternalBackupAt: entry.createdAt, lastBackupError: undefined, lastBackupErrorAt: undefined });
      })
      .catch((backupError) => writeSafetyState({ lastBackupErrorAt: new Date().toISOString(), lastBackupError: backupError instanceof Error ? backupError.message : String(backupError) }));
  }, [store, rev]);

  useEffect(() => {
    if (!store) return;
    return store.subscribe((change) => {
      setRev((value) => value + 1);
      if (change.entityTypes.includes('setting') || change.entityTypes.includes('*')) {
        void refreshLedgerKindSafely(store, setLedgerKind);
      }
    });
  }, [store]);

  useEffect(() => {
    if (!store) return;
    let running = false;
    const execute = async () => {
      if (running) return;
      running = true;
      try {
        await runScheduledTransactionsSafely(store, () => setRev((value) => value + 1));
      } finally {
        running = false;
      }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') void execute(); };
    const onFocus = () => { void execute(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => void execute(), 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [store]);

  function resetDevelopmentData(requireConfirmation = true): Promise<void> {
    return resetStorageFlight(async () => {
      if (
        requireConfirmation
        &&
        !window.confirm(
          '将删除本机开发账本、附件、表单草稿和浏览器内备份。此操作不可撤销；只有浏览器外的 .zcbak 或服务器副本可用于恢复。确定继续吗？',
        )
      ) return;
      setResetting(true);
      try {
        await resetStoreLifecycle({
          stores: [store, pendingInitialization?.store],
          clearStores: () => {
            setStore(null);
            setPendingInitialization(null);
          },
          lockStorage: lockDeviceStorage,
          resetPlatform: resetPlatformData,
        });
        window.location.reload();
      } catch (reason) {
        setError({
          message: `重置失败：${reason instanceof Error ? reason.message : String(reason)}`,
          resetRequired: true,
        });
        setResetting(false);
      }
    });
  }

  function unlockStorage(password: string): Promise<void> {
    return unlockStorageFlight(async () => {
      setUnlockBusy(true);
      setUnlockError('');
      try {
        const unlocked = await unlockDeviceStorage(password);
        setStorageProtection(unlocked.state);
      } catch (reason) {
        setUnlockError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setUnlockBusy(false);
      }
    });
  }

  async function retryInitialization() {
    const pending = pendingInitialization;
    if (pending) {
      try {
        await closeStoreOnce(pending.store);
      } catch (reason) {
        setError({
          message: `关闭上一次数据库连接失败：${reason instanceof Error ? reason.message : String(reason)}`,
          resetRequired: false,
        });
        return;
      }
    }
    setError(null);
    setPendingInitialization(null);
    setInitializationAttempt((attempt) => attempt + 1);
  }

  async function finishFirstRun(setting: Setting) {
    const pending = pendingInitialization;
    if (!pending) throw new Error('首次初始化上下文已经失效，请重新打开账本');
    try {
      await recoverAttachmentStorage(pending.store);
      await runLedgerMaintenance(pending.store);
      await runDueScheduledTransactions(pending.store);
      setStorageBackend(pending.storageBackend);
      setDataLocation(pending.dataLocation);
      setLedgerKind(setting.ledgerKind ?? 'personal');
      setPendingInitialization(null);
      setStore(pending.store);
      void maybeAutoBackup(pending.store)
        .then((entry) => {
          if (entry?.externalSaved) writeSafetyState({ lastExternalBackupAt: entry.createdAt, lastBackupError: undefined, lastBackupErrorAt: undefined });
        })
        .catch((backupError) => writeSafetyState({ lastBackupErrorAt: new Date().toISOString(), lastBackupError: backupError instanceof Error ? backupError.message : String(backupError) }));
    } catch (reason) {
      setError({
        message: reason instanceof Error ? reason.message : String(reason),
        resetRequired: isInitializationResetRequiredError(reason),
      });
      throw reason;
    }
  }

  function returnToStorageUnlock(): Promise<void> {
    return storageLockFlight(async () => {
      setError(null);
      setUnlockError('');
      try {
        await closeStoresBeforeStorageLock(
          [store, pendingInitialization?.store],
          () => {
            setStore(null);
            setPendingInitialization(null);
          },
          lockDeviceStorage,
        );
        setStorageProtection(await refreshDeviceStorageState());
      } catch (reason) {
        setError({
          message: reason instanceof Error ? reason.message : '无法返回设备解锁页面',
          resetRequired: false,
        });
      }
    });
  }

  if (!storageProtection) return <Splash label={unlockError || '正在检查本机加密存储…'} />;
  if (!storageProtection.unlocked) {
    return (
      <DeviceStorageGate
        state={storageProtection}
        busy={unlockBusy || resetting}
        error={unlockError}
        onUnlock={unlockStorage}
        onReset={resetDevelopmentData}
      />
    );
  }
  if (error) {
    return (
      <div style={{ minHeight: '100dvh', padding: 40, fontFamily: 'system-ui, sans-serif', background: '#f0e9dc', color: '#6b2f27' }}>
        <div style={{ maxWidth: 720, margin: '10vh auto 0' }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>数据库初始化失败</div>
          <div style={{ marginTop: 12, fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>{error.message}</div>
          {error.resetRequired ? (
            <div style={{ marginTop: 12 }}>
              旧数据尚未被修改。请先确认已有浏览器外的 .zcbak 备份或服务器副本，再执行重置。
            </div>
          ) : null}
          <div style={{ marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {error.resetRequired && (
              <button
                type="button"
                disabled={resetting}
                onClick={() => void resetDevelopmentData()}
                style={{ minHeight: 44, padding: '0 16px', border: 0, borderRadius: 8, background: '#b4483d', color: '#fff', fontWeight: 800 }}
              >
                {resetting ? '正在重置…' : '重置本机开发数据'}
              </button>
            )}
            <button
              type="button"
              disabled={resetting}
              onClick={retryInitialization}
              style={{ minHeight: 44, padding: '0 16px', border: '1px solid #b9a99a', borderRadius: 8, background: '#fffdf9', color: '#6b2f27', fontWeight: 800 }}
            >
              重新尝试
            </button>
            <button
              type="button"
              disabled={resetting}
              onClick={() => void returnToStorageUnlock()}
              style={{ minHeight: 44, padding: '0 16px', border: 0, borderRadius: 8, background: 'transparent', color: '#6b2f27', fontWeight: 800 }}
            >
              返回解锁
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (pendingInitialization) {
    return <FirstRunWizard store={pendingInitialization.store} onInitialized={finishFirstRun} />;
  }
  if (!store) return <Splash label="正在加载账本…" />;

  return (
      <Ctx.Provider value={{ store, rev, bump: () => setRev((n) => n + 1), storageBackend, dataLocation, resetLocalData: () => resetDevelopmentData(false) }}>
      {ledgerKind === 'demo' && (
        <div
          role="status"
          aria-label="当前是演示账本"
          style={{ position: 'fixed', top: 8, left: '50%', zIndex: 10000, transform: 'translateX(-50%)', border: '1px solid #d8ad75', borderRadius: 999, padding: '4px 10px', background: '#fff4dc', color: '#7b451d', boxShadow: '0 4px 12px rgba(75,61,43,.13)', fontFamily: 'system-ui, sans-serif', fontSize: 12, fontWeight: 900, pointerEvents: 'none' }}
        >
          演示账本
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}

export function useStore(): StoreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStore must be used within <StoreProvider>');
  return c;
}
