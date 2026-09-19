import { D, newId, isDefaultAccount, accountBalanceTiming, accountTransactionPostings, accountChainPostings,
  type Account, type Setting, type Transaction } from '@zichan/core';
import type { SqlLedgerStore } from './repository.js';
import { saveTransactionAggregate } from './services.js';

const base = (id = newId()) => ({ id, createdAt: '', updatedAt: '', version: 1, isDeleted: false });

/** Stable ledger-scoped IDs also prevent duplicate default accounts on another device. */
export async function ensureDefaultAccounts(store: SqlLedgerStore): Promise<Setting | undefined> {
  const setting = (await store.settings.list())[0];
  if (!setting) return undefined;
  const accounts = await store.accounts.list();
  const defaults = ['default_expense', 'default_income'] as const;
  const ids = defaults.map((purpose) => accounts.find((a) => a.purpose === purpose)?.id ?? `${setting.id}:${purpose}`);
  const missing = defaults.some((purpose) => !accounts.some((a) => a.purpose === purpose));
  const unassigned = (await store.transactions.list()).filter((t) => !t.accountId && ['expense', 'income', 'refund'].includes(t.type));
  if (!missing && setting.expenseDefaultAccountId && setting.incomeDefaultAccountId && !unassigned.length) return setting;
  return store.runInAuditBatch('准备默认收支账户', async (tx) => {
    for (const [index, purpose] of defaults.entries()) {
      if (!await tx.accounts.get(ids[index]!)) await tx.accounts.put({ ...base(ids[index]), purpose, kind: 'wallet',
        name: index === 0 ? '默认支出账户' : '默认收入账户', isActive: true });
    }
    const current = (await tx.settings.get(setting.id))!;
    const saved = await tx.settings.put({ ...current,
      expenseDefaultAccountId: current.expenseDefaultAccountId ?? ids[0], incomeDefaultAccountId: current.incomeDefaultAccountId ?? ids[1] });
    for (const row of unassigned) {
      const original = row.refundForId ? await tx.transactions.get(row.refundForId) : undefined;
      await tx.transactions.put({ ...row, accountId: original?.accountId ?? (row.type === 'income' ? ids[1] : ids[0]) });
    }
    return saved;
  }, 'system', { undoable: false });
}

export async function createFundAccount(store: SqlLedgerStore, input: {
  account: Account; defaultExpense?: boolean; defaultIncome?: boolean;
}): Promise<Account> {
  return store.runInAuditBatch('添加资金账户和余额起点', async (tx) => {
    const account = await tx.accounts.put({ ...input.account, purpose: 'funds' });
    const setting = (await tx.settings.list())[0];
    if (setting && (input.defaultExpense || input.defaultIncome)) await tx.settings.put({ ...setting,
      expenseDefaultAccountId: input.defaultExpense ? account.id : setting.expenseDefaultAccountId,
      incomeDefaultAccountId: input.defaultIncome ? account.id : setting.incomeDefaultAccountId });
    return account;
  });
}

export interface AccountAssignment { id: string; version: number; timing?: 'before' | 'after' }
export async function previewAccountAssignment(store: SqlLedgerStore, targetId: string, rows: AccountAssignment[]) {
  const accounts = await store.accounts.list();
  const target = accounts.find((a) => a.id === targetId && a.isActive !== false);
  if (!target || isDefaultAccount(target)) throw new Error('请选择银行卡或钱包');
  const changes: { before: Transaction; after: Transaction }[] = [];
  const impacts = new Map<string, string>();
  for (const item of rows) {
    const before = await store.transactions.get(item.id);
    if (!before || before.isDeleted || before.recordState === 'voided' || before.version !== item.version) throw new Error('记录已变化，请刷新后重试');
    if (!['expense', 'income', 'refund'].includes(before.type)) throw new Error('这里只整理收入、支出和退款');
    const after: Transaction = { ...before, accountId: targetId, balanceTiming: item.timing,
      balanceTimingAccountId: item.timing ? targetId : undefined };
    if ((!target.openingAssetId || target.openingAssetId === after.assetId) && accountBalanceTiming(target, after) === 'unknown') throw new Error(`请确认 ${before.date} 的记录发生在余额起点之前还是之后`);
    for (const [transaction, sign] of [[before, -1], [after, 1]] as const) {
      for (const posting of accountTransactionPostings(transaction, accounts)) {
        if (!posting.accountId) continue;
        const key = `${posting.accountId}|${posting.assetId}`;
        impacts.set(key, D(impacts.get(key) ?? 0).plus(D(posting.amount).mul(sign)).toString());
      }
    }
    changes.push({ before, after });
  }
  return { changes, impacts: Object.fromEntries(impacts), targetVersion: target.version };
}

