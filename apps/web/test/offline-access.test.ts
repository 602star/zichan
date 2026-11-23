import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createLedgerKeyEnvelope } from '@zichan/core';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); }, clear: () => data.clear(), key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

describe('trusted device fast open', () => {
  it('restores actual ledger and device keys without network, rejects another scope, expires and clears on logout', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('sessionStorage', memoryStorage());
    const events = new EventTarget();
    vi.stubGlobal('window', events); vi.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
    const network = vi.fn(() => { throw new Error('network must not be used'); });
    vi.stubGlobal('fetch', network);
    const storage = await import('../src/account-storage.js');
    const protection = await import('../src/account-protection.js');
    const device = await import('../src/device-storage-key.js');
    const ledger = await import('../src/ledger-key-vault.js');
    const offline = await import('../src/offline-access.js');
    const config = await import('../src/sync-config.js');
    const profile = { ...config.newSyncConnection('https://ledger.example'), id: 'profile-fast-open',
      serverId: 'server-fast', accountId: 'account-fast', ledgerId: 'ledger-fast-open-test', replicaId: 'replica-fast', streamEpoch: 'epoch-fast' };
    storage.enableWebAccounts(); storage.activateWebAccount(profile.serverId, profile.accountId, profile.replicaId);
    const created = await createLedgerKeyEnvelope(profile.ledgerId, 'managed-test-secret');
    const info = { mode: 'managed' as const, version: 1, defaultMode: 'managed' as const, custodyEnabled: true,
      secret: 'managed-test-secret', envelope: created.envelope,
      replica: { serverId: profile.serverId, ledgerId: profile.ledgerId, replicaId: profile.replicaId, streamEpoch: profile.streamEpoch, headSeq: 9 } };
    protection.adoptAccountProtection(profile, info, created.session);
    const originalDevice = await device.unlockDeviceStorage(info.secret, true);
    await offline.rememberDevice();
    await device.lockDeviceStorage(); protection.clearAccountProtection(); ledger.clearLedgerKey();
    expect(await offline.unlockRememberedDevice({ ...profile, streamEpoch: 'other' })).toBe(false);
    expect(await offline.unlockRememberedDevice(profile)).toBe(true);
    expect([...ledger.requireLedgerCryptoSession().dataKeys]).toEqual([...created.session.dataKeys]);
    expect(ledger.requireLedgerCryptoSession().attachmentSecret).toEqual(created.session.attachmentSecret);
    expect(device.requireDeviceStorageSession().cryptoSession.backupSecret).toEqual(originalDevice.cryptoSession.backupSecret);
    expect(network).not.toHaveBeenCalled();
    await device.lockDeviceStorage(); protection.clearAccountProtection();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 86400_000);
    expect(await offline.unlockRememberedDevice(profile)).toBe(false);
    vi.restoreAllMocks();
    protection.adoptAccountProtection(profile, info, created.session);
    await device.unlockDeviceStorage(info.secret, true); await offline.rememberDevice();
    protection.clearAccountProtection(); await offline.forgetOfflineAccess(); await device.lockDeviceStorage();
    expect(await offline.unlockRememberedDevice(profile)).toBe(false);
    expect(JSON.stringify({ ...localStorage })).not.toContain(info.secret);
  });
});
