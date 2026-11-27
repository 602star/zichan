import { useCallback, useEffect, useState } from 'react';
import { fetchAuthMe, requestJson } from '@zichan/db';
import { accountProtection } from '../account-protection.js';
import { useStore } from '../db/store.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';
import { AccountProfilePanel } from '../ui/AccountProfilePanel.js';
import { AccountEmailPanel } from '../ui/AccountEmailPanel.js';
import { AccountNotificationsPanel } from '../ui/AccountNotificationsPanel.js';
import { AccountSecurityPanel } from '../ui/AccountSecurityPanel.js';
import { CardAlert } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { useCompactView } from '../ui/useCompactView.js';
import { MobilePageHeader, TaskList, useMobileSection } from '../ui/MobilePage.js';
import { navigateTo, useScreenTarget } from '../screen-target.js';

interface AccountUsage {
  commits: { usedBytes: number; quotaBytes: number | null; commitCount: number };
  attachments: { usedBytes: number; quotaBytes: number | null; objectCount: number; trashBytes: number; stagingBytes: number };
  transfer?: { commitPushRequests: number; commitPullRequests: number;
    commitUploadBytes: number; commitDownloadBytes: number;
    blobUploadBytes: number; blobDownloadBytes: number;
    syncRuns: number; convergedRuns: number; partialRuns: number; failedRuns: number };
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

function QuotaCard({ title, used, limit, detail }: { title: string; used: number; limit: number | null; detail: string }) {
  if (limit === null) return <div className="zc-card-metric">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{title}</strong><span>无限配额</span></div>
    <div style={{ margin: '12px 0 6px' }}><strong>{bytes(used)}</strong> 已用</div>
    <div style={{ color: 'var(--text-secondary)' }}>{detail}</div>
  </div>;
  const ratio = limit > 0 ? used / limit : 0;
  const label = ratio >= 1 ? '已达上限' : ratio >= 0.9 ? '接近上限' : '可用';
  const state = ratio >= 1 ? 'over' : ratio >= 0.9 ? 'warn' : 'ok';
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  return <div className="zc-card-metric">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{title}</strong><span>{label} · 已用 {Math.round(ratio * 100)}%</span></div>
    <div style={{ margin: '12px 0 6px' }}><strong>{bytes(used)}</strong> / {bytes(limit)}</div>
    <div className="zc-quota-meter" role="progressbar" aria-label={`${title}用量`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} data-state={state}><span style={{ width: `${percent}%` }} /></div>
    <div style={{ color: 'var(--text-secondary)', marginTop: 6 }}>剩余 {bytes(Math.max(0, limit - used))} · {detail}</div>
  </div>;
}

export function Account() {
  const compact = useCompactView();
  const target = useScreenTarget('account');
  const [view, open, back] = useMobileSection('account');
  const { exitAccount } = useStore();
  const profileId = accountProtection()?.profileId;
  const profile = loadSyncConnections().find((row) => row.id === profileId);
  const [usage, setUsage] = useState<AccountUsage>();
  const [roleInfo, setRoleInfo] = useState<{ node: string; ledger: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  useEffect(() => { if (target?.tab && ['profile', 'email', 'notifications', 'security', 'quota'].includes(target.tab)) open(target.tab); }, [target, open]);
  const active = view === 'index' ? 'profile' : view;

  useEffect(() => {
    if (!profileId) return;
    const connection = loadSyncConnections().find((row) => row.id === profileId);
    if (!connection) return;
    let active = true;
    void authenticateSyncProfile(connection).then((token) =>
      fetchAuthMe(buildSyncBaseUrl(connection), token)).then((account) => {
      if (account.accountId !== connection.accountId) throw new Error('当前网站账号身份已变化');
      if (active) {
        setRoleInfo({ node: ({ owner: '节点所有者', admin: '节点管理员', viewer: '只读管理员', member: '普通用户' })[account.role],
          ledger: account.ledgerId ? '个人账本' : '尚未创建账本' });
      }
    }).catch(() => { /* Account details remain available after a transient network failure. */ });
    return () => { active = false; };
  }, [profileId]);

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

  const logout = confirmExit && exitAccount && <ConfirmDialog title="退出记账账号" confirmLabel="确认退出" onCancel={() => setConfirmExit(false)} onConfirm={exitAccount}><p>退出前请确认重要记录已同步，或已导出加密备份。未同步数据会留在本机；请勿清除网站数据。</p></ConfirmDialog>;
  if (compact && view === 'index' && profile) return <div className="zc-mobile-task-page">
    <section className="zc-paper-detail"><h2>{profile.username || profile.alias || '我的账号'}</h2><p className="zc-caption">{profile.alias || '当前服务器'}{roleInfo ? ` · ${roleInfo.node}` : ''}</p></section>
    <TaskList title="账号资料" items={[
      { label: '个人资料', note: '昵称与登录身份', onClick: () => open('profile') },
      { label: '邮箱', note: '绑定、验证和恢复途径', onClick: () => open('email') },
      { label: '报告与提醒', note: '日报、周报、自然月/发薪月报与推送', onClick: () => open('notifications') },
      { label: '账号安全', note: '密码与登录会话', onClick: () => open('security') },
      { label: '存储配额', note: error ? '暂时无法读取用量，打开后可重试' : '加密记录、附件与传输用量', onClick: () => open('quota') },
    ]} />
    <TaskList title="数据与设备" items={[
      { label: '数据保护', note: '服务器副本与同步状态', onClick: () => navigateTo({ screen: 'settings', tab: 'server' }) },
      ...(exitAccount ? [{ label: '退出记账账号', onClick: () => setConfirmExit(true) }] : []),
    ]} />
    {logout}
  </div>;
  return <div className={`zc-mobile-task-page${!compact && profile ? ' zc-account-workspace' : ''}`}>
    {!compact && profile && <nav className="zc-workspace-nav" aria-label="账号分类">{([['profile', '个人资料'], ['email', '邮箱'], ['notifications', '报告与提醒'], ['security', '账号安全'], ['quota', '存储配额']] as const).map(([id, label]) => <button type="button" key={id} aria-current={active === id ? 'page' : undefined} onClick={() => open(id)}>{label}</button>)}</nav>}
    <div className="zc-account-workspace-body">
    {compact && profile && <MobilePageHeader title={({ profile: '个人资料', email: '邮箱', notifications: '报告与提醒', security: '账号安全', quota: '存储配额' } as Record<string, string>)[view] ?? '我的账号'} onBack={back} backLabel="返回账号" />}
    {profile ? <>
      {(compact ? view === 'profile' : active === 'profile') && <div className="zc-card"><AccountProfilePanel /></div>}
      {(compact ? view === 'email' : active === 'email') && <AccountEmailPanel quotaUnlimited={usage?.commits.quotaBytes === null && usage?.attachments.quotaBytes === null} />}
      {(compact ? view === 'notifications' : active === 'notifications') && <AccountNotificationsPanel />}
      {!compact && active === 'profile' && <section className="zc-card" aria-label="数据保护入口">
        <h2 className="zc-section-title">数据保护</h2>
        <p className="zc-caption">查看当前账本连接了哪些服务器、各服务器的副本是否就绪；服务器同步组由管理员配置。</p>
        <button type="button" className="zc-btn" onClick={() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'settings', tab: 'server' } }))}>查看服务器上的账本</button>
      </section>}
      {(compact ? view === 'quota' : active === 'quota') && <section className="zc-card" aria-label="存储配额">
        <div className="zc-section-head"><div><h2 className="zc-section-title">存储配额</h2><p className="zc-meta">当前服务器：{profile.alias || profile.baseUrl}。只统计此账号在这台服务器上的加密数据。</p></div><button type="button" className="zc-btn" disabled={busy} onClick={() => void refreshUsage()}>{busy ? '查询中…' : '刷新用量'}</button></div>
        {roleInfo && <p className="zc-caption">本站角色：{roleInfo.node} · 当前账本权限：{roleInfo.ledger}</p>}
        {usage && <div className="zc-card-band is-inset zc-account-quota-band">
          <QuotaCard title="加密记录" used={usage.commits.usedBytes} limit={usage.commits.quotaBytes} detail={`${usage.commits.commitCount} 条同步提交`} />
          <QuotaCard title="附件" used={usage.attachments.usedBytes} limit={usage.attachments.quotaBytes} detail={`${usage.attachments.objectCount} 个有效附件对象`} />
        </div>}
        {usage && <p className="zc-caption">附件用量包含有效附件、回收站（{bytes(usage.attachments.trashBytes)}）和暂存上传（{bytes(usage.attachments.stagingBytes)}）。{usage.attachments.quotaBytes === null ? '当前账号无限额，仍受单文件大小与服务器磁盘空间限制。' : '配额由服务器管理员设置；达到上限后，新数据可能无法上传。'}</p>}
        {usage?.transfer && <p className="zc-caption">本站同步 {usage.transfer.syncRuns} 轮（已收敛 {usage.transfer.convergedRuns}、待续 {usage.transfer.partialRuns}、失败 {usage.transfer.failedRuns}）；上传 {bytes(usage.transfer.commitUploadBytes + usage.transfer.blobUploadBytes)}、下载 {bytes(usage.transfer.commitDownloadBytes + usage.transfer.blobDownloadBytes)}。只统计已记录的加密正文，重试计入流量。</p>}
        {error && <CardAlert tone="danger" role="alert">{error}</CardAlert>}
      </section>}
      {(compact ? view === 'security' : active === 'security') && <AccountSecurityPanel onExit={exitAccount} />}
      {!compact && active === 'security' && exitAccount && <section className="zc-card" aria-label="退出账号"><h2 className="zc-section-title">退出账号</h2><p className="zc-caption">退出会锁定本机账本并撤销会话；加密缓存与未同步记录仍留在本机。</p><button type="button" className="zc-btn zc-btn--danger" onClick={() => setConfirmExit(true)}>退出记账账号</button></section>}
      {logout}
    </> : <section className="zc-card"><h2 className="zc-section-title">本地账本</h2><p>此账本当前没有登录中的服务器账号，因此没有服务器存储配额。</p><button type="button" className="zc-btn" onClick={() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'settings', tab: 'device' } }))}>查看数据保护</button></section>}
    </div>
  </div>;
}
