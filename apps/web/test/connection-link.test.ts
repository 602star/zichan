import { describe, expect, it } from 'vitest';
import {
  createSyncConnectionLink,
  fingerprintServerPublicKey,
  parseSyncConnectionLink,
} from '../src/connection-link.js';

describe('non-secret sync connection links', () => {
  it('round-trips Unicode aliases, a canonical URL and pinned identity without credentials', async () => {
    const fingerprint = await fingerprintServerPublicKey('opaque-public-key-material');
    const link = createSyncConnectionLink({
      version: 1,
      alias: '家里账本',
      url: 'https://ledger.example.com/zichan/',
      serverId: 'server-identity-1',
      serverPublicKeyFingerprint: fingerprint,
    }, 'https://official.example.com/app?old=value');

    expect(link).toMatch(/^https:\/\/official\.example\.com\/app#zichan-sync=/);
    expect(link).not.toContain('password');
    expect(link).not.toContain('token');
    expect(parseSyncConnectionLink(link)).toEqual({
      version: 1,
      alias: '家里账本',
      url: 'https://ledger.example.com/zichan',
      serverId: 'server-identity-1',
      serverPublicKeyFingerprint: fingerprint,
    });
  });

  it('rejects links without a complete SHA-256 server-key fingerprint', () => {
    const payload = btoa(JSON.stringify({
      version: 1,
      alias: 'bad',
      url: 'https://ledger.example.com',
      serverId: 'server-1',
      serverPublicKeyFingerprint: 'short',
    }));
    expect(() => parseSyncConnectionLink(`https://app.example.com/#zichan-sync=${payload}`)).toThrow('缺少服务器身份');
  });
});
