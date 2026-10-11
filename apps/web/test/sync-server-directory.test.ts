import { describe, expect, it, vi } from 'vitest';
import { newSyncConnection, type SharedSyncServer, type SyncConnection } from '../src/sync-config.js';
import { loadSharedSyncDirectory, saveSharedSyncDirectory, mergeSharedSyncDirectory, sharedDirectoryFromConnections } from '../src/sync-server-directory.js';

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
  it.each(['{broken', '{"version":2,"servers":[]}', '{"version":1,"servers":[null]}', '{"version":1,"servers":[{"id":"damaged"}]}'])('preserves an unreadable directory: %s', async (raw) => {
    const setting = { id: 'settings', syncServersJson: raw };
    const put = vi.fn();
    const store = { settings: { list: vi.fn(async () => [setting]), put } } as unknown as Parameters<typeof loadSharedSyncDirectory>[0];
    await expect(loadSharedSyncDirectory(store)).rejects.toThrow('原始目录已保留');
    await expect(saveSharedSyncDirectory(store, [trustedConnection()])).rejects.toThrow('原始目录已保留');
    expect(put).not.toHaveBeenCalled();
    expect(setting.syncServersJson).toBe(raw);
  });

  it('blocks writes after read failure and supports a subsequent successful retry', async () => {
    const put = vi.fn();
    const list = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    const store = { settings: { list, put } } as unknown as Parameters<typeof loadSharedSyncDirectory>[0];
    await expect(loadSharedSyncDirectory(store)).rejects.toThrow('unavailable');
    await expect(saveSharedSyncDirectory(store, [])).rejects.toThrow('unavailable');
    expect(put).not.toHaveBeenCalled();
    list.mockResolvedValue([{ id: 'settings' }]);
    expect(await loadSharedSyncDirectory(store)).toEqual([]);
    expect(await saveSharedSyncDirectory(store, [trustedConnection()])).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
  });

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

  it('shares the pinned node signing key and refuses a conflicting shared identity', () => {
    const local = { ...trustedConnection(), nodePublicKey: 'trusted-node-key' };
    expect(sharedDirectoryFromConnections([local])[0]?.nodePublicKey).toBe('trusted-node-key');
    const conflicting = mergeSharedSyncDirectory([local], [{
      id: local.serverRef, alias: local.alias, serverId: local.serverId!,
      serverPublicKey: local.serverPublicKey!, nodePublicKey: 'changed-node-key',
      sharedUrls: ['https://other.example.com'],
    }]);
    expect(conflicting[0]).toMatchObject({ status: 'identity_changed',
      nodePublicKey: 'trusted-node-key' });
    expect(conflicting[0]?.sharedUrls).toEqual(local.sharedUrls);
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
