import { describe, expect, it } from 'vitest';
import { ProfileOperations } from '../src/profile-operation.js';

describe('profile authentication response fencing', () => {
  it.each(['username', 'address', 'password', 'logout', 'removed'])('rejects a delayed login after %s changes', async (change) => {
    const operations = new ProfileOperations();
    let revision = 'alice';
    const operation = operations.start('one', () => revision);
    let resolve!: (value: string) => void;
    let stored = '';
    const login = new Promise<string>((done) => { resolve = done; }).then((token) => { operation.assertCurrent(); stored = token; });
    const failed = expect(login).rejects.toThrow('忽略旧请求');
    revision = change;
    operations.cancelStale();
    resolve('alice-session');
    await failed;
    expect(stored).toBe('');
    expect(operation.signal.aborted).toBe(true);
  });

  it('does not let an old finally handler remove a newer operation', () => {
    const operations = new ProfileOperations();
    const old = operations.start('one', () => 'same');
    const next = operations.start('one', () => 'same');
    operations.finish('one', old);
    expect(old.current()).toBe(false);
    expect(next.current()).toBe(true);
    operations.cancelAll();
    expect(next.signal.aborted).toBe(true);
  });
});
