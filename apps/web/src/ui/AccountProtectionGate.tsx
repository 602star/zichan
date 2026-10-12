import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createLedgerKeyEnvelope, newId, unlockLedgerKeyEnvelope, wrapLedgerCryptoSession,
  type LedgerKeyEnvelope } from '@zichan/core';
import { requestJson } from '@zichan/db';
import { accountProtection, protectionRequest, randomRecoveryCode, unlockAccountProtection, type ProtectionInfo } from '../account-protection.js';
import { unlockDeviceStorage } from '../device-storage-key.js';
import type { SyncConnection } from '../sync-config.js';
import { persistCredential, runtimeCredentialMap } from '../credential-vault.js';
import { isTauriRuntime } from '../tauri.js';
import { cryptoContextProblem } from '../browser-storage-policy.js';
import { resetPlatformData } from '../db/platform-driver.js';
import { unlockRememberedDevice } from '../offline-access.js';
import { takeLoginPassword } from '../login-password.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl } from '../sync-config.js';

async function passwordEnvelopeRequest(connection: SyncConnection, method = 'GET', body?: unknown): Promise<{
  record?: { envelope: LedgerKeyEnvelope; revision: number } | null; revision?: number;
}> {
  const token = await authenticateSyncProfile(connection);
  const response = await requestJson(`${buildSyncBaseUrl(connection)}/api/v4/ledger/password-envelope`, {
    method, cache: 'no-store', redirect: 'error', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json() as { record?: { envelope: LedgerKeyEnvelope; revision: number } | null;
    revision?: number; error?: string };
  if (!response.ok) throw new Error(result.error ?? '无法读取或保存账本密码密钥包');
  return result;
}

export function AccountProtectionGate({ connection, children }: { connection: SyncConnection; children: ReactNode }) {
  const [info, setInfo] = useState<ProtectionInfo>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [accountPassword, setAccountPassword] = useState(() => takeLoginPassword(connection.serverId, connection.accountId) ?? '');
  const [passwordEnvelope, setPasswordEnvelope] = useState<{ envelope: LedgerKeyEnvelope; revision: number } | null>();
  const [saved, setSaved] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [resetCode] = useState(randomRecoveryCode);
  const [resetCodeSaved, setResetCodeSaved] = useState(false);
  const flight = useRef<Promise<ProtectionInfo>>();
  const creating = !!info && !info.mode;

  async function open(next: ProtectionInfo, recoveryCode?: string, envelope?: LedgerKeyEnvelope) {
    const problem = cryptoContextProblem();
    if (problem) throw new Error(problem);
    await unlockAccountProtection(connection, next, recoveryCode, envelope);
    const credentials = runtimeCredentialMap();
    await unlockDeviceStorage(accountProtection()!.secret, true);
    if (isTauriRuntime()) for (const [id, credential] of Object.entries(credentials)) {
      if (credential.refreshToken) await persistCredential(id, credential);
    }
    setReady(true);
  }

  useEffect(() => {
    let active = true;
    flight.current ??= (async () => {
      const current = await protectionRequest(connection);
      if (current.mode) return current;
      if (connection.initialProtectionMode === 'private' || current.defaultMode === 'private') return current;
      return protectionRequest(connection, 'POST', { mode: 'managed' }, '/initialize');
    })();
    void flight.current.then(async (current) => {
      if (!active) return;
      setInfo(current);
      if (current.mode === 'managed') await open(current);
      else if (!current.mode) setCode(randomRecoveryCode());
      else if (current.mode === 'private') {
        const record = (await passwordEnvelopeRequest(connection).catch(() => ({ record: null }))).record ?? null;
        if (!active) return;
        setPasswordEnvelope(record);
        if (record && accountPassword && record.envelope.generation === current.envelope?.generation) {
          try { await open(current, accountPassword, record.envelope); return; }
          catch { setError('账号密码尚未与此私密账本密钥匹配，请用恢复码解锁或更新密码密钥包。'); }
        }
        if (await unlockRememberedDevice(connection).catch(() => false)) {
          try { await open(current, accountProtection()?.secret, accountProtection()?.unlockEnvelope); }
          catch { setError('此设备记住的解锁材料已失效，请使用账号密码或恢复码。'); }
        }
      }
      else if (await unlockRememberedDevice(connection).catch(() => false)) {
        try { await open(current, accountProtection()?.secret); }
        catch { setError('此设备记住的恢复码已失效，请输入当前恢复码。'); }
      }
    }).catch((reason) => { if (active) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
    // This gate is mounted for one fixed authenticated account; retries reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  async function submit() {
    if (!info || busy) return;
    setBusy(true); setError('');
    try {
      const problem = cryptoContextProblem();
      if (problem) throw new Error(problem);
      if (!creating && !code.trim() && passwordEnvelope) {
        await open(info, accountPassword, passwordEnvelope.envelope);
        return;
      }
      let next = info;
      if (creating) {
        const created = await createLedgerKeyEnvelope(newId(), code.trim());
        next = await protectionRequest(connection, 'POST', { mode: 'private', envelope: created.envelope }, '/initialize');
      }
      if (accountPassword.length >= 8 && next.mode === 'private' && next.envelope) {
        const session = await unlockLedgerKeyEnvelope(code, next.envelope);
        const wrapped = await wrapLedgerCryptoSession(session, accountPassword);
        try {
          await passwordEnvelopeRequest(connection, 'PUT', {
            envelope: wrapped, expectedRevision: passwordEnvelope?.revision ?? 0,
          });
          setPasswordEnvelope({ envelope: wrapped, revision: (passwordEnvelope?.revision ?? 0) + 1 });
        } catch (reason) {
          setError(`恢复码已解锁，但未能绑定账号密码：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      }
      await open(next, code);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  if (ready) return <>{children}</>;
  if (busy && !info) return <p role="status">正在准备账号账本…</p>;
  return <main className="zc-protection" style={{ maxWidth: 600, margin: '10vh auto', padding: 24 }}>
    <h1>{creating ? '创建私密账本' : info?.mode === 'managed' ? '正在解锁云端账本' : '解锁私密账本'}</h1>
    {info?.mode !== 'managed' && <>
      <p>{creating ? '保存恢复码后即可开始记账。平时用账号密码解锁；忘记账号密码后仍需恢复码找回私密账本。' : passwordEnvelope ? '输入账号密码解锁；若密码已重设或密钥包尚未更新，请用恢复码重新绑定。' : '首次迁移请用恢复码解锁并绑定账号密码。恢复码不发送给服务器。'}</p>
      {creating ? <><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 16, background: 'var(--surface-2)' }}>{code}</pre>
        <label><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />我已把恢复码保存在此设备以外</label></>
        : <><label>账号密码<input aria-label="私密账本账号密码" type="password" autoComplete="current-password" value={accountPassword} onChange={(e) => setAccountPassword(e.target.value)} style={{ display: 'block', width: '100%', margin: '12px 0' }} /></label>
          <label>恢复码<input aria-label="账本恢复码" type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} style={{ display: 'block', width: '100%', margin: '12px 0' }} /></label></>}
      {creating && !accountPassword && <label>账号密码<input aria-label="绑定账本的账号密码" type="password" autoComplete="current-password" value={accountPassword} onChange={(e) => setAccountPassword(e.target.value)} /></label>}
      <p><button disabled={busy || accountPassword.length < 8 || creating && !saved
        || !creating && !passwordEnvelope && code.trim().length < 8
        || !creating && !!passwordEnvelope && code.trim().length > 0 && code.trim().length < 8}
        onClick={() => void submit()}>{busy ? '正在解锁…' : creating ? '创建私密账本' : '解锁账本'}</button></p>
    </>}
    {error && <p role="alert">{error}</p>}
    {info?.mode === 'private' && !creating && <details><summary>恢复码遗失，重新开账本</summary>
      <p>确认后删除此服务器的旧账本同步记录与密钥，并清空此设备缓存。账号保留，其他设备退出；旧服务器附件及备份仍保留，但需要旧恢复码读取。</p>
      <p>新私密账本的恢复码：</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{resetCode}</pre>
      <label><input type="checkbox" checked={resetCodeSaved} onChange={(e) => setResetCodeSaved(e.target.checked)} />我已保存新账本恢复码</label>
      <label>输入“替换旧账本”确认<input aria-label="替换旧账本确认文字" value={resetConfirmation} onChange={(e) => setResetConfirmation(e.target.value)} /></label>
      <button disabled={busy || resetting || !resetCodeSaved || resetConfirmation !== '替换旧账本'} onClick={() => {
        setResetting(true); setError('');
        void (async () => {
          const created = await createLedgerKeyEnvelope(newId(), resetCode);
          await protectionRequest(connection, 'POST', { mode: 'private', envelope: created.envelope, confirmation: resetConfirmation, expectedLedgerId: info.replica?.ledgerId, expectedStreamEpoch: info.replica?.streamEpoch }, '/replace');
          await resetPlatformData();
          location.reload();
        })().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setResetting(false));
      }}>确认替换并创建新账本</button>
    </details>}
    {error && <button onClick={() => location.reload()}>重新连接</button>}
  </main>;
}
