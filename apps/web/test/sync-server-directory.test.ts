import { describe, expect, it } from 'vitest';
import { newSyncConnection, type SharedSyncServer, type SyncConnection } from '../src/sync-config.js';
import { mergeSharedSyncDirectory, sharedDirectoryFromConnections } from '../src/sync-server-directory.js';

function trustedConnection(baseUrl = 'https://one.example.com/zichan'): SyncConnection {
  return {
    ...newSyncConnection(baseUrl),
    alias: '主服务器',
    serverId: 'server-identity-1',
    serverPublicKey: 'opaque-public-key-1',
    sharedUrls: [baseUrl],
    enabled: true,
    status: 'online',
  };
}

describe('shared sync server directory', () => {
  it('shares trusted public endpoints but keeps device-local addresses private by default', () => {
    const publicConnection = trustedConnection();
    const localConnection = {
      ...trustedConnection('http://192.168.1.8:8787'),
      serverId: 'server-identity-2',
      serverPublicKey: 'opaque-public-key-2',
      sharedUrls: [],
      deviceUrls: ['http://192.168.1.8:8787'],
    };

    expect(sharedDirectoryFromConnections([publicConnection, localConnection])).toEqual([{
      id: publicConnection.serverRef,
      alias: '主服务器',
      serverId: 'server-identity-1',
      serverPublicKey: 'opaque-public-key-1',
      sharedUrls: ['https://one.example.com/zichan'],
    }]);
  });

  it('shares a private address only when the device explicitly puts it in sharedUrls', () => {
    const connection = {
      ...trustedConnection('http://192.168.1.8:8787'),
      sharedUrls: ['http://192.168.1.8:8787'],
      deviceUrls: [],
    };
    expect(sharedDirectoryFromConnections([connection])[0]?.sharedUrls).toEqual(['http://192.168.1.8:8787']);
  });

  it('adds a server learned from the encrypted ledger as login-required on this device', () => {
    const local = trustedConnection();
    const shared: SharedSyncServer = {
      id: 'server-ref-2',
      alias: '异地服务器',
      serverId: 'server-identity-2',
      serverPublicKey: 'opaque-public-key-2',
      sharedUrls: ['https://two.example.com/zichan'],
    };

    const result = mergeSharedSyncDirectory([local], [shared]);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      id: 'server-ref-2',
      username: '',
      enabled: false,
      status: 'login_required',
      serverId: 'server-identity-2',
      serverPublicKey: 'opaque-public-key-2',
    });
  });

  it('blocks a shared-directory public-key change for an existing server identity', () => {
    const local = trustedConnection();
    const result = mergeSharedSyncDirectory([local], [{
      id: local.serverRef,
      alias: local.alias,
      serverId: local.serverId!,
      serverPublicKey: 'attacker-key',
      sharedUrls: ['https://other.example.com'],
    }]);

    expect(result[0]?.status).toBe('identity_changed');
    expect(result[0]?.baseUrl).toBe(local.baseUrl);
  });

  it('preserves the device connection id when matching a shared server by identity', () => {
    const local = trustedConnection();
    const localId = local.id;
    const result = mergeSharedSyncDirectory([local], [{
      id: 'id-from-another-device',
      alias: '共享别名',
      serverId: local.serverId!,
      serverPublicKey: local.serverPublicKey!,
      sharedUrls: ['https://other.example.com'],
    }]);
    expect(result[0]).toMatchObject({ id: localId, serverRef: local.serverRef, alias: '共享别名' });
  });
});
