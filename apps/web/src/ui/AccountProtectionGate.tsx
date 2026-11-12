import { useEffect, useRef, useState, type ReactNode } from 'react';
import { accountProtection, protectionRequest, unlockAccountProtection, type ProtectionInfo } from '../account-protection.js';
import { unlockDeviceStorage } from '../device-storage-key.js';
import type { SyncConnection } from '../sync-config.js';
import { persistCredential, runtimeCredentialMap } from '../credential-vault.js';
import { isTauriRuntime } from '../tauri.js';
import { cryptoContextProblem } from '../browser-storage-policy.js';
import { enableOfflinePassword } from '../offline-access.js';
import { takeLoginPassword } from '../login-password.js';
import { adoptFirstWebLedgerReplica } from '../account-storage.js';
import { STARTUP_READY_EVENT, measureStartupStage, startStartupTiming, startupTimingSnapshot } from '../startup-timing.js';
import { uploadStartupTiming } from '../startup-timing-upload.js';

export function AccountProtectionGate({ connection, children }: { connection: SyncConnection; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('正在确认账号和账本保护设置…');
  const flight = useRef<Promise<ProtectionInfo>>();

  useEffect(() => {
    let active = true;
    startStartupTiming();
    const sendTiming = () => {
      const snapshot = startupTimingSnapshot();
      if (snapshot) void uploadStartupTiming(connection, snapshot).catch(() => undefined);
    };
    window.addEventListener(STARTUP_READY_EVENT, sendTiming, { once: true });
    let prepareOffline: (() => void) | undefined;
    flight.current ??= (async () => {
      return measureStartupStage('account.protectionRequest', async () => {
        const current = await protectionRequest(connection);
        return current.mode ? current : protectionRequest(connection, 'POST', { mode: 'managed' }, '/initialize');
      });
    })();
    void flight.current.then(async (current) => {
      if (!active) return;
      const problem = cryptoContextProblem();
      if (problem) throw new Error(problem);
      if (current.mode !== 'managed') throw new Error('此账本未启用服务器托管，请联系管理员');
      if (active) setStage('正在解锁账本密钥…');
      await measureStartupStage('account.unlockLedgerKey', () => unlockAccountProtection(connection, current));
      if (!active) return;
      if (connection.serverId && connection.accountId && current.replica) {
        adoptFirstWebLedgerReplica(connection.serverId, connection.accountId,
          current.replica.ledgerId, current.replica.replicaId, current.replica.streamEpoch);
      }
      const credentials = runtimeCredentialMap();
      if (active) setStage('正在解锁本机加密存储…');
      await measureStartupStage('account.unlockDeviceStorage', () => unlockDeviceStorage(accountProtection()!.secret, true));
      if (!active) return;
      if (isTauriRuntime()) for (const [id, credential] of Object.entries(credentials)) {
        if (credential.refreshToken) await persistCredential(id, credential);
      }
      const password = takeLoginPassword(connection.serverId, connection.accountId);
      if (password) {
        prepareOffline = () => {
          if (!active) return;
          const run = () => {
            if (active) void measureStartupStage('background.prepareOfflinePassword',
              () => enableOfflinePassword(password)).catch(() => undefined);
          };
          if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 5_000 });
          else globalThis.setTimeout(run, 0);
        };
        window.addEventListener(STARTUP_READY_EVENT, prepareOffline, { once: true });
      }
      if (active) setReady(true);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => {
      active = false;
      window.removeEventListener(STARTUP_READY_EVENT, sendTiming);
      if (prepareOffline) window.removeEventListener(STARTUP_READY_EVENT, prepareOffline);
    };
    // This gate is mounted for one fixed authenticated account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  if (ready) return <>{children}</>;
  return <main className="zc-protection" style={{ maxWidth: 600, margin: '10vh auto', padding: 24 }}>
    <h1>正在打开账本</h1>
    {error ? <><p role="alert">{error}</p><button onClick={() => location.reload()}>重新连接</button></> : <p role="status">{stage}</p>}
  </main>;
}
