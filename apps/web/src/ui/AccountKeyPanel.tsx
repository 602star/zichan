import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchAuthMe, loginAccount, requestJson } from '@zichan/db';
import { accountSigningPublicKey, createAccountEncryptionKey, unlockAccountEncryptionKey,
  wrapAccountEncryptionKey,
  type AccountEncryptionKeyEnvelope } from '@zichan/core';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, type SyncConnection } from '../sync-config.js';

interface AccountKeyRecord {
  issuerNodeId: string;
  subjectAccountId: string;
  publicKey: string;
  envelope: AccountEncryptionKeyEnvelope;
  revision: number;
}

export function AccountKeyPanel({ profile, children }: { profile: SyncConnection; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [record, setRecord] = useState<AccountKeyRecord | null>();
  const [issuerNodeId, setIssuerNodeId] = useState('');
  const [password, setPassword] = useState('');
  const [sharePassphrase, setSharePassphrase] = useState('');
  const [shareCard, setShareCard] = useState('');
  const [currentPassphrase, setCurrentPassphrase] = useState('');
  const [nextPassphrase, setNextPassphrase] = useState('');
  const [nextConfirmation, setNextConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const token = await authenticateSyncProfile(profile);
    const baseUrl = buildSyncBaseUrl(profile);
    const me = await fetchAuthMe(baseUrl, token);
    if (me.accountId !== profile.accountId) throw new Error('账号身份已改变');
    setIssuerNodeId(me.federatedIdentity?.issuerNodeId ?? profile.serverId ?? '');
    const response = await requestJson(`${baseUrl}/api/v4/account/encryption-key`, {
      cache: 'no-store', redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json() as { record?: AccountKeyRecord | null; error?: string };
    if (!response.ok) throw new Error(body.error ?? '无法读取账号加密密钥');
    setRecord(body.record ?? null);
  }, [profile]);

  useEffect(() => {
    let active = true;
    void refresh().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [refresh]);

  async function create() {
    if (busy || !profile.serverId || !profile.accountId) return;
    setBusy(true); setError('');
    try {
      if (issuerNodeId !== profile.serverId) throw new Error('请在账号身份节点建立加密密钥');
      if (password.length < 8) throw new Error('请输入账号密码');
      const baseUrl = buildSyncBaseUrl(profile);
      const verified = await loginAccount(baseUrl, profile.username, password, {
        expectedServerId: profile.serverId, expectedServerPublicKey: profile.serverPublicKey,
        sessionTransport: 'token', deviceName: '验证成员身份账号密码',
      });
      await requestJson(`${baseUrl}/api/auth/logout`, { method: 'POST', cache: 'no-store',
        redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${verified.accessToken}` } });
      const created = await createAccountEncryptionKey(profile.serverId, profile.accountId, password);
      try {
        const token = await authenticateSyncProfile(profile);
        const response = await requestJson(`${buildSyncBaseUrl(profile)}/api/v4/account/encryption-key`, {
          method: 'PUT', cache: 'no-store', redirect: 'error', credentials: 'omit',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope: created.envelope, expectedRevision: 0 }),
        });
        const body = await response.json() as { record?: AccountKeyRecord; error?: string };
        if (!response.ok || !body.record) throw new Error(body.error ?? '无法保存账号加密密钥');
        setRecord(body.record);
        setPassword('');
      } finally { created.privateKey.fill(0); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function revealShareCard() {
    if (!record || busy) return;
    setBusy(true); setError('');
    try {
      const privateKey = await unlockAccountEncryptionKey(sharePassphrase, record.envelope);
      try { setShareCard(JSON.stringify({ issuerNodeId: record.issuerNodeId,
        accountId: record.subjectAccountId, encryptionPublicKey: record.publicKey,
        signingPublicKey: accountSigningPublicKey(privateKey) }, null, 2)); }
      finally { privateKey.fill(0); }
      setSharePassphrase('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function changePassword() {
    if (!record || busy) return;
    setBusy(true); setError('');
    try {
      if (record.issuerNodeId !== profile.serverId || record.subjectAccountId !== profile.accountId) {
        throw new Error('请在账号身份节点修改加密密钥密码');
      }
      if (nextPassphrase.length < 8 || nextPassphrase !== nextConfirmation) {
        throw new Error('新密钥密码至少八位，且两次输入须一致');
      }
      const baseUrl = buildSyncBaseUrl(profile);
      const verified = await loginAccount(baseUrl, profile.username, nextPassphrase, {
        expectedServerId: profile.serverId, expectedServerPublicKey: profile.serverPublicKey,
        sessionTransport: 'token', deviceName: '验证账号密码',
      });
      await requestJson(`${baseUrl}/api/auth/logout`, { method: 'POST', cache: 'no-store',
        redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${verified.accessToken}` } });
      const privateKey = await unlockAccountEncryptionKey(currentPassphrase, record.envelope);
      try {
        const envelope = await wrapAccountEncryptionKey(privateKey, record.issuerNodeId,
          record.subjectAccountId, nextPassphrase);
        const token = await authenticateSyncProfile(profile);
        const response = await requestJson(`${buildSyncBaseUrl(profile)}/api/v4/account/encryption-key`, {
          method: 'PUT', cache: 'no-store', redirect: 'error', credentials: 'omit',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope, expectedRevision: record.revision }),
        });
        const body = await response.json() as { record?: AccountKeyRecord; error?: string };
        if (!response.ok || !body.record) throw new Error(body.error ?? '无法更新账号加密密钥');
        setRecord(body.record);
        setCurrentPassphrase(''); setNextPassphrase(''); setNextConfirmation('');
        setShareCard('');
      } finally { privateKey.fill(0); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <details className="zc-card" aria-label="多人账本高级设置"
    onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>多人账本（高级）</summary>
    <p className="zc-caption">用于接收账本所有者发放的成员密钥包。新账号登录时自动用账号密码建立；服务器只保存加密后的私钥包。</p>
    {record ? <>
      <p>已建立 · 身份节点 {record.issuerNodeId} · 公钥 {record.publicKey.slice(0, 16)}… · 版本 {record.revision}</p>
      <details><summary>提供给账本所有者的成员身份</summary>
        <p>这里仅包含账号标识和公钥。所有者据此发放账本访问权；不要分享账号密码。</p>
        <form onSubmit={(event) => { event.preventDefault(); void revealShareCard(); }}>
          <label>账号密码<input aria-label="查看成员身份的密钥密码" type="password" autoComplete="current-password"
            value={sharePassphrase} onChange={(event) => setSharePassphrase(event.target.value)} /></label>
          <button disabled={busy || sharePassphrase.length < 8}>显示成员身份</button>
        </form>
        {shareCard && <textarea aria-label="成员身份信息" readOnly value={shareCard}
          style={{ display: 'block', width: '100%', minHeight: 150, marginTop: 10 }} />}
      </details>
      {record.issuerNodeId === profile.serverId && <details><summary>旧账号：迁移独立密钥密码</summary>
        <p>修改后公钥和现有成员授权保持不变。其他网站收到后台同步的新密钥包后使用新密码；已下载的旧密钥包不会因此失效。</p>
        <form onSubmit={(event) => { event.preventDefault(); void changePassword(); }}>
          <label>旧密钥密码<input aria-label="当前账号加密密钥密码" type="password" autoComplete="off"
            value={currentPassphrase} onChange={(event) => setCurrentPassphrase(event.target.value)} /></label>
          <label>当前账号密码<input aria-label="新账号加密密钥密码" type="password" autoComplete="current-password"
            value={nextPassphrase} onChange={(event) => setNextPassphrase(event.target.value)} /></label>
          <label>再次输入新密码<input aria-label="确认新账号加密密钥密码" type="password" autoComplete="new-password"
            value={nextConfirmation} onChange={(event) => setNextConfirmation(event.target.value)} /></label>
          <button disabled={busy || currentPassphrase.length < 8 || nextPassphrase.length < 8
            || nextPassphrase !== nextConfirmation}>{busy ? '正在更新…' : '绑定账号密码'}</button>
        </form>
      </details>}
    </>
      : record === null && issuerNodeId !== profile.serverId ? <p>此账号的身份由 {issuerNodeId} 管理；请先在身份节点登录并建立账号加密密钥。</p>
        : record === null ? <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label>账号密码<input aria-label="建立成员身份的账号密码" type="password" autoComplete="current-password"
            value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button disabled={busy || password.length < 8}>{busy ? '正在建立…' : '建立成员身份'}</button>
        </form> : <p role="status">正在读取账号加密密钥…</p>}
    {error && <p role="alert">{error}</p>}
    {expanded && children}
  </details>;
}
