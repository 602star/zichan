import { useEffect, useRef, useState } from 'react';
import {
  authenticateBiometric,
  biometricStatus,
  readDevicePreferences,
  recentlyAuthenticatedBiometric,
  type BiometricStatus,
} from '../device-capabilities.js';

export function shouldRelockApp(enabled: boolean, hiddenAt: number | null, visibleAt: number, thresholdMs = 1_000): boolean {
  return enabled && hiddenAt !== null && visibleAt - hiddenAt > thresholdMs;
}

export type AppLockResumeAction = 'none' | 'restore' | 'authenticate';

export function appLockResumeAction(
  enabled: boolean,
  hiddenAt: number | null,
  visibleAt: number,
  wasLockedBeforeHidden: boolean,
  authenticationBusy: boolean,
  thresholdMs = 1_000,
): AppLockResumeAction {
  if (!enabled || hiddenAt === null) return 'none';
  if (visibleAt - hiddenAt > thresholdMs) return 'authenticate';
  return !wasLockedBeforeHidden && !authenticationBusy ? 'restore' : 'none';
}

export async function authenticateAppLock(
  checkStatus: () => Promise<BiometricStatus> = biometricStatus,
  authenticate: () => Promise<void> = () => authenticateBiometric(),
): Promise<void> {
  const status = await checkStatus();
  try {
    // Authentication still runs when biometric status is unavailable because
    // the plugin may fall back to the device PIN/password.
    await authenticate();
  } catch (error) {
    if (!status.isAvailable) throw new Error(status.error || '设备验证暂不可用，请稍后重试');
    throw error;
  }
}

export function AppSecurityGate() {
  const [enabled, setEnabled] = useState(() => readDevicePreferences().biometricLock);
  const [locked, setLocked] = useState(() => readDevicePreferences().biometricLock && !recentlyAuthenticatedBiometric());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hiddenAt = useRef<number | null>(null);
  const wasLockedBeforeHidden = useRef(locked);
  const lockedRef = useRef(locked);
  const busyRef = useRef(false);
  const requestId = useRef(0);

  function setLockState(next: boolean) {
    lockedRef.current = next;
    setLocked(next);
  }

  async function unlock() {
    if (busyRef.current || !enabled) return;
    const id = ++requestId.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await authenticateAppLock();
      if (id === requestId.current) setLockState(false);
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      if (id === requestId.current) setBusy(false);
    }
  }

  useEffect(() => {
    const onPreferences = () => {
      const next = readDevicePreferences().biometricLock;
      setEnabled(next);
      if (!next || recentlyAuthenticatedBiometric()) setLockState(false);
      else setLockState(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        wasLockedBeforeHidden.current = lockedRef.current;
        if (enabled) setLockState(true);
        return;
      }
      const action = appLockResumeAction(
        enabled,
        hiddenAt.current,
        Date.now(),
        wasLockedBeforeHidden.current,
        busyRef.current,
      );
      if (action === 'restore') setLockState(false);
      if (action === 'authenticate') {
        setLockState(true);
        queueMicrotask(() => void unlock());
      }
      hiddenAt.current = null;
    };
    window.addEventListener('zichan:device-preferences-changed', onPreferences);
    document.addEventListener('visibilitychange', onVisibility);
    if (enabled && lockedRef.current) queueMicrotask(() => void unlock());
    return () => {
      requestId.current += 1;
      window.removeEventListener('zichan:device-preferences-changed', onPreferences);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  if (!enabled || !locked) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="应用已锁定" style={{
      position: 'fixed', inset: 0, zIndex: 10000, display: 'grid', placeItems: 'center',
      background: 'var(--bg, #f3eee7)', color: 'var(--fg, #302e2b)', padding: 24,
    }}>
      <div style={{ width: 'min(380px, 100%)', textAlign: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 900 }}>资产生命周期</div>
        <div style={{ marginTop: 10, color: 'var(--fg-muted, #6f6961)', fontSize: 13 }}>
          {busy ? '正在等待设备验证…' : '应用已锁定'}
        </div>
        {error && <div style={{ marginTop: 12, color: 'var(--negative, #b4483d)', fontSize: 12, overflowWrap: 'anywhere' }}>{error}</div>}
        <button type="button" onClick={() => void unlock()} disabled={busy} style={{
          marginTop: 18, height: 40, padding: '0 18px', border: 0, borderRadius: 8,
          background: 'var(--accent, #b56345)', color: '#fff', fontWeight: 800, cursor: busy ? 'wait' : 'pointer',
        }}>
          {busy ? '验证中…' : '使用生物识别或设备密码解锁'}
        </button>
      </div>
    </div>
  );
}
