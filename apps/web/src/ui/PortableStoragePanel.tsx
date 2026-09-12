import { useEffect, useState } from 'react';
import {
  readDesktopStorageStatus,
  type DesktopStorageStatus,
} from '../portable-desktop.js';
import { card } from './styles.js';

export function PortableStoragePanel() {
  const [status, setStatus] = useState<DesktopStorageStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void readDesktopStorageStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, []);

  if (!status && !error) return null;
  return (
    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 800 }}>完全便携存储</div>
      {status ? (
        <>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.7, marginTop: 8 }}>
            数据库、附件、备份、凭据、同步服务器和界面状态均保存在程序目录的 data 文件夹中。
            移动或备份前必须完全退出应用；整个 data 文件夹都应视为敏感数据。
          </div>
          <dl className="zc-storage-facts" style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '6px 12px', margin: '12px 0 0', fontSize: 12 }}>
            <dt style={{ color: 'var(--fg-subtle)' }}>程序目录</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{status.rootDirectory}</dd>
            <dt style={{ color: 'var(--fg-subtle)' }}>数据目录</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{status.dataDirectory}</dd>
            <dt style={{ color: 'var(--fg-subtle)' }}>文件系统</dt>
            <dd style={{ margin: 0 }}>{status.filesystem}</dd>
            <dt style={{ color: 'var(--fg-subtle)' }}>WebView2</dt>
            <dd style={{ margin: 0 }}>{status.webviewRuntime === 'fixed' ? 'ZIP 内置固定版' : '系统 Evergreen 回退'}</dd>
          </dl>
          <div style={{ marginTop: 12, border: '1px solid var(--negative)', borderRadius: 10, padding: 10, color: 'var(--negative)', fontSize: 12, lineHeight: 1.6 }}>
            内置同步服务器监听 {status.serverBind}:8787，可被同一局域网访问。应用不会自动创建防火墙规则，请只在可信网络启用。
          </div>
        </>
      ) : (
        <div style={{ marginTop: 8, color: 'var(--negative)', fontSize: 12 }}>读取便携存储状态失败：{error}</div>
      )}
    </div>
  );
}
