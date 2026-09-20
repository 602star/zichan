import { describe, expect, it, vi } from 'vitest';
import { actionApplies, partitionSelection, runBulkAction } from '../src/admin/bulk-actions.js';
import { AdminError } from '../src/admin/client.js';
import type { AccountRow } from '../src/admin/types.js';

/**
 * Bulk account actions.
 *
 * The failure modes here are all about telling the truth after a partial run: an account the server
 * refused must not be counted as done, an account with nothing to do must not be counted as
 * succeeded, and a retry must not repeat a write that already happened.
 */
const account = (overrides: Partial<AccountRow> & { accountId: string }): AccountRow => ({
  username: `user-${overrides.accountId}`,
  role: 'member',
  disabled: false,
  revision: 1,
  protectionMode: 'managed',
  commitBytes: 0,
  commitQuotaBytes: 1024 ** 3,
  quotaState: 'ok',
  activeDeviceCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
} as AccountRow);

const manageMembers = (actorRole: string) => (row: AccountRow) =>
  actorRole !== 'viewer' && row.role !== 'owner' && (actorRole === 'owner' || row.role === 'member');

describe('bulk account actions', () => {
  it('only offers an action that changes something', () => {
    expect(actionApplies('disable', { disabled: false })).toBe(true);
    expect(actionApplies('disable', { disabled: true })).toBe(false);
    expect(actionApplies('enable', { disabled: true })).toBe(true);
    expect(actionApplies('enable', { disabled: false })).toBe(false);
  });

  it('separates what will run from what will not, with a reason', () => {
    const rows = [
      account({ accountId: 'a1' }),
      account({ accountId: 'a2', disabled: true }),
      account({ accountId: 'a3', role: 'owner' }),
      account({ accountId: 'a4', role: 'admin' }),
    ];
    const { ready, skipped } = partitionSelection(rows, ['a1', 'a2', 'a3', 'a4'], 'disable', manageMembers('owner'));
    // The already-disabled one has nothing to change; the owner is protected; the peer administrator
    // is out of an owner's reach only for other owners, so it stays in scope here.
    expect(ready.map((row) => row.accountId)).toEqual(['a1', 'a4']);
    expect(skipped.map((entry) => [entry.account.accountId, entry.reason])).toEqual([
      ['a2', '账号已是禁用状态'],
      ['a3', '所有者账号不可批量处理'],
    ]);
  });

  it('refuses a privileged peer for an administrator but not for the owner', () => {
    const rows = [account({ accountId: 'a1', role: 'admin' }), account({ accountId: 'a2', role: 'member' })];
    const asAdmin = partitionSelection(rows, ['a1', 'a2'], 'disable', manageMembers('admin'));
    expect(asAdmin.ready.map((row) => row.accountId)).toEqual(['a2']);
    expect(asAdmin.skipped[0]?.reason).toBe('你的角色不能管理该账号');
    // An owner may manage an administrator; that is the whole difference between the two roles.
    const asOwner = partitionSelection(rows, ['a1', 'a2'], 'disable', manageMembers('owner'));
    expect(asOwner.ready.map((row) => row.accountId)).toEqual(['a1', 'a2']);
  });

  it('does not count an account with no sessions as sessions ended', () => {
    const rows = [account({ accountId: 'a1', activeDeviceCount: 2 }), account({ accountId: 'a2', activeDeviceCount: 0 })];
    const { ready, skipped } = partitionSelection(rows, ['a1', 'a2'], 'revoke-sessions', manageMembers('owner'));
    expect(ready.map((row) => row.accountId)).toEqual(['a1']);
    expect(skipped[0]?.reason).toBe('没有有效会话');
  });

  it('ignores selected keys that are not on the loaded page', () => {
    // A stale selection must not reach the server: the row it names is not on screen, so nothing
    // about it can be confirmed.
    const rows = [account({ accountId: 'a1' })];
    const { ready } = partitionSelection(rows, ['a1', 'gone'], 'disable', manageMembers('owner'));
    expect(ready.map((row) => row.accountId)).toEqual(['a1']);
  });

  it('reports every account individually and keeps going after a refusal', async () => {
    const calls: string[] = [];
    const client = {
      request: vi.fn(async (path: string) => {
        calls.push(path);
        if (path.includes('user-a2')) throw new AdminError(403, 'PROTECTED_ACCOUNT', '此账号受保护，你无权修改。');
        return {};
      }),
    };
    const rows = [account({ accountId: 'a1' }), account({ accountId: 'a2' }), account({ accountId: 'a3' })];
    const outcome = await runBulkAction(client as never, 'disable', rows, ['a1', 'a2', 'a3'], manageMembers('owner'));
    // The refusal on the second account must not stop the third: stopping would leave it undone and
    // silently report only the first.
    expect(calls).toHaveLength(3);
    expect(outcome.succeeded).toEqual(['user-a1', 'user-a3']);
    expect(outcome.failed).toEqual([{ username: 'user-a2', reason: '此账号受保护，你无权修改。' }]);
    expect(outcome.attempted).toBe(3);
    expect(outcome.lines.join('\n')).toContain('失败 1 个');
    expect(outcome.lines.join('\n')).toContain('成功 2 个');
  });

  it('names the intended state in the idempotency key, so a retry cannot replay the opposite', async () => {
    const keys: string[] = [];
    const client = {
      request: vi.fn(async (_path: string, _body: unknown, options: { idempotencyKey: string }) => {
        keys.push(options.idempotencyKey);
        return {};
      }),
    };
    const rows = [account({ accountId: 'a1' })];
    await runBulkAction(client as never, 'disable', rows, ['a1'], manageMembers('owner'));
    await runBulkAction(client as never, 'enable', [account({ accountId: 'a1', disabled: true })], ['a1'], manageMembers('owner'));
    // Same account, opposite intent: a retried disable must not be replayed as the enable.
    expect(keys[0]).toContain('bulk-state-off-a1');
    expect(keys[1]).toContain('bulk-state-on-a1');
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('sends the expected version so a concurrent edit is refused rather than overwritten', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = {
      request: vi.fn(async (_path: string, body: Record<string, unknown>) => { bodies.push(body); return {}; }),
    };
    const rows = [account({ accountId: 'a1', revision: 7 })];
    await runBulkAction(client as never, 'disable', rows, ['a1'], manageMembers('owner'));
    expect(bodies[0]?.['expectedVersion']).toBe(7);
    expect(bodies[0]?.['disabled']).toBe(true);
  });

  it('calls the session-revoke route without a version guard the server does not enforce', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const client = {
      request: vi.fn(async (path: string, body: unknown) => { calls.push({ path, body }); return {}; }),
    };
    const rows = [account({ accountId: 'a1', revision: 7, activeDeviceCount: 2 })];
    const outcome = await runBulkAction(client as never, 'revoke-sessions', rows, ['a1'], manageMembers('owner'));
    expect(calls[0]?.path).toBe('/accounts/a1/sessions/revoke');
    // The revoke route ignores `expectedVersion`, so sending one would imply a guard that is not
    // enforced. Pinning that here keeps a later "make it consistent" edit from adding it back.
    expect(calls[0]?.body).not.toHaveProperty('expectedVersion');
    expect(outcome.succeeded).toEqual(['user-a1']);
  });
});
