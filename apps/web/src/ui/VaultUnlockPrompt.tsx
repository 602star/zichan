import { useEffect, useRef, useState } from 'react';
import {
  credentialVaultState,
  refreshCredentialVaultState,
  unlockCredentialVault,
  VAULT_STATE_CHANGED_EVENT,
  type CredentialVaultState,
} from '../credential-vault.js';
import { loadAutoSync, loadSyncConnections, SYNC_CONFIG_CHANGED_EVENT } from '../sync-config.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export function runSynchronousFlight<T>(
  flightRef: { current: Promise<T> | null },
  operation: () => Promise<T>,
): Promise<T> {
  if (flightRef.current) return flightRef.current;
  const flight = Promise.resolve().then(operation);
  flightRef.current = flight;
  const release = () => {
    if (flightRef.current === flight) flightRef.current = null;
  };
  void flight.then(release, release);
  return flight;
}

export function VaultUnlockPrompt() {
  const [vault, setVault] = useState<CredentialVaultState>(credentialVaultState);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(() => loadAutoSync().enabled);
  const [dismissed, setDismissed] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const unlockFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    void refreshCredentialVaultState().then(setVault).catch(() => undefined);
    const onVault = () => setVault(credentialVaultState());
    const onConfig = (event: Event) => {
      setAutoSyncEnabled(loadAutoSync().enabled);
      if ((event as CustomEvent<{ kind?: string }>).detail?.kind === 'auto') setDismissed(false);
    };
    window.addEventListener(VAULT_STATE_CHANGED_EVENT, onVault);
    window.addEventListener(SYNC_CONFIG_CHANGED_EVENT, onConfig);
    return () => {
      window.removeEventListener(VAULT_STATE_CHANGED_EVENT, onVault);
      window.removeEventListener(SYNC_CONFIG_CHANGED_EVENT, onConfig);
    };
  }, []);

  function unlock(): Promise<void> {
    return runSynchronousFlight(unlockFlight, async () => {
      setBusy(true);
      setError('');
      try {
        await unlockCredentialVault(password, loadSyncConnections().map((profile) => profile.id));
        setVault(credentialVaultState());
        setPassword('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    });
  }

  if (dismissed || !autoSyncEnabled || vault.kind !== 'native-stronghold' || !vault.initialized || vault.unlocked) return null;
  return (
    <ConfirmDialog
      title="解锁同步密码库"
      confirmLabel="解锁并同步"
      cancelLabel="本次稍后"
      busy={busy}
      onCancel={() => setDismissed(true)}
      onConfirm={unlock}
    >
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginBottom: 10 }}>自动同步已启用。输入本机密码后会读取 Stronghold，并继续本次启动同步。</div>
      <input
        autoFocus
        aria-label="启动时解锁 Stronghold"
        className="zc-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && password.length >= 8) void unlock(); }}
        placeholder="Stronghold 本机密码"
      />
      {error && <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)', marginTop: 8, overflowWrap: 'anywhere' }}>{error}</div>}
    </ConfirmDialog>
  );
}
