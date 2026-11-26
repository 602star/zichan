import { useCallback, useEffect, useRef, useState } from 'react';
import { createLocalOrderPrivateStore, LOCAL_ORDERS_CHANGED_EVENT, type LocalOrderRecord, type PrivateOrderFields } from './db/local-order-private.js';
import type { SqlLedgerStore } from '@zichan/db';
import { DEVICE_STORAGE_STATE_CHANGED_EVENT, requireDeviceStorageSession } from './device-storage-key.js';
import { ACCOUNT_LOCK_REQUEST_EVENT } from './browser-account-exit.js';
import { reconcileLocalOrders } from './order-capture/lifecycle.js';

export function useLocalOrders(store: SqlLedgerStore | null, draftKey: string, transactionId?: string, enabled = true) {
  const [records, setRecords] = useState<LocalOrderRecord[]>([]), [drafts, setDrafts] = useState<LocalOrderRecord[]>([]), [error, setError] = useState('');
  const active = useRef<string[]>([]), generation = useRef(0);
  const locked = useRef(false);
  const refresh = useCallback(async () => {
    if (!store || !enabled || locked.current) return;
    const current = generation.current;
    try {
      const local = createLocalOrderPrivateStore(await store.getLedgerId());
      await reconcileLocalOrders(store);
      const all = await local.list(), linked: LocalOrderRecord[] = [];
      for (const row of all) {
        if (row.transactionId) {
          const transaction = await store.transactions.get(row.transactionId);
          if (transaction && !transaction.isDeleted && transaction.recordState !== 'voided') {
            if (row.transactionId === transactionId) linked.push(row);
          }
        }
      }
      if (current !== generation.current) return;
      setRecords(transactionId ? linked : all.filter((row) => active.current.includes(row.captureId) && row.state !== 'linked'));
      setDrafts(all.filter((row) => row.draftKey === draftKey && row.state !== 'linked' && !active.current.includes(row.captureId)));
      setError(active.current.some((id) => !all.some((row) => row.captureId === id)) ? '选择保留的本机订单信息已被清理，请明确放弃或重新识别。' : '');
    } catch { if (current === generation.current) setError('本机订单信息暂不可用，请解锁后重试；不会改存到备注。'); }
  }, [store, draftKey, transactionId, enabled]);
  useEffect(() => {
    const retire = () => { generation.current++; };
    generation.current++; active.current = []; locked.current = false; setRecords([]); setDrafts([]); setError('');
    void refresh();
    const changed = () => void refresh();
    const lock = () => { generation.current++; locked.current = true; setRecords([]); setDrafts([]); setError(''); };
    const device = () => { try { requireDeviceStorageSession(); locked.current = false; void refresh(); } catch { lock(); } };
    window.addEventListener(LOCAL_ORDERS_CHANGED_EVENT, changed); window.addEventListener(DEVICE_STORAGE_STATE_CHANGED_EVENT, device); window.addEventListener(ACCOUNT_LOCK_REQUEST_EVENT, lock);
    const unsubscribe = store && enabled ? store.subscribe(changed) : undefined;
    return () => { retire(); unsubscribe?.(); window.removeEventListener(LOCAL_ORDERS_CHANGED_EVENT, changed); window.removeEventListener(DEVICE_STORAGE_STATE_CHANGED_EVENT, device); window.removeEventListener(ACCOUNT_LOCK_REQUEST_EVENT, lock); };
  }, [store, enabled, refresh]);
  return { records, drafts, error, refresh, hasActive: active.current.length > 0,
    async stage(fields: PrivateOrderFields) {
      if (!store || !enabled || locked.current) throw new Error('当前表单已关闭或锁定，不能保存本机订单信息。');
      const current = generation.current;
      const local = createLocalOrderPrivateStore(await store.getLedgerId());
      if (current !== generation.current || locked.current) throw new Error('当前表单已关闭或锁定。');
      const row = await local.stage(draftKey, fields);
      if (current !== generation.current || locked.current) throw new Error('当前表单已关闭或锁定。');
      active.current.push(row.captureId); await refresh();
    },
    restore() { active.current = [...new Set([...active.current, ...drafts.map((row) => row.captureId)])]; void refresh(); },
    async discardDrafts() {
      if (!store || !enabled) return;
      const local = createLocalOrderPrivateStore(await store.getLedgerId());
      const ids = new Set([...active.current, ...drafts.map((row) => row.captureId)]);
      for (const row of (await local.list()).filter((row) => ids.has(row.captureId) && row.state !== 'linked')) await local.remove(row.captureId);
      active.current = []; await refresh();
    },
    async remove(id: string) { if (!store) return; await (createLocalOrderPrivateStore(await store.getLedgerId())).remove(id); active.current = active.current.filter((key) => key !== id); await refresh(); },
  };
}
