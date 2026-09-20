/**
 * Bulk account actions: enable, disable, and end sessions for a set of accounts.
 *
 * Three decisions shape this, and each one is here rather than in the page because getting it
 * wrong is silent:
 *
 * 1. **The scope is stated before the action, not after.** "Disabled 12 accounts" is not an
 *    answer to "which 12" — an operator who selected the wrong page must be able to see that
 *    before the write, not reconstruct it from the audit log afterwards.
 *
 * 2. **Every account is attempted and reported individually.** The server refuses some of them by
 *    design (owners are protected, an administrator may not touch a peer). Stopping at the first
 *    refusal would leave the rest undone with no record; silently skipping them would report
 *    success for work that did not happen. So the run continues and the outcome names each group.
 *
 * 3. **The per-account idempotency key carries the intended state.** A retry after a timeout
 *    replays the first result instead of repeating the write, and a *different* intent (disable
 *    where the first attempt enabled) must not be replayed as the old one.
 */
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { message } from './ui.js';
import type { AccountRow } from './types.js';

export type BulkAction = 'disable' | 'enable' | 'revoke-sessions';

export const BULK_LABELS: Record<BulkAction, string> = {
  disable: '禁用账号',
  enable: '启用账号',
  'revoke-sessions': '结束全部会话',
};

/** Whether a bulk action makes sense for this account's current state. */
export function actionApplies(action: BulkAction, account: Pick<AccountRow, 'disabled'>): boolean {
  if (action === 'disable') return !account.disabled;
  if (action === 'enable') return account.disabled;
  // Ending sessions is meaningful whenever there is at least one to end.
  return true;
}

/**
 * Splits the selection into what will be attempted and what will not, with the reason.
 *
 * Returned rather than logged, so the confirmation can show the same grouping the report will.
 * A reason here is a rule the server also enforces — the point is to say it before the write.
 */
export function partitionSelection(
  rows: AccountRow[],
  selected: string[],
  action: BulkAction,
  canManage: (account: AccountRow) => boolean,
): { ready: AccountRow[]; skipped: { account: AccountRow; reason: string }[] } {
  const chosen = rows.filter((row) => selected.includes(row.accountId));
  const ready: AccountRow[] = [];
  const skipped: { account: AccountRow; reason: string }[] = [];
  for (const account of chosen) {
    if (!canManage(account)) {
      skipped.push({ account, reason: account.role === 'owner' ? '所有者账号不可批量处理' : '你的角色不能管理该账号' });
    } else if (!actionApplies(action, account)) {
      skipped.push({ account, reason: action === 'disable' ? '账号已是禁用状态' : '账号已是启用状态' });
    } else if (action === 'revoke-sessions' && account.activeDeviceCount === 0) {
      // Saying "succeeded" for an account that had nothing to end would inflate the count and hide
      // that the operator picked the wrong rows.
      skipped.push({ account, reason: '没有有效会话' });
    } else {
      ready.push(account);
    }
  }
  return { ready, skipped };
}

/**
 * One reason, with its own trailing punctuation removed.
 *
 * `message()` returns sentences that end in a full stop; the report wraps each reason in
 * parentheses and ends the line itself, so keeping both produces "（…。）。".
 */
const reasonText = (text: string): string => text.replace(/[。；;.]+$/, '');

export interface BulkOutcome {
  action: BulkAction;
  attempted: number;
  succeeded: string[];
  failed: { username: string; reason: string }[];
  skipped: { username: string; reason: string }[];
  /** One line per group, ready to render, plus the scope line. */
  lines: string[];
}

/**
 * Runs one action across a set of accounts, sequentially.
 *
 * Sequential on purpose: these are audited, session-invalidating writes against one SQLite
 * database, and firing them concurrently trades a slower confirmation for lock contention and an
 * ordering nobody can reconstruct from the audit trail.
 */
export async function runBulkAction(
  client: AdminClient,
  action: BulkAction,
  rows: AccountRow[],
  selected: string[],
  canManage: (account: AccountRow) => boolean,
): Promise<BulkOutcome> {
  const { ready, skipped } = partitionSelection(rows, selected, action, canManage);
  const succeeded: string[] = [];
  const failed: { username: string; reason: string }[] = [];
  for (const account of ready) {
    try {
      if (action === 'revoke-sessions') {
        // No `expectedVersion` here: the revoke route does not compare one, so sending a version
        // would claim a guard that is not being enforced. Revoking is idempotent by nature — a
        // second call ends nothing that the first did not already end.
        await client.request(`/accounts/${account.accountId}/sessions/revoke`, {});
      } else {
        const disabled = action === 'disable';
        await client.request(`/users/${encodeURIComponent(account.username)}/disable`, { disabled, expectedVersion: account.revision }, { idempotencyKey: adminIdempotencyKey(`bulk-state-${disabled ? 'off' : 'on'}-${account.accountId}`) });
      }
      succeeded.push(account.username);
    } catch (error) {
      failed.push({ username: account.username, reason: message(error) });
    }
  }
  return {
    action,
    attempted: ready.length,
    succeeded,
    failed,
    skipped: skipped.map((entry) => ({ username: entry.account.username, reason: entry.reason })),
    lines: [
      `动作：${BULK_LABELS[action]}。范围：已选 ${selected.length} 个账号，其中可处理 ${ready.length} 个、跳过 ${skipped.length} 个。`,
      `成功 ${succeeded.length} 个${succeeded.length ? `：${succeeded.join('、')}` : ''}。`,
      failed.length ? `失败 ${failed.length} 个：${failed.map((entry) => `${entry.username}（${reasonText(entry.reason)}）`).join('；')}。` : '失败 0 个。',
      skipped.length ? `跳过 ${skipped.length} 个：${skipped.map((entry) => `${entry.account.username}（${entry.reason}）`).join('；')}。` : '跳过 0 个。',
    ],
  };
}
