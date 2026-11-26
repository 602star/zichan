import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { SqlLedgerStore } from '@zichan/db';
import type { DeviceStorageSession } from '../src/device-storage-key.js';
import { createLocalOrderPrivateStore, deleteLocalOrderDatabase, localOrderDatabaseName, selectPrivateOrderFields } from '../src/db/local-order-private.js';
import { saveWithLocalOrders } from '../src/order-capture/save.js';
import { reconcileLocalOrders } from '../src/order-capture/lifecycle.js';

const runtime = vi.hoisted(() => ({ device: undefined as DeviceStorageSession | undefined, base: 'private-test-account-replica' }));
vi.mock('../src/device-storage-key.js', () => ({ requireDeviceStorageSession: () => { if (!runtime.device) throw new Error('locked'); return runtime.device; } }));
vi.mock('../src/account-storage.js', () => ({ accountDatabaseName: () => runtime.base }));
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); runtime.base = 'private-test-account-replica';
  runtime.device = { state: { kind: 'browser-envelope', initialized: true, unlocked: true, platform: 'web', message: '' }, cryptoSession: { v: 1, ledgerId: 'local-device-A', keyringId: 'local-keyring-A', activeKeyId: 'key', generation: 1, dataKeys: new Map(), attachmentSecret: crypto.getRandomValues(new Uint8Array(32)), backupSecret: crypto.getRandomValues(new Uint8Array(32)) } };
});
async function inspectRaw() {
  return new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
    const request = indexedDB.open(localOrderDatabaseName());
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('records'), rows = tx.objectStore('records'), keys = rows.getAllKeys(), values = rows.getAll();
      tx.oncomplete = () => { db.close(); resolve({ keys: keys.result, values: values.result }); }; tx.onerror = () => reject(tx.error);
    };
  });
}
describe('independent encrypted local order storage', () => {
  it('persists only selected strings under opaque keys, with neither fields nor identifiers in stored plaintext', async () => {
    const local = createLocalOrderPrivateStore('ledger-A');
    const row = await local.stage('日常收支:new', { orderNumber: '00001234567890', trackingNumbers: ['SF00009876543210'] });
    const raw = await inspectRaw();
    expect(raw.keys).toEqual([row.captureId]);
    expect(Object.keys(raw.values[0] as object)).toEqual(['version', 'revision', 'iv', 'ciphertext']);
    expect(JSON.stringify(raw)).not.toContain('00001234567890'); expect(JSON.stringify(raw)).not.toContain('SF00009876543210');
    const restored = (await local.list())[0]!;
    expect(restored.orderNumber).toBe('00001234567890'); expect(restored.trackingNumbers).toEqual(['SF00009876543210']);
    expect(selectPrivateOrderFields({ orderNumber: '00001234567890', phone: '13800138000' } as never)).toEqual({ orderNumber: '00001234567890' });
  });
  it('isolates accounts, device sessions and ledger identities without copying private data', async () => {
    const local = createLocalOrderPrivateStore('ledger-A'); await local.stage('new', { orderNumber: '00001234567890' });
    await expect(createLocalOrderPrivateStore('ledger-B').list()).rejects.toThrow('无法解密');
    runtime.base = 'another-account'; await expect(local.list()).rejects.toThrow('账号已切换');
    expect(await createLocalOrderPrivateStore('ledger-A').list()).toEqual([]);
    runtime.device = undefined; await expect(local.list()).rejects.toThrow();
  });
  it('keeps pending intent on failure and prevents concurrent bindings to different transactions', async () => {
    const local = createLocalOrderPrivateStore('ledger-A'), row = await local.stage('new', { orderNumber: '00001234567890' });
    const attempts = await Promise.allSettled([local.bind([row.captureId], 'tx-A'), local.bind([row.captureId], 'tx-B')]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = (await local.list())[0]!; expect(stored.state).toBe('pending');
    await expect(local.bind([row.captureId], stored.transactionId === 'tx-A' ? 'tx-B' : 'tx-A')).rejects.toThrow('已关联');
    await local.link([row.captureId], stored.transactionId!); expect((await local.list())[0]?.state).toBe('linked');
  });
  it('clears this account private database without touching an ordinary ledger database', async () => {
    const local = createLocalOrderPrivateStore('ledger-A'); await local.stage('new', { orderNumber: '00001234567890' });
    await new Promise<void>((resolve) => { const request = indexedDB.open('ordinary-ledger'); request.onsuccess = () => { request.result.close(); resolve(); }; });
    await deleteLocalOrderDatabase();
    expect((await indexedDB.databases()).map((row) => row.name)).toEqual(['ordinary-ledger']);
  });
  it('fences a stale connection after a clear so delayed writes cannot recreate old private data', async () => {
    const stale = createLocalOrderPrivateStore('ledger-A'); await stale.stage('new', { orderNumber: '00001234567890' });
    await deleteLocalOrderDatabase();
    await expect(stale.stage('new', { orderNumber: '00001234567891' })).rejects.toThrow();
    expect(await createLocalOrderPrivateStore('ledger-A').list()).toEqual([]);
  });
});
describe('public save and private intent coordination', () => {
  function publicStore() {
    const transactions = new Map<string, { id: string; version: number }>();
    return { transactions, store: { getLedgerId: async () => 'ledger-A', transactions: { get: async (id: string) => transactions.get(id) } } as unknown as SqlLedgerStore };
  }
  it('passes only a public candidate to persistence and links identifiers separately', async () => {
    const local = createLocalOrderPrivateStore('ledger-A'), row = await local.stage('new', { orderNumber: '00001234567890' });
    const { store, transactions } = publicStore();
    const save = vi.fn(async (candidate: { id: string; amount: string }) => { transactions.set(candidate.id, { id: candidate.id, version: 1 }); });
    const result = await saveWithLocalOrders({ store, records: [row], candidate: { id: 'unstable-form-id', amount: '19.9' }, save, creating: true });
    expect(result.pending).toBe(false); expect(JSON.stringify(save.mock.calls)).not.toContain('00001234567890');
    expect((await local.list())[0]).toMatchObject({ state: 'linked', transactionId: result.transactionId });
  });
  it('retries the original fixed transaction after a public failure before commit', async () => {
    const local = createLocalOrderPrivateStore('ledger-A'), row = await local.stage('new', { orderNumber: '00001234567890' });
    const { store, transactions } = publicStore(), save = vi.fn(async (candidate: { id: string; amount: string }) => { transactions.set(candidate.id, { id: candidate.id, version: 1 }); });
    await expect(saveWithLocalOrders({ store, records: [row], candidate: { id: 'new-every-time', amount: '19.9' }, save: async () => { throw new Error('public failed'); }, creating: true })).rejects.toThrow('public failed');
    const intended = (await local.list())[0]?.transactionId;
    const result = await saveWithLocalOrders({ store, records: [row], candidate: { id: 'another-random-id', amount: '19.9' }, save, creating: true });
    expect(result.transactionId).toBe(intended); expect(transactions.size).toBe(1);
  });
  it('does not create a duplicate after public commit followed by an error', async () => {
    const local = createLocalOrderPrivateStore('ledger-A'), row = await local.stage('new', { orderNumber: '00001234567890' });
    const { store, transactions } = publicStore();
    const save = vi.fn(async (candidate: { id: string; amount: string }) => { transactions.set(candidate.id, { id: candidate.id, version: 1 }); throw new Error('attachment finalization failed'); });
    const first = await saveWithLocalOrders({ store, records: [row], candidate: { id: 'random-first', amount: '19.9' }, save, creating: true });
    expect(first.pending).toBe(true);
    const second = await saveWithLocalOrders({ store, records: [row], candidate: { id: 'random-second', amount: '19.9' }, save, creating: true });
    expect(second).toEqual({ transactionId: first.transactionId, pending: false }); expect(save).toHaveBeenCalledOnce(); expect(transactions.size).toBe(1);
  });
  it('blocks public persistence if private intent can no longer be read', async () => {
    const local = createLocalOrderPrivateStore('ledger-A'), row = await local.stage('new', { orderNumber: '00001234567890' });
    const { store } = publicStore(), save = vi.fn(); runtime.device = undefined;
    await expect(saveWithLocalOrders({ store, records: [row], candidate: {}, save, creating: true })).rejects.toThrow(); expect(save).not.toHaveBeenCalled();
  });
  it('recovers committed pending links and cleans only permanently missing transactions', async () => {
    const local = createLocalOrderPrivateStore('ledger-A');
    const linked = await local.stage('new', { orderNumber: '00001234567890' }), orphan = await local.stage('new', { orderNumber: '00001234567891' }), draft = await local.stage('new', { orderNumber: '00001234567892' });
    await local.bind([linked.captureId], 'tx-present'); await local.bind([orphan.captureId], 'tx-missing'); await local.link([orphan.captureId], 'tx-missing');
    const { store, transactions } = publicStore(); transactions.set('tx-present', { id: 'tx-present', version: 1 });
    await reconcileLocalOrders(store);
    expect(await local.list()).toEqual(expect.arrayContaining([expect.objectContaining({ captureId: linked.captureId, state: 'linked' }), expect.objectContaining({ captureId: draft.captureId, state: 'draft' })]));
    expect((await local.list()).some((row) => row.captureId === orphan.captureId)).toBe(false);
    Object.assign(transactions.get('tx-present')!, { recordState: 'voided' }); await reconcileLocalOrders(store);
    expect((await local.list()).some((row) => row.captureId === linked.captureId)).toBe(true);
  });
});
