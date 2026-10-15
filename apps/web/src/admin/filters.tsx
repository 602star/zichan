/** Shared filters: a time window and an account picker, used by the diagnostic pages. */
import { useEffect, useState } from 'react';
import { CalendarDatePicker } from '../ui/CalendarDatePicker.js';
import type { AdminClient } from './client.js';
import { Button, Field, Notice, TextInput, muted, row, useResource } from './ui.js';
import { RANGE_PRESETS, describeRange, isoToLocalInput, localInputToIso, presetWindow } from './time.js';
import type { AccountRow } from './types.js';

/**
 * A time window with the ledger's year/month/day date navigation and exact local clock fields.
 *
 * The parent keeps `from`/`until` in ISO in the URL; this component only owns the two
 * drafts, so an unapplied edit never changes what is being queried.
 */
export function TimeRangeFilter({ from, until, onApply, label = '时间范围' }: {
  from: string;
  until: string;
  onApply: (range: { from: string | undefined; until: string | undefined }) => void;
  label?: string;
}) {
  const [fromDraft, setFromDraft] = useState(isoToLocalInput(from, true));
  const [untilDraft, setUntilDraft] = useState(isoToLocalInput(until, true));
  // Follow the URL when it changes from elsewhere (a deep link, or "clear all filters").
  useEffect(() => { setFromDraft(isoToLocalInput(from, true)); setUntilDraft(isoToLocalInput(until, true)); }, [from, until]);
  const problem = (fromDraft && !localInputToIso(fromDraft)) || (untilDraft && !localInputToIso(untilDraft))
    ? '日期或时间无效，请重新选择。'
    : describeRange(localInputToIso(fromDraft) ?? '', localInputToIso(untilDraft) ?? '');
  const setDate = (date: string, draft: string, update: (value: string) => void, defaultTime: string) => {
    update(date ? `${date}T${draft.slice(11) || defaultTime}` : '');
  };
  const setTime = (time: string, draft: string, update: (value: string) => void) => {
    if (draft) update(`${draft.slice(0, 10)}T${time || '00:00'}`);
  };

  return (
    <div role="group" aria-label={label}>
      <span style={muted}>{label}</span>
      <div style={row}>
        <div className="zc-admin-time-boundary" role="group" aria-label="起始时间">
          <CalendarDatePicker value={fromDraft.slice(0, 10)} onChange={(date) => setDate(date, fromDraft, setFromDraft, '00:00')} label="起始日期" />
          <TextInput type="time" value={fromDraft.slice(11, 16)} disabled={!fromDraft} onChange={(event) => setTime(event.target.value, fromDraft, setFromDraft)} aria-label="起始时分" />
        </div>
        <span style={muted}>至</span>
        <div className="zc-admin-time-boundary" role="group" aria-label="结束时间">
          <CalendarDatePicker value={untilDraft.slice(0, 10)} onChange={(date) => setDate(date, untilDraft, setUntilDraft, '23:59:59.999')} label="结束日期" />
          <TextInput type="time" value={untilDraft.slice(11, 16)} disabled={!untilDraft} onChange={(event) => setTime(event.target.value, untilDraft, setUntilDraft)} aria-label="结束时分" />
        </div>
        <Button disabled={Boolean(problem)} onClick={() => onApply({ from: localInputToIso(fromDraft), until: localInputToIso(untilDraft) })}>应用</Button>
        <Button onClick={() => { setFromDraft(''); setUntilDraft(''); onApply({ from: undefined, until: undefined }); }}>清除</Button>
      </div>
      <div style={{ ...row, marginTop: 6 }}>
        {RANGE_PRESETS.map((preset) => (
          <Button key={preset.hours} onClick={() => {
            const window = presetWindow(preset.hours);
            setFromDraft(isoToLocalInput(window.from, true));
            setUntilDraft('');
            onApply({ from: window.from, until: undefined });
          }}>{preset.label}</Button>
        ))}
        <span style={muted}>显示与保存都按本地时间，发给服务端的仍是 UTC；快捷区间为「从某时刻起」，之后的新记录会继续出现。</span>
      </div>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </div>
  );
}

/**
 * Account picker for the diagnostic pages.
 *
 * It searches through the same `/users` endpoint the user list uses (username or full
 * accountId) instead of downloading every account: the picker only needs the twenty best
 * matches, and the filter value travels as an accountId so a shared link stays valid even
 * if the username changes.
 */
export function AccountFilter({ client, accountId, username, onApply }: {
  client: AdminClient;
  accountId: string;
  username: string;
  onApply: (next: { accountId: string | undefined; username: string | undefined }) => void;
}) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);
  const matches = useResource(() => debounced
    ? client.request<{ users: AccountRow[] }>(`/users?limit=20&search=${encodeURIComponent(debounced)}`)
    : Promise.resolve({ users: [] }), [debounced]);

  return (
    <Field label="账号（用户名或完整 accountId）">
      <div style={row}>
        <TextInput value={term} placeholder="输入用户名或 account-… 搜索"
          onChange={(event) => { setTerm(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
        {username || accountId ? (
          <>
            <span style={muted}>当前：{username || '（未知用户名）'}{accountId ? ` · ${accountId}` : ''}</span>
            <Button onClick={() => { setTerm(''); setOpen(false); onApply({ accountId: undefined, username: undefined }); }}>取消该账号筛选</Button>
          </>
        ) : null}
      </div>
      {open && debounced ? (
        <div style={{ marginTop: 6 }}>
          {matches.error ? <Notice tone="bad">{matches.error}</Notice> : null}
          {!matches.loading && matches.data?.users.length === 0 && !matches.error
            ? <span style={muted}>没有匹配的账号。也可以直接粘贴完整 accountId。</span>
            : null}
          <div style={row}>
            {(matches.data?.users ?? []).map((account) => (
              <Button key={account.accountId} onClick={() => {
                setTerm(''); setOpen(false);
                onApply({ accountId: account.accountId, username: account.username });
              }}>{account.username}{account.disabled ? '（已禁用）' : ''}</Button>
            ))}
            <Button onClick={() => { setOpen(false); onApply({ accountId: debounced, username: undefined }); }}>按完整 accountId「{debounced}」筛选</Button>
          </div>
        </div>
      ) : null}
    </Field>
  );
}
