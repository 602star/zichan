/** Shared filters: a time window and an account picker, used by the diagnostic pages. */
import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { Button, Field, Notice, TextInput, muted, row, useResource } from './ui.js';
import { RANGE_PRESETS, describeRange, isoToLocalInput, localInputToIso, presetWindow } from './time.js';
import type { AccountRow } from './types.js';

/**
 * A time window expressed as two `datetime-local` inputs plus one-click presets.
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
  const [fromDraft, setFromDraft] = useState(isoToLocalInput(from));
  const [untilDraft, setUntilDraft] = useState(isoToLocalInput(until));
  // Follow the URL when it changes from elsewhere (a deep link, or "clear all filters").
  useEffect(() => { setFromDraft(isoToLocalInput(from)); setUntilDraft(isoToLocalInput(until)); }, [from, until]);
  const problem = describeRange(localInputToIso(fromDraft) ?? '', localInputToIso(untilDraft) ?? '');

  return (
    <Field label={label}>
      <div style={row}>
        <TextInput type="datetime-local" value={fromDraft} onChange={(event) => setFromDraft(event.target.value)} aria-label="起始时间" />
        <span style={muted}>至</span>
        <TextInput type="datetime-local" value={untilDraft} onChange={(event) => setUntilDraft(event.target.value)} aria-label="结束时间" />
        <Button disabled={Boolean(problem)} onClick={() => onApply({ from: localInputToIso(fromDraft), until: localInputToIso(untilDraft) })}>应用</Button>
        <Button onClick={() => { setFromDraft(''); setUntilDraft(''); onApply({ from: undefined, until: undefined }); }}>清除</Button>
      </div>
      <div style={{ ...row, marginTop: 6 }}>
        {RANGE_PRESETS.map((preset) => (
          <Button key={preset.hours} onClick={() => {
            const window = presetWindow(preset.hours);
            setFromDraft(isoToLocalInput(window.from));
            setUntilDraft('');
            onApply({ from: window.from, until: undefined });
          }}>{preset.label}</Button>
        ))}
        <span style={muted}>显示与保存都按本地时间，发给服务端的仍是 UTC；快捷区间为「从某时刻起」，之后的新记录会继续出现。</span>
      </div>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </Field>
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
