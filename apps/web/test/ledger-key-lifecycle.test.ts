import { createLedgerKeyEnvelope } from '@zichan/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureLedgerKeyForStore } from '../src/ledger-key-lifecycle.js';
import {
  adoptUnlockedLedgerKeyEnvelope,
  ledgerKeyState,
  lockLedgerKey,
  storedLedgerKeyEnvelope,
} from '../src/ledger-key-vault.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

describe('ledger key lifecycle', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
    lockLedgerKey();
  });

  afterEach(() => {
    lockLedgerKey();
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('initializes a new ledger key and unlocks it again with the device passphrase', async () => {
    const store = { getLedgerId: async () => 'ledger-first-run-0001' };
    await ensureLedgerKeyForStore(store, 'device-password');
    expect(ledgerKeyState()).toMatchObject({
      initialized: true,
      unlocked: true,
      ledgerId: 'ledger-first-run-0001',
    });

    lockLedgerKey();
    expect(ledgerKeyState().unlocked).toBe(false);
    await ensureLedgerKeyForStore(store, 'device-password');
    expect(ledgerKeyState().unlocked).toBe(true);
  });

  it('never replaces a key envelope that belongs to another ledger', async () => {
    await ensureLedgerKeyForStore({ getLedgerId: async () => 'ledger-original-0001' }, 'device-password');
    const before = storedLedgerKeyEnvelope();
    await expect(ensureLedgerKeyForStore(
      { getLedgerId: async () => 'ledger-different-0002' },
      'device-password',
    )).rejects.toThrow(/属于其他账本/);
    expect(storedLedgerKeyEnvelope()).toEqual(before);
  });

  it('keeps the current runtime key when persistence of an adopted key fails', async () => {
    await ensureLedgerKeyForStore({ getLedgerId: async () => 'ledger-original-0003' }, 'device-password');
    const before = ledgerKeyState();
    const remote = await createLedgerKeyEnvelope('ledger-remote-0004', 'remote-password');
    const storage = localStorage;
    storage.setItem = () => { throw new Error('quota exceeded'); };

    expect(() => adoptUnlockedLedgerKeyEnvelope(remote.envelope, remote.session, true)).toThrow('quota exceeded');
    expect(ledgerKeyState()).toMatchObject(before);
  });
});
