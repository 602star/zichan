import { useEffect, useState } from 'react';
import { requestJson, HttpRequestError, type SyncAuthSession } from '@zichan/db';
import { MemberAccountProtectionGate } from './MemberAccountProtectionGate.js';
import { FirstServerConnectionGate } from './FirstServerConnectionGate.js';
import { buildSyncBaseUrl, loadSyncConnections, saveSyncConnections, type SyncConnection } from '../sync-config.js';
import { applySyncAuthSession, hasAccountSession } from '../sync-auth.js';
import { runtimeCredential } from '../credential-vault.js';
import { OfflineAccountGate } from './OfflineAccountGate.js';
import { canOfferOfflineCache } from '../account-restore-error.js';
import { activeDesktopLedgerProfile, consumeDesktopProfileSwitchError, nativeBootstrapConnection,
  returnToLegacyDesktopLedger, selectNativeProfileSession } from '../desktop-ledger-profile.js';

function Ready({ onReady }: { onReady: () => Promise<void> }) {
  useEffect(() => { void onReady(); }, [onReady]);
  return <p role="status">正在打开本机账本…</p>;
}
export function NativeAccountGate({ onReady, onCancel }: { onReady: () => Promise<void>; onCancel: () => void }) {
  const [saved] = useState(() => {
    const stored = loadSyncConnections()[0];
    const binding = activeDesktopLedgerProfile()?.ledgerProfileBinding;
    if (stored && (!binding || stored.serverId === binding.serverId
      && stored.accountId === binding.accountId && stored.replicaId === binding.replicaId
      && stored.ledgerId === binding.ledgerId && stored.streamEpoch === binding.streamEpoch)) return stored;
    return nativeBootstrapConnection();
  });
  const [offlineAvailable, setOfflineAvailable] = useState(false);
  const [switchError] = useState(consumeDesktopProfileSwitchError);
  const [profileSwitchError, setProfileSwitchError] = useState('');
  const [offline, setOffline] = useState(false);
  const [profile, setProfile] = useState(() => {
    const first = loadSyncConnections()[0];
    const binding = activeDesktopLedgerProfile()?.ledgerProfileBinding;
    const matches = !binding || first?.serverId === binding.serverId
      && first.accountId === binding.accountId && first.replicaId === binding.replicaId
      && first.ledgerId === binding.ledgerId && first.streamEpoch === binding.streamEpoch;
    return first && matches && hasAccountSession(runtimeCredential(first.id)) ? first : undefined;
  });
  useEffect(() => {
    if (!saved?.serverId || !saved.accountId) return;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await requestJson(`${buildSyncBaseUrl(saved)}/api/health`, { cache: 'no-store', redirect: 'error' }, { signal: controller.signal, timeoutMs: 5000 });
        if (!response.ok) throw new HttpRequestError('http', '服务器不可用', response.status);
      } catch (error) { if (active) setOfflineAvailable(canOfferOfflineCache(error)); }
    })();
    return () => { active = false; controller.abort(); };
  }, [saved]);
  async function authenticated(connection: SyncConnection, session: SyncAuthSession) {
    const binding = activeDesktopLedgerProfile()?.ledgerProfileBinding;
    if (binding) {
      ({ connection, session } = await selectNativeProfileSession(connection, session, binding));
    }
    const current = loadSyncConnections();
    const previous = current.find((row) => row.serverId === connection.serverId && row.accountId === connection.accountId);
    const next = { ...connection, id: previous?.id ?? connection.id, serverRef: previous?.serverRef ?? connection.serverRef };
    saveSyncConnections([next, ...current.filter((row) => row.id !== next.id)]);
    applySyncAuthSession(next.id, { password: '', inviteCode: '' }, session);
    setProfile(next);
  }
  if (offline && saved) return <>{switchError && <p role="alert">上次切换账本失败：{switchError}</p>}
    <OfflineAccountGate connection={saved}><Ready onReady={onReady} /></OfflineAccountGate></>;
  return profile ? <>{switchError && <p role="alert">上次切换账本失败：{switchError}</p>}
    <MemberAccountProtectionGate connection={profile}><Ready onReady={onReady} /></MemberAccountProtectionGate></>
    : <>{offlineAvailable && saved && <div className="zc-protection" style={{ padding: 16 }}><p>主服务器暂时不可用，可用账号密码打开此设备已有的账本缓存。</p><button onClick={() => setOffline(true)}>离线打开 {saved.username} 的本机账本</button></div>}
      {switchError && <p role="alert">上次切换账本失败：{switchError}</p>}
      {activeDesktopLedgerProfile()?.ledgerProfileId !== 'legacy'
        && activeDesktopLedgerProfile()?.ledgerProfileSwitchSupported && <div className="zc-protection">
        <button type="button" onClick={() => void returnToLegacyDesktopLedger()
          .catch((reason) => setProfileSwitchError(reason instanceof Error ? reason.message : String(reason)))}>
          返回原始本机账本
        </button>
        {profileSwitchError && <p role="alert">{profileSwitchError}</p>}
      </div>}
      <FirstServerConnectionGate initialProfile={saved} onAuthenticated={authenticated} onReady={async () => {}} onCancel={onCancel} /></>;
}
