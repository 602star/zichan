import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loginAccount, registerAccount } from '@zichan/db';
import { createLedgerKeyEnvelope, encryptJson, newId, sha256Json, unlockLedgerKeyEnvelope,
  wrapLedgerCryptoSession } from '@zichan/core';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';
import { SyncServerStore } from '../src/store.js';

describe('server synchronization group', () => {
  it('announces a LAN ledger and backfills both ledgers to a later joining node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-server-group-'));
    const main = createTestSyncServer({ dataDir: join(root, 'main') });
    const branch = createTestSyncServer({ dataDir: join(root, 'branch') });
    const later = createTestSyncServer({ dataDir: join(root, 'later') });
    const stores: SyncServerStore[] = [];
    try {
      await Promise.all([main.ready, branch.ready, later.ready]);
      await Promise.all([main, branch, later].map((node) => new Promise<void>((resolve) =>
        node.server.listen(0, '127.0.0.1', resolve))));
      const url = (node: typeof main) => `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
      await registerAccount(url(main), 'main-owner', 'main-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url(branch), 'branch-owner', 'branch-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url(later), 'later-owner', 'later-password', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url(branch), 'private-user', 'private-password');
      for (const node of [main, branch]) {
        const session = await loginAccount(url(node), node === main ? 'main-owner' : 'branch-owner',
          node === main ? 'main-password' : 'branch-password');
        const response = await fetch(`${url(node)}/api/v3/protection/initialize`, {
          method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}`,
            'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'managed' }),
        });
        expect(response.status).toBe(200);
      }
      const privateSession = await loginAccount(url(branch), 'private-user', 'private-password');
      const recovery = 'private-recovery-code';
      const privateKey = await createLedgerKeyEnvelope(newId(), recovery);
      const privateAuth = { Authorization: `Bearer ${privateSession.accessToken}`,
        'Content-Type': 'application/json' };
      expect((await fetch(`${url(branch)}/api/v3/protection/initialize`, {
        method: 'POST', headers: privateAuth,
        body: JSON.stringify({ mode: 'private', envelope: privateKey.envelope }),
      })).status).toBe(200);
      const unlockedPrivate = await unlockLedgerKeyEnvelope(recovery, privateKey.envelope);
      const passwordEnvelope = await wrapLedgerCryptoSession(unlockedPrivate, 'private-password');
      expect((await fetch(`${url(branch)}/api/v4/ledger/password-envelope`, {
        method: 'PUT', headers: privateAuth,
        body: JSON.stringify({ envelope: passwordEnvelope, expectedRevision: 0 }),
      })).status).toBe(200);
      const commitId = 'group-private-commit-0001';
      const commit = { protocol: 2, ledgerId: privateKey.envelope.ledgerId, commitId,
        originDeviceId: 'group-local-test', createdAt: new Date().toISOString(),
        parentCommitIds: [], revisions: [] };
      const contentHash = await sha256Json(commit);
      const encCommit = await encryptJson(unlockedPrivate, commit,
        { protocol: 2, ledgerId: commit.ledgerId, commitId, contentHash });
      expect((await fetch(`${url(branch)}/api/v3/commits`, {
        method: 'POST', headers: privateAuth,
        body: JSON.stringify({ commits: [{ commitId, ledgerId: commit.ledgerId,
          contentHash, encCommit }] }),
      })).status).toBe(200);
      for (const node of [main, branch, later]) {
        const store = new SyncServerStore(join(node.dataDir, 'server.sqlite'), 'open', node.serverId);
        await store.ready;
        stores.push(store);
      }
      const [mainStore, , laterStore] = stores as [SyncServerStore, SyncServerStore, SyncServerStore];
      const mainOwner = await loginAccount(url(main), 'main-owner', 'main-password');
      const mainAdmin = { Authorization: `Bearer ${mainOwner.accessToken}`, 'Content-Type': 'application/json' };
      const created = await fetch(`${url(main)}/api/admin/sync-group/create`, {
        method: 'POST', headers: mainAdmin, body: JSON.stringify({ mainUrl: url(main) }),
      });
      expect(created.status).toBe(201);
      const joinGroup = async (node: typeof main) => {
        const codeResponse = await fetch(`${url(main)}/api/admin/sync-group/join-token`, {
          method: 'POST', headers: mainAdmin, body: '{}',
        });
        expect(codeResponse.status).toBe(201);
        const code = await codeResponse.json() as { token: string };
        const owner = await loginAccount(url(node),
          node === branch ? 'branch-owner' : 'later-owner',
          node === branch ? 'branch-password' : 'later-password');
        const accepted = await fetch(`${url(node)}/api/admin/sync-group/join`, {
          method: 'POST', headers: { Authorization: `Bearer ${owner.accessToken}`,
            'Content-Type': 'application/json' },
          body: JSON.stringify({ mainUrl: url(main), localUrl: url(node), token: code.token }),
        });
        expect(accepted.status).toBe(201);
      };
      await joinGroup(branch);
      await branch.flushGroupReplication();
      await branch.flushNodeReplication();
      expect((await mainStore.listReplicaSlots()).map((slot) => slot.ledgerId)).toHaveLength(3);
      expect((await mainStore.getReplicaForLedger(
        (await mainStore.listReplicaSlots()).find((slot) => slot.ledgerId === commit.ledgerId)!.username,
        commit.ledgerId))?.headSeq).toBe(1);
      await mainStore.setRegistrationMode('invite');
      const invite = 'group-once-invite';
      await mainStore.createInvite(invite);
      await registerAccount(url(branch), 'group-user', 'group-password',
        { inviteCode: invite });
      const branchGroupLogin = await loginAccount(url(branch), 'group-user', 'group-password',
        { sessionContext: 'ledger' });
      const mainGroupLogin = await loginAccount(url(main), 'group-user', 'group-password',
        { sessionContext: 'ledger' });
      expect(mainGroupLogin.accountId).toBe(branchGroupLogin.accountId);
      expect((await (await fetch(`${url(main)}/api/v3/replica`, {
        headers: { Authorization: `Bearer ${mainGroupLogin.accessToken}` },
      })).json() as { bound: boolean }).bound).toBe(false);
      expect((await fetch(`${url(branch)}/api/v3/protection/initialize`, {
        method: 'POST', headers: { Authorization: `Bearer ${branchGroupLogin.accessToken}`,
          'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'managed' }),
      })).status).toBe(200);
      await branch.flushGroupReplication();
      await branch.flushNodeReplication();
      expect((await mainStore.listReplicaSlots()).map((slot) => slot.ledgerId)).toHaveLength(4);
      await expect(registerAccount(url(branch), 'another-user', 'another-password',
        { inviteCode: invite })).rejects.toThrow();
      await joinGroup(later);
      await later.flushGroupReplication();
      await later.flushNodeReplication();
      await later.flushNodeReplication();
      expect((await laterStore.listReplicaSlots()).map((slot) => slot.ledgerId)).toHaveLength(4);
      await expect(loginAccount(url(later), 'main-owner', 'main-password',
        { sessionContext: 'ledger' })).resolves.toMatchObject({ accountId: expect.any(String) });
      const branchOnLater = await loginAccount(url(later), 'branch-owner', 'branch-password',
        { sessionContext: 'ledger' });
      expect(branchOnLater.accountId).toEqual(expect.any(String));
      const protection = await (await fetch(`${url(later)}/api/v3/protection`,
        { headers: { Authorization: `Bearer ${branchOnLater.accessToken}` } })).json() as {
          mode: string; secret: string | null;
        };
      expect(protection.mode).toBe('managed');
      expect(protection.secret).toEqual(expect.any(String));
      const privateOnLater = await loginAccount(url(later), 'private-user', 'private-password',
        { sessionContext: 'ledger' });
      const privateHeaders = { Authorization: `Bearer ${privateOnLater.accessToken}` };
      const privateProtection = await (await fetch(`${url(later)}/api/v3/protection`,
        { headers: privateHeaders })).json() as { mode: string };
      expect(privateProtection.mode).toBe('private');
      const replicatedPassword = await (await fetch(`${url(later)}/api/v4/ledger/password-envelope`,
        { headers: privateHeaders })).json() as { record: { envelope: typeof passwordEnvelope } };
      expect(await unlockLedgerKeyEnvelope('private-password', replicatedPassword.record.envelope))
        .toMatchObject({ ledgerId: privateKey.envelope.ledgerId });
      const replicatedCommits = await (await fetch(`${url(later)}/api/v3/commits?after=0&limit=10`,
        { headers: privateHeaders })).json() as { commits: { commitId: string }[] };
      expect(replicatedCommits.commits.map((entry) => entry.commitId)).toContain(commitId);
      const groupOnLater = await loginAccount(url(later), 'group-user', 'group-password',
        { sessionContext: 'ledger' });
      expect(groupOnLater.accountId).toBe(branchGroupLogin.accountId);
      expect((await (await fetch(`${url(later)}/api/v3/replica`, {
        headers: { Authorization: `Bearer ${groupOnLater.accessToken}` },
      })).json() as { bound: boolean }).bound).toBe(true);
      await new Promise<void>((resolve, reject) => main.server.close((error) =>
        error ? reject(error) : resolve()));
      await expect(loginAccount(url(branch), 'main-owner', 'main-password',
        { sessionContext: 'ledger' })).resolves.toMatchObject({ accountId: expect.any(String) });
    } finally {
      await Promise.all(stores.map((store) => store.close()));
      await Promise.all([main.close(), branch.close(), later.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
