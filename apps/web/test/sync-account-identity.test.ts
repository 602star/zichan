import type { AddressInfo } from 'node:net';
import { loginAccount, registerAccount } from '@zichan/db';
import { describe, expect, it } from 'vitest';
import { createTestSyncServer as createSyncServer, OWNER_SETUP_TOKEN } from '../../sync-server/test/support/server-fixture.js';
import { assertSyncServerIdentity } from '../src/sync-auth.js';
import { newSyncConnection } from '../src/sync-config.js';

describe('sync account server identity pinning', () => {
  it('never completes registration or login against an unexpected server identity', async () => {
    const runtime = createSyncServer();
    await new Promise<void>((resolve) => runtime.server.listen(0, resolve));
    const baseUrl = `http://localhost:${(runtime.server.address() as AddressInfo).port}`;
    try {
      const health = await fetch(`${baseUrl}/api/health`, { redirect: 'error' })
        .then((response) => response.json()) as {
          serverId: string;
          serverPublicKey: string;
          nodePublicKey: string;
          claimed: boolean;
        };
      expect(health.claimed).toBe(false);
      const profile = { ...newSyncConnection(baseUrl), serverId: health.serverId,
        serverPublicKey: health.serverPublicKey, nodePublicKey: health.nodePublicKey };
      await expect(assertSyncServerIdentity(profile)).resolves.toBeUndefined();
      await expect(assertSyncServerIdentity({ ...profile, nodePublicKey: 'changed-node-key' }))
        .rejects.toThrow('节点签名公钥与已信任记录不一致');

      await expect(registerAccount(baseUrl, 'owner', 'account-password', {
        ownerSetupToken: OWNER_SETUP_TOKEN,
        expectedServerId: 'another-server',
        expectedServerPublicKey: health.serverPublicKey,
      })).rejects.toThrow('服务器 ID');
      const afterRejectedRegistration = await fetch(`${baseUrl}/api/health`, { redirect: 'error' })
        .then((response) => response.json()) as { claimed: boolean };
      expect(afterRejectedRegistration.claimed).toBe(false);

      await expect(registerAccount(baseUrl, 'owner', 'account-password', {
        ownerSetupToken: OWNER_SETUP_TOKEN,
        expectedServerId: health.serverId,
        expectedServerPublicKey: health.serverPublicKey,
      })).resolves.toEqual({ role: 'owner' });

      await expect(loginAccount(baseUrl, 'owner', 'account-password', {
        expectedServerId: health.serverId,
        expectedServerPublicKey: 'another-public-key',
      })).rejects.toThrow('身份公钥');
      await expect(loginAccount(baseUrl, 'owner', 'account-password', {
        expectedServerId: health.serverId,
        expectedServerPublicKey: health.serverPublicKey,
        deviceId: 'identity-test-device',
        deviceName: 'Identity pinning test',
      })).resolves.toMatchObject({ role: 'owner' });
    } finally {
      await runtime.close();
    }
  });
});
