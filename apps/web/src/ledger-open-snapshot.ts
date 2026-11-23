import { decryptBackupBytes, sha256Bytes, type LedgerCryptoSession } from '@zichan/core';
import { assertCurrentSchema, CURRENT_SCHEMA_VERSION, HttpRequestError, ledgerOpenContext, MAX_LEDGER_OPEN_BYTES, requestJson,
  type LedgerOpenSnapshot } from '@zichan/db';
import { SqlJsDriver } from './db/sqljs-driver.js';
import { authenticateSyncProfile } from './sync-auth.js';
import { buildSyncBaseUrl, type SyncConnection } from './sync-config.js';
import { measureStartupStage, recordStartupCount } from './startup-timing.js';

export async function decodeLedgerOpenSnapshot(snapshot: LedgerOpenSnapshot, profile: SyncConnection,
  crypto: LedgerCryptoSession): Promise<Uint8Array> {
  const m = snapshot.manifest;
  if (!m || m.version !== 1 || m.schemaVersion !== CURRENT_SCHEMA_VERSION || m.serverId !== profile.serverId
    || m.accountId !== profile.accountId || m.ledgerId !== profile.ledgerId || m.replicaId !== profile.replicaId
    || m.streamEpoch !== profile.streamEpoch || m.keyringId !== crypto.keyringId || m.generation !== crypto.generation
    || !Number.isSafeInteger(m.headSeq) || m.headSeq < 1 || !Number.isSafeInteger(m.plainBytes)
    || m.plainBytes < 1 || m.plainBytes > MAX_LEDGER_OPEN_BYTES || !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error('打开快照身份或版本不匹配，请重新登录');
  const compressed = await decryptBackupBytes(crypto, snapshot.payload, ledgerOpenContext(m));
  const stream = new Blob([new Uint8Array(compressed)]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > m.plainBytes) throw new Error('打开快照解压大小异常');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  if (length !== m.plainBytes || await sha256Bytes(bytes) !== m.sha256) throw new Error('打开快照完整性验证失败');
  const check = await SqlJsDriver.open(bytes);
  try {
    await assertCurrentSchema(check);
    const meta = await check.get<{ ledger_id: string }>("SELECT ledger_id FROM ledger_meta WHERE id = 'current'");
    const cursor = await check.get<{ cursor: number }>('SELECT cursor FROM sync_replica_state WHERE server_id = ? AND replica_id = ? AND stream_epoch = ?',
      [m.serverId, m.replicaId, m.streamEpoch]);
    const settings = await check.get<{ n: number }>('SELECT COUNT(*) AS n FROM settings WHERE is_deleted = 0');
    if (meta?.ledger_id !== m.ledgerId || Number(cursor?.cursor) !== m.headSeq || Number(settings?.n) !== 1) throw new Error('打开快照缺少有效账本或同步基线');
  } finally { await check.close(); }
  return bytes;
}

export async function fetchLedgerOpenSnapshot(profile: SyncConnection, crypto: LedgerCryptoSession,
  onStage: (stage: string) => void): Promise<Uint8Array> {
  const token = await authenticateSyncProfile(profile);
  const deadline = Date.now() + 120_000;
  return measureStartupStage('remote.snapshotDownload', async () => {
    while (Date.now() < deadline) {
      const response = await requestJson(`${buildSyncBaseUrl(profile)}/api/v4/ledger-open-snapshot`, {
        cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${token}` },
      }, { timeoutMs: 30_000 });
      if (response.status === 202) {
        onStage('服务器正在准备加密账本快照，完成后即可记账…');
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new HttpRequestError('http', body.error ?? `读取打开快照失败：HTTP ${response.status}`, response.status);
      }
      const snapshot = await response.json() as LedgerOpenSnapshot;
      onStage('正在校验并打开加密账本快照…');
      recordStartupCount('remote.snapshotBytes', snapshot.manifest?.plainBytes ?? 0);
      return measureStartupStage('remote.snapshotDecode', () => decodeLedgerOpenSnapshot(snapshot, profile, crypto));
    }
    throw new Error('服务器尚未准备好账本快照，请稍后重试或让管理员检查快照任务');
  });
}
