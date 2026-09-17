/** Account-scoped writes, shared by the user list and the user detail page. */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Button, Field, Notice, Select, TextInput, bytes, message, muted, row } from './ui.js';
import type { AccountRow } from './types.js';

export interface AccountActionTarget {
  accountId: string;
  username: string;
  role: AccountRow['role'];
  revision: number;
  disabled: boolean;
  commitBytes: number;
  commitQuotaBytes: number;
  activeDeviceCount: number;
}

export function AccountActions({ client, target, canManage, canEditQuota, onDone, token }: {
  client: AdminClient;
  target: AccountActionTarget;
  canManage: boolean;
  /** Owners may retune their own quota; only the actor role decides this. */
  canEditQuota?: boolean;
  onDone: () => void;
  /** 'full' shows quotas and role changes; 'inline' keeps only state and sessions. */
  token?: 'full' | 'inline';
}) {
  const [mode, setMode] = useState<'' | 'state' | 'commit' | 'blob' | 'role'>('');
  const [reason, setReason] = useState('');
  const [commitGiB, setCommitGiB] = useState(String((target.commitQuotaBytes / 1024 ** 3).toFixed(2)));
  const [blobGiB, setBlobGiB] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer' | 'member'>(target.role === 'admin' || target.role === 'viewer' ? target.role : 'member');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const full = token !== 'inline';

  const submit = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setBusy(true); setError(''); setNotice('');
    try {
      await client.request(`/accounts/${target.accountId}${path}`, { ...body, expectedVersion: target.revision, ...(reason ? { reason } : {}) }, { idempotencyKey: adminIdempotencyKey(path) });
      setMode('');
      setNotice('操作已完成。');
      onDone();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={row}>
        <Button disabled={!canManage} onClick={() => setMode(mode === 'state' ? '' : 'state')}>{target.disabled ? '启用账号' : '禁用账号'}</Button>
        {full ? <Button disabled={!canEditQuota} onClick={() => setMode(mode === 'commit' ? '' : 'commit')}>调整提交配额</Button> : null}
        {full ? <Button disabled={!canEditQuota} onClick={() => setMode(mode === 'blob' ? '' : 'blob')}>调整附件配额</Button> : null}
        {full ? <Button disabled={!canManage} onClick={() => setMode(mode === 'role' ? '' : 'role')}>修改角色</Button> : null}
        <Button disabled={!canManage} onClick={() => { void submit('/sessions/revoke', {}); }}>撤销全部可管理会话</Button>
      </div>

      {mode === 'state' ? (
        <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <strong>{target.disabled ? '启用账号' : '禁用账号'}</strong>
          <p style={muted}>
            {target.disabled
              ? '启用后账号可以重新登录；旧会话不会复活，需要用户重新登录。'
              : `将立即撤销该账号的 ${target.activeDeviceCount} 个有效会话，数据保留。`}
          </p>
          <Field label="原因（会写入审计）"><TextInput value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></Field>
          <div style={row}>
            <Button disabled={busy} onClick={() => { void submit('/state', { disabled: !target.disabled }); }}>确认{target.disabled ? '启用' : '禁用'}</Button>
            <Button onClick={() => setMode('')}>取消</Button>
          </div>
        </div>
      ) : null}

      {mode === 'commit' ? (
        <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <strong>调整提交配额</strong>
          <p style={muted}>
            当前用量 {bytes(target.commitBytes)}；上限 {bytes(target.commitQuotaBytes)}。低于当前用量时不会删除已有数据，只限制后续上传。
          </p>
          <Field label="新的上限（GiB）"><TextInput value={commitGiB} inputMode="decimal" onChange={(event) => setCommitGiB(event.target.value)} /></Field>
          <Field label="原因（会写入审计）"><TextInput value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></Field>
          <div style={row}>
            <Button disabled={busy} onClick={() => { void submit('/commits', { commitQuotaBytes: Math.round(Number(commitGiB) * 1024 ** 3) }); }}>保存</Button>
            <Button disabled={busy} onClick={() => { void submit('/commits', { commitQuotaBytes: null }); }}>恢复服务器默认</Button>
            <Button onClick={() => setMode('')}>取消</Button>
          </div>
        </div>
      ) : null}

      {mode === 'blob' ? (
        <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <strong>调整附件配额</strong>
          <p style={muted}>提交、有效附件、回收站与暂存上传都计入配额；降低上限不删除已有内容。</p>
          <Field label="新的上限（GiB）"><TextInput value={blobGiB} inputMode="decimal" onChange={(event) => setBlobGiB(event.target.value)} /></Field>
          <Field label="原因（会写入审计）"><TextInput value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></Field>
          <div style={row}>
            <Button disabled={busy} onClick={() => { void submit('/blobs', { quotaBytes: Math.round(Number(blobGiB) * 1024 ** 3) }); }}>保存</Button>
            <Button disabled={busy} onClick={() => { void submit('/blobs', { quotaBytes: null }); }}>恢复服务器默认</Button>
            <Button onClick={() => setMode('')}>取消</Button>
          </div>
        </div>
      ) : null}

      {mode === 'role' ? (
        <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <strong>修改角色</strong>
          <p style={muted}>需要最近 5 分钟内的登录。完成后会撤销目标账号的现有会话，权限变化立即生效。</p>
          <Field label="角色">
            <Select value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'member' | 'viewer')}>
              <option value="member">普通用户</option>
              <option value="admin">管理员</option>
              <option value="viewer">只读运维（可查看与导出，不能变更）</option>
            </Select>
          </Field>
          <Field label="原因（会写入审计）"><TextInput value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></Field>
          <div style={row}>
            <Button disabled={busy} onClick={() => { void submit('/role', { role }); }}>保存</Button>
            <Button onClick={() => setMode('')}>取消</Button>
          </div>
        </div>
      ) : null}

      {notice ? <Notice>{notice}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
    </div>
  );
}

export function RoleNote({ role }: { role: AccountRow['role'] }) {
  return <p style={muted}>{role === 'owner' ? '所有者账号不可禁用或降权。' : role === 'admin' ? '管理员账号仅所有者可管理。' : role === 'viewer' ? '只读运维账号仅所有者可管理；它只能查看与导出，不能执行管理变更。' : '普通用户可由管理员管理。'}</p>;
}
