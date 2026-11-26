import { describe, expect, it } from 'vitest';
import { calendarOccurrences } from '@zichan/core';
import { openLedger } from '../src/node.js';
import { exportLedger, importLedger, memoryCommitTransport, newCalendarEntry, preflightImport, saveCalendarEntry, setCalendarOccurrenceStatus, syncReplica } from '../src/index.js';
import { NodeSqliteDriver } from '../src/drivers/node-sqlite.js';
import { assertCurrentSchema, runMigrations } from '../src/migrations.js';
import { createLogger, nullSink } from '@zichan/logger';

describe('calendar storage, sync and backup', () => {
  it('persists lunar recurrence and keeps completion separate from transactions', async () => {
    const store = await openLedger();
    try {
      const entry = await saveCalendarEntry(store, { ...newCalendarEntry('2026-02-17', 'Asia/Shanghai'), title: '农历生日', kind: 'birthday',
        calendar: 'lunar', repeat: 'yearly', lunarMonth: 1, lunarDay: 1, reminderMinutes: [1440, 0] });
      await setCalendarOccurrenceStatus(store, entry.id, '2026-02-17', 'completed');
      expect((await store.calendarEntries.get(entry.id))?.reminderMinutes).toEqual([1440, 0]);
      expect(await store.transactions.count()).toBe(0);
      expect(calendarOccurrences(entry, '2026-02-01', '2026-02-28', await store.calendarOccurrenceStates.list())[0]?.completed).toBe(true);
      const backup = await exportLedger(store);
      expect(preflightImport(backup).ok).toBe(true);
      const target = await openLedger();
      try {
        await importLedger(target, backup);
        expect((await target.calendarEntries.get(entry.id))?.lunarMonth).toBe(1);
        expect(await target.calendarOccurrenceStates.count()).toBe(1);
      } finally { await target.close(); }
    } finally { await store.close(); }
  });
  it('changes one occurrence atomically and rejects stale edits without skipping data', async () => {
    const store = await openLedger();
    try {
      const series = await saveCalendarEntry(store, { ...newCalendarEntry('2026-11-16', 'Asia/Shanghai'), title: '每周整理', repeat: 'weekly' });
      const changed = { ...newCalendarEntry('2026-11-17', 'Asia/Shanghai'), title: '本次改到周二' };
      await expect(saveCalendarEntry(store, changed, { entryId: series.id, date: '2026-11-16', version: 999 })).rejects.toThrow(/修改/);
      expect(await store.calendarOccurrenceStates.count()).toBe(0);
      await saveCalendarEntry(store, changed, { entryId: series.id, date: '2026-11-16', version: series.version });
      expect((await store.calendarOccurrenceStates.list())[0]?.status).toBe('skipped');
      expect(calendarOccurrences(series, '2026-11-16', '2026-11-23', await store.calendarOccurrenceStates.list()).map(o => o.date)).toEqual(['2026-11-23']);
      await saveCalendarEntry(store, { ...series, startDate: '2026-11-17', endDate: '2026-11-17' });
      const restored = await openLedger();
      try { await importLedger(restored, await exportLedger(store)); expect(await restored.calendarOccurrenceStates.count()).toBe(1); }
      finally { await restored.close(); }
      await expect(store.calendarEntries.put({ ...changed, startDate: '2026-02-30' })).rejects.toThrow();
    } finally { await store.close(); }
  });
  it('syncs occurrence states after their parent and converges simultaneous completion on one identity', async () => {
    const a = await openLedger({ deviceId: 'A' }); const b = await openLedger({ deviceId: 'B' });
    try {
      await b.adoptLedgerId(await a.getLedgerId());
      const transport = memoryCommitTransport();
      const entry = await saveCalendarEntry(a, { ...newCalendarEntry('2026-11-16', 'Asia/Shanghai'), title: '同步提醒', kind: 'todo' });
      await syncReplica(a, transport, 'memory'); await syncReplica(b, transport, 'memory');
      const first = await setCalendarOccurrenceStatus(a, entry.id, entry.startDate, 'completed');
      const second = await setCalendarOccurrenceStatus(b, entry.id, entry.startDate, 'completed');
      expect(first.id).toBe(second.id);
      await syncReplica(a, transport, 'memory'); const result = await syncReplica(b, transport, 'memory');
      // Different completion timestamps may conflict conservatively; no duplicate entity or invalid SQL is allowed.
      expect(result.invalid).toBe(0);
      expect(await b.calendarOccurrenceStates.count()).toBe(1);
      const target = await openLedger({ deviceId: 'C' });
      try {
        await target.adoptLedgerId(await a.getLedgerId());
        const loaded = await syncReplica(target, transport, 'memory');
        expect(loaded.invalid).toBe(0); expect(await target.calendarEntries.count()).toBe(1);
      } finally { await target.close(); }
    } finally { await a.close(); await b.close(); }
  });
  it('upgrades schema 129 without resetting existing rows', async () => {
    const driver = new NodeSqliteDriver(); const logger = createLogger({ level: 'error', sinks: [nullSink()] });
    try {
      await runMigrations(driver, logger);
      await driver.exec('DROP TABLE calendar_occurrence_states'); await driver.exec('DROP TABLE calendar_entries');
      await driver.exec('ALTER TABLE settings DROP COLUMN calendar_preferences_json');
      await driver.exec('ALTER TABLE transactions DROP COLUMN order_number');
      await driver.exec('ALTER TABLE transactions DROP COLUMN tracking_number');
      await driver.run("INSERT INTO fixed_assets (id, name, version, is_deleted) VALUES ('kept', '保留原记录', 1, 0)");
      await driver.run("UPDATE schema_migrations SET version=129, name='current_schema_2026_11_16_operating_cost'");
      await runMigrations(driver, logger); await assertCurrentSchema(driver);
      expect(await driver.all('SELECT name FROM fixed_assets WHERE id = ?', ['kept'])).toEqual([{ name: '保留原记录' }]);
    } finally { await driver.close(); }
  });
});
