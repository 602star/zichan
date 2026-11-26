import { decryptBackupChunk, encryptBackupChunk, newId } from '@zichan/core';
import { accountDatabaseName } from '../account-storage.js';
import { requireDeviceStorageSession } from '../device-storage-key.js';

export interface PrivateOrderFields { orderNumber?: string; trackingNumbers?: string[] }
export interface LocalOrderRecord extends PrivateOrderFields {
  version: 1; captureId: string; ledgerId: string; draftKey: string;
  transactionId?: string; state: 'draft' | 'pending' | 'linked'; createdAt: string;
}
interface Envelope { version: 1; revision: number; iv: Uint8Array; ciphertext: Uint8Array }
const STORE = 'records';
const META = 'metadata';
export const LOCAL_ORDERS_CHANGED_EVENT = 'zichan:local-orders-changed';
export const localOrderDatabaseName = (base = accountDatabaseName()) => `${base}:local-order-private.v1`;
const emit = () => globalThis.dispatchEvent?.(new CustomEvent(LOCAL_ORDERS_CHANGED_EVENT));
function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains(META)) request.result.createObjectStore(META).put(newId(), 'epoch');
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); emit(); }; if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(new Error('无法打开本机订单存储，请释放空间后重试。'));
    request.onblocked = () => { blocked = true; reject(new Error('其他页面占用本机订单存储，请关闭后重试。')); };
  });
}
async function epochFor(name: string): Promise<string> {
  const db = await open(name);
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction(META).objectStore(META).get('epoch');
    request.onsuccess = () => resolve(String(request.result)); request.onerror = () => reject(new Error('无法读取本机订单存储身份。'));
  }); } finally { db.close(); }
}
async function read(name: string, key: string | undefined, epoch: string): Promise<{ id: string; value: Envelope }[]> {
  const db = await open(name);
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, META], 'readonly'), rows: { id: string; value: Envelope }[] = [];
    let sameEpoch = false;
    const identity = tx.objectStore(META).get('epoch'); identity.onsuccess = () => { sameEpoch = identity.result === epoch; };
    const cursor = tx.objectStore(STORE).openCursor(key);
    cursor.onsuccess = () => { const next = cursor.result; if (next) { rows.push({ id: String(next.key), value: next.value as Envelope }); next.continue(); } };
    tx.oncomplete = () => sameEpoch ? resolve(rows) : reject(new Error('本机订单存储已清理，请重新打开。')); tx.onerror = () => reject(new Error('无法读取本机订单信息。'));
  }); } finally { db.close(); }
}
async function write(name: string, id: string, expected: number, epoch: string, next?: Envelope): Promise<void> {
  const db = await open(name);
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, META], 'readwrite'), records = tx.objectStore(STORE);
    let conflict = false;
    const identity = tx.objectStore(META).get('epoch');
    identity.onsuccess = () => { if (identity.result !== epoch) { conflict = true; tx.abort(); } };
    const request = records.get(id);
    request.onsuccess = () => {
      if (((request.result as Envelope | undefined)?.revision ?? 0) !== expected) { conflict = true; tx.abort(); return; }
      if (next) records.put(next, id); else records.delete(id);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error(conflict ? '本机订单信息已被其他页面修改，请重新打开。' : '本机订单信息保存失败，请重试或明确放弃保留。'));
  }); } finally { db.close(); }
}
export function selectPrivateOrderFields(value: PrivateOrderFields): PrivateOrderFields {
  const valid = (text: string) => /^[A-Za-z0-9][A-Za-z0-9-]{5,63}$/.test(text);
  const orderNumber = value.orderNumber?.trim();
  const trackingNumbers = [...new Set(value.trackingNumbers?.map((text) => text.trim()) ?? [])];
  if ((orderNumber && !valid(orderNumber)) || trackingNumbers.length > 8 || trackingNumbers.some((text) => !valid(text))) throw new Error('请核对订单号和物流单号，最多保留 8 个物流单号。');
  return { ...(orderNumber ? { orderNumber } : {}), ...(trackingNumbers.length ? { trackingNumbers } : {}) };
}
/** Separate encrypted database: never registered with the ledger, sync, audit or backup exporters. */
export function createLocalOrderPrivateStore(ledgerId: string, base = accountDatabaseName()) {
  const device = requireDeviceStorageSession(), name = localOrderDatabaseName(base);
  let epoch: Promise<string> | undefined;
  const identity = () => epoch ??= epochFor(name);
  const context = (captureId: string) => ({ purpose: 'local-order-private', version: 1, account: base, ledgerId, storageId: device.cryptoSession.ledgerId, captureId });
  const check = () => {
    if (requireDeviceStorageSession() !== device || accountDatabaseName() !== base) throw new Error('本机数据已锁定或账号已切换，请重新打开。');
  };
  const decode = async (id: string, row: Envelope): Promise<LocalOrderRecord> => {
    check();
    try {
      if (row.version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error();
      const bytes = await decryptBackupChunk(device.cryptoSession, { v: 1, iv: row.iv, ciphertext: row.ciphertext }, context(id));
      const result = JSON.parse(new TextDecoder().decode(bytes)) as LocalOrderRecord;
      if (result.version !== 1 || result.captureId !== id || result.ledgerId !== ledgerId || !['draft', 'pending', 'linked'].includes(result.state)) throw new Error();
      check(); return result;
    } catch { throw new Error('本机订单信息无法解密或不属于当前账本；原记录已保留。'); }
  };
  const encode = async (record: LocalOrderRecord, revision: number): Promise<Envelope> => {
    check(); const encrypted = await encryptBackupChunk(device.cryptoSession, new TextEncoder().encode(JSON.stringify(record)), context(record.captureId));
    check(); return { version: 1, revision, iv: encrypted.iv, ciphertext: encrypted.ciphertext };
  };
  const list = async () => { check(); const rows = await read(name, undefined, await identity()); return Promise.all(rows.map(async ({ id, value }) => ({ record: await decode(id, value), revision: value.revision }))); };
  const change = async (id: string, update: (record: LocalOrderRecord) => LocalOrderRecord | undefined) => {
    check(); const row = (await read(name, id, await identity()))[0]; if (!row) throw new Error('本机订单草稿不存在，请重新选择保留信息。');
    const current = await decode(id, row.value), next = update(current);
    if (next === current) return;
    const value = next ? await encode(next, row.value.revision + 1) : undefined;
    check(); await write(name, id, row.value.revision, await identity(), value); emit();
  };
  return {
    async list(): Promise<LocalOrderRecord[]> { return (await list()).map(({ record }) => record); },
    async stage(draftKey: string, fields: PrivateOrderFields): Promise<LocalOrderRecord> {
      const selected = selectPrivateOrderFields(fields);
      if (!selected.orderNumber && !selected.trackingNumbers?.length) throw new Error('未选择本机保留字段。');
      const record: LocalOrderRecord = { version: 1, captureId: newId(), ledgerId, draftKey, state: 'draft', createdAt: new Date().toISOString(), ...selected };
      const epoch = await identity(); const row = await encode(record, 1); check(); await write(name, record.captureId, 0, epoch, row); emit(); return record;
    },
    async bind(ids: string[], transactionId: string): Promise<void> {
      for (const id of ids) await change(id, (row) => {
        if (row.transactionId && row.transactionId !== transactionId) throw new Error('此订单草稿已关联其他流水，请重新打开草稿。');
        if (row.transactionId === transactionId && row.state !== 'draft') return row;
        return { ...row, transactionId, state: row.state === 'linked' ? 'linked' : 'pending' };
      });
    },
    async link(ids: string[], transactionId: string): Promise<void> {
      for (const id of ids) await change(id, (row) => {
        if (row.transactionId !== transactionId) throw new Error('本机订单与流水关联不一致，请重新打开。');
        if (row.state === 'linked') return row;
        return { ...row, state: 'linked' };
      });
    },
    async remove(id: string): Promise<void> { await change(id, () => undefined); },
  };
}
export async function deleteLocalOrderDatabase(base = accountDatabaseName()): Promise<void> {
  if (!globalThis.indexedDB) return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(localOrderDatabaseName(base));
    request.onsuccess = () => resolve(); request.onerror = () => reject(new Error('本机订单信息清理失败，请重试。'));
    request.onblocked = () => undefined;
  }); emit();
}
