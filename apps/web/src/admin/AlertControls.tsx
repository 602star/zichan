import { useRef, useState } from 'react';
import type { AdminClient } from './client.js';
import type { Alert } from './types.js';
import { acknowledgeAlert, isSilenced, silenceAlert, unsilenceAlert, SILENCE_HOURS } from './alerts.js';
import { Button, Field, Notice, Select, TextInput, canWrite, message, row } from './ui.js';

/** Act where the alert is being read; acknowledgement never implies recovery. */
export function AlertControls({ client, alert, role, onChanged }: { client: AdminClient; alert: Alert; role: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState(24);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (pending.current || !canWrite(role)) return;
    pending.current = true; setBusy(true); setError('');
    try { await action(); setEditing(false); onChanged(); }
    catch (caught) { setError(message(caught)); }
    finally { pending.current = false; setBusy(false); }
  };
  if (alert.state === 'resolved') return <span>已结束</span>;
  if (!canWrite(role)) return <span>只读运维不可处理</span>;
  return <div className="zc-admin-alert-controls">
    <div style={row}>
      <Button disabled={busy || Boolean(alert.acknowledgedAt)} onClick={() => { void run(() => acknowledgeAlert(client, alert)); }}>{alert.acknowledgedAt ? '已知晓' : '标记已知晓'}</Button>
      {isSilenced(alert)
        ? <Button disabled={busy} onClick={() => { void run(() => unsilenceAlert(client, alert)); }}>恢复通知</Button>
        : <Button disabled={busy} onClick={() => setEditing(!editing)}>暂停通知…</Button>}
    </div>
    {editing ? <div className="zc-admin-inline-form">
      <Field label="暂停通知时长"><Select value={String(hours)} disabled={busy} onChange={(event) => setHours(Number(event.target.value))}>
        {SILENCE_HOURS.map((value) => <option key={value} value={value}>{value >= 24 ? `${value / 24} 天` : `${value} 小时`}</option>)}
      </Select></Field>
      <Field label="暂停通知原因"><TextInput value={reason} maxLength={200} disabled={busy} onChange={(event) => setReason(event.target.value)} /></Field>
      <div style={row}><Button disabled={busy || !reason.trim()} onClick={() => { void run(() => silenceAlert(client, alert, { hours, reason })); }}>确认暂停通知</Button>
        <Button disabled={busy} onClick={() => setEditing(false)}>取消</Button></div>
    </div> : null}
    {error ? <Notice tone="bad">{error}</Notice> : null}
  </div>;
}
