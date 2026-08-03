import { useEffect, useState } from 'react';
import {
  checkDesktopUpdate,
  confirmDesktopUpdateHealthy,
  desktopUpdateStatus,
  installDesktopUpdate,
  type DesktopUpdateChannel,
  type DesktopUpdateStatus,
} from '../desktop-updater.js';
import { isTauriRuntime } from '../tauri.js';
import { card } from './styles.js';

interface DesktopUpdatePanelProps {
  beforeInstall: (label: string) => Promise<void>;
}

const channelLabels: Record<Exclude<DesktopUpdateChannel, 'rollback'>, string> = {
  stable: '稳定通道',
  preview: '测试通道',
};

export function DesktopUpdatePanel({ beforeInstall }: DesktopUpdatePanelProps) {
  const [channel, setChannel] = useState<Exclude<DesktopUpdateChannel, 'rollback'>>(() => {
    try {
      return localStorage.getItem('zichan.desktop.update-channel') === 'preview' ? 'preview' : 'stable';
    } catch {
      return 'stable';
    }
  });
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void desktopUpdateStatus().then(async (value) => {
      if (value?.phase === 'awaiting_health') {
        setStatus(await confirmDesktopUpdateHealthy());
      } else {
        setStatus(value);
      }
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  if (!isTauriRuntime()) return null;

  async function check(selected: DesktopUpdateChannel) {
    setBusy(`check-${selected}`);
    setError('');
    try {
      setStatus(await checkDesktopUpdate(selected));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  }

  async function install() {
    if (!status?.availableVersion) return;
    setBusy('install');
    setError('');
    try {
      await beforeInstall(`桌面更新前 · ${status.currentVersion} → ${status.availableVersion}`);
      const next = await installDesktopUpdate(status.channel);
      if (next) setStatus(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy('');
    }
  }

  const selectedLabel = status?.channel === 'rollback' ? '回退通道' : channelLabels[channel];
  return (
    <div style={card}>
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>桌面更新</div>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
            当前版本 {status?.currentVersion ?? '读取中'} · {selectedLabel}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select
            aria-label="桌面更新通道"
            className="zc-select"
            value={channel}
            disabled={busy === 'install'}
            onChange={(event) => {
              const next = event.target.value as typeof channel;
              setChannel(next);
              try {
                localStorage.setItem('zichan.desktop.update-channel', next);
              } catch {
                // The selected channel remains active for this session.
              }
            }}
            style={{ width: 126 }}
          >
            <option value="stable">稳定通道</option>
            <option value="preview">测试通道</option>
          </select>
          <button type="button" disabled={!!busy || !status?.configured} onClick={() => void check(channel)} style={outline}>
            {busy === `check-${channel}` ? '检查中…' : '检查更新'}
          </button>
          {status?.phase === 'available' && status.channel !== 'rollback' && (
            <button type="button" disabled={!!busy} onClick={() => void install()} style={primary}>备份并安装</button>
          )}
        </div>
      </div>
      <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 11, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 800, color: status?.phase === 'failed' || error ? 'var(--negative)' : 'var(--fg)' }}>
          {error || status?.message || '正在读取发布配置'}
        </div>
        {status?.availableVersion && <div>目标版本：{status.availableVersion}</div>}
        {status?.publishedAt && <div>发布时间：{status.publishedAt}</div>}
        {status?.notes && <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{status.notes}</div>}
        {!status?.configured && <div>本地开发构建不会连接发布服务器；正式安装包会固化 HTTPS 清单和签名公钥。</div>}
      </div>
      {status?.rollbackConfigured && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" disabled={!!busy} onClick={() => void check('rollback')} style={outline}>
            {busy === 'check-rollback' ? '检查中…' : '检查已签名回退版本'}
          </button>
          {status.phase === 'available' && status.channel === 'rollback' && (
            <button type="button" disabled={!!busy} onClick={() => void install()} style={danger}>备份并回退</button>
          )}
          <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>只有发布管理员上传的签名回退清单可以降级。</span>
        </div>
      )}
    </div>
  );
}

const outline = { padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg-muted)', fontWeight: 750, fontSize: 12, cursor: 'pointer' } as const;
const primary = { ...outline, borderColor: 'var(--accent)', background: 'var(--accent)', color: '#fff' } as const;
const danger = { ...outline, borderColor: 'var(--negative)', color: 'var(--negative)' } as const;
