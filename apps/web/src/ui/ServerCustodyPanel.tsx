import { useEffect, useState } from 'react';
import { accountProtection, protectionRequest, type ProtectionInfo } from '../account-protection.js';
import { storedLedgerKeyEnvelope } from '../ledger-key-vault.js';
import type { SyncConnection } from '../sync-config.js';
import { isPrimaryWebConnection } from '../web-sync-connections.js';

export function ServerCustodyPanel({ profile }: { profile: SyncConnection }) {
  const [info, setInfo] = useState<ProtectionInfo>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setInfo(undefined); setError(''); setConfirmed(false); }, [profile.id, profile.username, profile.baseUrl]);
  if (isPrimaryWebConnection(profile) || accountProtection()?.profileId === profile.id) return null;
  async function inspect() {
    setBusy(true); setError('');
    try { setInfo(await protectionRequest(profile)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function change(mode: 'managed' | 'relay') {
    const state = accountProtection();
    const envelope = storedLedgerKeyEnvelope();
    if (!info || !state || !envelope || busy) return;
    setBusy(true); setError('');
    try {
      if (info.controlled) throw new Error('成员账本的密钥由成员控制链管理，不能使用旧服务器托管设置');
      if (mode === 'managed' && (state.info.mode !== 'managed' || !confirmed)) throw new Error('私密账本不能授权托管，请先在账本保护中更改模式');
      const result = await protectionRequest(profile, 'PUT', { mode, version: info.version, envelope,
        ...(mode === 'managed' ? { secret: state.secret, confirmation: '允许此服务器解密账本' } : {}) });
      setInfo(result); setConfirmed(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="zc-protection" style={{ padding: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 16 }} aria-label="服务器保护方式">
    <strong>此服务器的保护方式</strong><p>新增连接默认仅同步密文，无需另设密钥。托管需要此服务器支持，并明确授权。</p>
    <button disabled={busy} onClick={() => void inspect()}>检查保护方式</button>
    {info && <><p>{info.mode === 'managed' ? '此服务器已获授权，可以解密账本。' : '此服务器仅保存密文，没有托管解密凭据。'}</p>
      {info.controlled ? <p>此账本已启用成员密钥；旧服务器托管设置不可再修改，请在成员管理中轮换密钥。</p>
        : info.mode === 'managed' ? <><p>撤销会删除此服务器当前保存的托管凭据。若需要阻止未来解密，请把整个账本切到私密模式以轮换密钥。</p><button disabled={busy} onClick={() => void change('relay')}>撤销此服务器托管</button></>
        : info.custodyEnabled && accountProtection()?.info.mode === 'managed' ? <><label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />允许此服务器解密账本</label><button disabled={busy || !confirmed || !profile.ledgerId} onClick={() => void change('managed')}>启用此服务器托管</button><p>先完成一次同步，再授权托管。</p></>
          : <p>{info.custodyEnabled ? '当前为私密账本，保持仅存密文。' : '此服务器未开放托管能力。'}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
