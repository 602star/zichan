import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerAccount, loginAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('management access path', () => {
  it('generates a stable default, rejects old and guessed routes, and applies owner changes immediately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-admin-path-'));
    const webDir = join(root, 'web');
    const dataDir = join(root, 'data');
    mkdirSync(webDir);
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Hosted app</title>');
    const start = async () => {
      const instance = createTestSyncServer({ dataDir, webDir, basePath: '/ledger' });
      await instance.started;
      await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
      const address = instance.server.address();
      if (!address || typeof address === 'string') throw new Error('missing listener');
      return { instance, url: `http://127.0.0.1:${address.port}/ledger` };
    };
    let running = await start();
    try {
      const generated = running.instance.adminAccessPath();
      expect(generated).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect((await fetch(`${running.url}/admin/`)).status).toBe(404);
      expect((await fetch(`${running.url}/wrong-segment/admin/`)).status).toBe(404);
      expect((await fetch(`${running.url}/${generated}/admin/`)).status).toBe(200);
      expect((await fetch(`${running.url}/${generated}/admin/users`)).status).toBe(200);
      expect((await fetch(`${running.url}/app/`)).status).toBe(200);
      await registerAccount(running.url, 'owner', 'owner-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      const owner = await loginAccount(running.url, 'owner', 'owner-password');
      const headers = { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' };
      const bad = await fetch(`${running.url}/api/admin/settings`, { method: 'POST', headers,
        body: JSON.stringify({ settings: { adminAccessPath: '../admin' } }) });
      expect(bad.status).toBe(400);
      const changed = await fetch(`${running.url}/api/admin/settings`, { method: 'POST', headers,
        body: JSON.stringify({ settings: { adminAccessPath: 'my-private-entry-2026' } }) });
      expect(changed.status).toBe(200);
      expect(running.instance.adminAccessPath()).toBe('my-private-entry-2026');
      expect((await fetch(`${running.url}/${generated}/admin/`)).status).toBe(404);
      expect((await fetch(`${running.url}/my-private-entry-2026/admin/`)).status).toBe(200);
      await running.instance.close();
      running = await start();
      expect(running.instance.adminAccessPath()).toBe('my-private-entry-2026');
      expect((await fetch(`${running.url}/my-private-entry-2026/admin/`)).status).toBe(200);
    } finally {
      await running.instance.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
