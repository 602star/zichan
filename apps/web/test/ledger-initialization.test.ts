import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@zichan/core';
import { exportLedger, preflightImport, type LedgerBackup, type SqlLedgerStore } from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import {
  initializeEmptyLedger,
  initializedLedgerSetting,
} from '../src/db/ledger-initialization.js';
import { importPortableLedger } from '../src/db/portable-backup.js';
import { runLedgerMaintenance } from '../src/db/maintenance.js';
import {
  claimFirstRunFlight,
  releaseFirstRunFlight,
} from '../src/ui/FirstRunWizard.js';

describe('first-run ledger initialization', () => {
  it('claims a first-run write synchronously until the active flight releases', () => {
    const flight = { active: false };
    expect(claimFirstRunFlight(flight)).toBe(true);
    expect(claimFirstRunFlight(flight)).toBe(false);
    releaseFirstRunFlight(flight);
    expect(claimFirstRunFlight(flight)).toBe(true);
  });

  it('creates a minimal personal ledger exactly once', async () => {
    const store = await openLedger({ deviceId: 'first-run-empty' });
    try {
      expect(await initializedLedgerSetting(store)).toBeNull();
      await expect(initializeEmptyLedger(store, {
        baseCurrencyCode: 'CNY',
        ledgerMode: 'accounts',
        initializedAt: 'not-a-date',
      })).rejects.toThrow(/初始化时间/);
      expect(await store.assets.count()).toBe(0);
      const setting = await initializeEmptyLedger(store, {
        baseCurrencyCode: 'CNY',
        ledgerMode: 'accounts',
        initializedAt: '2026-08-13T00:00:00.000Z',
      });

      expect(setting.ledgerKind).toBe('personal');
      expect(setting.initializedAt).toBe('2026-08-13T00:00:00.000Z');
      expect(setting.ledgerMode).toBe('accounts');
      expect((await store.assets.list()).map((asset) => asset.code)).toEqual(['CNY']);
      expect(await store.settings.count()).toBe(1);
      expect(await store.categories.count()).toBeGreaterThan(0);
      expect(await store.fixedAssetCategories.count()).toBeGreaterThan(0);
      expect(await store.accounts.count()).toBe(0);
      expect(await store.transactions.count()).toBe(0);
      expect(await store.conversionChains.count()).toBe(0);
      expect(await store.dcaPlans.count()).toBe(0);
      expect(await store.games.count()).toBe(0);
      expect(await store.fixedAssets.count()).toBe(0);

      await runLedgerMaintenance(store);
      expect(await store.transactionTags.count()).toBe(0);
      expect(await store.transactionLocations.count()).toBe(0);
      expect(await store.transactionTemplates.count()).toBe(0);
      expect(await store.budgetCategories.count()).toBe(0);
      expect(await store.scheduledTransactions.count()).toBe(0);

      await expect(initializeEmptyLedger(store, {
        baseCurrencyCode: 'USD',
        ledgerMode: 'assets',
      })).rejects.toThrow(/已经初始化/);
      expect(await store.assets.count()).toBe(1);
      expect(await store.settings.count()).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('marks an older portable backup during the same restore operation', async () => {
    const source = await openLedger({ deviceId: 'first-run-import-source' });
    const target = await openLedger({ deviceId: 'first-run-import-target' });
    try {
      await initializeEmptyLedger(source, { baseCurrencyCode: 'GBP', ledgerMode: 'spending' });
      const exported = await exportLedger(source);
      const legacySettings = exported.settings.map((setting) => {
        const { ledgerKind: _ledgerKind, initializedAt: _initializedAt, ...legacy } = setting;
        return legacy;
      });
      const backup = { ...exported, settings: legacySettings } as LedgerBackup;

      await importPortableLedger(target, backup, 'replace', {
        initialize: { initializedAt: '2026-08-13T01:00:00.000Z', fallbackLedgerKind: 'personal' },
      });
      const restored = await initializedLedgerSetting(target);
      expect(restored?.ledgerKind).toBe('personal');
      expect(restored?.initializedAt).toBe('2026-08-13T01:00:00.000Z');
      expect((await target.assets.list()).map((asset) => asset.code)).toEqual(['GBP']);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('does not leave business rows when restore validation fails', async () => {
    const source = await openLedger({ deviceId: 'first-run-failed-source' });
    const target = await openLedger({ deviceId: 'first-run-failed-target' });
    try {
      await initializeEmptyLedger(source, { baseCurrencyCode: 'EUR', ledgerMode: 'spending' });
      const exported = await exportLedger(source);
      const invalid = {
        ...exported,
        settings: exported.settings.map((setting) => ({ ...setting, baseCurrencyAssetId: 'missing-asset' })),
      } as LedgerBackup;
      await expect(importPortableLedger(target, invalid, 'replace', {
        initialize: { initializedAt: new Date().toISOString() },
      })).rejects.toThrow(/preflight|不存在/);
      expect(await target.assets.count()).toBe(0);
      expect(await target.settings.count()).toBe(0);
      expect(await target.transactions.count()).toBe(0);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('rejects backups with more than one active ledger setting', async () => {
    const source = await openLedger({ deviceId: 'multiple-setting-preflight' });
    try {
      await initializeEmptyLedger(source, { baseCurrencyCode: 'CNY', ledgerMode: 'spending' });
      const backup = await exportLedger(source);
      const setting = backup.settings[0] as Record<string, unknown>;
      const invalid = {
        ...backup,
        settings: [setting, { ...setting, id: newId() }],
      } as LedgerBackup;
      expect(preflightImport(invalid)).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'multiple_active_settings' })]),
      });

      const withTombstone = {
        ...backup,
        settings: [setting, { ...setting, id: newId(), isDeleted: true }],
      } as LedgerBackup;
      expect(preflightImport(withTombstone).issues.some((issue) => issue.code === 'multiple_active_settings')).toBe(false);
    } finally {
      await source.close();
    }
  });

  it('keeps the current singleton setting when merging a different portable ledger and can reopen', async () => {
    const filename = join(tmpdir(), `zichan-portable-setting-${newId()}.sqlite`);
    const source = await openLedger({ deviceId: 'portable-setting-source' });
    let target: SqlLedgerStore | null = await openLedger({ filename, deviceId: 'portable-setting-target' });
    try {
      await initializeEmptyLedger(source, { baseCurrencyCode: 'GBP', ledgerMode: 'spending' });
      const current = await initializeEmptyLedger(target, { baseCurrencyCode: 'CNY', ledgerMode: 'accounts' });
      const incoming = (await source.settings.list())[0]!;
      expect(incoming.id).not.toBe(current.id);

      await importPortableLedger(target, await exportLedger(source), 'merge');
      expect(await target.settings.count()).toBe(1);
      expect((await target.settings.list())[0]).toMatchObject({
        id: current.id,
        baseCurrencyAssetId: current.baseCurrencyAssetId,
        ledgerMode: 'accounts',
        ledgerKind: 'personal',
      });
      expect((await target.assets.list()).map((asset) => asset.code).sort()).toEqual(['CNY', 'GBP']);

      await target.close();
      target = null;
      target = await openLedger({ filename, deviceId: 'portable-setting-reopen' });
      expect(await initializedLedgerSetting(target)).toMatchObject({ id: current.id, ledgerMode: 'accounts' });
      expect(await target.settings.count()).toBe(1);
    } finally {
      await source.close();
      await target?.close();
      rmSync(filename, { force: true });
    }
  });
});
