import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginAccount, registerAccount } from '@zichan/db';
import { issueOwnerRecovery } from '../src/owner-recovery.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('local owner recovery', () => {
  it('recovers the same owner after restart, replaces older codes and never overwrites output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-recovery-'));
    const dataDir = join(root, 'data');
    let server = createTestSyncServer({ dataDir });
    const listen = async () => {
      await server.ready;
      await new Promise<void>((done) => server.server.listen(0, '127.0.0.1', done));
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      return `http://127.0.0.1:${address.port}`;
    };
    try {
      let url = await listen();
      await registerAccount(url, 'owner', 'original-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const before = await loginAccount(url, 'owner', 'original-password');
      await server.close();
      const first = join(root, 'first.json');
      const second = join(root, 'second.json');
      expect((await issueOwnerRecovery(dataDir, first)).username).toBe('owner');
      await expect(issueOwnerRecovery(dataDir, first)).rejects.toThrow();
      await issueOwnerRecovery(dataDir, second);
      const oldCode = JSON.parse(readFileSync(first, 'utf8')).code;
      const code = JSON.parse(readFileSync(second, 'utf8')).code;
      server = createTestSyncServer({ dataDir });
      url = await listen();
      await expect(registerAccount(url, 'owner', 'new-owner-password', { passwordResetCode: oldCode })).rejects.toThrow();
      await registerAccount(url, 'owner', 'new-owner-password', { passwordResetCode: code });
      const after = await loginAccount(url, 'owner', 'new-owner-password');
      expect(after.accountId).toBe(before.accountId);
      expect(after.role).toBe('owner');
      await expect(registerAccount(url, 'owner', 'replayed-password', { passwordResetCode: code })).rejects.toThrow();
      expect((await fetch(`${url}/api/auth/me`, { headers: { Authorization: `Bearer ${before.accessToken}` } })).status).toBe(401);
    } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
