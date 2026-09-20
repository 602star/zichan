/**
 * The maintenance window control.
 *
 * What this panel is careful about:
 *
 * - **It does not claim to perform the backup.** The deployment-side procedure stops this process
 *   to snapshot it; a button here could not do that. So the panel declares the window, shows the
 *   command to run, and answers the one question the operator cannot answer from outside: whether
 *   stopping now would interrupt a write or a job.
 * - **"Maintenance" is not shown as a fault.** A planned window and a degraded service are
 *   different states with different next steps, so the two are never merged.
 * - **It says when writes come back.** An open-ended window is allowed, but the panel says plainly
 *   that nothing will resume it automatically, because that is the difference between a window and
 *   an outage with a friendly name.
 */
import { useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, Field, Notice, Panel, Stat, TextInput, canWrite, message, muted, row, useActionError, when } from './ui.js';
import type { DrainView, MaintenanceView } from './types.js';

/** Windows offered in the console: a short patch, a longer migration, or open-ended. */
const WINDOWS = [
  { label: '30 分钟', minutes: 30 },
  { label: '1 小时', minutes: 60 },
  { label: '4 小时', minutes: 240 },
  { label: '不设结束时间', minutes: 0 },
];

export function MaintenancePanel({ client, role, view, drain, onChanged }: {
  client: AdminClient;
  role: string;
  view: MaintenanceView | undefined;
  drain: DrainView | undefined;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<{ minutes: number; message: string }>({ minutes: 60, message: '' });
  const [busy, setBusy] = useState(false);
  const actionError = useActionError();
  const writable = canWrite(role);
  // Only the owner may declare a window; the server refuses anyone else, so the control is hidden
  // rather than offered and rejected.
  const owner = writable && role === 'owner';

  const submit = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    actionError.clear();
    try {
      const until = enabled && draft.minutes > 0 ? new Date(Date.now() + draft.minutes * 60_000).toISOString() : null;
      await client.request('/maintenance', { enabled, ...(until ? { until } : {}), message: enabled ? draft.message.trim() : '' }, { idempotencyKey: adminIdempotencyKey(`maintenance-${enabled ? 'on' : 'off'}`) });
      onChanged();
    } catch (error) {
      actionError.setError(message(error));
    } finally { setBusy(false); }
  };

  return (
    <Panel
      title="维护窗口"
      action={view?.active ? <Badge tone="warn">维护中</Badge> : view?.expired ? <Badge tone="muted">已过期</Badge> : <Badge tone="ok">正常</Badge>}
      note="后台不执行停服备份与生产恢复——那些流程必须先停掉服务本身。这里声明窗口、暂停客户端写入，并说明现在停机是否会中断工作。"
    >
      {actionError.error ? <Notice tone="bad">{actionError.error}</Notice> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
        <Stat label="客户端写入" value={view?.active ? '已暂停' : '正常'} tone={view?.active ? 'warn' : undefined}
          hint={view?.active ? '读取与登录不受影响' : '读写都可用'} />
        <Stat label="写入中" value={drain ? drain.inFlightWrites : '暂无数据'} hint="正在进行、尚未完成的客户端写入" />
        <Stat label="执行中任务" value={drain ? drain.runningJobs : '暂无数据'} hint={drain && drain.queuedJobs > 0 ? `另有 ${drain.queuedJobs} 个排队任务` : '排队任务不计入停机风险'} />
      </div>

      {view?.active ? (
        <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
          <p style={muted}>
            维护中：{view.message}
            {view.until ? `，计划至 ${when(view.until)}。` : '，且未设结束时间——不会自动恢复，需要手动结束。'}
          </p>
          {view.startedBy ? <p style={muted}>由 {view.startedBy} 于 {view.startedAt ? when(view.startedAt) : '未记录'}声明。</p> : null}
        </div>
      ) : view?.expired ? (
        <p style={muted}>此前的维护窗口已过期，客户端写入已自动恢复；记录仍保留，可在管理审计中查看。</p>
      ) : null}

      {drain ? <Notice tone={drain.safeToStop ? undefined : 'warn'}>{drain.note}</Notice> : null}

      {owner ? (
        view?.active ? (
          <div style={{ ...row, marginTop: 10 }}>
            <Button disabled={busy} onClick={() => { void submit(false); }}>结束维护，恢复写入</Button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            <Field label="维护说明（会显示给客户端）">
              <TextInput value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} placeholder="例如：升级数据库，约 30 分钟" />
            </Field>
            <div style={row}>
              <span style={muted}>计划时长</span>
              {WINDOWS.map((option) => (
                <Button key={option.minutes} disabled={draft.minutes === option.minutes} onClick={() => setDraft({ ...draft, minutes: option.minutes })}>{option.label}</Button>
              ))}
            </div>
            <p style={muted}>
              建议先确认「写入中」为 0 再停机：停机会中断仍在进行的写入，客户端需要重传。
            </p>
            <div style={row}>
              <Button disabled={busy} onClick={() => { void submit(true); }}>声明维护窗口</Button>
            </div>
          </div>
        )
      ) : (
        <p style={muted}>只有服务器所有者可以声明维护窗口。</p>
      )}
    </Panel>
  );
}
