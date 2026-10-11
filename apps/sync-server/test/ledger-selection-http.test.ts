import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchAuthMe, loginAccount, refreshAccountSession, registerAccount,
  selectAccountLedger } from '@zichan/db';
import { NodeSqliteDriver } from '@zichan/db/node';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '@zichan/core';
import { loadNodeIdentity } from '../src/node-identity.js';
import { CURRENT_SERVER_SCHEMA, SyncServerStore } from '../src/store.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('session ledger selection', () => {
  it('upgrades schema 16 sessions without changing their ledger choice', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zichan-session-selection-'));
    const file = join(directory, 'server.sqlite');
    const initial = new SyncServerStore(file, 'open', 'server-session-upgrade');
    let upgraded: SyncServerStore | undefined;
    try {
      await initial.register('member', 'opaque-member', undefined, true);
      const replica = await initial.bindReplica('member', 'ledger-session-upgrade-0001');
      await initial.createSession({ id: 'session-upgrade-0001', username: 'member',
        deviceId: 'device-upgrade-0001', deviceName: 'Old browser', refreshHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await initial.close();
      const sql = new NodeSqliteDriver(file);
      try {
        await sql.exec('ALTER TABLE sync_sessions DROP COLUMN selection_version');
        await sql.run(`INSERT INTO sync_backup_archives
          (username, ledger_id, archive_id, blob_id, created_at, reason, kind, label, size_bytes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['member', replica.ledgerId, 'backup-upgrade-0001', 'a'.repeat(64),
          new Date().toISOString(), 'manual', 'portable', 'old backup', 128]);
        await sql.run('UPDATE server_schema_migrations SET version = 16, name = ?',
          ['account_ledger_index_v16']);
      } finally { await sql.close(); }
      upgraded = new SyncServerStore(file, 'open', 'server-session-upgrade');
      expect((await upgraded.verify()).schemaVersion).toBe(CURRENT_SERVER_SCHEMA);
      expect(await upgraded.getSession('session-upgrade-0001')).toMatchObject({
        replicaId: replica.replicaId, selectionVersion: 0,
      });
      expect((await upgraded.getReplica('member'))?.replicaId).toBe(replica.replicaId);
      expect(await upgraded.listBackupArchives('member', replica.ledgerId)).toMatchObject([
        { archiveId: 'backup-upgrade-0001', label: 'old backup' },
      ]);
    } finally {
      await (upgraded ?? initial).close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps two browser sessions on separate ledgers and invalidates the selected session old token', async () => {
    const server = createTestSyncServer();
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    const url = `http://localhost:${(server.server.address() as AddressInfo).port}`;
    let store: SyncServerStore | undefined;
    try {
      await registerAccount(url, 'owner', 'account-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'member', 'account-password');
      store = new SyncServerStore(join(server.dataDir, 'server.sqlite'), 'open', server.serverId);
      const owner = (await store.getUser('owner'))!;
      const member = (await store.getUser('member'))!;
      const sharedLedgerId = 'ledger-selected-shared-0001';
      const personalLedgerId = 'ledger-selected-personal-001';
      const shared = await store.bindReplica('owner', sharedLedgerId);
      const personal = await store.bindReplica('member', personalLedgerId);
      const ownerKey = await createAccountEncryptionKey(server.serverId, owner.accountId, 'owner account key password');
      const memberKey = await createAccountEncryptionKey(server.serverId, member.accountId, 'member account key password');
      await store.putAccountEncryptionKey(server.serverId, owner.accountId, ownerKey.envelope.publicKey,
        ownerKey.envelope as unknown as Record<string, unknown>, 0);
      await store.putAccountEncryptionKey(server.serverId, member.accountId, memberKey.envelope.publicKey,
        memberKey.envelope as unknown as Record<string, unknown>, 0);
      const actor = { issuerNodeId: server.serverId, accountId: owner.accountId };
      const target = { issuerNodeId: server.serverId, accountId: member.accountId };
      const genesis = signLedgerControlEvent(ownerKey.privateKey, { v: 1, ledgerId: sharedLedgerId,
        seq: 1, previousHash: null, keyEpoch: 1, kind: 'MemberGenesis', actor, target: actor,
        role: 'OWNER', signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
        encryptionPublicKey: ownerKey.envelope.publicKey });
      const first = await store.initializeLedgerControl('owner', genesis);
      const added = signLedgerControlEvent(ownerKey.privateKey, { v: 1, ledgerId: sharedLedgerId,
        seq: 2, previousHash: first.headHash, keyEpoch: 1, kind: 'MemberAdded', actor, target,
        role: 'EDITOR', signingPublicKey: accountSigningPublicKey(memberKey.privateKey),
        encryptionPublicKey: memberKey.envelope.publicKey });
      const addedState = await store.appendLedgerControlEvent('owner', added);
      const firstBrowser = await loginAccount(url, 'member', 'account-password', {
        deviceId: 'device-first-browser', deviceName: 'First browser' });
      const secondBrowser = await loginAccount(url, 'member', 'account-password', {
        deviceId: 'device-second-browser', deviceName: 'Second browser' });
      const select = (token: string, replicaId: string) => fetch(`${url}/api/auth/ledger/select`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ replicaId }),
      });
      expect((await select(secondBrowser.accessToken, shared.replicaId)).status).toBe(409);
      const memberEnvelope = await wrapLedgerCryptoSessionForMember(createLedgerCryptoSession(sharedLedgerId),
        { ...target, recipientPublicKey: memberKey.envelope.publicKey, keyEpoch: 1 });
      await store.putLedgerMemberKeyEnvelope('owner', memberEnvelope);
      expect((await select(firstBrowser.accessToken, 'rep-unknown000000000000000')).status).toBe(403);
      const selection = await select(secondBrowser.accessToken, shared.replicaId);
      expect(selection.status).toBe(200);
      expect(selection.headers.get('cache-control')).toBe('no-store');
      const selected = await selection.json() as { accessToken: string; replicaId: string;
        session: { selectionVersion: number; replicaId: string } };
      expect(selected).toMatchObject({ replicaId: shared.replicaId,
        session: { selectionVersion: 1, replicaId: shared.replicaId } });
      expect((await fetchAuthMe(url, firstBrowser.accessToken)).replicaId).toBe(personal.replicaId);
      expect((await fetchAuthMe(url, selected.accessToken)).replicaId).toBe(shared.replicaId);
      expect((await fetch(`${url}/api/auth/me`, {
        headers: { Authorization: `Bearer ${secondBrowser.accessToken}` },
      })).status).toBe(401);
      const headers = { Authorization: `Bearer ${selected.accessToken}` };
      expect((await (await fetch(`${url}/api/v3/commits`, { headers })).json() as { replicaId: string }).replicaId)
        .toBe(shared.replicaId);
      expect((await fetch(`${url}/api/v3/protection`, { headers })).status).toBe(403);
      expect((await fetch(`${url}/api/v3/key-envelope`, { headers })).status).toBe(403);
      expect((await fetch(`${url}/api/v3/protection`, { method: 'PUT', headers })).status).toBe(409);
      const chunk = Buffer.alloc(128, 7);
      const blobId = 'b'.repeat(64);
      const manifest = { v: 2, blobId, cipherBytes: chunk.byteLength, chunkCount: 1,
        chunks: [{ index: 0, sizeBytes: chunk.byteLength,
          ciphertextSha256: createHash('sha256').update(chunk).digest('hex'), iv: 'test-iv-123456' }] };
      const upload = await fetch(`${url}/api/v3/blobs/uploads`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest }) });
      expect(upload.status).toBe(201);
      const plan = await upload.json() as { uploadId: string };
      expect((await fetch(`${url}/api/v3/blobs/uploads/${plan.uploadId}/chunks/0`,
        { method: 'PUT', headers, body: chunk })).status).toBe(200);
      expect((await fetch(`${url}/api/v3/blobs/uploads/${plan.uploadId}/complete`,
        { method: 'POST', headers })).status).toBe(200);
      const status = (token: string) => fetch(`${url}/api/v3/blobs/status`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobIds: [blobId] }),
      }).then((response) => response.json()) as Promise<{ objects: Record<string, string> }>;
      expect((await status(selected.accessToken)).objects[blobId]).toBe('available');
      expect((await status(firstBrowser.accessToken)).objects[blobId]).toBe('missing');
      expect((await (await fetch(`${url}/api/v3/blobs/usage`, { headers })).json() as {
        usage: { objectCount: number } }).usage.objectCount).toBe(1);
      const backup = { archiveId: 'backup-shared-0001', blobId,
        createdAt: new Date().toISOString(), reason: 'manual', kind: 'portable',
        label: 'shared ledger backup', sizeBytes: chunk.byteLength };
      expect((await fetch(`${url}/api/v3/backups`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive: backup }) })).status).toBe(201);
      const personalHeaders = { Authorization: `Bearer ${firstBrowser.accessToken}` };
      expect((await (await fetch(`${url}/api/v3/backups`, { headers })).json() as {
        backups: unknown[] }).backups).toHaveLength(1);
      expect((await (await fetch(`${url}/api/v3/backups`, { headers: personalHeaders })).json() as {
        backups: unknown[] }).backups).toHaveLength(0);
      expect((await fetch(`${url}/api/v3/backups/${backup.archiveId}`,
        { method: 'DELETE', headers: personalHeaders })).status).toBe(404);
      expect((await fetch(`${url}/api/v4/replication/grants`, { headers })).status).toBe(403);
      expect((await fetch(`${url}/api/v4/replication/links`, { headers })).status).toBe(403);
      await store.appendLedgerControlEvent('owner', signLedgerControlEvent(ownerKey.privateKey, {
        v: 1, ledgerId: sharedLedgerId, seq: 3, previousHash: addedState.headHash,
        keyEpoch: 1, kind: 'MemberRoleChanged', actor, target, role: 'OWNER',
      }));
      expect(await (await fetch(`${url}/api/v3/protection`, { headers })).json()).toMatchObject({
        mode: 'relay', secret: null, envelope: null, replica: { replicaId: shared.replicaId },
      });
      expect(await (await fetch(`${url}/api/v3/key-envelope`, { headers })).json())
        .toEqual({ envelope: null });
      const grantResponse = await fetch(`${url}/api/v4/replication/grants`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerNodeId: 'node-peer-ledger-test',
          peerPublicKey: loadNodeIdentity(server.dataDir, server.serverId).publicKey,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
      });
      expect(grantResponse.status).toBe(201);
      const grant = await grantResponse.json() as { grantId: string; ledgerId: string };
      expect(grant.ledgerId).toBe(sharedLedgerId);
      expect(await store.issueFederatedLoginCode(grant.grantId, 'member', member.accountId,
        'shared-ledger-login-state-0001')).toBeTruthy();
      const personalGrant = await store.createNodeReplicationGrant('member', 'node-peer-personal-test',
        loadNodeIdentity(server.dataDir, server.serverId).publicKey,
        new Date(Date.now() + 86_400_000).toISOString());
      await expect(store.issueFederatedLoginCode(personalGrant.grantId, 'owner', owner.accountId,
        'personal-ledger-login-state-0001')).rejects.toMatchObject({ code: 'LEDGER_MEMBER_REQUIRED' });
      expect(await store.revokeNodeReplicationGrant('member', personalGrant.grantId)).toBe(true);
      expect((await (await fetch(`${url}/api/v4/replication/grants`, { headers })).json() as {
        grants: unknown[] }).grants).toHaveLength(1);
      const refreshed = await refreshAccountSession(url, secondBrowser.refreshToken);
      expect((await fetchAuthMe(url, refreshed.accessToken)).replicaId).toBe(shared.replicaId);
      const returned = await selectAccountLedger(url, refreshed.accessToken, personal.replicaId);
      expect((await fetchAuthMe(url, returned.accessToken)).replicaId).toBe(personal.replicaId);
      const returnedHeaders = { Authorization: `Bearer ${returned.accessToken}` };
      expect((await (await fetch(`${url}/api/v4/replication/grants`, { headers: returnedHeaders })).json() as {
        grants: unknown[] }).grants).toHaveLength(0);
      expect((await fetch(`${url}/api/v4/replication/grants/${grant.grantId}`, {
        method: 'DELETE', headers: returnedHeaders })).status).toBe(404);
      const sharedAgain = await selectAccountLedger(url, returned.accessToken, shared.replicaId);
      expect((await fetch(`${url}/api/v4/replication/grants/${grant.grantId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${sharedAgain.accessToken}` } })).status).toBe(200);
      expect((await fetch(`${url}/api/auth/me`, { headers: {
        Authorization: `Bearer ${selected.accessToken}` } })).status).toBe(401);
    } finally {
      await store?.close();
      await server.close();
    }
  }, 25_000);
});