export async function assignTransactionAccounts(store: SqlLedgerStore, targetId: string, rows: AccountAssignment[], expectedTargetVersion?: number) {
  return store.runInAuditBatch('整理以前的记录：账户归属', async (tx) => {
    const preview = await previewAccountAssignment(tx, targetId, rows);
    if (expectedTargetVersion !== undefined && expectedTargetVersion !== preview.targetVersion) throw new Error('账户余额起点已变化，请重新预览');
    const saved = [];
    for (const change of preview.changes) saved.push(await saveTransactionAggregate(tx, {
      transaction: change.after, expectedVersion: change.before.version,
      splits: await tx.transactionSplits.list({ where: { transactionId: change.before.id } }),
    }));
    return { ...preview, saved };
  });
}

export interface EarlierBalanceInput {
  accountId: string; openingBalance: string; balanceStartAt: string; balanceStartDate: string;
}

/** Reconstruct an earlier start only when it reproduces the known later balance. */
export async function previewEarlierBalance(store: SqlLedgerStore, input: EarlierBalanceInput) {
  const account = await store.accounts.get(input.accountId);
  if (!account || isDefaultAccount(account) || !account.balanceStartAt || !account.openingAssetId) throw new Error('请选择已有余额起点的资金账户');
  if (!Number.isFinite(Date.parse(input.balanceStartAt)) || Date.parse(input.balanceStartAt) >= Date.parse(account.balanceStartAt)) throw new Error('请选择比现有余额起点更早的时间');
  if ((await store.reconciliationSessions.list({ where: { accountId: account.id } })).length) throw new Error('该账户已有对账记录，请先按原流程撤销相关对账后再前移余额起点');
  const next: Account = { ...account, openingBalance: D(input.openingBalance).toString(), balanceStartAt: input.balanceStartAt, balanceStartDate: input.balanceStartDate };
  const transactions = (await store.transactions.list()).filter((t) => t.recordState !== 'voided' && (t.accountId === account.id || t.transferAccountId === account.id));
  let reconstructed = D(next.openingBalance!);
  const updates: Transaction[] = [];
  for (const t of transactions) {
    const clean = t.balanceTimingAccountId === account.id ? { ...t, balanceTiming: undefined, balanceTimingAccountId: undefined } : t;
    const newPostings = accountTransactionPostings(clean, [next]).filter((p) => p.accountId === account.id && p.assetId === account.openingAssetId);
    const oldPostings = accountTransactionPostings(t, [account]).filter((p) => p.accountId === account.id && p.assetId === account.openingAssetId);
    reconstructed = reconstructed.plus(newPostings.reduce((sum, p) => sum.plus(p.amount), D(0))).minus(oldPostings.reduce((sum, p) => sum.plus(p.amount), D(0)));
    const extraPostings = accountTransactionPostings(clean, [next]).filter((p) => p.accountId === account.id && p.assetId !== account.openingAssetId);
    const oldExtra = accountTransactionPostings(t, [account]).filter((p) => p.accountId === account.id && p.assetId !== account.openingAssetId);
    if (JSON.stringify(extraPostings) !== JSON.stringify(oldExtra)) throw new Error('这段历史涉及其他币种，请先核实各币种余额，暂不能前移单币种余额起点');
    if (clean !== t) updates.push(clean);
  }
  const chains = await store.conversionChains.list();
  for (const chain of chains) {
    const aggregate = { chain, steps: await store.listStepsByChain(chain.id) };
    const extra = (a: Account) => accountChainPostings(aggregate, [a]).filter((p) => p.accountId === account.id && p.assetId !== account.openingAssetId);
    if (JSON.stringify(extra(next)) !== JSON.stringify(extra(account))) throw new Error('这段转换涉及其他币种，请先核实各币种余额，暂不能前移单币种余额起点');
    for (const [a, sign] of [[next, 1], [account, -1]] as const) {
      for (const posting of accountChainPostings(aggregate, [a]).filter((p) => p.accountId === account.id && p.assetId === account.openingAssetId)) reconstructed = reconstructed.plus(D(posting.amount).mul(sign));
    }
  }
  const signature = JSON.stringify([account.version, input, transactions.map((t) => [t.id, t.version]), chains.map((c) => [c.id, c.version])]);
  return { account, next, updates, reconstructed: reconstructed.toString(), difference: reconstructed.minus(account.openingBalance!).toString(), signature };
}

export async function applyEarlierBalance(store: SqlLedgerStore, input: EarlierBalanceInput, expectedPreview: string) {
  return store.runInAuditBatch('从更早日期核算账户余额', async (tx) => {
    const preview = await previewEarlierBalance(tx, input);
    if (preview.signature !== expectedPreview) throw new Error('账户或记录已变化，请重新预览');
    if (!D(preview.difference).isZero()) throw new Error('与已知余额仍有差额，请先补齐记录或核实更早余额');
    const account = { ...preview.next, balanceCheckpoints: [...(preview.account.balanceCheckpoints ?? []), {
      at: preview.account.balanceStartAt!, date: preview.account.balanceStartDate!, assetId: preview.account.openingAssetId!, balance: preview.account.openingBalance!,
    }] };
    return tx.withValidatedRestore(['account:' + account.id], [], async (restore) => {
      const saved = await restore.accounts.put(account);
      for (const transaction of preview.updates) await saveTransactionAggregate(restore, { transaction, expectedVersion: transaction.version });
      return saved;
    });
  }, 'user', { undoable: false });
}
