import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createLedgerKeyEnvelope, newId } from '@zichan/core';
import { accountProtection, protectionRequest, randomRecoveryCode, unlockAccountProtection, type ProtectionInfo } from '../account-protection.js';
import { unlockDeviceStorage } from '../device-storage-key.js';
import type { SyncConnection } from '../sync-config.js';
import { persistCredential, runtimeCredentialMap } from '../credential-vault.js';
import { isTauriRuntime } from '../tauri.js';
import { resetPlatformData } from '../db/platform-driver.js';
import { unlockRememberedDevice } from '../offline-access.js';

export function AccountProtectionGate({ connection, children }: { connection: SyncConnection; children: ReactNode }) {
  const [info, setInfo] = useState<ProtectionInfo>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [resetCode] = useState(randomRecoveryCode);
  const [resetCodeSaved, setResetCodeSaved] = useState(false);
  const flight = useRef<Promise<ProtectionInfo>>();
  const creating = !!info && !info.mode;

  async function open(next: ProtectionInfo, recoveryCode?: string) {
    await unlockAccountProtection(connection, next, recoveryCode);
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
      let next = info;
      if (creating) {
        const created = await createLedgerKeyEnvelope(newId(), code.trim());
        next = await protectionRequest(connection, 'POST', { mode: 'private', envelope: created.envelope }, '/initialize');
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
      <p>{creating ? '保存恢复码后即可开始记账。服务器无法解密此账本；换设备或恢复备份时使用恢复码，账号密码找回不能替代它。' : '输入恢复码解锁账本。恢复码只在此设备解密，不发送给服务器。'}</p>
      {creating ? <><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 16, background: 'var(--surface-2)' }}>{code}</pre>
        <label><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />我已把恢复码保存在此设备以外</label></>
        : <label>恢复码<input aria-label="账本恢复码" type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} style={{ display: 'block', width: '100%', margin: '12px 0' }} /></label>}
      <p><button disabled={busy || code.trim().length < 8 || creating && !saved} onClick={() => void submit()}>{busy ? '正在解锁…' : creating ? '创建私密账本' : '解锁账本'}</button></p>
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
