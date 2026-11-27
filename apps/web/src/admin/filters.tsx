/** Shared filters: a time window and an account picker, used by the diagnostic pages. */
import { useEffect, useState } from 'react';
import { CalendarDatePicker } from '../ui/CalendarDatePicker.js';
import { TimeRangeSelect } from '../ui/TimeRangeSelect.js';
import type { AdminClient } from './client.js';
import { Button, Field, Notice, TextInput, muted, row, useResource } from './ui.js';
import { RANGE_PRESETS, describeRange, isoToLocalInput, localInputToIso, presetWindow } from './time.js';
import type { AccountRow } from './types.js';

/**
 * A time window with the ledger's year/month/day date navigation and exact local clock fields.
 *
 * The parent keeps `from`/`until` in ISO in the URL; local drafts and the preset label
 * never change the query until applied (quick presets apply immediately).
 */
export function TimeRangeFilter({ from, until, onApply, label = '时间范围', showPresets = true, help, showDraftStatus = false, presetControl }: {
  from: string;
  until: string;
  onApply: (range: { from: string | undefined; until: string | undefined }) => void;
  label?: string;
  showPresets?: boolean;
  help?: string;
  showDraftStatus?: boolean;
  presetControl?: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void };
}) {
  const [fromDraft, setFromDraft] = useState(isoToLocalInput(from, true));
  const [untilDraft, setUntilDraft] = useState(isoToLocalInput(until, true));
  const [presetSelection, setPresetSelection] = useState<{ value: string; from: string; until: string } | null>(null);
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
  const matches = (draft: string, value: string) => (!draft && !value) || Date.parse(localInputToIso(draft) ?? '') === Date.parse(value);
  const draftsMatch = matches(fromDraft, from) && matches(untilDraft, until);
  const presetValue = draftsMatch && presetSelection?.from === from && presetSelection.until === until
    ? presetSelection.value : fromDraft || untilDraft ? 'custom' : 'all';
  const clear = () => {
    setFromDraft(''); setUntilDraft(''); setPresetSelection(null);
    onApply({ from: undefined, until: undefined });
  };

  return (
    <div role="group" aria-label={label}>
      <span style={muted}>{label}</span>
      <div style={row}>
        {showPresets && <TimeRangeSelect label={presetControl?.label} value={presetControl ? draftsMatch ? presetControl.value : 'custom' : presetValue} onChange={(value) => {
          if (presetControl) { presetControl.onChange(value); return; }
          if (value === 'all') { clear(); return; }
          if (value === 'custom') { setPresetSelection({ value, from, until }); return; }
          const preset = RANGE_PRESETS.find((item) => String(item.hours) === value);
          if (!preset) return;
          const window = presetWindow(preset.hours);
          setFromDraft(isoToLocalInput(window.from, true)); setUntilDraft('');
          setPresetSelection({ value, from: window.from, until: '' });
          onApply({ from: window.from, until: undefined });
        }} options={presetControl?.options ?? [
          ...RANGE_PRESETS.map((preset) => ({ value: String(preset.hours), label: preset.label })),
          { value: 'all', label: '全部时间' }, { value: 'custom', label: '自定义' },
        ]} />}
        <div className="zc-admin-time-boundary" role="group" aria-label="起始时间">
          <span>从</span>
          <CalendarDatePicker value={fromDraft.slice(0, 10)} onChange={(date) => setDate(date, fromDraft, setFromDraft, '00:00')} label="起始日期" />
          <TextInput type="time" value={fromDraft.slice(11, 16)} disabled={!fromDraft} onChange={(event) => setTime(event.target.value, fromDraft, setFromDraft)} aria-label="起始时分" />
        </div>
        <div className="zc-admin-time-boundary" role="group" aria-label="结束时间">
          <span style={muted}>至</span>
          <CalendarDatePicker value={untilDraft.slice(0, 10)} onChange={(date) => setDate(date, untilDraft, setUntilDraft, '23:59:59.999')} label="结束日期" />
          <TextInput type="time" value={untilDraft.slice(11, 16)} disabled={!untilDraft} onChange={(event) => setTime(event.target.value, untilDraft, setUntilDraft)} aria-label="结束时分" />
        </div>
        <Button disabled={Boolean(problem)} onClick={() => onApply({ from: localInputToIso(fromDraft), until: localInputToIso(untilDraft) })}>应用</Button>
        <Button onClick={clear}>清除</Button>
      </div>
      <div style={{ ...row, marginTop: 6 }}>
        <span style={muted}>{help ?? '显示与保存都按本地时间，发给服务端的仍是 UTC；快捷区间为「从某时刻起」，之后的新记录会继续出现。'}</span>
      </div>
      {showDraftStatus && !draftsMatch && <p role="status" style={muted}>修改尚未应用，结果仍按已应用区间显示。</p>}
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
    <Field label="账号（用户名或完整账号 ID）">
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
