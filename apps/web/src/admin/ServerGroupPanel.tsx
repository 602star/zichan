import { useState } from 'react';
import type { AdminClient } from './client.js';
import { Button, CopyValue, Field, Loading, Notice, Panel, TextInput,
  message, muted, row, useResource } from './ui.js';

interface GroupStatus {
  group: { groupId: string; mainNodeId: string; mainUrl: string;
    role: 'main' | 'member' } | null;
  members: { nodeId: string; nodeUrl: string; joinedAt: string }[];
  ledgerCount: number;
  progress?: { lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string };
}

export function ServerGroupPanel({ client, role }: { client: AdminClient; role: string }) {
  const status = useResource(() => client.request<GroupStatus>('/sync-group'), []);
  const currentUrl = client.baseUrl;
  const [createUrl, setCreateUrl] = useState(currentUrl);
  const [mainUrl, setMainUrl] = useState('');
  const [localUrl, setLocalUrl] = useState(currentUrl);
  const [joinCode, setJoinCode] = useState('');
  const [issued, setIssued] = useState<{ token: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const execute = async (operation: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); setNotice(success); status.reload(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const group = status.data?.group;
  return <Panel title="服务器同步组" note="每台服务器只需创建或加入一次；组内账本、账号与附件由服务器自动增量同步。">
    <Loading loading={status.loading} error={status.error} stale={status.stale} />
    <Button disabled={busy} onClick={status.reload}>刷新状态</Button>
    <p style={muted}>组内每台节点都会保存全部账本密文；托管账本的解锁材料也会在节点间安全传递并分别封存。</p>
    {!group ? <>
      <p style={muted}>本站尚未加入同步组。单机使用无需配置；需要互联时，在选定的主节点创建同步组，再在其他服务器加入。</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
        <div>
          <h3>在本站创建同步组</h3>
          <Field label="其他节点访问本站的地址">
            <TextInput value={createUrl} onChange={(event) => setCreateUrl(event.target.value)}
              placeholder="https://ledger.example.com" style={{ width: '100%' }} />
          </Field>
          <p style={muted}>使用 HTTPS 地址；本机演示可用 127.0.0.1。</p>
          <Button disabled={busy || role !== 'owner' || !createUrl.trim()} onClick={() => void execute(
            () => client.request('/sync-group/create', { mainUrl: createUrl.trim() }),
            '同步组已创建。现在可生成一次性加入码。')}>创建同步组</Button>
        </div>
        <div>
          <h3>将本站加入已有同步组</h3>
          <Field label="主节点地址"><TextInput value={mainUrl} onChange={(event) => setMainUrl(event.target.value)}
            placeholder="https://ledger.example.com" style={{ width: '100%' }} /></Field>
          <Field label="主节点生成的一次性加入码"><TextInput value={joinCode}
            onChange={(event) => setJoinCode(event.target.value)} style={{ width: '100%' }} /></Field>
          <details><summary>检查本站地址</summary>
            <Field label="本站地址"><TextInput value={localUrl} onChange={(event) => setLocalUrl(event.target.value)}
              placeholder="https://home.example.com" style={{ width: '100%' }} /></Field>
            <p style={muted}>默认使用当前网页地址；通过反向代理访问时，可在这里修正。</p>
          </details>
          <Button disabled={busy || role !== 'owner' || !mainUrl.trim() || !localUrl.trim() || !joinCode.trim()}
            onClick={() => void execute(() => client.request('/sync-group/join', {
              mainUrl: mainUrl.trim(), localUrl: localUrl.trim(), token: joinCode.trim() }),
            '本站已加入同步组，服务器正在自动发现并复制账本。')}>加入同步组</Button>
        </div>
      </div>
    </> : <>
      <p>本站是<strong>{group.role === 'main' ? '主节点' : '附属节点'}</strong>；
        同步组共有 {status.data?.members.length ?? 0} 台服务器，本站保存 {status.data?.ledgerCount ?? 0} 本账本。</p>
      <p style={muted}>主节点：{group.mainUrl}（{group.mainNodeId}）</p>
      {status.data?.progress?.lastSuccessAt ? <p style={muted}>最近目录同步：
        {new Date(status.data.progress.lastSuccessAt).toLocaleString()}</p> : null}
      {status.data?.progress?.lastError ? <Notice tone="bad">同步组目录处理失败：
        {status.data.progress.lastError}</Notice> : null}
      <ul>{status.data?.members.map((member) =>
        <li key={member.nodeId}><code>{member.nodeId}</code> · {member.nodeUrl}</li>)}</ul>
      {group.role === 'main' && role === 'owner' ? <div style={row}>
        <Button disabled={busy} onClick={() => void execute(async () => {
          const result = await client.request<{ token: string; expiresAt: string }>('/sync-group/join-token', {});
          setIssued(result);
        }, '一次性加入码已生成，有效期 20 分钟。')}>生成节点加入码</Button>
        {issued ? <span>加入码：<code>{issued.token}</code> <CopyValue value={issued.token} /></span> : null}
      </div> : null}
    </>}
    {notice ? <Notice>{notice}</Notice> : null}
    {error ? <Notice tone="bad">{error}</Notice> : null}
  </Panel>;
}
