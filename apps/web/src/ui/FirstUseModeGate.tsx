import { useState, type CSSProperties } from 'react';
import { browserLocalCapability, type FirstUseMode } from '../browser-storage-policy.js';
import { isTauriRuntime } from '../tauri.js';

export interface FirstUseModeGateProps {
  busy: boolean;
  error?: string;
  onSelect: (mode: FirstUseMode) => Promise<void>;
  persistence?: { checked: boolean; persisted: boolean; reason: string };
  onContinueLocal?: () => Promise<void>;
}

export function BrowserStorageConsent({ busy, onContinue }: { busy: boolean; onContinue: () => Promise<void> }) {
  const [accepted, setAccepted] = useState(false);
  return <section aria-label="普通本地存储风险确认" style={{ marginTop: 18, padding: 16, border: '1px solid #b78a66', borderRadius: 10 }}>
    <p>普通本地存储仍会加密保存账本，但空间不足时浏览器可能自动清理；清除网站数据会删除账本，无痕窗口关闭后数据通常会丢失。即使取得持久保护，也不能防止手动清理。</p>
    <p>请定期导出加密 .zcbak 到浏览器外并妥善保管密码；浏览器内部的自动备份不算独立备份。</p>
    <label style={{ display: 'block', marginBottom: 12 }}><input type="checkbox" checked={accepted} disabled={busy} onChange={(event) => setAccepted(event.target.checked)} />我了解数据清理风险，会保存浏览器外备份</label>
    <button type="button" disabled={busy || !accepted} onClick={() => void onContinue()} style={{ padding: '10px 16px' }}>确认风险，继续本地使用</button>
  </section>;
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

export function FirstUseModeGate({ busy, error = '', onSelect, persistence, onContinueLocal }: FirstUseModeGateProps) {
  const native = isTauriRuntime();
  const capability = browserLocalCapability();
  return (
    <main style={{ minHeight: '100dvh', overflowY: 'auto', padding: 'clamp(24px, 6vw, 72px)', boxSizing: 'border-box', background: '#f0e9dc', color: '#4e473f', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(860px, 100%)', margin: '0 auto' }}>
        <div style={{ color: '#985734', fontSize: 12, fontWeight: 900, letterSpacing: '.12em' }}>ZICHAN · 首次使用</div>
        <h1 style={{ margin: '10px 0 6px', color: '#672f20', fontSize: 'clamp(28px, 5vw, 44px)' }}>选择数据保存方式</h1>
        <p style={{ margin: 0, color: '#756b60', lineHeight: 1.7 }}>之后仍可把纯本地账本连接到一台或多台同步服务器。</p>
        <section aria-label="存储能力与权限状态" style={{ marginTop: 20, padding: 16, background: '#fffdf9', borderRadius: 12, lineHeight: 1.8 }}>
          <strong>当前存储能力与权限</strong>
          {native ? <p>桌面本地存储：使用应用数据目录，不需要浏览器持久存储授权。</p> : <>
            <div>本地加密存储：{capability.supported ? '所需接口可用（实际读写将在打开账本时验证）' : `不可用，缺少 ${capability.missing.join('、')}`}</div>
            <div>防自动清理保护：{!persistence?.checked ? '正在检查' : persistence.persisted ? '已授予' : '未授予或未确认'}</div>
            <div>普通 IndexedDB 存储不是文件夹访问授权；本站不会因此获得任意磁盘文件的读写权限。</div>
            <div>Chrome、Edge 通常自动决定是否授予保护，不弹授权窗口。点击“纯本地使用”会尝试申请。</div>
            {persistence?.checked && !persistence.persisted && <div>{persistence.reason}</div>}
          </>}
        </section>
        <div role="group" aria-label="数据保存方式" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginTop: 28 }}>
          <button type="button" disabled={busy} onClick={() => void onSelect('local')} style={{ ...card, opacity: busy ? .55 : 1 }}>
            <span style={{ display: 'block', color: '#672f20', fontSize: 20, fontWeight: 900 }}>纯本地使用</span>
            <span style={{ display: 'block', marginTop: 10, color: '#756b60', fontSize: 13, lineHeight: 1.65 }}>桌面版保存到应用数据目录；网页版加密保存在当前网站的 IndexedDB。未取得防自动清理保护时，可确认风险后继续。</span>
          </button>
          <button type="button" disabled={busy} onClick={() => void onSelect('server')} style={{ ...card, borderColor: '#b78a66', opacity: busy ? .55 : 1 }}>
            <span style={{ display: 'block', color: '#672f20', fontSize: 20, fontWeight: 900 }}>连接同步服务器</span>
            <span style={{ display: 'block', marginTop: 10, color: '#756b60', fontSize: 13, lineHeight: 1.65 }}>注册或登录服务器账号，从已有账本恢复，或者创建新账本并在多台设备间增量同步。</span>
          </button>
        </div>
        {!native && capability.supported && persistence?.checked && !persistence.persisted && onContinueLocal && <>
          <button type="button" disabled={busy} onClick={() => void onSelect('local')} style={{ marginTop: 16, padding: 10 }}>重新申请防自动清理保护</button>
          <BrowserStorageConsent busy={busy} onContinue={onContinueLocal} />
        </>}
        {error && (
          <div role="alert" style={{ marginTop: 18, padding: 14, border: '1px solid #d9a9a2', borderRadius: 10, background: '#fff5f2', color: '#8f332d', lineHeight: 1.6 }}>
            {error}
          </div>
        )}
      </section>
    </main>
  );
}
