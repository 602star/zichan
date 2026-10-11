import { useCallback, useEffect, useState } from 'react';
import { fetchAuthMe, requestJson, selectAccountLedger,
  type SyncAuthMe } from '@zichan/db';
import { WEB_ACCOUNT_BINDING_KEY, WEB_LEDGER_SWITCH_EVENT_KEY } from '../account-storage.js';
import { accountProtection } from '../account-protection.js';
import { ACCOUNT_LOCK_REQUEST_EVENT, hasAccountCloseHandler } from '../browser-account-exit.js';
import { useStore } from '../db/store.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';
import { suspendSyncForLedgerSwitch, withSyncLock } from '../sync-lock.js';
import { isTauriRuntime } from '../tauri.js';
import { activeDesktopLedgerProfile, bindLegacyDesktopLedger, desktopBinding,
  rememberDesktopProfileSwitchError, switchDesktopLedger } from '../desktop-ledger-profile.js';
import { AccountProfilePanel } from '../ui/AccountProfilePanel.js';
import { AccountEmailPanel } from '../ui/AccountEmailPanel.js';
import { AccountSecurityPanel } from '../ui/AccountSecurityPanel.js';
import { AccountKeyPanel } from '../ui/AccountKeyPanel.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { btnOutline } from '../ui/styles.js';

