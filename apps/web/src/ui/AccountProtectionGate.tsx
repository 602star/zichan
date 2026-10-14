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

export function AccountProtectionGate({ connection, children }: { connection: SyncConnection; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const flight = useRef<Promise<ProtectionInfo>>();

  useEffect(() => {
    let active = true;
    flight.current ??= (async () => {
      const current = await protectionRequest(connection);
      return current.mode ? current : protectionRequest(connection, 'POST', { mode: 'managed' }, '/initialize');
    })();
    void flight.current.then(async (current) => {
      const problem = cryptoContextProblem();
      if (problem) throw new Error(problem);
      if (current.mode !== 'managed') throw new Error('此账本未启用服务器托管，请联系管理员');
      await unlockAccountProtection(connection, current);
      if (connection.serverId && connection.accountId && current.replica) {
        adoptFirstWebLedgerReplica(connection.serverId, connection.accountId,
          current.replica.ledgerId, current.replica.replicaId, current.replica.streamEpoch);
      }
      const credentials = runtimeCredentialMap();
      await unlockDeviceStorage(accountProtection()!.secret, true);
      if (isTauriRuntime()) for (const [id, credential] of Object.entries(credentials)) {
        if (credential.refreshToken) await persistCredential(id, credential);
      }
      const password = takeLoginPassword(connection.serverId, connection.accountId);
      if (password) await enableOfflinePassword(password).catch(() => undefined);
      if (active) setReady(true);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
    // This gate is mounted for one fixed authenticated account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  if (ready) return <>{children}</>;
  return <main className="zc-protection" style={{ maxWidth: 600, margin: '10vh auto', padding: 24 }}>
    <h1>正在打开账本</h1>
    {error ? <><p role="alert">{error}</p><button onClick={() => location.reload()}>重新连接</button></> : <p role="status">正在准备账本和本机离线访问…</p>}
  </main>;
}
