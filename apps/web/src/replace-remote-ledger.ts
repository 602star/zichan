import { createLedgerKeyEnvelope, encryptJson, sha256Json, wireSyncCommit, type Setting } from '@zichan/core';
import { requestJson, type SqlLedgerStore, type SyncReplicaIdentity } from '@zichan/db';
import { initializeEmptyLedger, QUICK_START_LEDGER_OPTIONS } from './db/ledger-initialization.js';
import { adoptUnlockedLedgerKeyEnvelope } from './ledger-key-vault.js';
import { authenticateSyncProfile } from './sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections, saveSyncConnections, type SyncConnection } from './sync-config.js';

/** Called only from first-use's explicit destructive confirmation, on an empty local store. */
export async function replaceRemoteLedger(store: SqlLedgerStore, connection: SyncConnection, passphrase: string): Promise<Setting> {
  if (!connection.ledgerId || !connection.streamEpoch) throw new Error('旧账本身份不完整，请重新登录');
  const baseUrl = buildSyncBaseUrl(connection);
  const token = await authenticateSyncProfile(connection);
  const health = await requestJson(`${baseUrl}/api/health`, { redirect: 'error', cache: 'no-store' });
  const info = await health.json() as { serverId?: string; capabilities?: string[] };
  if (!health.ok || info.serverId !== connection.serverId || !info.capabilities?.includes('ledger-replacement-v1')) throw new Error('服务器尚未支持替换账本，请先更新服务器');
  const ledgerId = await store.getLedgerId();
  if (ledgerId === connection.ledgerId) throw new Error('新旧账本不能使用同一标识，请先重置本机账本');
  const keys = await createLedgerKeyEnvelope(ledgerId, passphrase);
  let identity: SyncReplicaIdentity;
  const setting = await store.transaction(async (transaction) => {
    const initialized = await initializeEmptyLedger(transaction, QUICK_START_LEDGER_OPTIONS);
    const commits = [];
    for (const stored of await transaction.listSyncCommits()) {
      const commit = wireSyncCommit(stored);
      const contentHash = await sha256Json(commit);
      commits.push({ commitId: commit.commitId, ledgerId, contentHash, encCommit: await encryptJson(keys.session, commit, { protocol: 2, ledgerId, commitId: commit.commitId, contentHash }) });
    }
    const response = await requestJson(`${baseUrl}/api/v3/replica/replace`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedLedgerId: connection.ledgerId, expectedStreamEpoch: connection.streamEpoch, confirmation: '替换旧账本', envelope: keys.envelope, commits }),
    });
    const result = await response.json() as SyncReplicaIdentity & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `替换失败：HTTP ${response.status}`);
    if (result.serverId !== connection.serverId || result.ledgerId !== ledgerId || !result.replicaId || !result.streamEpoch) throw new Error('替换结果身份不完整，请重新登录检查服务器账本');
    identity = result;
    return initialized;
  });
  adoptUnlockedLedgerKeyEnvelope(keys.envelope, keys.session, true);
  saveSyncConnections(loadSyncConnections().map((row) => row.id === connection.id
    ? { ...row, ...identity!, lastSyncAt: undefined, lastError: undefined, status: 'online' as const }
    : { ...row, enabled: false }));
  return setting;
}
