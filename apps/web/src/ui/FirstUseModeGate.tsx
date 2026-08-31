import type { CSSProperties } from 'react';
import type { FirstUseMode } from '../browser-storage-policy.js';

export interface FirstUseModeGateProps {
  busy: boolean;
  error?: string;
  onSelect: (mode: FirstUseMode) => Promise<void>;
}
const card: CSSProperties = {
  minHeight: 168,
  padding: 22,
  border: '1px solid #d6ccbd',
  borderRadius: 14,
  background: '#fffdf9',
  color: '#4e473f',
  textAlign: 'left',
  cursor: 'pointer',
};

export function FirstUseModeGate({ busy, error = '', onSelect }: FirstUseModeGateProps) {
  return (
    <main style={{ minHeight: '100dvh', overflowY: 'auto', padding: 'clamp(24px, 6vw, 72px)', boxSizing: 'border-box', background: '#f0e9dc', color: '#4e473f', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(860px, 100%)', margin: '0 auto' }}>
        <div style={{ color: '#985734', fontSize: 12, fontWeight: 900, letterSpacing: '.12em' }}>ZICHAN · 首次使用</div>
        <h1 style={{ margin: '10px 0 6px', color: '#672f20', fontSize: 'clamp(28px, 5vw, 44px)' }}>选择数据保存方式</h1>
        <p style={{ margin: 0, color: '#756b60', lineHeight: 1.7 }}>之后仍可把纯本地账本连接到一台或多台同步服务器。</p>
        <div role="group" aria-label="数据保存方式" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginTop: 28 }}>
          <button type="button" disabled={busy} onClick={() => void onSelect('local')} style={{ ...card, opacity: busy ? .55 : 1 }}>
            <span style={{ display: 'block', color: '#672f20', fontSize: 20, fontWeight: 900 }}>纯本地使用</span>
            <span style={{ display: 'block', marginTop: 10, color: '#756b60', fontSize: 13, lineHeight: 1.65 }}>Windows 数据保存在便携目录；浏览器必须先取得持久存储授权，数据加密保存在当前网站的 IndexedDB。</span>
          </button>
          <button type="button" disabled={busy} onClick={() => void onSelect('server')} style={{ ...card, borderColor: '#b78a66', opacity: busy ? .55 : 1 }}>
            <span style={{ display: 'block', color: '#672f20', fontSize: 20, fontWeight: 900 }}>连接同步服务器</span>
            <span style={{ display: 'block', marginTop: 10, color: '#756b60', fontSize: 13, lineHeight: 1.65 }}>注册或登录服务器账号，从已有账本恢复，或者创建新账本并在多台设备间增量同步。</span>
          </button>
        </div>
        {error && (
          <div role="alert" style={{ marginTop: 18, padding: 14, border: '1px solid #d9a9a2', borderRadius: 10, background: '#fff5f2', color: '#8f332d', lineHeight: 1.6 }}>
            {error}<br />请连接同步服务器，或使用 Windows 完全便携版创建纯本地账本。
          </div>
        )}
      </section>
    </main>
  );
}
