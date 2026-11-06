import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerAccount, loginAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('management access path', () => {
  it('uses /admin by default, supports custom paths, and returns to /admin when cleared', async () => {
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
      expect(running.instance.adminAccessPath()).toBe('');
      expect((await fetch(`${running.url}/admin/`)).status).toBe(200);
      expect((await fetch(`${running.url}/admin/users`)).status).toBe(200);
      expect((await fetch(`${running.url}/wrong-segment/admin/`)).status).toBe(404);
      expect((await fetch(`${running.url}/`)).status).toBe(200);
      const legacyEntry = await fetch(`${running.url}/app/`, { redirect: 'manual' });
      expect(legacyEntry.status).toBe(302);
      expect(legacyEntry.headers.get('location')).toBe('/ledger/');
      await registerAccount(running.url, 'owner', 'owner-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      expect((await fetch(`${running.url}/admin/`)).status).toBe(200);
      const owner = await loginAccount(running.url, 'owner', 'owner-password');
      const headers = { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' };
      const bad = await fetch(`${running.url}/api/admin/settings`, { method: 'POST', headers,
        body: JSON.stringify({ settings: { adminAccessPath: '../admin' } }) });
      expect(bad.status).toBe(400);
      const reserved = await fetch(`${running.url}/api/admin/settings`, { method: 'POST', headers,
        body: JSON.stringify({ settings: { adminAccessPath: 'api' } }) });
      expect(reserved.status).toBe(400);
      const changed = await fetch(`${running.url}/api/admin/settings`, { method: 'POST', headers,
        body: JSON.stringify({ settings: { adminAccessPath: 'admin1' } }) });
      expect(changed.status).toBe(200);
      expect(running.instance.adminAccessPath()).toBe('admin1');
      expect((await fetch(`${running.url}/admin/`, { redirect: 'manual' })).status).toBe(404);
      expect((await fetch(`${running.url}/admin1/admin/`)).status).toBe(200);
      await running.instance.close();
      running = await start();
      expect(running.instance.adminAccessPath()).toBe('admin1');
      expect((await fetch(`${running.url}/admin/`, { redirect: 'manual' })).status).toBe(404);
      expect((await fetch(`${running.url}/admin1/admin/`)).status).toBe(200);
      const longPath = 'x'.repeat(600);
      const longValue = await fetch(`${running.url}/api/admin/settings`, { method: 'POST', headers,
        body: JSON.stringify({ settings: { adminAccessPath: longPath } }) });
      expect(longValue.status).toBe(200);
      expect((await fetch(`${running.url}/admin1/admin/`)).status).toBe(404);
      expect((await fetch(`${running.url}/${longPath}/admin/`)).status).toBe(200);
      const cleared = await fetch(`${running.url}/api/admin/settings`, { method: 'POST', headers,
        body: JSON.stringify({ settings: { adminAccessPath: '' } }) });
      expect(cleared.status).toBe(200);
      expect(running.instance.adminAccessPath()).toBe('');
      expect((await fetch(`${running.url}/admin/`)).status).toBe(200);
      expect((await fetch(`${running.url}/${longPath}/admin/`)).status).toBe(404);
      await running.instance.close();
      running = await start();
      expect(running.instance.adminAccessPath()).toBe('');
      expect((await fetch(`${running.url}/admin/`)).status).toBe(200);
    } finally {
      await running.instance.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
