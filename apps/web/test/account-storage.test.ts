import { afterEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); }, clear: () => data.clear(), key: (index) => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe('new Web account storage', () => {
  it('does not read or clear old keys and rejects database access before login', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    localStorage.setItem('envelope', 'old');
    const storage = await import('../src/account-storage.js');
    storage.enableWebAccounts();
    expect(storage.accountLocalStorage.getItem('envelope')).toBeNull();
    expect(storage.accountDatabaseName).toThrow('请先登录');
    storage.activateWebAccount('server-a', 'user-a');
    storage.accountLocalStorage.setItem('envelope', 'new');
    storage.accountLocalStorage.clear();
    expect(localStorage.getItem('envelope')).toBe('old');
  });
  it('isolates account keys, session metadata and database names across documents', async () => {
    vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('sessionStorage', memoryStorage());
    const a = await import('../src/account-storage.js');
    a.enableWebAccounts(); a.activateWebAccount('server-a', 'user-a');
    a.accountLocalStorage.setItem('envelope', 'alice'); a.accountSessionStorage.setItem('session', 'alice-session');
    vi.resetModules();
    const b = await import('../src/account-storage.js');
    b.enableWebAccounts(); b.activateWebAccount('server-a', 'user-b');
    expect(b.accountLocalStorage.getItem('envelope')).toBeNull();
    expect(b.accountSessionStorage.getItem('session')).toBeNull();
    expect(b.accountDatabaseName()).not.toBe(a.accountDatabaseName());
    b.accountLocalStorage.setItem('envelope', 'bob');
    expect(a.accountLocalStorage.getItem('envelope')).toBe('alice');
    expect(() => b.activateWebAccount('server-a', 'user-a')).toThrow('重新加载');
  });
  it('keeps desktop storage names unchanged', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const storage = await import('../src/account-storage.js');
    expect(storage.accountDatabaseName()).toBe('zichan-web');
    storage.accountLocalStorage.setItem('desktop', 'value');
    expect(localStorage.getItem('desktop')).toBe('value');
  });
});
