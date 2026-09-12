import { rotateLedgerProtection, changeLedgerPassphrase, type LedgerKeyEnvelope } from '@zichan/core';
import { type SqlLedgerStore } from '@zichan/db';
import { accountProtection, protectionRequest, replaceProtectionRuntime, type ProtectionInfo } from './account-protection.js';
import { adoptUnlockedLedgerKeyEnvelope, requireLedgerCryptoSession } from './ledger-key-vault.js';
import { loadSyncConnections } from './sync-config.js';
import { stageDeviceStorageRewrap, commitDeviceStorageRewrap } from './device-storage-key.js';
import { forgetOfflineAccess } from './offline-access.js';
import { saveLedgerBackup } from './db/backups.js';
import { syncConfiguredServers } from './sync-orchestrator.js';
import { withSyncLock } from './sync-lock.js';

let changing = false;
export function protectionChangeInProgress(): boolean { return changing; }
function sameEnvelope(left: LedgerKeyEnvelope | null, right: LedgerKeyEnvelope): boolean { return left?.ct === right.ct && left.iv === right.iv; }

export async function changeAccountProtection(store: SqlLedgerStore, mode: 'managed' | 'private', secret: string): Promise<void> {
  if (changing) throw new Error('保护设置正在更新');
  const current = accountProtection();
  const profile = loadSyncConnections().find((row) => row.id === current?.profileId);
  if (!current || !profile) throw new Error('请在线登录主账号');
  changing = true;
  try {
    const synced = await syncConfiguredServers(store, [profile]);
    if (synced.endpoints.some((row) => row.error)) throw new Error('请先完成主服务器同步，再更改保护方式');
    await withSyncLock(async () => {
      const remote = await protectionRequest(profile);
      if (remote.envelope?.generation !== requireLedgerCryptoSession().generation) throw new Error('密钥版本已变化，请重新登录');
      await saveLedgerBackup(store, 'manual', '更改账本保护前');
      const changed = mode === 'private'
        ? await rotateLedgerProtection(requireLedgerCryptoSession(), secret)
        : await changeLedgerPassphrase(requireLedgerCryptoSession(), secret);
      // A failed or uncertain HTTP response can always be recovered with either
      // the old device wrapper or the staged new one. Neither exposes the key.
      await stageDeviceStorageRewrap(secret);
      let next: ProtectionInfo;
      try {
        next = await protectionRequest(profile, 'PUT', {
          mode, version: remote.version, envelope: changed.envelope,
          ...(mode === 'managed' ? { secret, confirmation: '允许此服务器解密账本' } : {}),
        });
      } catch (error) {
        const observed = await protectionRequest(profile).catch(() => undefined);
        if (!observed || observed.mode !== mode || !sameEnvelope(observed.envelope, changed.envelope)) throw error;
        next = observed;
      }
      adoptUnlockedLedgerKeyEnvelope(changed.envelope, changed.session, true);
      replaceProtectionRuntime(secret, next);
      commitDeviceStorageRewrap();
      await forgetOfflineAccess();
    });
  } finally { changing = false; }
}
