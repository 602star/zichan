import { encryptJson, sha256Json, wireSyncCommit } from '@zichan/core';
import { loginAccount, type SqlLedgerStore, type SyncReplicaIdentity } from '@zichan/db';
import { accountProtection, protectionRequest } from './account-protection.js';
import { requireLedgerCryptoSession, storedLedgerKeyEnvelope } from './ledger-key-vault.js';
import { authenticateSyncProfile } from './sync-auth.js';
import { buildSyncBaseUrl, type SyncConnection } from './sync-config.js';

interface RemoteReplica extends SyncReplicaIdentity {
  bound: boolean;
  headSeq: number;
  serverManagedReplication?: boolean;
}

export interface BrowserReplicaInventory extends SyncReplicaIdentity {
  commitCount: number;
  commitHash: string;
  promisedBlobCount: number;
  promisedBlobHash: string;
  missingPromisedBlobCount: number;
  attachmentPromiseCurrent: number;
}

async function request<T>(profile: SyncConnection, path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = await authenticateSyncProfile(profile);
  const response = await fetch(`${buildSyncBaseUrl(profile)}${path}`, {
    method, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

export function readBrowserReplicaInventory(profile: SyncConnection): Promise<BrowserReplicaInventory> {
  return request<BrowserReplicaInventory>(profile, '/api/v4/ledger/browser-inventory');
}

/** Initialize one empty, independent account replica; the browser remains its only courier. */
export async function attachBrowserReplica(store: SqlLedgerStore, profile: SyncConnection,
  accountPassword: string): Promise<SyncReplicaIdentity> {
  if (accountPassword.length < 8) throw new Error('请输入这台服务器账号的密码');
  const checked = await loginAccount(buildSyncBaseUrl(profile), profile.username, accountPassword, {
    sessionTransport: 'token', expectedServerId: profile.serverId,
    expectedServerPublicKey: profile.serverPublicKey,
  });
  if (checked.accountId !== profile.accountId) throw new Error('目标服务器的账号与当前连接不一致');
  void fetch(`${buildSyncBaseUrl(profile)}/api/auth/logout`, {
    method: 'POST', credentials: 'omit', headers: { Authorization: `Bearer ${checked.accessToken}` },
  }).catch(() => undefined);
  const envelope = storedLedgerKeyEnvelope();
  if (!envelope) throw new Error('请先解锁当前账本');
  const session = requireLedgerCryptoSession(envelope.ledgerId);
  const source = accountProtection();
  if (!source || source.info.mode !== 'managed') throw new Error('仅个人账本可连接独立服务器');
  const group = await request<{ joined: boolean }>(profile, '/api/v4/group/status');
  if (group.joined) throw new Error('这台服务器已加入管理员同步组，请直接在该组内登录账本');
  const protection = await protectionRequest(profile);
  const remote = await request<RemoteReplica>(profile, '/api/v3/replica');
  if (remote.serverId !== profile.serverId) throw new Error('目标服务器身份已变化，请重新登录');
  if (remote.serverManagedReplication) throw new Error('目标账本已有服务器复制链路，不能改为浏览器同步');
  if (!remote.bound) {
    const initialized = await protectionRequest(profile, 'POST', { mode: 'managed', envelope,
      secret: source.secret }, '/initialize');
    if (initialized.replica?.ledgerId !== envelope.ledgerId) throw new Error('目标服务器未能建立当前账本');
  } else if (!remote.replicaId || !remote.streamEpoch) {
    throw new Error('目标服务器账本身份不完整，请重新登录');
  } else if (remote.ledgerId !== envelope.ledgerId) {
    if (remote.headSeq !== 0) throw new Error('目标服务器已有记账数据，请使用一个尚未记账的新账号');
    const usage = await request<{ objectCount: number; stagingCount?: number }>(profile, '/api/v3/blobs/usage');
    if (usage.objectCount || usage.stagingCount) throw new Error('目标服务器已有附件，不能覆盖');
    const first = (await store.listSyncCommits())[0];
    if (!first) throw new Error('当前账本还没有可同步的记录，请先完成首次记账');
    const commit = wireSyncCommit(first);
    const contentHash = await sha256Json(commit);
    const initial = { commitId: commit.commitId, ledgerId: envelope.ledgerId, contentHash,
      encCommit: await encryptJson(session, commit, { protocol: 2, ledgerId: envelope.ledgerId,
        commitId: commit.commitId, contentHash }) };
    const result = await request<SyncReplicaIdentity>(profile, '/api/v3/replica/replace', 'POST', {
      expectedLedgerId: remote.ledgerId, expectedStreamEpoch: remote.streamEpoch,
      confirmation: '替换旧账本', envelope, commits: [initial], secret: source.secret,
    });
    if (result.serverId !== profile.serverId || result.ledgerId !== envelope.ledgerId
      || !result.replicaId || !result.streamEpoch) throw new Error('目标服务器返回的账本身份不一致，请重新登录检查');
  } else if (protection.envelope?.keyringId !== envelope.keyringId
    || protection.envelope.generation !== envelope.generation) {
    throw new Error('目标服务器虽有同名账本，但加密密钥不同，已拒绝连接');
  }
  const current = await protectionRequest(profile);
  if (current.mode !== 'managed') {
    await protectionRequest(profile, 'PUT', { mode: 'managed', version: current.version, envelope,
      secret: source.secret, confirmation: '允许此服务器解密账本' });
  }
  const bound = await request<RemoteReplica>(profile, '/api/v3/replica');
  if (!bound.bound || bound.ledgerId !== envelope.ledgerId || !bound.replicaId || !bound.streamEpoch) {
    throw new Error('目标服务器未完成账本绑定，请刷新后重试');
  }
  return bound;
}
