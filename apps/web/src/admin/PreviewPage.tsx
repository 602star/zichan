/**
 * The ledger preview page.
 *
 * An administrator opens a preview from the user list; this page renders that user's ledger
 * through the ordinary ledger UI, with a banner that never lets the operator forget what they
 * are looking at. Three things matter here and nothing else does:
 *
 * 1. The banner states who is looking at whose data, that the look is audited, and how long the
 *    session has left. An operator who mistakes a preview for their own ledger could believe a
 *    user's figures are theirs, so the distinction is stated, not implied by colour.
 * 2. The clock counts down to the server's expiry, and the page says so when it runs out
 *    instead of showing a frozen ledger that looks live.
 * 3. Exiting closes the session server-side, which drops the plaintext immediately. It is the
 *    only control that changes anything, so it is the only one offered.
 *
 * The data itself is fetched once and handed to the read-only provider; this component owns
 * nothing but the fetch, the countdown and the close.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerBackup } from '@zichan/db';
import { PreviewStoreProvider } from './PreviewStoreProvider.js';
import { App } from '../App.js';
import { UndoProvider } from '../ui/UndoToast.js';
import { Loading, Notice, Panel, row } from './ui.js';
import type { AdminClient } from './client.js';

export interface PreviewSummary {
  previewId: string;
  username: string;
  ledgerId: string;
  transactionCount: number;
  attachmentCount: number;
  commitCount: number;
  openedAt: string;
  expiresAt: string;
}

/** Minutes and seconds left, or null once the deadline has passed. */
export function remainingLabel(expiresAt: string, now: number): string | null {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return null;
  const left = deadline - now;
  if (left <= 0) return null;
  const totalSeconds = Math.floor(left / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function PreviewPage({ client, username, operator, navigate }: {
  client: AdminClient;
  username: string;
  operator: string;
  navigate: (to: string) => void;
}) {
  const [summary, setSummary] = useState<PreviewSummary>();
  const [backup, setBackup] = useState<LedgerBackup>();
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [closing, setClosing] = useState(false);
  // Opening decrypts the user's ledger, so it is explicitly requested: the operator states a
  // reason, and the server records it before returning any data.
  const [reason, setReason] = useState('');
  const [opening, setOpening] = useState(false);
  const closed = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const closePreview = useCallback(async () => {
    const id = summary?.previewId;
    closed.current = true;
    setClosing(true);
    try {
      if (id) await client.request(`/previews/${encodeURIComponent(id)}`, undefined);
    } catch {
      // Closing is best-effort: the session also expires on its own. Reporting a failure here
      // would suggest the plaintext is still there when the server may already have dropped it.
    } finally {
      setClosing(false);
      navigate('/users');
    }
  }, [client, summary?.previewId, navigate]);

  const loadBackup = useCallback(async (id: string) => {
    try {
      const data = await client.request<LedgerBackup>(`/previews/${encodeURIComponent(id)}/backup`);
      setBackup(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [client]);

  // Reopening an existing session is what makes a refresh cheap: the server keeps one session
  // per account, and this only *reports* it. A 404 means nothing is open — the normal first
  // visit — so it is not an error to show.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const existing = await client.request<PreviewSummary>(`/users/${encodeURIComponent(username)}/preview`);
        if (!active) return;
        setSummary(existing);
        await loadBackup(existing.previewId);
      } catch {
        // Nothing is open yet; the operator opens one deliberately below.
      }
    })();
    return () => { active = false; };
  }, [client, username, loadBackup]);

  async function openPreview() {
    setOpening(true);
    setError('');
    try {
      const created = await client.request<PreviewSummary>(
        `/users/${encodeURIComponent(username)}/preview`,
        { reason },
        { idempotencyKey: `ledger-preview:${username}` },
      );
      setSummary(created);
      await loadBackup(created.previewId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpening(false);
    }
  }

  const remaining = summary ? remainingLabel(summary.expiresAt, now) : null;
  const preview = useMemo(() => (summary ? {
    previewId: summary.previewId,
    username: summary.username,
    operator,
    expiresAt: summary.expiresAt,
    openedAt: summary.openedAt,
    transactionCount: summary.transactionCount,
    attachmentCount: summary.attachmentCount,
    commitCount: summary.commitCount,
  } : undefined), [summary, operator]);

  // The backup arrives in a second request, so a summary alone is not enough to render: passing
  // an undefined backup would fail the import with a message about the backup being invalid,
  // which describes the symptom rather than the fact that nothing has loaded yet.
  if (!summary || !backup) {
    return (
      <>
        <h2>预览用户记账 · {username}</h2>
        <Panel title="为什么要写原因" note="打开预览会用服务器的托管主密钥解密这个账号的账本，因此这一操作会被记入管理审计。">
          <label style={{ display: 'block', maxWidth: 520 }}>
            查看原因
            <textarea
              className="zc-input"
              aria-label="查看原因"
              required
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 6, padding: 8, boxSizing: 'border-box' }}
            />
          </label>
          <p style={{ marginTop: 10 }}>这次查看会以“管理员 {operator} 查看了用户 {username} 的记账数据”记录在审计里，并出现在审计导出中。</p>
          {/* An open that failed must be announced, not just painted: the operator clicked and
              nothing appeared, and a silent failure reads as "still loading". */}
          {error ? <div role="alert"><Notice tone="bad">{error}</Notice></div> : null}
          <div style={{ ...row, marginTop: 12 }}>
            <button disabled={opening || !reason.trim()} onClick={() => void openPreview()}>
              {opening ? '正在解密并载入…' : summary ? '重新载入预览数据' : '打开预览'}
            </button>
            <button onClick={() => navigate('/users')}>取消</button>
          </div>
          {!reason.trim() && !summary && <p style={{ marginTop: 8 }}>请先填写原因，再打开预览。</p>}
        </Panel>
        <Loading loading={opening} error="" />
      </>
    );
  }

  return (
    <>
      <div
        role="status"
        aria-label="只读预览"
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)',
          background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 6,
        }}
      >
        <div>
          <strong>只读预览</strong>
          <span style={{ marginLeft: 8 }}>管理员 {operator} 正在查看 {summary.username} 的记账</span>
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginTop: 4 }}>
            本次查看已记录审计；数据只在服务器内存中，不写入磁盘，也不进入你的本机账本。
          </div>
        </div>
        <div style={row}>
          <span aria-live="polite">{remaining ? `剩余 ${remaining}` : '预览已过期'}</span>
          <button disabled={closing} onClick={() => void closePreview()}>{closing ? '正在退出…' : '退出预览'}</button>
        </div>
      </div>

      {remaining
        ? (
          <PreviewStoreProvider backup={backup} preview={preview} onClose={closePreview}>
            <UndoProvider><App /></UndoProvider>
          </PreviewStoreProvider>
        )
        : (
          <Notice tone="warn">
            预览已过期，服务器已经丢弃这份解密数据。如需继续查看，请重新打开预览。
          </Notice>
        )}
    </>
  );
}