interface AccountUsage {
  commits: { usedBytes: number; quotaBytes: number | null; commitCount: number };
  attachments: { usedBytes: number; quotaBytes: number | null; objectCount: number; trashBytes: number; stagingBytes: number };
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

function QuotaCard({ title, used, limit, detail }: { title: string; used: number; limit: number | null; detail: string }) {
  if (limit === null) return <div style={{ flex: '1 1 240px', padding: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--surface-2)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{title}</strong><span>无限配额</span></div>
    <div style={{ margin: '12px 0 6px' }}><strong>{bytes(used)}</strong> 已用</div>
    <div style={{ color: 'var(--text-secondary)' }}>{detail}</div>
  </div>;
  const ratio = limit > 0 ? used / limit : 0;
  const label = ratio >= 1 ? '已达上限' : ratio >= 0.9 ? '接近上限' : '可用';
  return <div style={{ flex: '1 1 240px', padding: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--surface-2)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{title}</strong><span>{label} · 已用 {Math.round(ratio * 100)}%</span></div>
    <div style={{ margin: '12px 0 6px' }}><strong>{bytes(used)}</strong> / {bytes(limit)}</div>
    <progress aria-label={`${title}用量`} max={limit || 1} value={Math.min(used, limit || 1)} style={{ width: '100%' }} />
    <div style={{ color: 'var(--text-secondary)', marginTop: 6 }}>剩余 {bytes(Math.max(0, limit - used))} · {detail}</div>
  </div>;
}

export function Account() {
  const { exitAccount, prepareNativeLedgerSwitch, store } = useStore();
  const profileId = accountProtection()?.profileId;
  const profile = loadSyncConnections().find((row) => row.id === profileId);
  const [usage, setUsage] = useState<AccountUsage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  const [ledgers, setLedgers] = useState<NonNullable<SyncAuthMe['ledgers']>>([]);
  const [currentReplicaId, setCurrentReplicaId] = useState('');
  const [selectedReplicaId, setSelectedReplicaId] = useState('');
  const [switchBusy, setSwitchBusy] = useState(false);
  const [ledgerError, setLedgerError] = useState('');

  useEffect(() => {
    if (!profileId) return;
    const connection = loadSyncConnections().find((row) => row.id === profileId);
    if (!connection) return;
    let active = true;
    void authenticateSyncProfile(connection).then((token) =>
      fetchAuthMe(buildSyncBaseUrl(connection), token)).then((account) => {
      if (account.accountId !== connection.accountId) throw new Error('当前网站账号身份已变化');
      if (active) {
        setLedgers(account.ledgers ?? []);
        setCurrentReplicaId(account.replicaId ?? '');
        setSelectedReplicaId(account.replicaId ?? '');
      }
    }).catch((reason) => {
      if (active) setLedgerError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [profileId]);

  async function switchLedger() {
    if (!profile || !selectedReplicaId || selectedReplicaId === currentReplicaId || switchBusy) return;
    setSwitchBusy(true); setLedgerError('');
    try {
      if (isTauriRuntime()) {
        if (!prepareNativeLedgerSwitch) throw new Error('桌面账本切换流程不可用');
        const profileStatus = activeDesktopLedgerProfile();
        if (!profileStatus) throw new Error('桌面账本 profile 状态尚未加载');
        if (!profileStatus.ledgerProfileSwitchSupported) throw new Error('当前桌面平台尚未支持账本 profile 切换');
        await withSyncLock(async () => {
          const resumeSync = suspendSyncForLedgerSwitch();
          let resumeBackups: (() => void) | undefined;
          try {
            const token = await authenticateSyncProfile(profile);
            const account = await fetchAuthMe(buildSyncBaseUrl(profile), token);
            const currentLedgerId = await store.getLedgerId();
            if (account.accountId !== profile.accountId || account.ledgerId !== currentLedgerId
              || !account.replicaId || (profile.replicaId && account.replicaId !== profile.replicaId)
              || !account.streamEpoch) {
              throw new Error('当前本机账本与服务器会话不一致，请重新登录后再切换');
            }
            const target = account.ledgers?.find((item) => item.replicaId === selectedReplicaId);
            if (!target) throw new Error('目标账本不在当前账号可访问列表中');
            if (target.replicaId === account.replicaId) throw new Error('当前账本已经打开');
            const currentBinding = desktopBinding(profile, currentLedgerId,
              account.replicaId, account.streamEpoch);
            if (profileStatus.ledgerProfileId === 'legacy') {
              await bindLegacyDesktopLedger(currentBinding);
            } else if (JSON.stringify(profileStatus.ledgerProfileBinding) !== JSON.stringify(currentBinding)) {
              const bound = profileStatus.ledgerProfileBinding;
              if (!bound || bound.serverId !== currentBinding.serverId
                || bound.accountId !== currentBinding.accountId || bound.replicaId !== currentBinding.replicaId
                || bound.ledgerId !== currentBinding.ledgerId || bound.streamEpoch !== currentBinding.streamEpoch) {
                throw new Error('本机账本 profile 与当前服务器副本身份不一致');
              }
            }
            const targetBinding = desktopBinding(profile, target.ledgerId,
              target.replicaId, target.streamEpoch);
            resumeBackups = await prepareNativeLedgerSwitch();
            await switchDesktopLedger(targetBinding);
            throw new Error('桌面重启未开始');
          } catch (reason) {
            resumeBackups?.();
            resumeSync();
            if (resumeBackups) {
              rememberDesktopProfileSwitchError(reason instanceof Error ? reason.message : String(reason));
              window.location.reload();
            }
            throw reason;
          }
        });
        return;
      }
      await withSyncLock(async () => {
        const resume = suspendSyncForLedgerSwitch();
        try {
          const token = await authenticateSyncProfile(profile);
          const selected = await selectAccountLedger(buildSyncBaseUrl(profile), token, selectedReplicaId);
          if (selected.accountId !== profile.accountId) throw new Error('服务器返回了不同账号的账本');
          try {
            const remembered = { ...profile, ledgerId: selected.ledgerId,
              replicaId: selected.replicaId, streamEpoch: selected.streamEpoch,
              browserSessionId: selected.session.id };
            const encoded = JSON.stringify(remembered);
            sessionStorage.setItem(WEB_ACCOUNT_BINDING_KEY, encoded);
            localStorage.setItem(WEB_ACCOUNT_BINDING_KEY, encoded);
          } catch { /* The live cookie session still restores the selected ledger after reload. */ }
          try {
            localStorage.setItem(WEB_LEDGER_SWITCH_EVENT_KEY, JSON.stringify({
              serverId: profile.serverId, accountId: profile.accountId,
              replicaId: selected.replicaId, at: Date.now(),
            }));
          } catch { /* The selected session still reloads this tab safely. */ }
          if (hasAccountCloseHandler()) window.dispatchEvent(new Event(ACCOUNT_LOCK_REQUEST_EVENT));
          else window.location.reload();
        } catch (reason) { resume(); throw reason; }
      });
    } catch (reason) {
      setLedgerError(reason instanceof Error ? reason.message : String(reason));
      setSwitchBusy(false);
    }
  }

  const refreshUsage = useCallback(async () => {
    const selected = loadSyncConnections().find((row) => row.id === profileId);
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const token = await authenticateSyncProfile(selected);
      const response = await requestJson(`${buildSyncBaseUrl(selected)}/api/auth/usage`, {
        cache: 'no-store', redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`配额查询失败（HTTP ${response.status}）`);
      setUsage(await response.json() as AccountUsage);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [profileId]);

  useEffect(() => { void refreshUsage(); }, [refreshUsage]);

  return <div>
    {profile ? <>
      <div className="zc-card"><AccountProfilePanel /></div>
      {ledgers.length > 1 && (!isTauriRuntime()
        || activeDesktopLedgerProfile()?.ledgerProfileSwitchSupported) && <section className="zc-card" aria-label="选择账本">
        <h2 className="zc-section-title">选择账本</h2>
        <p className="zc-caption">此账号可进入 {ledgers.length} 个账本。{isTauriRuntime()
          ? '桌面版切换时会关闭当前加密数据库并重启，目标账本使用独立的本机文件和安全库；首次进入需再次登录并解锁。'
          : '切换会保存并关闭当前设备缓存，然后打开所选账本。'}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <select aria-label="账本副本" value={selectedReplicaId}
            onChange={(event) => setSelectedReplicaId(event.target.value)} disabled={switchBusy}>
            {ledgers.map((item) => <option key={item.replicaId} value={item.replicaId}>{item.ledgerId}</option>)}
          </select>
          <button type="button" style={btnOutline} disabled={switchBusy || !selectedReplicaId
            || selectedReplicaId === currentReplicaId} onClick={() => void switchLedger()}>
            {switchBusy ? '正在切换…' : '进入账本'}
          </button>
        </div>
        {ledgerError && <p role="alert">{ledgerError}</p>}
      </section>}
      {ledgers.length <= 1 && ledgerError && <p role="alert">账本列表读取失败：{ledgerError}</p>}
      <AccountEmailPanel quotaUnlimited={usage?.commits.quotaBytes === null && usage?.attachments.quotaBytes === null} />
      <AccountKeyPanel profile={profile} />
      <section className="zc-card" aria-label="账本副本入口">
        <h2 className="zc-section-title">账本副本</h2>
        <p className="zc-caption">查看当前账本在各服务器上的复制进度、完整性状态和节点授权；添加副本后由服务器在后台补齐数据。</p>
        <button type="button" style={btnOutline} onClick={() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'sync' } }))}>查看账本副本与状态</button>
      </section>
      <section className="zc-card" aria-label="存储配额">
        <div className="zc-section-head"><div><h2 className="zc-section-title">存储配额</h2><p className="zc-meta">当前服务器：{profile.alias || profile.baseUrl}。只统计此账号在这台服务器上的加密数据。</p></div><button type="button" style={btnOutline} disabled={busy} onClick={() => void refreshUsage()}>{busy ? '查询中…' : '刷新用量'}</button></div>
        {usage && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
          <QuotaCard title="加密记录" used={usage.commits.usedBytes} limit={usage.commits.quotaBytes} detail={`${usage.commits.commitCount} 条同步提交`} />
          <QuotaCard title="附件" used={usage.attachments.usedBytes} limit={usage.attachments.quotaBytes} detail={`${usage.attachments.objectCount} 个有效附件对象`} />
        </div>}
        {usage && <p className="zc-caption">附件用量包含有效附件、回收站（{bytes(usage.attachments.trashBytes)}）和暂存上传（{bytes(usage.attachments.stagingBytes)}）。{usage.attachments.quotaBytes === null ? '当前账号无限额，仍受单文件大小与服务器磁盘空间限制。' : '配额由服务器管理员设置；达到上限后，新数据可能无法上传。'}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
      <AccountSecurityPanel onExit={exitAccount} />
      {exitAccount && <section className="zc-card" aria-label="退出账号"><h2 className="zc-section-title">退出账号</h2><p className="zc-caption">退出会锁定本机账本并撤销会话；加密缓存与未同步记录仍留在本机。</p><button type="button" style={btnOutline} onClick={() => setConfirmExit(true)}>退出记账账号</button></section>}
      {confirmExit && exitAccount && <ConfirmDialog title="退出记账账号" confirmLabel="确认退出" onCancel={() => setConfirmExit(false)} onConfirm={exitAccount}><p>退出前请确认重要记录已同步，或已导出加密备份。未同步数据会留在本机；请勿清除网站数据。</p></ConfirmDialog>}
    </> : <section className="zc-card"><h2 className="zc-section-title">本地账本</h2><p>此账本当前没有登录中的服务器账号，因此没有服务器存储配额。</p><button type="button" style={btnOutline} onClick={() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'sync' } }))}>管理同步服务器</button></section>}
  </div>;
}
