import { unlockLedgerKeyEnvelope, type LedgerCryptoSession, type LedgerKeyEnvelope } from '@zichan/core';
import {
  assertSecureSyncUrl,
  checkConsistency,
  createLedgerStore,
  exportLedger,
  fetchLedgerKeyEnvelope,
  httpCommitTransport,
  importLedger,
  preflightImport,
  syncReplicas,
  type CommitTransport,
  type DeviceRecoveryState,
  type LedgerBackup,
  type SyncReplicaIdentity,
  type SqlLedgerStore,
} from '@zichan/db';
import { SqlJsDriver } from './db/sqljs-driver.js';
import { clientIdentity } from './client-identity.js';

export interface PreparedRemoteLedgerJoin {
  ledgerId: string;
  keyEnvelope: LedgerKeyEnvelope;
  cryptoSession: LedgerCryptoSession;
  ledger: LedgerBackup;
  deviceState: DeviceRecoveryState;
  identity: SyncReplicaIdentity;
  pulled: number;
}

export interface PrepareRemoteLedgerJoinInput {
  baseUrl: string;
  token: string;
  ledgerId: string;
  passphrase: string;
  endpointLabel?: string;
  expectedServerId?: string;
  onProgress?: (received: number, total: number) => void;
}

function validLedgerId(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

async function requireBoundRemoteReplica(
  baseUrl: string,
  token: string,
  expectedLedgerId: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v3/replica`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`远端副本预检失败：HTTP ${response.status}`);
  const replica = await response.json() as { bound?: unknown; ledgerId?: unknown };
  if (replica.bound !== true || typeof replica.ledgerId !== 'string') {
    throw new Error('同步账号尚未绑定远端账本，不能执行加入');
  }
  if (replica.ledgerId !== expectedLedgerId) {
    throw new Error(`远端副本账本已变化：预期 ${expectedLedgerId}，实际 ${replica.ledgerId}`);
  }
}

/**
 * Materialize the complete remote ledger in an isolated sql.js database.
 * No caller database or key vault is touched until this function succeeds.
 */
export async function stageRemoteLedgerJoin(
  ledgerId: string,
  transport: CommitTransport,
  keyEnvelope: LedgerKeyEnvelope,
  cryptoSession: LedgerCryptoSession,
  endpointLabel = 'remote-preflight',
  onProgress?: (received: number, total: number) => void,
): Promise<PreparedRemoteLedgerJoin> {
  if (!validLedgerId(ledgerId)) throw new Error('远端账本 ID 无效');
  if (keyEnvelope.ledgerId !== ledgerId || cryptoSession.ledgerId !== ledgerId
    || keyEnvelope.keyringId !== cryptoSession.keyringId
    || keyEnvelope.generation !== cryptoSession.generation) {
    throw new Error('远端账本、密钥封套与已解锁会话不一致');
  }

  const temp = await createLedgerStore(await SqlJsDriver.open(null), {
    deviceId: 'remote-ledger-join-preflight',
  });
  try {
    await temp.resetToLedger(ledgerId);
    const observedTransport: CommitTransport = onProgress ? {
      connect: (value) => transport.connect(value),
      pullCommits: async (identity, afterSeq, limit) => {
        const page = await transport.pullCommits(identity, afterSeq, limit);
        onProgress(page.nextSeq, page.headSeq);
        return page;
      },
      pushCommits: (identity, commits, capabilities) => transport.pushCommits(identity, commits, capabilities),
    } : transport;
    const result = await syncReplicas(temp, [{
      id: 'remote-join',
      endpoint: endpointLabel,
      transport: observedTransport,
    }], { maxRounds: 10 });
    const endpoint = result.endpoints[0];
    if (!endpoint) throw new Error('远端同步预检没有返回副本结果');
    if (endpoint.error) throw new Error(`远端提交预检失败：${endpoint.error}`);
    if (!endpoint.identity || endpoint.identity.ledgerId !== ledgerId) {
      throw new Error('远端同步副本身份不完整或账本不一致');
    }
    if (!result.converged) throw new Error('远端提交在预检数据库中未能完全收敛');
    const invalidCommits = await temp.listSyncCommits({ state: 'invalid', includeInvalid: true });
    if (result.invalid > 0 || invalidCommits.length > 0) {
      throw new Error(`远端提交验证失败：${invalidCommits.slice(0, 5)
        .map((commit) => `${commit.commitId.slice(0, 8)} ${commit.error ?? '无效提交'}`)
        .join('；') || `${result.invalid} 条提交无效`}`);
    }

    const issues = await checkConsistency(temp);
    if (issues.length) {
      throw new Error(`远端账本一致性检查失败：${issues.slice(0, 5).map((issue) => issue.detail).join('；')}`);
    }
    const ledger = await exportLedger(temp);
    const preflight = preflightImport(ledger);
    if (!preflight.ok) {
      throw new Error(`远端账本导入预检失败：${preflight.issues
        .filter((issue) => issue.level === 'error')
        .slice(0, 5)
        .map((issue) => issue.message)
        .join('；')}`);
    }
    const activeSettings = ledger.settings.filter((setting) => (
      !!setting
      && typeof setting === 'object'
      && !Array.isArray(setting)
      && (setting as Record<string, unknown>)['isDeleted'] !== true
    ));
    if (activeSettings.length !== 1) throw new Error('远端账本必须包含且只能包含一个活动设置');

    return {
      ledgerId,
      keyEnvelope,
      cryptoSession,
      ledger,
      deviceState: await temp.exportDeviceRecoveryState(),
      identity: endpoint.identity,
      pulled: result.pulled,
    };
  } finally {
    await temp.close();
  }
}

/** Authenticate, unlock and fully validate a bound server without mutating local data. */
export async function prepareRemoteLedgerJoin(
  input: PrepareRemoteLedgerJoinInput,
): Promise<PreparedRemoteLedgerJoin> {
  if (!validLedgerId(input.ledgerId)) throw new Error('远端账本 ID 无效');
  assertSecureSyncUrl(input.baseUrl);
  await requireBoundRemoteReplica(input.baseUrl, input.token, input.ledgerId);
  const envelope = await fetchLedgerKeyEnvelope(input.baseUrl, input.token);
  if (!envelope) throw new Error('远端账本没有密钥封套，不能安全加入');
  if (envelope.ledgerId !== input.ledgerId) throw new Error('远端密钥封套不属于目标账本');
  let cryptoSession: LedgerCryptoSession;
  try {
    cryptoSession = await unlockLedgerKeyEnvelope(input.passphrase, envelope);
  } catch {
    throw new Error('远端账本加密密码错误，或密钥封套已经损坏');
  }
  const transport = httpCommitTransport({
    baseUrl: input.baseUrl,
    token: input.token,
    cryptoSession,
    keyEnvelope: envelope,
    requireExistingReplica: true,
    clientIdentity: clientIdentity(),
  });
  const prepared = await stageRemoteLedgerJoin(
    input.ledgerId,
    transport,
    envelope,
    cryptoSession,
    input.endpointLabel ?? input.baseUrl,
    input.onProgress,
  );
  if (input.expectedServerId && prepared.identity.serverId !== input.expectedServerId) {
    throw new Error('远端同步服务器身份在恢复预检期间发生变化');
  }
  return prepared;
}

/** Restore a member's first device from the already unlocked per-member keyring. */
export async function prepareMemberRemoteLedgerJoin(input: Omit<PrepareRemoteLedgerJoinInput, 'passphrase'> & {
  keyEnvelope: LedgerKeyEnvelope;
  cryptoSession: LedgerCryptoSession;
}, memberKeyEnvelope = true): Promise<PreparedRemoteLedgerJoin> {
  if (!validLedgerId(input.ledgerId)) throw new Error('远端账本 ID 无效');
  assertSecureSyncUrl(input.baseUrl);
  await requireBoundRemoteReplica(input.baseUrl, input.token, input.ledgerId);
  const transportEnvelope = memberKeyEnvelope ? input.keyEnvelope
    : await fetchLedgerKeyEnvelope(input.baseUrl, input.token);
  if (!transportEnvelope || transportEnvelope.ledgerId !== input.ledgerId
    || transportEnvelope.keyringId !== input.keyEnvelope.keyringId
    || transportEnvelope.generation !== input.keyEnvelope.generation) {
    throw new Error('远端账本当前密钥版本与已解锁密钥包不一致');
  }
  const transport = httpCommitTransport({
    baseUrl: input.baseUrl,
    token: input.token,
    cryptoSession: input.cryptoSession,
    keyEnvelope: transportEnvelope,
    memberKeyEnvelope,
    requireExistingReplica: true,
    clientIdentity: clientIdentity(),
  });
  const prepared = await stageRemoteLedgerJoin(input.ledgerId, transport, transportEnvelope,
    input.cryptoSession, input.endpointLabel ?? input.baseUrl, input.onProgress);
  if (input.expectedServerId && prepared.identity.serverId !== input.expectedServerId) {
    throw new Error('远端同步服务器身份在恢复预检期间发生变化');
  }
  return { ...prepared, keyEnvelope: input.keyEnvelope };
}

async function replaceDatabaseState(
  store: SqlLedgerStore,
  ledgerId: string,
  ledger: LedgerBackup,
  deviceState: DeviceRecoveryState,
): Promise<void> {
  await store.transaction(async (transaction) => {
    await transaction.resetToLedger(ledgerId);
    await importLedger(transaction, ledger, {
      afterImport: async (importStore) => importStore.restoreDeviceRecoveryState(deviceState),
    });
  });
}

export interface CommitRemoteLedgerJoinHooks {
  /** Must durably save a recoverable local archive before replacement begins. */
  createProtectionBackup: () => Promise<void>;
  adoptRemoteKey: (prepared: PreparedRemoteLedgerJoin) => void | Promise<void>;
  restoreLocalKey: () => void | Promise<void>;
  /** Persist the server/replica identity that must match the replacement ledger. */
  commitClientState?: (prepared: PreparedRemoteLedgerJoin) => void | Promise<void>;
  restoreClientState?: () => void | Promise<void>;
  reconcileAttachments: () => Promise<void>;
}

/**
 * Atomically replace the database only after remote validation and a durable
 * protection backup. Any failure after the database commit restores both the
 * previous database/device state and key session before it is rethrown.
 */
export async function commitRemoteLedgerJoin(
  store: SqlLedgerStore,
  prepared: PreparedRemoteLedgerJoin,
  hooks: CommitRemoteLedgerJoinHooks,
): Promise<void> {
  const localLedgerId = await store.getLedgerId();
  const localLedger = await exportLedger(store);
  const localDeviceState = await store.exportDeviceRecoveryState();
  await hooks.createProtectionBackup();

  await replaceDatabaseState(
    store,
    prepared.ledgerId,
    prepared.ledger,
    prepared.deviceState,
  );
  try {
    await hooks.adoptRemoteKey(prepared);
    await hooks.reconcileAttachments();
    await hooks.commitClientState?.(prepared);
  } catch (error) {
    try {
      await replaceDatabaseState(store, localLedgerId, localLedger, localDeviceState);
    } catch (databaseRollbackError) {
      throw new Error(
        `加入远端账本失败，且本机数据库回滚失败：${error instanceof Error ? error.message : String(error)}；回滚：${databaseRollbackError instanceof Error ? databaseRollbackError.message : String(databaseRollbackError)}`,
      );
    }
    const rollbackErrors: string[] = [];
    for (const [label, action] of [
      ['恢复本机账本密钥', hooks.restoreLocalKey],
      ['恢复本机同步配置', hooks.restoreClientState],
      ['整理本机附件', hooks.reconcileAttachments],
    ] as const) {
      if (!action) continue;
      try {
        await action();
      } catch (rollbackError) {
        rollbackErrors.push(`${label}：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(
        `加入远端账本失败，本机数据库已恢复，但后续回滚不完整：${error instanceof Error ? error.message : String(error)}；${rollbackErrors.join('；')}`,
      );
    }
    throw error;
  }
}
