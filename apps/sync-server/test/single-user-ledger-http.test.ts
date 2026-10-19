import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('single-user ledger HTTP surface', () => {
  it('does not expose member identity or ledger sharing endpoints', async () => {
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    try {
      await registerAccount(url, 'nodeadmin', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'alice', 'account-password');
      const session = await loginAccount(url, 'alice', 'account-password');
      const headers = { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' };
      for (const [method, path] of [
        ['GET', '/api/v4/account/encryption-key'],
        ['PUT', '/api/v4/account/encryption-key'],
        ['GET', '/api/v4/ledger/control'],
        ['POST', '/api/v4/ledger/control'],
        ['POST', '/api/v4/ledger/control/events'],
        ['GET', '/api/v4/ledger/member-envelope'],
        ['PUT', '/api/v4/ledger/member-envelope'],
        ['GET', '/api/v4/ledger/member-envelopes'],
        ['POST', '/api/auth/ledger/select'],
      ] as const) {
        const response = await fetch(`${url}${path}`, { method, headers,
          ...(method === 'PUT' || method === 'POST' ? { body: '{}' } : {}) });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    } finally { await server.close(); }
  });
});
