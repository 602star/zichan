import {
  createContext, useContext, useEffect, useState, type ReactNode,
} from 'react';
import { createLedgerStore, isSchemaResetRequiredError, runDueScheduledTransactions, type SqlLedgerStore } from '@zichan/db';
import { createLogger, consoleSink } from '@zichan/logger';
import { seedIfEmpty } from './seed.js';
import { getDeviceId } from './cloud.js';
import { maybeAutoBackup } from './backups.js';
import { runLedgerMaintenance } from './maintenance.js';
import { writeSafetyState } from './safety.js';
import { openPlatformDriver, resetPlatformData, type StorageBackend } from './platform-driver.js';
import { recoverAttachmentStorage } from './attachment-storage.js';
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
}

const Ctx = createContext<StoreCtx | null>(null);

export async function closeStoreWhenCancelled(
  store: Pick<SqlLedgerStore, 'close'>,
  isCancelled: () => boolean,
): Promise<boolean> {
  if (!isCancelled()) return false;
  await store.close();
  return true;
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
      await current?.close();
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
        await seedIfEmpty(s);
        if (await closeStoreWhenCancelled(s, () => cancelled)) {
          openedStore = null;
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
            resetRequired: isSchemaResetRequiredError(e),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (published) void closeOpenedStore();
    };
  }, [storageProtection?.unlocked]);

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
    return store.subscribe(() => setRev((value) => value + 1));
  }, [store]);

  useEffect(() => {
    if (!store) return;
    let running = false;
    const execute = async () => {
      if (running) return;
      running = true;
      try {
        const result = await runDueScheduledTransactions(store);
        if (result.created || result.skipped || result.failed) setRev((value) => value + 1);
        if (result.errors.length) console.warn('scheduled transaction execution failed', result.errors);
      } finally {
        running = false;
      }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') void execute(); };
    window.addEventListener('focus', execute);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => void execute(), 60_000);
    return () => {
      window.removeEventListener('focus', execute);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [store]);

  async function resetDevelopmentData() {
    if (!window.confirm('将删除本机开发账本、附件和浏览器缓存数据。确定继续吗？')) return;
    setResetting(true);
    try {
      if (store) {
        await store.close();
        setStore(null);
      }
      await lockDeviceStorage();
      await resetPlatformData();
      window.location.reload();
    } catch (reason) {
      setError({
        message: `重置失败：${reason instanceof Error ? reason.message : String(reason)}`,
        resetRequired: true,
      });
      setResetting(false);
    }
  }

  async function unlockStorage(password: string) {
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
          {error.resetRequired && (
            <button
              type="button"
              disabled={resetting}
              onClick={() => void resetDevelopmentData()}
              style={{ marginTop: 20, minHeight: 44, padding: '0 16px', border: 0, borderRadius: 8, background: '#b4483d', color: '#fff', fontWeight: 800 }}
            >
              {resetting ? '正在重置…' : '重置本地开发数据'}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!store) return <Splash label="正在加载账本…" />;

  return <Ctx.Provider value={{ store, rev, bump: () => setRev((n) => n + 1), storageBackend, dataLocation }}>{children}</Ctx.Provider>;
}

export function useStore(): StoreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStore must be used within <StoreProvider>');
  return c;
}
