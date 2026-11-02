import { useEffect, useState } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { isTauriRuntime, tauriInvoke } from '../tauri.js';
import { btnOutline, btnPrimary } from './styles.js';

interface ClientUpdateInfo {
  enabled: boolean;
  mode: string;
  currentVersion: string;
  targetVersion?: string;
  notes?: string;
  reason?: string;
}
type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' | 'Installing' };

interface UpdateAttempt {
  id: string;
  target: string;
  startedAt: string;
  state: 'pending' | 'opened' | 'success' | 'failed';
  detail?: string;
}
const historyKey = 'zichan:client-update-history:v1';
const attemptLabel: Record<UpdateAttempt['state'], string> = {
  pending: '等待安装结果', opened: '已打开系统安装器', success: '已安装', failed: '失败',
};

function readHistory(): UpdateAttempt[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(historyKey) ?? '[]');
    return Array.isArray(value) ? value.filter((row): row is UpdateAttempt => Boolean(row
      && typeof row.id === 'string' && typeof row.target === 'string' && typeof row.startedAt === 'string'
      && ['pending', 'opened', 'success', 'failed'].includes(row.state))).slice(0, 20) : [];
  } catch { return []; }
}

function writeHistory(attempt: UpdateAttempt): UpdateAttempt[] {
  const rows = readHistory();
  const next = [attempt, ...rows.filter((row) => row.id !== attempt.id)].slice(0, 20);
  try { localStorage.setItem(historyKey, JSON.stringify(next)); } catch { /* Storage may be disabled. */ }
  return next;
}

function reconcileHistory(currentVersion: string): UpdateAttempt[] {
  const rows = readHistory();
  const changed = rows.map((row) => row.state === 'pending' || row.state === 'opened'
    ? row.target === currentVersion ? { ...row, state: 'success' as const, detail: undefined } : row
    : row);
  if (changed.some((row, index) => row !== rows[index])) {
    try { localStorage.setItem(historyKey, JSON.stringify(changed)); } catch { /* Storage may be disabled. */ }
  }
  return changed;
}

export function ClientUpdatePanel() {
  const [info, setInfo] = useState<ClientUpdateInfo>();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ received: number; total?: number; stage: string }>({ received: 0, stage: '' });
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const [history, setHistory] = useState(readHistory);
  const check = async () => {
    setChecking(true); setError(''); setOutcome(''); setInfo(undefined);
    try {
      const request = tauriInvoke<ClientUpdateInfo>('client_update_check');
      if (request) {
        const next = await request;
        setInfo(next);
        setHistory(reconcileHistory(next.currentVersion));
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setChecking(false); }
  };
  useEffect(() => { if (isTauriRuntime()) void check(); }, []);
  if (!isTauriRuntime()) return null;
  const install = async () => {
    if (!info?.targetVersion) return;
    setInstalling(true); setError(''); setOutcome(''); setProgress({ received: 0, stage: '准备下载' });
    const attempt: UpdateAttempt = { id: crypto.randomUUID(), target: info.targetVersion,
      startedAt: new Date().toISOString(), state: 'pending' };
    setHistory(writeHistory(attempt));
    const channel = new Channel<DownloadEvent>();
    channel.onmessage = (event) => {
      if (event.event === 'Started') setProgress({ received: 0, total: event.data.contentLength, stage: '下载中' });
      else if (event.event === 'Progress') setProgress((current) => ({ ...current, received: current.received + event.data.chunkLength }));
      else setProgress((current) => ({ ...current, stage: event.event === 'Installing' ? '安装中' : '验证中' }));
    };
    try {
      const request = tauriInvoke<string | void>('client_update_install', { version: info.targetVersion, onEvent: channel });
      if (!request) throw new Error('原生更新命令不可用');
      const result = await request;
      const detail = info.mode === 'android'
        ? '请在系统安装界面确认，完成后重新打开应用' : result || '安装完成，正在重启';
      setOutcome(detail);
      setHistory(writeHistory({ ...attempt, state: 'opened', detail }));
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
      setInfo((current) => current ? { ...current, targetVersion: undefined } : current);
      setHistory(writeHistory({ ...attempt, state: 'failed', detail }));
    }
    finally { setInstalling(false); }
  };
  return <section className="zc-card" aria-label="应用版本更新" style={{ padding: 'var(--sp-5)' }}>
    <h2 className="zc-section-title">应用版本更新</h2>
    <p className="zc-caption">当前版本 {info?.currentVersion ?? '读取中'} · {info?.mode === 'portable' ? 'Windows 便携版' : info?.mode === 'installed' ? 'Windows 安装版' : info?.mode === 'android' ? 'Android' : info?.mode === 'ios' ? 'iOS' : 'Linux 原生版'}</p>
    {info?.reason ? <p className="zc-caption">{info.reason}</p> : null}
    {info?.targetVersion ? <p>发现新版本 {info.targetVersion}{info.notes ? ` · ${info.notes}` : ''}</p> : info?.enabled && !error ? <p>当前已是最新的可用版本。</p> : null}
    {error ? <p role="alert" style={{ color: 'var(--negative)' }}>{error}</p> : null}
    {outcome ? <p role="status">{outcome}</p> : null}
    {installing ? <p role="status">{progress.stage}{progress.total ? ` · ${Math.min(100, Math.floor(progress.received / progress.total * 100))}%` : ''} · {(progress.received / 1024 / 1024).toFixed(1)} MiB
      {progress.total ? ` / ${(progress.total / 1024 / 1024).toFixed(1)} MiB` : ''}</p> : null}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
      <button type="button" style={btnOutline} disabled={checking || installing} onClick={() => { void check(); }}>
        {checking ? '正在检查…' : '检查更新'}
      </button>
      {info?.targetVersion ? <button type="button" style={btnPrimary} disabled={checking || installing} onClick={() => { void install(); }}>
        {installing ? '正在更新…' : `更新至 ${info.targetVersion}`}
      </button> : null}
    </div>
    {history.length ? <div style={{ marginTop: 'var(--sp-4)' }}>
      <h3 className="zc-section-title">本机更新记录</h3>
      <ul style={{ paddingInlineStart: 'var(--sp-5)', marginBottom: 0 }}>
        {history.slice(0, 5).map((entry) => <li key={entry.id} style={{ overflowWrap: 'anywhere' }}>
          {new Date(entry.startedAt).toLocaleString()} · {entry.target} · {attemptLabel[entry.state]}
          {entry.detail && entry.state !== 'success' ? ` · ${entry.detail}` : ''}
        </li>)}
      </ul>
      {history.length > 5 ? <details style={{ marginTop: 'var(--sp-2)' }}>
        <summary>查看更多记录（{history.length - 5}）</summary>
        <ul style={{ paddingInlineStart: 'var(--sp-5)' }}>{history.slice(5).map((entry) => <li key={entry.id} style={{ overflowWrap: 'anywhere' }}>
          {new Date(entry.startedAt).toLocaleString()} · {entry.target} · {attemptLabel[entry.state]}
          {entry.detail && entry.state !== 'success' ? ` · ${entry.detail}` : ''}
        </li>)}</ul>
      </details> : null}
    </div> : null}
    <p className="zc-caption" style={{ marginTop: 'var(--sp-3)' }}>安装期间会退出当前应用。更新程序文件不会删除账本；如本地数据结构发生变化，请先备份。</p>
  </section>;
}
