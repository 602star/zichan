/** Account-scoped writes, shared by the user list and the user detail page. */
import { useRef, useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { quotaBytesFromGiB } from './number-input.js';
import { Button, Field, Notice, Select, TextInput, bytes, message, muted, quotaLimit, row } from './ui.js';
import type { AccountRow } from './types.js';

export interface AccountActionTarget {
  accountId: string;
  username: string;
  role: AccountRow['role'];
  revision: number;
  disabled: boolean;
  commitBytes: number;
  commitQuotaBytes: number | null;
  activeDeviceCount: number;
}

export type AccountActionMode = '' | 'state' | 'commit' | 'blob' | 'role' | 'sessions';

export function AccountActions({ client, target, canManage, canEditQuota, onDone, token, initialMode = '', hideTriggers = false, onBusyChange }: {
  client: AdminClient;
  target: AccountActionTarget;
  canManage: boolean;
  /** Owners may retune their own quota; only the actor role decides this. */
  canEditQuota?: boolean;
  onDone: () => void;
  /** 'full' shows quotas and role changes; 'inline' keeps only state and sessions. */
  token?: 'full' | 'inline';
  initialMode?: AccountActionMode;
  hideTriggers?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [mode, setMode] = useState<AccountActionMode>(initialMode);
  const [reason, setReason] = useState('');
  const [commitGiB, setCommitGiB] = useState(target.commitQuotaBytes === null ? '' : String(target.commitQuotaBytes / 1024 ** 3));
  const [blobGiB, setBlobGiB] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer' | 'member'>(target.role === 'admin' || target.role === 'viewer' ? target.role : 'member');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const full = token !== 'inline';

  const submit = async (path: string, body: Record<string, unknown>): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); onBusyChange?.(true); setError(''); setNotice('');
    try {
      await client.request(`/accounts/${target.accountId}${path}`, { ...body, expectedVersion: target.revision, ...(reason ? { reason } : {}) }, { idempotencyKey: adminIdempotencyKey(path) });
      setMode('');
      setNotice('操作已完成。');
      onDone();
    } catch (caught) {
      setError(message(caught));
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const saveQuota = (kind: 'commits' | 'blobs', raw: string) => {
    try {
      const bytes = quotaBytesFromGiB(raw);
      void submit(`/${kind}`, { [kind === 'commits' ? 'commitQuotaBytes' : 'quotaBytes']: bytes });
    } catch (caught) { setNotice(''); setError(message(caught)); }
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {!hideTriggers ? <div style={row}>
        <Button disabled={busy || !canManage} onClick={() => setMode(mode === 'state' ? '' : 'state')}>{target.disabled ? '启用账号' : '禁用账号'}</Button>
        {full ? <Button disabled={busy || !canEditQuota} onClick={() => setMode(mode === 'commit' ? '' : 'commit')}>调整提交配额</Button> : null}
        {full ? <Button disabled={busy || !canEditQuota} onClick={() => setMode(mode === 'blob' ? '' : 'blob')}>调整附件配额</Button> : null}
        {full ? <Button disabled={busy || !canManage} onClick={() => setMode(mode === 'role' ? '' : 'role')}>修改角色</Button> : null}
        <Button disabled={busy || !canManage} onClick={() => { setError(''); setNotice(''); setMode('sessions'); }}>撤销全部可管理会话</Button>
      </div> : null}

      {mode === 'sessions' ? (
        <section aria-label="确认撤销全部会话" style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <strong>确认撤销全部可管理会话</strong>
          <div>目标账号：{target.username}（<code>{target.accountId}</code>）</div>
          <p style={muted}>根据当前数据，将影响 {target.activeDeviceCount} 个有效会话。执行时会撤销该账号的全部可管理会话；用户需要重新登录，账号与数据保留。实际数量可能随用户登录或退出变化。</p>
          <div style={row}>
            <Button disabled={busy || !canManage} onClick={() => { void submit('/sessions/revoke', {}); }}>{busy ? '正在撤销…' : '确认撤销'}</Button>
            <Button disabled={busy} onClick={() => setMode('')}>取消</Button>
          </div>
        </section>
      ) : null}

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
            当前用量 {bytes(target.commitBytes)}；上限 {quotaLimit(target.commitQuotaBytes)}。低于当前用量时不会删除已有数据，只限制后续上传。
          </p>
          {(target.role === 'owner' || target.role === 'admin') && <p style={muted}>所有者和管理员始终无限额；这里设置的数值只在角色变更为普通用户或只读运维后生效。</p>}
          <Field label="新的上限（GiB）"><TextInput value={commitGiB} inputMode="decimal" onChange={(event) => setCommitGiB(event.target.value)} /></Field>
          <p style={muted}>输入纯数字，范围 0.0009765625–1024 GiB，最多 30 位小数，按最近的整数字节保存。</p>
          <Field label="原因（会写入审计）"><TextInput value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></Field>
          <div style={row}>
            <Button disabled={busy} onClick={() => saveQuota('commits', commitGiB)}>保存</Button>
            <Button disabled={busy} onClick={() => { void submit('/commits', { commitQuotaBytes: null }); }}>恢复服务器默认</Button>
            <Button onClick={() => setMode('')}>取消</Button>
          </div>
        </div>
      ) : null}

      {mode === 'blob' ? (
        <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <strong>调整附件配额</strong>
          <p style={muted}>提交、有效附件、回收站与暂存上传都计入配额；降低上限不删除已有内容。</p>
          {(target.role === 'owner' || target.role === 'admin') && <p style={muted}>所有者和管理员始终无限额；这里设置的数值只在角色变更为普通用户或只读运维后生效。</p>}
          <Field label="新的上限（GiB）"><TextInput value={blobGiB} inputMode="decimal" onChange={(event) => setBlobGiB(event.target.value)} /></Field>
          <p style={muted}>输入纯数字，范围 0.0009765625–1024 GiB，最多 30 位小数，按最近的整数字节保存。</p>
          <Field label="原因（会写入审计）"><TextInput value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></Field>
          <div style={row}>
            <Button disabled={busy} onClick={() => saveQuota('blobs', blobGiB)}>保存</Button>
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
