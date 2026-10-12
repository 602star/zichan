import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchAuthMe, requestJson } from '@zichan/db';
import { changeLedgerPassphrase, unlockAccountEncryptionKey, unlockLedgerMemberKeyEnvelope,
  wrapAccountEncryptionKey,
  type AccountEncryptionKeyEnvelope, type LedgerControlState, type LedgerMemberKeyEnvelope } from '@zichan/core';
import { unlockAccountProtection, type ProtectionInfo } from '../account-protection.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, type SyncConnection } from '../sync-config.js';
import { unlockDeviceStorage } from '../device-storage-key.js';
import { AccountProtectionGate } from './AccountProtectionGate.js';
import { AccountKeyPanel } from './AccountKeyPanel.js';
import { takeLoginPassword } from '../login-password.js';

interface MemberAccess {
  state: LedgerControlState;
  accountKey: AccountEncryptionKeyEnvelope;
  accountKeyRevision: number;
  envelope: LedgerMemberKeyEnvelope;
  replica: NonNullable<ProtectionInfo['replica']>;
}

async function getJson(profile: SyncConnection, token: string, path: string) {
  return requestJson(`${buildSyncBaseUrl(profile)}${path}`, {
    cache: 'no-store', redirect: 'error', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function inspectMemberAccess(profile: SyncConnection): Promise<MemberAccess | 'unbound' | 'directory-only' | null> {
  if (!profile.serverId || !profile.accountId) return null;
  const token = await authenticateSyncProfile(profile);
  const account = await fetchAuthMe(buildSyncBaseUrl(profile), token);
  if (!profile.ledgerId) return account.federatedIdentity ? 'directory-only' : 'unbound';
  if (account.accountId !== profile.accountId || account.ledgerId !== profile.ledgerId) {
    throw new Error('当前网站的账号或账本身份已改变');
  }
  const controlResponse = await getJson(profile, token, '/api/v4/ledger/control');
  if (controlResponse.status === 409) return null;
  const controlBody = await controlResponse.json() as { state?: LedgerControlState | null; error?: string };
  if (!controlResponse.ok) throw new Error(controlBody.error ?? '无法读取账本成员权限');
  const state = controlBody.state;
  if (!state) return null;
  const identity = account.federatedIdentity
    ? { issuerNodeId: account.federatedIdentity.issuerNodeId,
      accountId: account.federatedIdentity.subjectAccountId }
    : { issuerNodeId: profile.serverId, accountId: profile.accountId };
  const member = state.members[`${identity.issuerNodeId}/${identity.accountId}`];
  if (!member || member.removed) throw new Error('当前账号已无账本访问权');
  const envelopeResponse = await getJson(profile, token, '/api/v4/ledger/member-envelope');
  const envelopeBody = await envelopeResponse.json() as { envelope?: LedgerMemberKeyEnvelope | null; error?: string };
  if (!envelopeResponse.ok) throw new Error(envelopeBody.error ?? '无法读取成员密钥包');
  if (!envelopeBody.envelope) {
    if (member.role === 'OWNER') {
      const legacyResponse = await getJson(profile, token, '/api/v3/protection');
      if (legacyResponse.ok) {
        const legacy = await legacyResponse.json() as ProtectionInfo;
        if (legacy.envelope?.ledgerId === state.ledgerId
          && legacy.replica?.replicaId === account.replicaId) return null;
      }
    }
    throw new Error('成员密钥包尚未同步到此副本，请等待账本所有者发放并重试');
  }
  const keyResponse = await getJson(profile, token, '/api/v4/account/encryption-key');
  const keyBody = await keyResponse.json() as { record?: { envelope: AccountEncryptionKeyEnvelope; publicKey: string; revision: number } | null; error?: string };
  if (!keyResponse.ok) throw new Error(keyBody.error ?? '无法读取账号加密密钥');
  const accountKey = keyBody.record?.envelope;
  const envelope = envelopeBody.envelope;
  if (!accountKey || accountKey.publicKey !== member.encryptionPublicKey
    || envelope.ledgerId !== state.ledgerId || envelope.keyEpoch !== state.keyEpoch
    || envelope.recipientPublicKey !== accountKey.publicKey
    || envelope.issuerNodeId !== identity.issuerNodeId || envelope.accountId !== identity.accountId) {
    throw new Error('成员密钥与当前账本权限或账号公钥不匹配');
  }
  const replicaResponse = await getJson(profile, token, '/api/v3/replica');
  const replicaBody = await replicaResponse.json() as {
    bound?: boolean; serverId?: string; ledgerId?: string; replicaId?: string; streamEpoch?: string;
    headSeq?: number; error?: string;
  };
  if (!replicaResponse.ok || !replicaBody.bound || replicaBody.serverId !== profile.serverId
    || replicaBody.ledgerId !== state.ledgerId || !replicaBody.replicaId || !replicaBody.streamEpoch) {
    throw new Error(replicaBody.error ?? '账本副本身份不匹配');
  }
  return { state, accountKey, accountKeyRevision: keyBody.record!.revision, envelope, replica: {
    serverId: replicaBody.serverId, ledgerId: replicaBody.ledgerId,
    replicaId: replicaBody.replicaId, streamEpoch: replicaBody.streamEpoch,
    headSeq: Number(replicaBody.headSeq ?? 0),
  } };
}

/** Open a controlled ledger with the member's own account key instead of the owner-only legacy key. */
export function MemberAccountProtectionGate({ connection, children }: {
  connection: SyncConnection; children: ReactNode;
}) {
  const [access, setAccess] = useState<MemberAccess | 'unbound' | 'directory-only' | null>();
  const [ready, setReady] = useState(false);
  const [createPersonal, setCreatePersonal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [legacyPassphrase, setLegacyPassphrase] = useState('');
  const [legacyRequired, setLegacyRequired] = useState(false);
  const autoAttempted = useRef(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setAccess(undefined);
    void inspectMemberAccess(connection).then((result) => {
      if (active) { setAccess(result); setError(''); }
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [connection, attempt]);

  async function unlock(password = passphrase) {
    if (!access || access === 'unbound' || access === 'directory-only' || busy) return;
    setBusy(true); setError('');
    try {
      let privateKey;
      try { privateKey = await unlockAccountEncryptionKey(password, access.accountKey); }
      catch (reason) {
        if (!legacyPassphrase) { setLegacyRequired(true); throw reason; }
        privateKey = await unlockAccountEncryptionKey(legacyPassphrase, access.accountKey);
        if (access.accountKey.issuerNodeId !== connection.serverId) {
          privateKey.fill(0);
          throw new Error('旧密钥密码需在账号创建节点迁移为账号密码，然后等待密钥包同步到本站');
        }
        try {
          const envelope = await wrapAccountEncryptionKey(privateKey, access.accountKey.issuerNodeId,
            access.accountKey.accountId, password);
          const token = await authenticateSyncProfile(connection);
          const response = await requestJson(`${buildSyncBaseUrl(connection)}/api/v4/account/encryption-key`, {
            method: 'PUT', cache: 'no-store', redirect: 'error', credentials: 'omit',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ envelope, expectedRevision: access.accountKeyRevision }),
          });
          if (!response.ok) throw new Error('旧密钥密码迁移失败，请到账号设置重试');
        } catch (reason) { privateKey.fill(0); throw reason; }
      }
      let session;
      try { session = await unlockLedgerMemberKeyEnvelope(privateKey, access.envelope); }
      finally { privateKey.fill(0); }
      const local = await changeLedgerPassphrase(session, password);
      const info: ProtectionInfo = {
        mode: 'member', version: 0, defaultMode: 'private', custodyEnabled: false,
        secret: null, envelope: local.envelope, replica: access.replica,
      };
      await unlockAccountProtection(connection, info, password);
      await unlockDeviceStorage(password, true);
      setPassphrase('');
      setReady(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!access || access === 'unbound' || access === 'directory-only' || autoAttempted.current) return;
    autoAttempted.current = true;
    const password = takeLoginPassword(connection.serverId, connection.accountId);
    if (password) {
      setPassphrase(password);
      void unlock(password);
    }
    // One automatic unlock attempt per authenticated mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access]);

  if (ready) return <>{children}</>;
  if (access === 'directory-only') return <main className="zc-protection" style={{ maxWidth: 640, margin: '8vh auto', padding: 24 }}>
    <h1>账号已同步，账本尚未加入本站</h1>
    <p>这个账号可以在本站登录，但个人账本还未复制到此节点。请先在创建账号的网站开通账本，
      再由管理员为该账本建立本站副本；完成后即可用同一账号密码记账。</p>
    <button onClick={() => window.location.reload()}>检查账本授权</button>
    {error && <p role="alert">{error}</p>}
  </main>;
  if (access === 'unbound') return createPersonal
    ? <AccountProtectionGate connection={connection}>{children}</AccountProtectionGate>
    : <main className="zc-protection" style={{ maxWidth: 640, margin: '8vh auto', padding: 24 }}>
      <h1>选择账本</h1>
      <p>此账号尚未加入账本。可以创建个人账本，或把成员身份信息提供给账本所有者，等待邀请。</p>
      <button onClick={() => setCreatePersonal(true)}>创建个人账本</button>
      <AccountKeyPanel profile={connection} />
      <button onClick={() => {
        void (async () => {
          const token = await authenticateSyncProfile(connection);
          const account = await fetchAuthMe(buildSyncBaseUrl(connection), token);
          if (account.ledgerId) window.location.reload();
          else setError('此账号尚未收到账本授权，请稍后再检查。');
        })().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      }}>检查是否已加入账本</button>
      {error && <p role="status">{error}</p>}
    </main>;
  if (access === null) return <AccountProtectionGate connection={connection}>{children}</AccountProtectionGate>;
  if (!access && !error) return <p role="status">正在核对账本成员权限…</p>;
  return <main className="zc-protection" style={{ maxWidth: 600, margin: '10vh auto', padding: 24 }}>
    <h1>解锁成员账本</h1>
    {access ? <>
      <p>输入账号密码解锁此账号的成员密钥包。旧账号若使用过独立密钥密码，可在下方一次性迁移。</p>
      <form onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
        <label>账号密码<input aria-label="成员账本账号密码" type="password" autoComplete="current-password"
          value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
        {legacyRequired && <label>旧账号密钥密码（仅迁移一次）<input aria-label="旧账号密钥密码" type="password" autoComplete="off"
          value={legacyPassphrase} onChange={(event) => setLegacyPassphrase(event.target.value)} /></label>}
        <p><button disabled={busy || passphrase.length < 8}>{busy ? '正在解锁…' : '解锁账本'}</button></p>
      </form>
    </> : <button onClick={() => setAttempt((value) => value + 1)}>重试读取成员权限</button>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
