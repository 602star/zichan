import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../src/account-protection.js');
  vi.doUnmock('../src/sync-config.js');
  vi.doUnmock('../src/sync-orchestrator.js');
  vi.resetModules();
});

describe('legacy protection scope', () => {
  it('refuses a controlled ledger before synchronization, backup or key rotation', async () => {
    const ledgerId = 'ledger-controlled-protection-001';
    const replica = { serverId: 'server-one', ledgerId, replicaId: 'replica-one',
      streamEpoch: 'epoch-one', headSeq: 3 };
    const profile = { id: 'primary', ledgerId, replicaId: replica.replicaId };
    const protectionRequest = vi.fn().mockResolvedValue({ controlled: true, replica });
    const syncConfiguredServers = vi.fn();
    vi.doMock('../src/account-protection.js', () => ({
      accountProtection: () => ({ profileId: profile.id, secret: 'old-secret', info: { replica } }),
      protectionRequest,
    }));
    vi.doMock('../src/sync-config.js', async (importOriginal) => ({
      ...await importOriginal<Record<string, unknown>>(), loadSyncConnections: () => [profile],
    }));
    vi.doMock('../src/sync-orchestrator.js', () => ({ syncConfiguredServers }));
    const { changeAccountProtection } = await import('../src/change-protection.js');
    await expect(changeAccountProtection({ getLedgerId: async () => ledgerId } as never,
      'private', 'new-secret')).rejects.toThrow('已启用成员密钥');
    expect(protectionRequest).toHaveBeenCalledTimes(1);
    expect(syncConfiguredServers).not.toHaveBeenCalled();
  });
});
