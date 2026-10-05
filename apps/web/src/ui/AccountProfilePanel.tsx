import { useEffect, useState } from 'react';
import { fetchAuthMe, requestJson } from '@zichan/db';
import { accountProtection } from '../account-protection.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';

export function AccountProfilePanel() {
  const profileId = accountProtection()?.profileId;
  const profile = loadSyncConnections().find((row) => row.id === profileId);
  const [displayName, setDisplayName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const selected = loadSyncConnections().find((row) => row.id === profileId);
    if (!selected) return;
    let active = true;
    void authenticateSyncProfile(selected).then((token) => fetchAuthMe(buildSyncBaseUrl(selected), token))
      .then((me) => { if (active) { setDisplayName(me.displayName || me.username); setSavedName(me.displayName || me.username); } })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [profileId]);

  if (!profile) return null;
  const selected = profile;
  const avatarText = Array.from(savedName || selected.username)[0] || '?';
  async function save() {
    const next = displayName.trim();
    if (!next || Array.from(next).length > 24 || /[\p{Cc}\p{Cf}]/u.test(next)) { setMessage('昵称请填写 1 至 24 个字符，不能包含控制字符'); return; }
    setBusy(true); setMessage('');
    try {
      const token = await authenticateSyncProfile(selected);
      const response = await requestJson(`${buildSyncBaseUrl(selected)}/api/auth/profile`, {
        method: 'PUT', cache: 'no-store', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ displayName: next }),
      });
      const result = await response.json() as { displayName?: string; error?: string };
      if (!response.ok || !result.displayName) throw new Error(result.error || '昵称保存失败');
      setDisplayName(result.displayName); setSavedName(result.displayName);
      setMessage('昵称已保存');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <section className="zc-section" aria-label="个人资料">
    <h2 className="zc-section-title">个人资料</h2>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '14px 0' }}>
      <span aria-hidden="true" style={{ width: 48, height: 48, borderRadius: 'var(--r-round)', display: 'grid', placeItems: 'center', background: 'var(--accent-soft)', color: 'var(--text-primary)', fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{avatarText}</span>
      <span><strong>{savedName || selected.username}</strong><br /><small>当前使用昵称首字作为头像</small></span>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
      <label>昵称<input className="zc-input" aria-label="修改昵称" autoComplete="nickname" value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <small>支持中文，1 至 24 个字符，可随时修改。</small>
      <label>登录账号<input className="zc-input" value={selected.username} readOnly aria-label="登录账号" /></label>
      <small>登录账号用于登录，注册后暂不能修改。</small>
      <button type="submit" disabled={busy || !displayName.trim() || displayName.trim() === savedName}>{busy ? '保存中…' : '保存昵称'}</button>
    </form>
    {selected.accountId && <details style={{ marginTop: 16 }}><summary>账号标识（排障时使用）</summary><code style={{ overflowWrap: 'anywhere' }}>{selected.accountId}</code></details>}
    {message && <p role="status">{message}</p>}
  </section>;
}
