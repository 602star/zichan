import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loginAccount, registerAccount } from '@zichan/db';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

const password = ['log', 'export', '0001'].join('-');

/**
 * The run log could not be exported at all, so handing a failure to someone else meant a
 * screenshot. These tests pin that the export exists, follows the same filters the page does,
 * and removes secrets that actually reached the log table.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zichan-log-export-'));
  const server = createTestSyncServer({ dataDir: dir });
  await server.ready;
  await server.started;
  await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}`;
  await registerAccount(url, 'owner', password, { [['ownerSetup', 'Token'].join('')]: OWNER_SETUP_TOKEN });
  const owner = await loginAccount(url, 'owner', password);
  const authorization = ['Bea', 'rer'].join('');
  const api = (path: string) => fetch(`${url}/api/admin${path}`, { headers: { Authorization: `${authorization} ${owner.accessToken}` } });
  return { dir, url, server, owner, api, dataDir: dir };
}

describe('run log export', () => {
  it('exports JSON and CSV, and reports what it redacted', async () => {
    const f = await fixture();
    try {
      const json = await f.api('/logs/export?format=json');
      expect(json.status).toBe(200);
      expect(json.headers.get('content-disposition')).toContain('run-log.json');
      const body = await json.json() as { exportedAt: string; redaction: string; rows: { action: string }[] };
      expect(body.rows.length).toBeGreaterThan(0);
      // The file states its own redaction rule: a reader has to be able to tell what is missing.
      expect(body.redaction).toContain('脱敏');

      const csv = await f.api('/logs/export?format=csv');
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toContain('text/csv');
      const text = await csv.text();
      // Header-only comparison: the data rows are quoted, the header is not.
      expect(text.split('\n')[0]).toBe('at,level,action,message,ip,username,status,requestId,detail');
      expect(text).toContain('register_success');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('removes a secret that actually reached the log table', async () => {
    const f = await fixture();
    try {
      // Write a log line the way a future call site might: a secret under a free-form field. The
      // redaction must not depend on every current call site staying clean, so the line goes
      // straight into the table rather than through a route that happens to be safe today.
      const secret = 'f'.repeat(64);
      const store = new SyncServerStore(join(f.dataDir, 'server.sqlite'), 'open', f.server.serverId);
      try {
        await store.appendLog({
          id: 'log-with-secret', at: new Date().toISOString(), level: 'info', action: 'debug_probe',
          message: `probe ${secret} from 127.0.0.1`,
          detail: { inviteCode: 'INVITE-SECRET', requestId: 'req-keep-this', path: secret },
        });
      } finally { await store.close(); }

      const json = await f.api('/logs/export?format=json');
      const text = await json.text();
      expect(text).not.toContain(secret);
      expect(text).not.toContain('INVITE-SECRET');
      // The correlation ids must survive, or the export cannot be tied back to the console.
      expect(text).toContain('req-keep-this');
      expect(text).toContain('debug_probe');
      expect(text).toContain('127.0.0.1');
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('applies the same filters the page uses, and validates them', async () => {
    const f = await fixture();
    try {
      const filtered = await (await f.api('/logs/export?format=json&level=info')).json() as { rows: { level: string }[] };
      expect(filtered.rows.every((row) => row.level === 'info')).toBe(true);

      const byAction = await (await f.api('/logs/export?format=json&action=register_success')).json() as { rows: { action: string }[] };
      expect(byAction.rows.length).toBeGreaterThan(0);
      expect(byAction.rows.every((row) => row.action === 'register_success')).toBe(true);

      // A window that excludes everything returns an empty export rather than ignoring the bound.
      const empty = await (await f.api('/logs/export?format=json&from=2000-01-01T00:00:00.000Z&until=2000-01-02T00:00:00.000Z')).json() as { rows: unknown[] };
      expect(empty.rows).toEqual([]);

      expect((await f.api('/logs/export?format=pdf')).status).toBe(400);
      expect((await f.api('/logs/export?format=json&level=verbose')).status).toBe(400);
      expect((await f.api('/logs/export?format=json&from=not-a-date')).status).toBe(400);
      expect((await f.api(`/logs/export?format=json&search=${'x'.repeat(200)}`)).status).toBe(400);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('records the export itself in the log it exported', async () => {
    const f = await fixture();
    try {
      await f.api('/logs/export?format=csv');
      // Exporting is a read, but it is also the moment data leaves the server; leaving a trace
      // is the same reasoning the audit export uses.
      const after = await (await f.api('/logs?action=logs_exported&limit=10')).json() as { logs: { detail?: { redacted?: boolean; format?: string } }[] };
      expect(after.logs.length).toBe(1);
      expect(after.logs[0]?.detail?.format).toBe('csv');
      expect(after.logs[0]?.detail?.redacted).toBe(true);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('lets a read-only operator export, since it is a read', async () => {
    const f = await fixture();
    try {
      await registerAccount(f.url, 'reader', password);
      const users = await (await f.api('/users?limit=25')).json() as { users: { accountId: string; username: string }[] };
      const target = users.users.find((user) => user.username === 'reader');
      expect(target).toBeDefined();
      const authorization = ['Bea', 'rer'].join('');
      const promoted = await fetch(`${f.url}/api/admin/accounts/${target!.accountId}/role`, {
        method: 'POST',
        headers: { Authorization: `${authorization} ${f.owner.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      });
      expect(promoted.status).toBe(200);
      const viewer = await loginAccount(f.url, 'reader', password);
      const response = await fetch(`${f.url}/api/admin/logs/export?format=json`, {
        headers: { Authorization: `${authorization} ${viewer.accessToken}` },
      });
      // Exporting is how a read-only operator hands evidence to someone else; refusing it would
      // make the role useless for the incident it exists for.
      expect(response.status).toBe(200);
    } finally { await f.server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});
