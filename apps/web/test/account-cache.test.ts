import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLedgerKeyEnvelope } from '@zichan/core';
import { accountScopeKey, createAccountScope } from '../src/account-scope.js';

const memory = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock('../src/db/idb.js', () => {
  const db = (name: string) => {
    if (!memory.has(name)) memory.set(name, new Map());
    return memory.get(name)!;
  };
  return {
    loadKv: async (key: string, name: string) => structuredClone(db(name).get(key) ?? null),
    saveKv: async (key: string, value: unknown, name: string) => { db(name).set(key, structuredClone(value)); },
    hasKv: async (key: string, name: string) => db(name).has(key),
    deleteKv: async (key: string, name: string) => { db(name).delete(key); },
    moveKv: async (source: string, target: string, name: string) => {
      if (!db(name).has(source)) return false;
      if (!db(name).has(target)) db(name).set(target, db(name).get(source));
      db(name).delete(source);
      return true;
    },
  };
});
import { createAccountCache } from '../src/db/account-cache.js';

const scope = {
  origin: 'https://ledger.example.com', serverId: 'server-primary',
  accountId: `account-${'a'.repeat(32)}`, ledgerId: 'ledger-0000000001',
};
beforeEach(() => memory.clear());

describe('account-scoped browser cache', () => {
  it('normalizes origins, captures a frozen scope, and rejects missing stable IDs', () => {
    expect(createAccountScope({ ...scope, origin: 'https://LEDGER.example.com:443/' })).toEqual(scope);
    expect(Object.isFrozen(createAccountScope(scope))).toBe(true);
    for (const patch of [{ accountId: 'owner' }, { ledgerId: '' }, { serverId: '' }, { origin: 'https://user:password@ledger.example.com' }, { origin: 'https://ledger.example.com/app' }]) {
      expect(() => createAccountScope({ ...scope, ...patch })).toThrow();
    }
  });

  it.each([
    { accountId: `account-${'b'.repeat(32)}` },
    { serverId: 'server-secondary' },
    { ledgerId: 'ledger-0000000002' },
    { origin: 'https://other.example.com' },
  ])('isolates database, drafts, backups and attachments for %j', async (patch) => {
    const left = createAccountCache(scope);
    const right = createAccountCache({ ...scope, ...patch });
    for (const key of ['ledger.sqlite', 'draft:transaction', 'backups', 'attachment:content']) {
      await left.put(key, 'left-private-data');
      expect(await right.get(key)).toBeNull();
      await right.put(key, 'right-private-data');
      await right.remove(key);
      expect(await left.get(key)).toBe('left-private-data');
    }
    expect(left.databaseName).not.toBe('zichan-web');
  });

  it('keeps late operations on the captured scope even when the input is mutated', async () => {
    const input = { ...scope };
    const left = createAccountCache(input);
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    const pending = gate.then(() => left.put('draft', 'left-only'));
    input.accountId = `account-${'b'.repeat(32)}`;
    const right = createAccountCache(input);
    proceed();
    await pending;
    expect(await right.get('draft')).toBeNull();
    expect(await left.get('draft')).toBe('left-only');
  });

  it('authenticates scope metadata and never resets an unreadable database', async () => {
    const key = await createLedgerKeyEnvelope('device-storage-account', 'account-cache-password');
    const left = createAccountCache(scope);
    const rightScope = { ...scope, accountId: `account-${'b'.repeat(32)}` };
    const right = createAccountCache(rightScope);
    const plaintext = new TextEncoder().encode('private SQLite records');
    await left.saveDatabase(plaintext, key.session);
    expect(await left.loadDatabase(key.session)).toEqual(plaintext);
    const copied = await left.get<Record<string, unknown>>('ledger.sqlite');
    expect(JSON.stringify(copied)).not.toContain('private SQLite records');
    await right.put('ledger.sqlite', copied);
    await expect(right.loadDatabase(key.session)).rejects.toThrow('已保留原数据');
    await right.put('ledger.sqlite', { ...copied, scopeKey: accountScopeKey(rightScope) });
    await expect(right.loadDatabase(key.session)).rejects.toThrow();
    expect(await right.has('ledger.sqlite')).toBe(true);
    expect(await left.loadDatabase(key.session)).toEqual(plaintext);
  });
});
