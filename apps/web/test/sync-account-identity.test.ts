import type { AddressInfo } from 'node:net';
import { loginAccount, registerAccount } from '@zichan/db';
import { describe, expect, it } from 'vitest';
import { createSyncServer } from '../../sync-server/src/server.js';

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
          claimed: boolean;
        };
      expect(health.claimed).toBe(false);

      await expect(registerAccount(baseUrl, 'owner', 'account-password', {
        expectedServerId: 'another-server',
        expectedServerPublicKey: health.serverPublicKey,
      })).rejects.toThrow('服务器 ID');
      const afterRejectedRegistration = await fetch(`${baseUrl}/api/health`, { redirect: 'error' })
        .then((response) => response.json()) as { claimed: boolean };
      expect(afterRejectedRegistration.claimed).toBe(false);

      await expect(registerAccount(baseUrl, 'owner', 'account-password', {
        expectedServerId: health.serverId,
        expectedServerPublicKey: health.serverPublicKey,
      })).resolves.toEqual({ role: 'admin' });

      await expect(loginAccount(baseUrl, 'owner', 'account-password', {
        expectedServerId: health.serverId,
        expectedServerPublicKey: 'another-public-key',
      })).rejects.toThrow('身份公钥');
      await expect(loginAccount(baseUrl, 'owner', 'account-password', {
        expectedServerId: health.serverId,
        expectedServerPublicKey: health.serverPublicKey,
        deviceId: 'identity-test-device',
        deviceName: 'Identity pinning test',
      })).resolves.toMatchObject({ role: 'admin' });
    } finally {
      await runtime.close();
    }
  });
});
