import { D } from './decimal.js';
import { normalizeOccurrence } from './time.js';
import { postingsFromChain, postingsFromTransaction, type Posting } from './postings.js';
import type { Account, ChainWithSteps, Setting, Transaction } from './types.js';

export function isDefaultAccount(account: Account): boolean {
  return account.purpose === 'default_expense' || account.purpose === 'default_income';
}

export function defaultTransactionAccount(accounts: Account[], setting: Setting | undefined, type: string): string | undefined {
  const purpose = type === 'income' ? 'default_income' : 'default_expense';
  const selected = type === 'income' ? setting?.incomeDefaultAccountId : setting?.expenseDefaultAccountId;
  const active = accounts.filter((a) => !a.isDeleted && a.isActive !== false);
  return active.find((a) => a.id === selected)?.id ?? active.find((a) => a.purpose === purpose)?.id;
}

export function accountBalanceTiming(account: Account, transaction: Pick<Transaction,
  'date' | 'time' | 'timezone' | 'occurredAtUtc' | 'timePrecision' | 'balanceTiming' | 'balanceTimingAccountId'>): 'before' | 'after' | 'unknown' {
  if (!account.balanceStartAt) return 'after';
  if (transaction.balanceTimingAccountId === account.id && transaction.balanceTiming) return transaction.balanceTiming;
  const occurrence = transaction.occurredAtUtc ? transaction : normalizeOccurrence(transaction);
  if (occurrence.occurredAtUtc) {
    const instant = Date.parse(occurrence.occurredAtUtc);
    const start = Date.parse(account.balanceStartAt);
    const width = transaction.timePrecision === 'minute' || transaction.time?.length === 5 ? 60_000 : 1000;
    if (instant < start && instant + width > start) return 'unknown';
    return instant >= start ? 'after' : 'before';
  }
  if (transaction.date === account.balanceStartDate) return 'unknown';
  return transaction.date < (account.balanceStartDate ?? account.balanceStartAt.slice(0, 10)) ? 'before' : 'after';
}

export function accountTransactionPostings(transaction: Transaction, accounts: Account[]): Posting[] {
  return postingsFromTransaction(transaction).filter((posting) => {
    const account = accounts.find((a) => a.id === posting.accountId);
    if (!account) return true; // Read old exports without inventing an account.
    if (isDefaultAccount(account) || account.kind === 'other') return false;
    if (account.openingAssetId && posting.assetId !== account.openingAssetId) return true;
    const timing = accountBalanceTiming(account, transaction);
    if (timing === 'unknown') throw new Error(`请确认「${account.name}」的这笔记录发生在余额起点之前还是之后`);
    return timing === 'after';
  });
}

export function accountOpeningPostings(accounts: Account[]): Posting[] {
  return accounts.filter((a) => !a.isDeleted && !isDefaultAccount(a) && a.openingBalance !== undefined && a.openingAssetId && a.balanceStartAt)
    .map((a) => ({ assetId: a.openingAssetId!, accountId: a.id, amount: D(a.openingBalance!).toString(),
      date: a.balanceStartDate!, source: { kind: 'account_opening', id: a.id } }));
}

/** Conversion balances obey the same account starting snapshot. */
export function accountChainPostings(chain: ChainWithSteps, accounts: Account[]): Posting[] {
  return postingsFromChain(chain).filter((posting) => {
    const account = accounts.find((a) => a.id === posting.accountId);
    if (!account) return true;
    if (isDefaultAccount(account) || account.kind === 'other') return false;
    if (account.openingAssetId && posting.assetId !== account.openingAssetId) return true;
    const timing = accountBalanceTiming(account, chain.chain);
    if (timing === 'unknown') throw new Error('请补充资产转换的准确时间，以确认是否已包含在账户起始余额中');
    return timing === 'after';
  });
}
