import { useEffect, useState, type ReactNode } from 'react';
import { fetchAuthMe } from '@zichan/db';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, type SyncConnection } from '../sync-config.js';
import { AccountProtectionGate } from './AccountProtectionGate.js';

/** A relayed identity may be available before its personal ledger reaches this node. */
export function AccountLedgerGate({ connection, children }: {
  connection: SyncConnection; children: ReactNode;
}) {
  const [directoryOnly, setDirectoryOnly] = useState<boolean | null>(connection.ledgerId ? false : null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    if (connection.ledgerId) { setDirectoryOnly(false); return; }
    setDirectoryOnly(null);
    let active = true;
    void authenticateSyncProfile(connection).then((token) => fetchAuthMe(buildSyncBaseUrl(connection), token))
      .then((account) => { if (active) setDirectoryOnly(Boolean(account.federatedIdentity)); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [connection]);
  if (error) return <main className="zc-protection" role="alert">{error}</main>;
  if (directoryOnly === null) return <p role="status">正在检查个人账本…</p>;
  if (directoryOnly) return <main className="zc-protection"
    style={{ maxWidth: 640, margin: '8vh auto', padding: 24 }}>
    <h1>账本尚未加入本站</h1>
    <p>个人账本还在后台加入本站。请稍后重试；若一直未完成，让管理员检查服务器同步组状态。</p>
    <button onClick={() => window.location.reload()}>检查账本状态</button>
  </main>;
  return <AccountProtectionGate connection={connection}>{children}</AccountProtectionGate>;
}
