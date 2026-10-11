import { describe, expect, it, vi } from 'vitest';
import type { SyncAuthMe, SyncAuthSession, SyncLedgerSelection } from '@zichan/db';
import { newSyncConnection } from '../src/sync-config.js';
import { activeDesktopLedgerProfile, desktopBinding, loadDesktopLedgerProfile,
  nativeBootstrapConnection, selectNativeProfileSession,
  type DesktopLedgerProfileBinding } from '../src/desktop-ledger-profile.js';

const binding: DesktopLedgerProfileBinding = {
  serverId: 'server-public-0001', serverPublicKey: 'public-key-example-0001',
  accountId: 'account-owner-0001', replicaId: 'replica-shared-0001',
  ledgerId: 'ledger-shared-0001', streamEpoch: 'stream-epoch-0001',
  serverUrl: 'https://ledger.example.com', username: 'owner',
};

const connection = { ...newSyncConnection(binding.serverUrl),
  serverId: binding.serverId, serverPublicKey: binding.serverPublicKey,
  accountId: binding.accountId, username: binding.username,
  ledgerId: 'ledger-personal-0001', replicaId: 'replica-personal-0001',
  streamEpoch: 'stream-personal-0001' };
const session: SyncAuthSession = { accountId: binding.accountId, accessToken: 'old-access-token',
  refreshToken: 'refresh-token', accessExpiresAt: new Date().toISOString(),
  session: { id: 'session-0001', username: 'owner', deviceId: 'device-0001', deviceName: 'Desktop',
    createdAt: '', updatedAt: '', expiresAt: '', lastSeenAt: '', lastIp: null,
    revokedAt: null, active: true } };
const selectedAccount: SyncAuthMe = { accountId: binding.accountId, username: binding.username,
  role: 'member', disabled: false, session: session.session, ledgerId: binding.ledgerId,
  replicaId: binding.replicaId, streamEpoch: binding.streamEpoch };

describe('desktop ledger profile selection', () => {
  it('chooses the bound replica before opening the native ledger and preserves refresh credentials', async () => {
    const select = vi.fn(async (): Promise<SyncLedgerSelection> => ({
      accessToken: 'selected-access-token', accessExpiresAt: new Date().toISOString(),
      accountId: binding.accountId, session: { ...session.session, replicaId: binding.replicaId },
      ledgerId: binding.ledgerId, replicaId: binding.replicaId, streamEpoch: binding.streamEpoch,
      ledgers: [],
    }));
    const readAccount = vi.fn(async () => selectedAccount);
    const selected = await selectNativeProfileSession(connection, session, binding, select, readAccount);
    expect(select).toHaveBeenCalledWith(binding.serverUrl, session.accessToken, binding.replicaId);
    expect(selected.connection).toMatchObject({ ledgerId: binding.ledgerId,
      replicaId: binding.replicaId, streamEpoch: binding.streamEpoch, role: 'member' });
    expect(readAccount).toHaveBeenCalledWith(binding.serverUrl, 'selected-access-token');
    expect(selected.session).toMatchObject({ accessToken: 'selected-access-token',
      refreshToken: 'refresh-token' });
    expect(desktopBinding(selected.connection, binding.ledgerId, binding.replicaId, binding.streamEpoch))
      .toEqual(binding);
  });

  it('refuses a different node, account, ledger or stream epoch', async () => {
    const select = vi.fn(async (): Promise<SyncLedgerSelection> => ({
      accessToken: 'selected', accessExpiresAt: '', accountId: binding.accountId,
      session: session.session, ledgerId: binding.ledgerId, replicaId: binding.replicaId,
      streamEpoch: 'unexpected-epoch', ledgers: [],
    }));
    const readAccount = vi.fn(async () => selectedAccount);
    await expect(selectNativeProfileSession({ ...connection, accountId: 'account-other-0001' },
      session, binding, select, readAccount)).rejects.toThrow('登录账号或节点');
    expect(select).not.toHaveBeenCalled();
    await expect(selectNativeProfileSession(connection, session, binding, select, readAccount))
      .rejects.toThrow('服务器账本副本身份已变化');
    await expect(selectNativeProfileSession({ ...connection, ledgerId: binding.ledgerId,
      replicaId: binding.replicaId, streamEpoch: 'unexpected-epoch' }, session, binding, select, readAccount))
      .rejects.toThrow('profile 与服务器副本身份不一致');
  });

  it('loads a profile status only when the native command gives a bound nonlegacy replica', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const invoke = vi.fn(async (command: string) => {
      expect(command).toBe('desktop_storage_status');
      return { ledgerProfileId: 'profile-0001', ledgerProfileBinding: binding,
        ledgerProfileSwitchSupported: true };
    });
    Object.defineProperty(globalThis, 'window', { configurable: true,
      value: { __TAURI__: { core: { invoke } } } });
    try {
      expect(await loadDesktopLedgerProfile()).toMatchObject({ ledgerProfileBinding: binding });
      expect(activeDesktopLedgerProfile()?.ledgerProfileId).toBe('profile-0001');
      expect(nativeBootstrapConnection()).toMatchObject({ ledgerId: binding.ledgerId,
        replicaId: binding.replicaId, serverPublicKey: binding.serverPublicKey });
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
