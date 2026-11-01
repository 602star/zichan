import { listenOnSafePort, closeTestSyncServer } from '../safe-listen.mjs';
import { test as base, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { registerAccount } from '../../../packages/db/dist/index.js';

// Each workflow gets an isolated real server. Rate limits and accounts never leak between tests.
export const test = base.extend({
  baseURL: async ({}, use) => {
    const setup = 'e2e-only-owner-setup-00000000000000000000';
    const server = createSyncServer({ enableWeb: true, webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)), registrationMode: 'open', ownerSetupToken: setup });
    try {
      await server.ready;
      await listenOnSafePort(server.server, '127.0.0.1');
      const url = `http://127.0.0.1:${server.server.address().port}`;
      await registerAccount(url, 'test-owner', 'test-owner-password', { ownerSetupToken: setup });
      await use(url);
    } finally { await closeTestSyncServer(server); }
  },
});
export { expect };
