import type { NodeIdentity } from './node-identity.js';
import { signedCall } from './node-replication.js';
import { parseFederatedCredential, signFederatedCredential, verifyFederatedCredential,
  type FederatedCredentialBundle } from './federated-credential.js';
import { ServerStoreError, type JsonRecord, type ServerSyncGroupMember,
  type SyncServerStore } from './store.js';

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A member always connects out to the main node; the main never needs an inbound LAN route. */
export function createGroupReconciler(store: SyncServerStore, identity: () => NodeIdentity,
  opaqueSetup: () => string,
  readProtection: (username: string, accountId: string) => Promise<{
    mode: 'managed'; secret: string;
  } | null>) {
  let flight: Promise<void> | undefined;
  const run = (): Promise<void> => {
    if (flight) return flight;
    flight = (async () => {
      const group = await store.serverSyncGroup();
      if (!group || group.role !== 'member') return;
      const node = identity();
      const peer = { peerUrl: group.mainUrl, peerPublicKey: group.mainPublicKey,
        grantId: group.groupId };

      // Export accounts independently of ledgers so a new user can log in before
      // creating a personal ledger and old local users are included on first join.
      let accountAfter = '';
      for (;;) {
        const rows = await store.groupAccountRows(accountAfter, 50);
        for (const row of rows) {
          if (row.issuerNodeId !== node.nodeId) continue;
          const accountKey = await store.accountEncryptionKey(node.nodeId, row.subjectAccountId);
          const bundle: FederatedCredentialBundle = {
            v: 1, ledgerId: group.groupId, issuerNodeId: node.nodeId,
            subjectAccountId: row.subjectAccountId, username: row.user.username,
            displayName: row.user.displayName,
            registrationRecord: row.user.opaqueRegistrationRecord,
            serverSetup: await store.opaqueSetupForUser(row.user.username) ?? opaqueSetup(),
            disabled: row.user.disabled,
            revision: row.user.revision * 1_000_000 + (accountKey?.revision ?? 0),
            accountKey: accountKey ?? null,
          };
          if (await store.groupAccountExportRevision(row.subjectAccountId) >= bundle.revision) continue;
          const result = await signedCall(node, peer, 'POST', '/api/v4/group/account',
            JSON.stringify({ bundle, issuerSignature: signFederatedCredential(node, bundle),
              preExistingAt: row.user.createdAt }));
          if (result.groupId !== group.groupId || result.issuerNodeId !== node.nodeId
            || result.subjectAccountId !== row.subjectAccountId) {
            throw new Error('主节点账号目录接收结果无效');
          }
          await store.markGroupAccountExported(row.subjectAccountId, bundle.revision);
        }
        if (rows.length < 50) break;
        accountAfter = rows.at(-1)!.key;
      }

      accountAfter = '';
      for (;;) {
        const answer = await signedCall(node, peer, 'GET',
          `/api/v4/group/accounts?after=${encodeURIComponent(accountAfter)}&limit=50`);
        if (answer.groupId !== group.groupId || answer.serverId !== group.mainNodeId
          || !Array.isArray(answer.members) || !Array.isArray(answer.accounts)
          || typeof answer.next !== 'string' || typeof answer.hasMore !== 'boolean'
          || !record(answer.registrationPolicy)) throw new Error('主节点账号目录无效');
        await store.applyServerSyncGroupMembers(answer.members as ServerSyncGroupMember[]);
        const mode = answer.registrationPolicy.mode;
        const revision = answer.registrationPolicy.revision;
        if (mode !== 'open' && mode !== 'invite' && mode !== 'closed'
          || !Number.isSafeInteger(revision)) throw new Error('主节点注册策略无效');
        await store.applyJoinedRegistrationPolicy(group.mainNodeId, mode, Number(revision));
        const members = await store.serverSyncGroupMembers();
        for (const item of answer.accounts) {
          if (!record(item) || typeof item.issuerSignature !== 'string') throw new Error('账号目录记录无效');
          const bundle = parseFederatedCredential(item.bundle);
          const issuer = members.find((member) => member.nodeId === bundle.issuerNodeId);
          if (bundle.ledgerId !== group.groupId || !issuer
            || !verifyFederatedCredential(bundle, item.issuerSignature, issuer.publicKey)) {
            throw new Error('账号目录签名或组身份无效');
          }
          if (issuer.nodeId === node.nodeId) {
            const local = await store.getUser(bundle.username);
            if (local?.accountId !== bundle.subjectAccountId) throw new Error('本站账号与主节点目录冲突');
            continue;
          }
          const localUsername = await store.provisionFederatedDirectoryAccount(group.groupId,
            bundle.issuerNodeId, bundle.subjectAccountId);
          if (bundle.accountKey) await store.importAccountEncryptionKey(bundle.accountKey);
          await store.importFederatedPasswordCredential({ localUsername,
            sourceUsername: bundle.username, displayName: bundle.displayName,
            issuerNodeId: bundle.issuerNodeId, subjectAccountId: bundle.subjectAccountId,
            registrationRecord: bundle.registrationRecord, serverSetup: bundle.serverSetup,
            disabled: bundle.disabled, sourceRevision: bundle.revision });
        }
        if (!answer.hasMore) break;
        if (!answer.accounts.length || answer.next <= accountAfter) throw new Error('账号目录游标无效');
        accountAfter = answer.next;
      }

      // Announce every native personal ledger, including ones created before joining.
      for (const slot of await store.listReplicaSlots()) {
        if (await store.federatedAccount(slot.username)) continue;
        const [user, replica] = await Promise.all([
          store.getUser(slot.username), store.getReplicaForLedger(slot.username, slot.ledgerId),
        ]);
        if (!user || !replica) continue;
        const envelope = await store.getKeyEnvelope(slot.username, slot.ledgerId, 'node', replica.replicaId);
        if (!envelope) continue;
        const sourceGrant = await store.ensureNativeGroupSourceGrant(slot.username, replica.replicaId,
          group.mainNodeId, group.mainPublicKey);
        const accountKey = await store.accountEncryptionKey(node.nodeId, user.accountId);
        const protection = await readProtection(slot.username, user.accountId);
        if (!protection) continue;
        const bundle: FederatedCredentialBundle = {
          v: 1, ledgerId: slot.ledgerId, issuerNodeId: node.nodeId,
          subjectAccountId: user.accountId, username: user.username,
          displayName: user.displayName,
          registrationRecord: user.opaqueRegistrationRecord,
          serverSetup: await store.opaqueSetupForUser(user.username) ?? opaqueSetup(),
          disabled: user.disabled, revision: user.revision * 1_000_000 + (accountKey?.revision ?? 0),
          accountKey: accountKey ?? null,
        };
        const answer = await signedCall(node, peer, 'POST', '/api/v4/group/announce',
          JSON.stringify({ ledgerId: slot.ledgerId, replicaId: replica.replicaId,
            streamEpoch: replica.streamEpoch, grantId: sourceGrant.grantId,
            envelope, protection, bundle, issuerSignature: signFederatedCredential(node, bundle) }));
        if (answer.groupId !== group.groupId || answer.serverId !== group.mainNodeId
          || answer.ledgerId !== slot.ledgerId || typeof answer.replicaId !== 'string'
          || typeof answer.streamEpoch !== 'string' || typeof answer.grantId !== 'string') {
          throw new Error('主节点账本登记响应身份不匹配');
        }
        await store.createNativeGroupSourceLink(slot.username, slot.ledgerId,
          { peerUrl: group.mainUrl, peerNodeId: group.mainNodeId,
            peerPublicKey: group.mainPublicKey, peerReplicaId: answer.replicaId,
            peerStreamEpoch: answer.streamEpoch, grantId: answer.grantId });
      }

      // The signed catalog is the sole authority for group members and ledger grants.
      let after = '';
      for (;;) {
        const answer = await signedCall(node, peer, 'GET',
          `/api/v4/group/catalog?after=${encodeURIComponent(after)}&limit=50`);
        if (answer.groupId !== group.groupId || answer.serverId !== group.mainNodeId
          || !Array.isArray(answer.members) || !Array.isArray(answer.ledgers)
          || typeof answer.next !== 'string' || typeof answer.hasMore !== 'boolean'
          || !record(answer.registrationPolicy)) throw new Error('主节点同步组目录无效');
        await store.applyServerSyncGroupMembers(answer.members as ServerSyncGroupMember[]);
        const mode = answer.registrationPolicy.mode;
        const revision = answer.registrationPolicy.revision;
        if (mode !== 'open' && mode !== 'invite' && mode !== 'closed'
          || !Number.isSafeInteger(revision)) throw new Error('主节点注册策略无效');
        await store.applyJoinedRegistrationPolicy(group.mainNodeId, mode, Number(revision));
        for (const item of answer.ledgers) {
          if (!record(item) || typeof item.ledgerId !== 'string'
            || typeof item.issuerNodeId !== 'string' || typeof item.subjectAccountId !== 'string'
            || typeof item.replicaId !== 'string' || typeof item.streamEpoch !== 'string'
            || typeof item.grantId !== 'string' || !record(item.envelope)
            || item.envelope.ledgerId !== item.ledgerId) throw new Error('主节点账本目录项无效');
          const existing = (await store.listReplicaSlots()).find((slot) => slot.ledgerId === item.ledgerId);
          if (existing) {
            const local = await store.getReplicaForLedger(existing.username, item.ledgerId);
            if (!local) throw new Error('本地账本目录状态不一致');
            const binding = await store.federatedAccount(existing.username);
            const original = binding?.issuerNodeId === item.issuerNodeId
              && binding.subjectAccountId === item.subjectAccountId
              || item.issuerNodeId === node.nodeId
              && (await store.getUser(existing.username))?.accountId === item.subjectAccountId;
            if (!original) throw new ServerStoreError('GROUP_LEDGER_COLLISION', 409,
              `账本 ${item.ledgerId} 与主节点目录中的身份冲突`);
            const link = (await store.listNodeReplicationLinks(existing.username)).find((entry) =>
              entry.ledgerId === item.ledgerId && entry.peerNodeId === group.mainNodeId);
            if (link && (link.peerReplicaId !== item.replicaId
              || link.peerStreamEpoch !== item.streamEpoch || link.peerPublicKey !== group.mainPublicKey)) {
              throw new ServerStoreError('PEER_CHANGED', 409, '主节点账本副本身份已改变');
            }
            if (link && link.grantId !== item.grantId) await store.renewNodeReplicationLink(
              existing.username, link.linkId, item.grantId, group.mainNodeId,
              group.mainPublicKey, item.replicaId, item.streamEpoch);
            continue;
          }
          if (item.issuerNodeId === node.nodeId) throw new ServerStoreError('GROUP_SOURCE_MISSING', 409,
            '主节点保留了本站已丢失的原始账本，请先人工恢复本站副本');
          await store.provisionFederatedReplica({ issuerNodeId: item.issuerNodeId,
            subjectAccountId: item.subjectAccountId, ledgerId: item.ledgerId,
            envelope: item.envelope, peerUrl: group.mainUrl,
            peerNodeId: group.mainNodeId, peerPublicKey: group.mainPublicKey,
            peerReplicaId: item.replicaId, peerStreamEpoch: item.streamEpoch,
            grantId: item.grantId });
        }
        if (!answer.hasMore) return;
        if (!answer.ledgers.length || answer.next <= after) throw new Error('主节点账本目录游标无效');
        after = answer.next;
      }
    })().then(async () => {
      if ((await store.serverSyncGroup())?.role === 'member') {
        await store.recordServerSyncGroupProgress();
      }
    }, async (error: unknown) => {
      await store.recordServerSyncGroupProgress(error);
      throw error;
    }).finally(() => { flight = undefined; });
    return flight;
  };
  return { run };
}
