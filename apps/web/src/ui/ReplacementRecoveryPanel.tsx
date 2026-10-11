import { useState } from 'react';
import { requestJson, type SqlLedgerStore, type SyncReplicaIdentity } from '@zichan/db';
import { saveLedgerBackup } from '../db/backups.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections, saveSyncConnections, type SyncConnection } from '../sync-config.js';

interface RecoveryCheckpoint {
  checkpointId: string;
  ledgerId: string;
  replicaId: string;
  headSeq: number;
  createdAt: string;
}

interface RecoveryCatalog {
  current: SyncReplicaIdentity;
  checkpoints: RecoveryCheckpoint[];
}

export function ReplacementRecoveryPanel({ store, profile }: { store: SqlLedgerStore; profile: SyncConnection }) {
  const [catalog, setCatalog] = useState<RecoveryCatalog>();
  const [selected, setSelected] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [restored, setRestored] = useState(false);
  const baseUrl = buildSyncBaseUrl(profile);

  async function readCatalog(token: string): Promise<RecoveryCatalog> {
    const response = await requestJson(`${baseUrl}/api/v3/replica/recovery`, {
      redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await response.json() as RecoveryCatalog & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `恢复点查询失败：HTTP ${response.status}`);
    if (result.current.serverId !== profile.serverId || !Array.isArray(result.checkpoints)) {
      throw new Error('服务器身份或恢复点目录不匹配，请重新登录');
    }
    return result;
  }

  async function inspect() {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const token = await authenticateSyncProfile(profile);
      const result = await readCatalog(token);
      setCatalog(result);
      setSelected(result.checkpoints[0]?.checkpointId ?? '');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function restore() {
    if (busy || !catalog || !selected || confirmation !== '恢复旧账本') return;
    setBusy(true); setNotice('正在保存当前本机账本的加密备份…');
    let restoreIssued = false;
    const targetLedgerId = catalog.checkpoints.find((row) => row.checkpointId === selected)?.ledgerId;
    try {
      const token = await authenticateSyncProfile(profile);
      const fresh = await readCatalog(token);
      if (!fresh.checkpoints.some((row) => row.checkpointId === selected)
        || fresh.current.ledgerId !== catalog.current.ledgerId
        || fresh.current.replicaId !== catalog.current.replicaId
        || fresh.current.streamEpoch !== catalog.current.streamEpoch
        || await store.getLedgerId() !== fresh.current.ledgerId) {
        throw new Error('当前账本或恢复点已变化，请重新检查后再恢复');
      }
      const backup = await saveLedgerBackup(store, 'pre-import', '恢复服务器旧账本前');
      if (!backup.externalSaved) throw new Error('当前账本备份没有保存到浏览器之外，请先导出备份后重试');
      setNotice('备份已保存，正在把服务器切回旧账本…');
      restoreIssued = true;
      const response = await requestJson(`${baseUrl}/api/v3/replica/recovery/restore`, {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpointId: selected,
          expectedLedgerId: fresh.current.ledgerId, expectedStreamEpoch: fresh.current.streamEpoch,
          confirmation: '恢复旧账本' }),
      });
      const result = await response.json() as SyncReplicaIdentity & { error?: string };
      if (!response.ok) {
        restoreIssued = false;
        throw new Error(result.error ?? `恢复失败：HTTP ${response.status}`);
      }
      if (result.serverId !== profile.serverId || result.ledgerId !== fresh.checkpoints.find((row) => row.checkpointId === selected)?.ledgerId) {
        throw new Error('服务器已处理恢复请求，但返回身份不匹配；请重新登录检查，不要继续同步');
      }
      saveSyncConnections(loadSyncConnections().map((row) => row.id === profile.id
        ? { ...row, enabled: false, status: 'offline' as const,
          lastError: '服务器已恢复旧账本；请退出当前账本后重新登录，并用旧账本密码从服务器恢复' }
        : row));
      setRestored(true);
      setNotice('服务器已恢复旧账本，当前本机账本已另存加密备份，服务器也保留了其恢复点。请退出当前账本、重新登录，再用旧账本密码从服务器恢复。旧节点复制链路须重新授权。');
    } catch (error) {
      if (restoreIssued) {
        try {
          const token = await authenticateSyncProfile(profile);
          const current = await readCatalog(token);
          if (current.current.ledgerId === targetLedgerId) {
            saveSyncConnections(loadSyncConnections().map((row) => row.id === profile.id
              ? { ...row, enabled: false, status: 'offline' as const,
                lastError: '服务器已恢复旧账本；请重新登录并从远端恢复' } : row));
            setRestored(true);
            setNotice('服务器已恢复旧账本，但响应中断。请退出当前账本，重新登录后用旧账本密码从服务器恢复。');
            return;
          }
        } catch { /* A second connection failure leaves the result unknown. */ }
        setNotice('恢复请求结果尚未确认。请重新登录检查服务器账本身份，在确认前不要继续同步。');
      } else setNotice(error instanceof Error ? error.message : String(error));
    }
    finally { setBusy(false); }
  }

  return <details style={{ marginTop: 16 }}>
    <summary>高级：恢复替换前的个人账本</summary>
    <p>服务器在替换个人账本前保存加密检查点。恢复会先备份当前本机账本，再把服务器切回所选旧账本；需要旧账本密码才能解锁旧数据。</p>
    <button disabled={busy || restored} onClick={() => void inspect()}>检查恢复点</button>
    {catalog && <>
      {catalog.checkpoints.length === 0 ? <p>没有可恢复的旧账本。</p> : <>
        <p>当前服务器账本：{catalog.current.ledgerId}</p>
        <label>恢复点 <select value={selected} disabled={busy || restored}
          onChange={(event) => setSelected(event.target.value)}>
          {catalog.checkpoints.map((row) => <option key={row.checkpointId} value={row.checkpointId}>
            {row.ledgerId} · {row.headSeq} 条提交 · {new Date(row.createdAt).toLocaleString()}
          </option>)}
        </select></label>
        <p>请输入“恢复旧账本”确认：</p>
        <input aria-label="确认恢复旧账本" value={confirmation} disabled={busy || restored}
          onChange={(event) => setConfirmation(event.target.value)} />
        <button disabled={busy || restored || !selected || confirmation !== '恢复旧账本'}
          onClick={() => void restore()}>备份当前账本并恢复所选旧账本</button>
      </>}
    </>}
    {notice && <p role={restored ? 'status' : 'alert'}>{notice}</p>}
  </details>;
}
