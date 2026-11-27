import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, Download } from 'lucide-react';
import {
  calendarDayInfo,
  exportCalendarIcs,
  importCalendarIcs,
  localToday,
  parseCalendarPreferences,
  type CalendarPreferences,
} from '@zichan/core';
import { saveCalendarEntry } from '@zichan/db';
import type { Snapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { saveLedgerSetting } from '../db/ledger-settings.js';
import { cacheCalendarDisplay } from '../calendar-display.js';
import { requestNotificationPermission } from '../device-capabilities.js';
import { accountLocalStorage } from '../account-storage.js';
import './home-calendar.css';

type View = CalendarPreferences['defaultView'];

const viewLabels: Record<View, string> = { month: '月', week: '周', day: '日', year: '年', agenda: '议程' };
const notifyKey = 'zichan.calendar-notifications.v1';

export function CalendarSettings({ snap }: { snap: Snapshot }) {
  const { store, bump, preview } = useStore();
  const storedPreferences = useMemo(
    () => parseCalendarPreferences(snap.setting?.calendarPreferencesJson),
    [snap.setting?.calendarPreferencesJson],
  );
  const [displayOverride, setDisplayOverride] = useState<CalendarPreferences | null>(null);
  const preferences = displayOverride ?? storedPreferences;
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => accountLocalStorage.getItem(notifyKey) === 'true');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const today = localToday();
  const timezone = snap.setting?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const info = calendarDayInfo(today);

  useEffect(() => cacheCalendarDisplay(preferences), [preferences]);
  useEffect(() => {
    if (displayOverride && JSON.stringify(displayOverride) === JSON.stringify(storedPreferences)) {
      setDisplayOverride(null);
    }
  }, [displayOverride, storedPreferences]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      bump();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changePreferences(patch: Partial<CalendarPreferences>) {
    if (busy) return;
    const previous = preferences;
    const next = { ...previous, ...patch };
    setDisplayOverride(next);
    setBusy(true);
    setError('');
    setNotice('正在保存日历显示设置…');
    try {
      if (!snap.setting) throw new Error('账本设置未就绪');
      await saveLedgerSetting(store, snap.setting, snap.setting, { calendarPreferencesJson: JSON.stringify(next) }, '修改日历显示');
      cacheCalendarDisplay(next);
      bump();
      setNotice('日历显示设置已保存到本机。');
    } catch (cause) {
      setDisplayOverride(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file?: File) {
    if (!file) return;
    await run(async () => {
      if (file.size > 5_000_000) throw new Error('日历文件不能超过 5 MB');
      const text = await file.text();
      const entries = importCalendarIcs(text, timezone);
      await store.transaction(async (scoped) => {
        const existing = await scoped.calendarEntries.list();
        for (const entry of entries) {
          const prior = entry.sourceUid
            ? existing.find((item) => item.sourceUid === entry.sourceUid || `${item.id}@youben` === entry.sourceUid)
            : undefined;
          await saveCalendarEntry(
            scoped,
            prior ? { ...entry, id: prior.id, createdAt: prior.createdAt, version: prior.version } : entry,
          );
        }
      });
      setNotice(`已导入 ${entries.length} 条日历事项。相同 UID 的事项已更新。`);
    });
    if (inputRef.current) inputRef.current.value = '';
  }

  function exportFile() {
    const blob = new Blob([exportCalendarIcs(snap.calendarEntries ?? [])], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `有本日历-${today}.ics`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('已导出个人事项；农历规则保留在有本扩展字段中，其他日历可能仅识别首次日期。完成与单次例外请使用完整账本备份保留。');
  }

  async function toggleNotifications() {
    if (notificationsEnabled) {
      accountLocalStorage.removeItem(notifyKey);
      setNotificationsEnabled(false);
      setError('');
      setNotice('系统日历提醒已关闭，事项仍保留。');
      return;
    }
    await run(async () => {
      const permission = await requestNotificationPermission();
      if (permission !== 'granted') throw new Error('系统未授权通知，仍可在日历中查看提醒');
      accountLocalStorage.setItem(notifyKey, 'true');
      setNotificationsEnabled(true);
      setNotice('应用打开时可发送日历通知；关闭应用后不保证系统通知送达。');
    });
  }

  return (
    <section id="zc-settings-calendar" className="zc-card" aria-label="日历显示与导入导出">
      <h2 className="zc-section-title">日历显示与导入导出</h2>
      <div className="zc-home-calendar-option-fields">
        <label>
          <input
            type="checkbox"
            checked={preferences.showLunar}
            disabled={busy || !!preview}
            onChange={(e) => void changePreferences({ showLunar: e.target.checked })}
          />
          农历
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.showFestivals}
            disabled={busy || !!preview}
            onChange={(e) => void changePreferences({ showFestivals: e.target.checked })}
          />
          节日与节气
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.showHolidays}
            disabled={busy || !!preview}
            onChange={(e) => void changePreferences({ showHolidays: e.target.checked })}
          />
          放假与调休
        </label>
        <label>
          每周开始
          <select
            className="zc-select"
            value={preferences.firstDay}
            disabled={busy || !!preview}
            onChange={(e) => void changePreferences({ firstDay: Number(e.target.value) as 0 | 1 })}
          >
            <option value="1">周一</option>
            <option value="0">周日</option>
          </select>
        </label>
        <label>
          默认视图
          <select
            className="zc-select"
            value={preferences.defaultView}
            disabled={busy || !!preview}
            onChange={(e) => void changePreferences({ defaultView: e.target.value as View })}
          >
            {Object.entries(viewLabels).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="zc-home-calendar-option-fields">
        <button type="button" className="zc-btn" onClick={() => inputRef.current?.click()} disabled={busy || !!preview}>
          导入 ICS
        </button>
        <input
          hidden
          type="file"
          accept=".ics,text/calendar"
          aria-label="导入日历文件"
          ref={inputRef}
          onChange={(e) => void importFile(e.target.files?.[0])}
        />
        <button type="button" className="zc-btn" onClick={exportFile}>
          <Download size={16} aria-hidden="true" />
          导出个人日历
        </button>
        <button
          type="button"
          className={notificationsEnabled ? 'zc-btn zc-btn--primary' : 'zc-btn'}
          aria-pressed={notificationsEnabled}
          disabled={busy || !!preview}
          onClick={() => void toggleNotifications()}
        >
          {notificationsEnabled ? <Bell size={16} aria-hidden="true" /> : <BellOff size={16} aria-hidden="true" />}
          {notificationsEnabled ? '系统提醒：已开启' : '系统提醒：已关闭'}
        </button>
      </div>
      <p className="zc-caption">
        公历／农历及已收录的大陆节假日离线可用。
        {info.holidayCovered ? `${today.slice(0, 4)} 年调休安排已收录。` : '该年调休安排未收录，仅显示节日和普通周末。'}
        系统通知需授权，应用打开时检查；全天事项按事项时区当天 09:00 提醒。
      </p>
      {error && <p role="alert" className="zc-calendar-error">{error}</p>}
      {notice && <p role="status" className="zc-caption">{notice}</p>}
    </section>
  );
}
