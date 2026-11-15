import { D, newId, isDefaultAccount, isLegacyExternalAccount, accountBalanceTiming, accountTransactionPostings, accountChainPostings,
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
  const legacy = accounts.filter((account) => isDefaultAccount(account) && account.kind === 'wallet');
  const missing = accounts.length === 0;
  const unassigned = (await store.transactions.list()).filter((t) => !t.accountId && ['expense', 'income', 'refund'].includes(t.type));
  const active = accounts.filter((a) => !a.isDeleted && a.isActive !== false && !a.archivedAt && !isLegacyExternalAccount(a));
  if (!missing && !legacy.length && active.some((a) => a.id === setting.expenseDefaultAccountId) && active.some((a) => a.id === setting.incomeDefaultAccountId) && !unassigned.length) return setting;
  return store.runInAuditBatch('准备默认账户', async (tx) => {
    if (missing) for (const [index] of defaults.entries()) {
      await tx.accounts.put({ ...base(ids[index]), purpose: 'funds', kind: 'other',
        name: index === 0 ? '默认支出账户' : '默认收入账户', isActive: true });
    }
    if (legacy.length) await tx.withValidatedRestore(legacy.map((a) => `account:${a.id}`), [], async (restore) => {
      for (const account of legacy) await restore.accounts.put({ ...account, kind: 'other' });
    });
    const available = (await tx.accounts.list()).filter((a) => !a.isDeleted && a.isActive !== false && !a.archivedAt && !isLegacyExternalAccount(a));
    const current = (await tx.settings.get(setting.id))!;
    const saved = await tx.settings.put({ ...current,
      expenseDefaultAccountId: available.find((a) => a.id === current.expenseDefaultAccountId)?.id ?? available.find((a) => a.id === ids[0])?.id ?? available[0]?.id,
      incomeDefaultAccountId: available.find((a) => a.id === current.incomeDefaultAccountId)?.id ?? available.find((a) => a.id === ids[1])?.id ?? available[0]?.id });
    for (const row of unassigned) {
      const original = row.refundForId ? await tx.transactions.get(row.refundForId) : undefined;
      await tx.transactions.put({ ...row, accountId: original?.accountId ?? (row.type === 'income' ? saved.incomeDefaultAccountId : saved.expenseDefaultAccountId) });
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

/** Change future entry defaults together; existing postings and balances stay intact. */
export async function setDefaultTransactionAccounts(store: SqlLedgerStore, input: {
  expenseAccountId: string; incomeAccountId: string; expectedVersion?: number;
}): Promise<Setting> {
  return store.runInAuditBatch('设置默认支出与收入账户', async (tx) => {
    const setting = (await tx.settings.list())[0];
    if (!setting) throw new Error('找不到账本设置，请重新打开账本');
    if (input.expectedVersion !== undefined && setting.version !== input.expectedVersion) throw new Error('默认设置已变化，请刷新后重新选择');
    if (!input.expenseAccountId || !input.incomeAccountId) throw new Error('请选择默认支出账户和默认收入账户');
    return tx.settings.put({ ...setting, expenseDefaultAccountId: input.expenseAccountId, incomeDefaultAccountId: input.incomeAccountId });
  });
}

export interface AccountAssignment { id: string; version: number; timing?: 'before' | 'after' }
export async function previewAccountAssignment(store: SqlLedgerStore, targetId: string, rows: AccountAssignment[]) {
  const accounts = await store.accounts.list();
  const target = accounts.find((a) => a.id === targetId && a.isActive !== false);
  if (!target || isLegacyExternalAccount(target)) throw new Error('请选择可用账户');
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
  if (!account || isLegacyExternalAccount(account) || !account.balanceStartAt || !account.openingAssetId) throw new Error('请选择已有余额起点的资金账户');
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


/** Account metadata and default directions commit together; balance origins are preserved. */
export async function saveAccountDetails(store: SqlLedgerStore, input: { account: Account; defaultExpense: boolean; defaultIncome: boolean; expectedSettingVersion?: number }): Promise<Account> {
  return store.runInAuditBatch('编辑账户资料与默认用途', async (tx) => {
    const current = await tx.accounts.get(input.account.id);
    if (!current || current.isDeleted || current.version !== input.account.version) throw new Error('账户已变化，请重新打开');
    const account = await tx.accounts.put({ ...input.account, openingBalance: current.openingBalance, openingAssetId: current.openingAssetId,
      balanceStartAt: current.balanceStartAt, balanceStartDate: current.balanceStartDate, balanceCheckpoints: current.balanceCheckpoints, purpose: current.purpose });
    const setting = (await tx.settings.list())[0];
    if (setting) {
      if (input.expectedSettingVersion !== undefined && setting.version !== input.expectedSettingVersion) throw new Error('默认收支设置已变化，请重新打开账户');
      const accounts = await tx.accounts.list();
      const fallback = () => accounts.find((row) => row.id !== account.id && row.isActive !== false && !row.archivedAt && !isLegacyExternalAccount(row))?.id;
      const expense = input.defaultExpense ? account.id : setting.expenseDefaultAccountId === account.id ? fallback() : setting.expenseDefaultAccountId;
      const income = input.defaultIncome ? account.id : setting.incomeDefaultAccountId === account.id ? fallback() : setting.incomeDefaultAccountId;
      await tx.settings.put({ ...setting, expenseDefaultAccountId: expense, incomeDefaultAccountId: income });
    }
    return account;
  });
}
