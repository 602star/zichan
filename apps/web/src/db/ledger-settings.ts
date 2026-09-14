import { newId, type Setting } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';

/** Placeholder Setting row for a ledger that has no stored row yet. */
export function draftSetting(baseCurrencyAssetId: string, today: string): Setting {
  return {
    id: newId(),
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    baseCurrencyAssetId,
    defaultLotMethod: 'fifo',
    ledgerMode: 'spending',
    asOfDate: today,
    categoryPickerDefaultScope: 'frequent',
    refundAttributionMode: 'original_date',
  };
}

/**
 * Persist a Setting patch inside an audited batch. Audit writes are fail-closed,
 * so every settings mutation goes through here — including the "advance the
 * ledger day" shortcut offered on the report banners, which must not become a
 * way to change settings without an audit trail.
 */
export async function saveLedgerSetting(
  store: SqlLedgerStore,
  current: Setting | undefined,
  draft: Setting,
  patch: Partial<Setting>,
  label: string,
  options: { undoable?: boolean } = {},
): Promise<void> {
  const row = current ?? draft;
  await store.runInAuditBatch(
    label,
    async (transactionStore) => {
      const latest = await transactionStore.settings.get(row.id);
      await transactionStore.settings.put({ ...(latest ?? row), ...patch });
    },
    'system',
    { undoable: options.undoable },
  );
}
