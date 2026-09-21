import { useEffect, useRef, useState } from 'react';
import { accountProtection } from '../account-protection.js';
import { importLedger, type SqlLedgerStore } from '@zichan/db';
import type { Setting } from '@zichan/core';
import { adoptUnlockedLedgerKeyEnvelope } from '../ledger-key-vault.js';
import { prepareRemoteLedgerJoin } from '../remote-ledger-join.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import {
  buildSyncBaseUrl,
  loadSyncConnections,
  saveSyncConnections,
  type SyncConnection,
} from '../sync-config.js';
import { btnOutline, btnPrimary } from './styles.js';

const button = btnOutline;
const primary = btnPrimary;

export function FirstRemoteLedgerRestoreGate(props: {
  store: SqlLedgerStore;
  connection: SyncConnection;
  onRestored: (setting: Setting) => Promise<void>;
  onUseDifferentAccount: () => void;
  onStartNew: () => Promise<void>;
}) {
  const automaticSecret = accountProtection()?.profileId === props.connection.id ? accountProtection()?.secret : undefined;
  const [passphrase, setPassphrase] = useState(automaticSecret ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const replacementFlight = useRef(false);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (automaticSecret && !autoStarted.current) { autoStarted.current = true; void restore(); }
    // The initial restoration is a single operation; state updates must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startNew() {
    if (replacementFlight.current || busy || confirmation !== '替换旧账本') return;
    replacementFlight.current = true;
    setBusy(true);
    setMessage('正在创建并加密新账本…');
    try {
      await props.onStartNew();
    } catch (error) {
      setMessage(`创建失败：${error instanceof Error ? error.message : String(error)}。如连接中断，请重新登录检查账本状态。`);
    } finally {
      replacementFlight.current = false;
      setBusy(false);
    }
  }

  async function restore() {
    if (busy || replacementFlight.current) return;
    const ledgerId = props.connection.ledgerId;
    if (!ledgerId) return;
    if (passphrase.length < 8) {
      setMessage('请输入至少 8 个字符的账本密码');
      return;
    }
    setBusy(true);
    setMessage('正在验证服务器身份、密钥封套和全部加密提交…');
    try {
      // Authentication always performs an anonymous health identity check first. Cached
      // access/refresh tokens and the password are never sent to an unverified endpoint.
      const accessToken = await authenticateSyncProfile(props.connection);
      const prepared = await prepareRemoteLedgerJoin({
        baseUrl: buildSyncBaseUrl(props.connection),
        token: accessToken,
        ledgerId,
        passphrase,
        endpointLabel: props.connection.alias,
        expectedServerId: props.connection.serverId,
      });
      await props.store.transaction(async (transaction) => {
        await transaction.resetToLedger(prepared.ledgerId);
        await importLedger(transaction, prepared.ledger, {
          afterImport: (importStore) => importStore.restoreDeviceRecoveryState(prepared.deviceState),
        });
      });
      adoptUnlockedLedgerKeyEnvelope(prepared.keyEnvelope, prepared.cryptoSession, true);
      const restoredAt = new Date().toISOString();
      saveSyncConnections(loadSyncConnections().map((connection) => connection.id === props.connection.id ? {
        ...connection,
        serverId: prepared.identity.serverId,
        ledgerId: prepared.identity.ledgerId,
        replicaId: prepared.identity.replicaId,
        streamEpoch: prepared.identity.streamEpoch,
        status: 'online' as const,
        lastSyncAt: restoredAt,
        lastError: `首次恢复完成，共验证并拉取 ${prepared.pulled} 条提交`,
      } : connection));
      setMessage('远端账本验证通过，正在完成本机初始化…');
      const setting = (await props.store.settings.list({ limit: 1 }))[0];
      if (!setting) throw new Error('远端账本没有活动设置');
      await props.onRestored(setting);
    } catch (error) {
      setMessage(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100dvh', overflowY: 'auto', padding: 'clamp(22px, 6vw, 70px)', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(720px, 100%)', margin: '3vh auto 0', padding: 'clamp(22px, 5vw, 36px)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--surface-2)' }}>
        <div style={{ color: 'var(--accent)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', letterSpacing: '.1em' }}>发现已有远端账本</div>
        <h1 style={{ margin: '10px 0 8px', color: 'var(--text-primary)', fontSize: 'var(--fs-hero)' }}>从 {props.connection.alias} 恢复</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>账号 {props.connection.username} 已绑定账本 {props.connection.ledgerId}。系统会先在隔离数据库验证密钥、提交 DAG 与账本一致性，成功后才写入本机。</p>
        {!automaticSecret && <label style={{ display: 'block', marginTop: 20, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
          账本密码
          <input
            aria-label="远端账本密码"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            disabled={busy}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void restore(); }}
            style={{ boxSizing: 'border-box', display: 'block', width: '100%', minHeight: 44, marginTop: 7, padding: '0 11px', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', color: 'var(--text-primary)' }}
          />
        </label>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20 }}>
          <button type="button" onClick={() => void restore()} disabled={busy || passphrase.length < 8} style={primary}>{busy ? '验证并恢复中…' : '验证并恢复账本'}</button>
          <button type="button" onClick={props.onUseDifferentAccount} disabled={busy} style={button}>改用其他账号或模式</button>
          {!automaticSecret && <button type="button" onClick={() => { setReplacing(!replacing); setConfirmation(''); }} disabled={busy} style={button}>忘记账本密码，重新开账本</button>}
        </div>
        {replacing && <section aria-label="替换旧账本确认" style={{ marginTop: 20, padding: 16, border: '1px solid var(--negative)', borderRadius: 'var(--r-sm)' }}>
          <strong>使用账号 {props.connection.username} 创建新账本</strong>
          <p style={{ lineHeight: 1.7 }}>确认后将删除此服务器上旧账本的同步记录和密钥，替换为人民币收支空账本。账号密码和权限不变，其他设备会话将退出。新账本使用刚设置的本机账本密码，币种和记账模式可在设置中调整。</p>
          <p style={{ lineHeight: 1.7 }}>旧附件和服务器备份仍保留并占用配额，但不能从新账本访问；其他服务器副本不受影响。需要保留旧数据时，请先保存外部加密备份，恢复仍需原账本密码。</p>
          <label>输入“替换旧账本”确认<input aria-label="替换旧账本确认文字" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} style={{ display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 42, margin: '8px 0' }} /></label>
          <button type="button" disabled={busy || confirmation !== '替换旧账本'} onClick={() => void startNew()} style={primary}>{busy ? '正在创建…' : '确认替换并创建新账本'}</button>
        </section>}
        {message && <div role="status" style={{ marginTop: 14, color: message.includes('失败') ? 'var(--negative)' : 'var(--positive)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', lineHeight: 1.6 }}>{message}</div>}
      </section>
    </main>
  );
}
