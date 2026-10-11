import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasKv } from '../src/db/idb.js';
import { resolveWebLedgerNamespace } from '../src/web-ledger-storage.js';

vi.mock('../src/db/idb.js', () => ({ hasKv: vi.fn() }));

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); }, clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() { return data.size; } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(hasKv).mockReset(); });

describe('Web ledger cache namespaces', () => {
  it('keeps a large legacy cache with its original replica and isolates a second ledger', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('indexedDB', {});
    vi.mocked(hasKv).mockResolvedValue(true);
    storage.setItem('zichan.account.v2:server-a:account-a:zichan.ledger.keyEnvelope.v1',
      JSON.stringify({ ledgerId: 'ledger-personal' }));
    const binding = { serverId: 'server-a', accountId: 'account-a',
      ledgerId: 'ledger-personal', replicaId: 'rep-personal' };
    const primary = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-personal', replicaId: 'rep-personal' }, binding);
    expect(primary.namespace).toBe('zichan.account.v2:server-a:account-a:');
    const shared = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-shared', replicaId: 'rep-shared' }, binding);
    expect(shared.namespace).toBe('zichan.account.v3:server-a:account-a:rep-shared:');
    expect(shared.primaryReplicaId).toBe('rep-personal');
    expect(hasKv).toHaveBeenCalledWith('ledger.sqlite', 'zichan.account.v2:server-a:account-a:database');
  });

  it('does not assign an unidentified legacy cache to another replica with the same ledger ID', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('indexedDB', {});
    vi.mocked(hasKv).mockResolvedValue(true);
    const choice = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-duplicate', replicaId: 'rep-other' });
    expect(choice.namespace).toBe('zichan.account.v3:server-a:account-a:rep-other:');
    expect(choice.primaryReplicaId).toBeUndefined();
  });

  it('uses the saved connection while checking encrypted snapshot existence only', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('indexedDB', {});
    vi.mocked(hasKv).mockResolvedValue(true);
    storage.setItem('zichan.account.v2:server-a:account-a:zichan.sync.connections.v1', JSON.stringify({
      servers: [{ id: 'server-ref-a', serverId: 'server-a' }],
      connections: [{ serverRef: 'server-ref-a', accountId: 'account-a',
        ledgerId: 'ledger-personal', replicaId: 'rep-personal' }],
    }));
    const primary = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-personal', replicaId: 'rep-personal' },
      { serverId: 'server-a', accountId: 'account-a' });
    expect(primary.namespace).toBe('zichan.account.v2:server-a:account-a:');
    expect(primary.primaryReplicaId).toBe('rep-personal');
    expect(JSON.parse(storage.getItem('zichan.account.primary-replica.v1:server-a:account-a')!))
      .toEqual({ ledgerId: 'ledger-personal', replicaId: 'rep-personal' });
  });

  it('uses account recovery metadata when the old connection list is unavailable', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('indexedDB', {});
    vi.mocked(hasKv).mockResolvedValue(true);
    storage.setItem('zichan.account.v2:server-a:account-a:zichan.account.device-recovery.v1',
      JSON.stringify({ ledgerId: 'ledger-personal' }));
    const primary = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-personal', replicaId: 'rep-personal' },
      { serverId: 'server-a', accountId: 'account-a',
        ledgerId: 'ledger-personal', replicaId: 'rep-personal' });
    expect(primary.namespace).toBe('zichan.account.v2:server-a:account-a:');
    const other = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-other', replicaId: 'rep-other' });
    expect(other.namespace).toBe('zichan.account.v3:server-a:account-a:rep-other:');
  });

  it('uses the old namespace connection when only settings remain and the last login points elsewhere', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('indexedDB', {});
    vi.mocked(hasKv).mockResolvedValue(false);
    storage.setItem('zichan.account.v2:server-a:account-a:zichan.sync.connections.v1', JSON.stringify({
      servers: [{ id: 'server-ref-a', serverId: 'server-a' }],
      connections: [{ serverRef: 'server-ref-a', accountId: 'account-a',
        ledgerId: 'ledger-same', replicaId: 'rep-original' }],
    }));
    const laterBinding = { serverId: 'server-a', accountId: 'account-a',
      ledgerId: 'ledger-same', replicaId: 'rep-other' };
    const other = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-same', replicaId: 'rep-other' }, laterBinding);
    expect(other.namespace).toBe('zichan.account.v3:server-a:account-a:rep-other:');
    expect(other.primaryReplicaId).toBe('rep-original');
    const original = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-same', replicaId: 'rep-original' }, laterBinding);
    expect(original.namespace).toBe('zichan.account.v2:server-a:account-a:');
  });

  it('assigns an empty legacy namespace to the first replica and remembers it', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('indexedDB', {});
    vi.mocked(hasKv).mockResolvedValue(false);
    const first = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-first', replicaId: 'rep-first' });
    const second = await resolveWebLedgerNamespace('server-a', 'account-a',
      { ledgerId: 'ledger-second', replicaId: 'rep-second' });
    expect(first.namespace).toBe('zichan.account.v2:server-a:account-a:');
    expect(second.namespace).toBe('zichan.account.v3:server-a:account-a:rep-second:');
  });
});
