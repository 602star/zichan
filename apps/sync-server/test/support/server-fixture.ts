import { createSyncServer, type SyncServerOptions } from '../../src/server.js';

// Explicit test-only deployment secret. Production always generates a random file.
export const OWNER_SETUP_TOKEN = 'test-only-owner-setup-token-0000000000000000';

export function createTestSyncServer(options: SyncServerOptions = {}) {
  return createSyncServer({ registrationMode: 'open', ...options, ownerSetupToken: OWNER_SETUP_TOKEN });
}
