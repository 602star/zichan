import { useCallback, useEffect, useState } from 'react';
import { requestJson } from '@zichan/db';
import { accountProtection } from '../account-protection.js';
import { useStore } from '../db/store.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';
import { AccountProfilePanel } from '../ui/AccountProfilePanel.js';
import { AccountEmailPanel } from '../ui/AccountEmailPanel.js';
import { AccountSecurityPanel } from '../ui/AccountSecurityPanel.js';
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
  const { exitAccount } = useStore();
  const profileId = accountProtection()?.profileId;
  const profile = loadSyncConnections().find((row) => row.id === profileId);
  const [usage, setUsage] = useState<AccountUsage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);

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
      <AccountEmailPanel quotaUnlimited={usage?.commits.quotaBytes === null && usage?.attachments.quotaBytes === null} />
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
