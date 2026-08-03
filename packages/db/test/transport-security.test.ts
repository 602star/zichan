import { describe, expect, it } from 'vitest';
import { assertSecureSyncUrl } from '../src/http-transport.js';

describe('sync transport security', () => {
  it('allows HTTPS and explicit local network HTTP endpoints', () => {
    expect(() => assertSecureSyncUrl('https://ledger.example.com/zichan')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://localhost:8787')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://192.168.1.20:8787')).not.toThrow();
    expect(() => assertSecureSyncUrl('http://[fd00::20]:8787')).not.toThrow();
  });

  it('rejects public HTTP endpoints and URL credentials', () => {
    expect(() => assertSecureSyncUrl('http://ledger.example.com')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('http://8.8.8.8:8787')).toThrow('公网同步必须使用 HTTPS');
    expect(() => assertSecureSyncUrl('https://owner:secret@ledger.example.com')).toThrow('不能包含用户名或密码');
  });
});
